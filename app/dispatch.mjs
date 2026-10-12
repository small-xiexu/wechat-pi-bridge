// dispatch.mjs - process due batches for the Pi binding (webhook mode).
// One-shot or loop: `node app/dispatch.mjs once` | `node app/dispatch.mjs loop`.
// Flow per batch: claim (lease+fencing) -> pi --print (stdin) -> plaintext ->
// delivery_parts -> outbox send (wx-bot) -> done. Failures back off, never lost.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readdirSync, statSync, realpathSync } from 'node:fs';
import { openDb, dueBatches, claimBatch, batchTexts, setBatchStatus,
  createDeliveryParts, dueDeliveryParts, setPartStatus, maybeCompleteTarget, audit, nowIso } from './db.mjs';
import { addToBatch } from './debounce.mjs';
import { runPi, isAllowedMediaPath } from './pi-runner.mjs';
import { shrinkSessionImages } from './session-images.mjs';
import { sendText, sendTelegramText, backoffMs } from './outbox.mjs';
import { markdownToPlain, formatBatchForPi } from './normalize.mjs';
import { loadBindingsConfig } from './auth.mjs';
import { markWxAuthInvalid, markWxAuthValid, shouldNotify } from './wx-auth-state.mjs';
import { notifyWxAuthInvalid } from './wechat-auth-alert.mjs';

const BRIDGE_HOME = process.env.WB_HOME || '/home/hatch/workspace/wechat-bridge';
const AUTH_STATE_HOME = process.env.WB_HOME || BRIDGE_HOME;
const DISPATCH_OWNER = `dispatch-${process.pid}`;

function fencing() { return randomBytes(16).toString('hex'); }

/** Resolve the Telegram bot token for a telegram-* binding from telegram.json. */
export function telegramTokenFor(telegramCfg, binding) {
  const t = telegramCfg?.telegram || {};
  if (binding === 'telegram-pi') return t.pi_bot_token || null;
  if (binding === 'telegram-muse') return t.muse_bot_token || null;
  return null;
}

function telegramTokenOk(token) {
  return typeof token === 'string' && token.length > 0 && !token.startsWith('__REPLACE');
}

/** Send an image file via wx-bot send --image. */
async function sendPiMedia(cfg, batch, mediaPath, drySend) {
  if (drySend) { console.log(`[drySend] would send media ${mediaPath}`); return; }
  const { spawn } = await import('node:child_process');
  const wxbotConfig = cfg?.wxbot_config?.startsWith('/') ? cfg.wxbot_config : `${BRIDGE_HOME}/${cfg?.wxbot_config || 'config/wx-bot-pi.json'}`;
  const wxbotBin = process.env.WB_WXBOT_BIN || `${BRIDGE_HOME}/vendor/wx-bot/wx-bot`;
  const to = batch.conversation_id;
  const flag = '--image';
  return new Promise((resolve, reject) => {
    const child = spawn(wxbotBin, ['--config', wxbotConfig, 'send', '--binding', batch.binding, '--to', to, flag, mediaPath], {
      env: { ...process.env },
      cwd: BRIDGE_HOME,
    });
    child.on('error', reject);
    let stderr = '';
    child.stderr?.on('data', d => stderr += d.toString());
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`wx-bot send ${flag} exit ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}
// Back-compat alias
const sendPiImage = sendPiMedia;

/** Session epoch: lets user start a fresh Pi session via "新会话" keyword.
 *  Stored in state dir as JSON: { "<binding>-<principal>": epoch } */
function sessionEpochFile() {
  const dir = `${BRIDGE_HOME}/state`;
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return join(dir, 'pi-session-epoch.json');
}
function getSessionEpoch(key) {
  try {
    const f = sessionEpochFile();
    if (!existsSync(f)) return 0;
    return JSON.parse(readFileSync(f, 'utf8'))[key] || 0;
  } catch { return 0; }
}
function bumpSessionEpoch(key) {
  const f = sessionEpochFile();
  let data = {};
  try { if (existsSync(f)) data = JSON.parse(readFileSync(f, 'utf8')); } catch {}
  data[key] = (data[key] || 0) + 1;
  writeFileSync(f, JSON.stringify(data));
  return data[key];
}
function sessionIdFor(binding, principal) {
  const key = `${binding}-${principal}`;
  const epoch = getSessionEpoch(key);
  return epoch > 0 ? `${key}-s${epoch}` : key;
}

/** Session size guard: generated images land in Pi's session history as
 *  base64, and a bloated session file (25MB observed 2026-10-12) makes every
 *  subsequent Pi request huge enough that the relay rejects it with 503.
 *  When the current session file exceeds the cap, rotate to a fresh epoch
 *  (the old file stays on disk) and continue with the new session. */
const SESSION_MAX_BYTES = Number(process.env.WB_PI_SESSION_MAX_MB || 10) * 1024 * 1024;
function sessionFileSizeBytes(sessionDir, sessionId) {
  try {
    const f = readdirSync(sessionDir).find((n) => n.endsWith(`_${sessionId}.jsonl`));
    return f ? statSync(join(sessionDir, f)).size : 0;
  } catch { return 0; }
}
export function guardedSessionId(binding, principal, sessionDir) {
  let sid = sessionIdFor(binding, principal);
  const dir = sessionDir
    || `${process.env.WB_PI_HOME || '/home/hatch'}/.pi/agent/sessions`;
  const size = sessionFileSizeBytes(dir, sid);
  if (size > SESSION_MAX_BYTES) {
    bumpSessionEpoch(`${binding}-${principal}`);
    const fresh = sessionIdFor(binding, principal);
    console.log(`[dispatch] session ${sid} is ${(size / 1048576).toFixed(1)}MB (> cap); rotated to ${fresh}`);
    sid = fresh;
  }
  return sid;
}

/** Check if message is a "new session" command. */
function isNewSessionCmd(text) {
  const t = String(text || '').trim().toLowerCase();
  return t === '新会话' || t === '/new' || t === 'new session' || t === '重新开始';
}

/** List image files in dir (non-recursive, png/jpg/jpeg/webp). */
function listImages(dir) {
  try {
    return readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).map(f => join(dir, f));
  } catch { return []; }
}
/** List Pi-generated outbound images for auto-send. */
function listOutboundMedia(dir) {
  try {
    return readdirSync(dir).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f)).map(f => join(dir, f));
  } catch { return []; }
}

export async function dispatchOnce({ dbPath, bindings, drySend = false, telegramCfg = null } = {}) {
  const db = openDb(dbPath);
  const now = nowIso();
  const results = { batches: [], parts: [] };

  // 1. due batches -> run pi
  for (const b of dueBatches(db, now)) {
    const token = fencing();
    const claimed = claimBatch(db, b.id, DISPATCH_OWNER, 10 * 60 * 1000, token, now);
    if (!claimed) continue; // lost the race
    const cfg = bindings.bindings[b.binding];
    try {
      const msgs = batchTexts(db, b.id);
      const ch0 = cfg?.channel || 'wechat';
      // "新会话" command: bump epoch, reply confirmation, skip Pi
      const onlyText = msgs.map(m => m.text || '').join('\n').trim();
      if (isNewSessionCmd(onlyText) && msgs.length === 1) {
        const key = `${b.binding}-${b.authorized_principal}`;
        bumpSessionEpoch(key);
        const confirmParts = createDeliveryParts(db, {
          batchId: b.id,
          principal: b.authorized_principal,
          binding: b.binding,
          conversationId: b.conversation_id,
          recipientId: b.conversation_id,
          text: '好的，已开始新会话，之前的上下文已清空。',
          maxPartLen: 1500,
          channel: cfg?.channel || 'wechat',
        });
        setBatchStatus(db, b.id, 'done', now);
        results.batches.push({ id: b.id, status: 'new_session' });
        continue;
      }
      const input = formatBatchForPi(msgs, b.binding, ch0 === 'telegram' ? 'Telegram' : '微信', { imageModel: cfg?.image_model || null });
      const workdir = cfg?.pi_workdir || `${BRIDGE_HOME}/sandbox/pi-work`;
      const beforeImgs = listOutboundMedia(workdir);
      const mediaRoots = [
        ...(Array.isArray(cfg?.media_roots) ? cfg.media_roots : []),
        `${BRIDGE_HOME}/state/wx-pi/media`,
        `${BRIDGE_HOME}/state/telegram-media`,
        workdir,
      ];
      const images = msgs.flatMap(m => [
        ...(Array.isArray(m.media_files) ? m.media_files : []),
        m.media_file_id,
      ]).filter(p => isAllowedMediaPath(p, mediaRoots));
      // dedupe; reject rather than pass arbitrary absolute paths to Pi.
      const seen = new Set(); const uniqImages = images.filter(p => !seen.has(p) && seen.add(p));
      const sessionIdUsed = guardedSessionId(b.binding, b.authorized_principal, cfg?.pi_session_dir || undefined);
      const r = await runPi(input, {
        piBin: cfg?.pi_bin || undefined,
        model: cfg?.pi_model || 'sub2api/gpt-6.1-sol',
        workdir,
        timeoutMs: cfg?.pi_timeout_ms || 600_000,
        sessionId: sessionIdUsed,
        sessionDir: cfg?.pi_session_dir || undefined,
        images: uniqImages,
      });
      if (!r.ok) throw new Error(`pi failed code=${r.code} signal=${r.signal} timedOut=${r.timedOut} stderr=${r.stderr.slice(0, 300)}`);
      const newImgs = listOutboundMedia(workdir).filter(f => !beforeImgs.includes(f));
      const plain = markdownToPlain(r.stdout);
      // Send Pi-generated images (wechat via wx-bot, telegram via sendPhoto)
      if (newImgs.length > 0) {
        const ch = cfg?.channel || 'wechat';
        for (const imgPath of newImgs) {
          try {
            if (ch === 'telegram') {
              const { sendTelegramPhoto } = await import('./outbox.mjs');
              const tToken = telegramTokenFor(telegramCfg, b.binding);
              if (!telegramTokenOk(tToken)) throw new Error('telegram token not configured');
              const r = await sendTelegramPhoto({
                token: tToken,
                apiBase: telegramCfg?.telegram?.api_base,
                chatId: b.conversation_id,
                photoPath: imgPath,
              });
              if (!r.ok) throw new Error(`tg sendPhoto failed: ${r.kind} ${r.stderr.slice(0, 100)}`);
            } else {
              await sendPiMedia(cfg, b, imgPath, drySend);
            }
            console.log(`[dispatch] sent image ${imgPath} for batch ${b.id} via ${ch}`);
          } catch (e) {
            console.error(`[dispatch] send image failed: ${e.message}`);
          }
        }
      }
      const parts = createDeliveryParts(db, {
        batchId: b.id,
        principal: b.authorized_principal,
        binding: b.binding,
        conversationId: b.conversation_id,
        recipientId: b.conversation_id,
        text: plain || '[Pi 返回了空回复]',
        maxPartLen: 1500,
        channel: cfg?.channel || 'wechat',
      });
      setBatchStatus(db, b.id, 'done', { fencingToken: token });
      audit(db, { binding: b.binding, eventType: 'batch.pi_done', entityType: 'batches', entityId: b.id, details: { parts: parts.length } });
      // Route-1 fix for session bloat: downscale images from older exchanges
      // inside the Pi session file so later turns stop re-sending MB-sized
      // originals. Best-effort only; never affects delivery.
      try {
        const shrunk = shrinkSessionImages(cfg?.pi_session_dir || '/home/hatch/.pi/agent/sessions', sessionIdUsed);
        if (shrunk?.replaced) {
          audit(db, { binding: b.binding, eventType: 'session.images_shrunk', entityType: 'batches', entityId: b.id, details: shrunk });
          console.log(`[dispatch] shrunk ${shrunk.replaced} session images, saved ${(shrunk.savedBytes / 1048576).toFixed(1)}MB (session ${sessionIdUsed})`);
        }
      } catch (e) { console.error(`[dispatch] session image shrink failed: ${e.message}`); }
      results.batches.push({ id: b.id, status: 'done', parts: parts.length });
    } catch (e) {
      const attempt = (b.attempt || 0) + 1;
      const wait = backoffMs(Math.min(attempt, 3));
      const next = new Date(Date.now() + wait).toISOString();
      if (attempt >= 5) {
        setBatchStatus(db, b.id, 'dead', { fencingToken: token, error: String(e.message).slice(0, 500) });
        db.prepare(`INSERT INTO dead_letters (entity_type, entity_id, reason, attempts, created_at) VALUES ('batches', ?, ?, ?, ?)`)
          .run(b.id, String(e.message).slice(0, 500), attempt, nowIso());
      } else {
        db.prepare(`UPDATE batches SET status = 'pending', next_attempt_at = ?, next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND fencing_token = ?`)
          .run(next, next, String(e.message).slice(0, 500), nowIso(), b.id, token);
      }
      audit(db, { binding: b.binding, eventType: 'batch.pi_failed', entityType: 'batches', entityId: b.id, details: { error: String(e.message).slice(0, 200) } });
      results.batches.push({ id: b.id, status: 'failed', error: String(e.message).slice(0, 200) });
    }
  }

  // 2. due delivery parts -> wx-bot send
  const t = nowIso();
  for (const p of dueDeliveryParts(db, t)) {
    const token = fencing();
    const r = db.prepare(`UPDATE delivery_parts SET status = 'sending', lease_owner = ?, lease_until = ?, fencing_token = ?, attempt = attempt + 1, updated_at = ?
      WHERE id = ? AND status = 'pending'`)
      .run(DISPATCH_OWNER, new Date(Date.now() + 120000).toISOString(), token, t, p.id);
    if (r.changes === 0) continue;
    const cfg = bindings.bindings[p.binding];
    const ch = p.channel || 'wechat';
    let s;
    if (ch === 'telegram') {
      const token = telegramTokenFor(telegramCfg, p.binding);
      if (!telegramTokenOk(token)) {
        setPartStatus(db, p.id, 'dead', { fencingToken: token, error: 'telegram token not configured (fail-closed)' });
        maybeCompleteTarget(db, p.id);
        results.parts.push({ id: p.id, status: 'dead', kind: 'no_token' });
        continue;
      }
      if (drySend) process.env.TG_SEND_MOCK = '1';
      s = await sendTelegramText({
        token,
        apiBase: telegramCfg?.telegram?.api_base,
        chatId: p.recipient_id,
        text: p.text,
      });
    } else {
      const sendCfg = {
        wxbotConfig: cfg?.wxbot_config?.startsWith('/') ? cfg.wxbot_config : `${BRIDGE_HOME}/${cfg?.wxbot_config || 'config/wx-bot-pi.json'}`,
        binding: p.binding,
        to: p.recipient_id,
        text: p.text,
      };
      if (drySend) process.env.WB_SEND_MOCK = '1';
      s = await sendText(sendCfg);
    }
    if (s.ok) {
      if (ch !== 'telegram') {
        const source = `binding=${p.binding}; outbound=delivery_part:${p.id}`;
        markWxAuthValid({
          bridgeHome: AUTH_STATE_HOME,
          source,
          audit: ({ eventType, details }) => audit(db, {
            binding: p.binding,
            eventType,
            entityType: 'delivery_parts',
            entityId: p.id,
            details,
          }),
        });
      }
      setPartStatus(db, p.id, 'sent', { fencingToken: token });
      maybeCompleteTarget(db, p.id);
      results.parts.push({ id: p.id, status: 'sent' });
    } else if (!s.retry) {
      if (ch !== 'telegram' && s.kind === 'auth_invalid') {
        const source = `binding=${p.binding}; outbound=delivery_part:${p.id}`;
        markWxAuthInvalid({
          bridgeHome: AUTH_STATE_HOME,
          source,
          reason: 'errcode=-14',
          audit: ({ eventType, details }) => audit(db, {
            binding: p.binding,
            eventType,
            entityType: 'delivery_parts',
            entityId: p.id,
            details,
          }),
        });
        // Keep this event separate from the state-transition audit: repeated
        // -14s are useful evidence even while the state remains invalid.
        audit(db, {
          binding: p.binding,
          eventType: 'wechat.auth_invalid',
          entityType: 'delivery_parts',
          entityId: p.id,
          details: { source, kind: s.kind, retry: false },
        });
        if (shouldNotify({ bridgeHome: AUTH_STATE_HOME })) {
          const alert = await notifyWxAuthInvalid({
            telegramConfig: telegramCfg,
            telegramConfigPath: process.env.WB_TG_CONFIG || `${AUTH_STATE_HOME}/config/telegram.json`,
            reason: 'errcode=-14',
            source,
          });
          if (!alert.ok) {
            console.error(`[dispatch] WeChat auth alert failed: ${alert.error || alert.kind || 'unknown error'}`);
          }
        }
      }
      setPartStatus(db, p.id, 'dead', { fencingToken: token, error: `${s.kind}: ${s.stderr.slice(0, 200)}` });
      maybeCompleteTarget(db, p.id);
      results.parts.push({ id: p.id, status: 'dead', kind: s.kind });
    } else {
      const wait = Math.max(backoffMs(p.attempt || 0), s.retryAfterMs || 0);
      setPartStatus(db, p.id, 'pending', { fencingToken: token, error: `${s.kind}: ${s.stderr.slice(0, 200)}`, nextAttemptAt: new Date(Date.now() + wait).toISOString() });
      results.parts.push({ id: p.id, status: 'retry', kind: s.kind });
    }
  }
  db.close();
  return results;
}

const mode = process.argv[2] || 'once';
if (import.meta.url === `file://${process.argv[1]}`) {
  const bindings = loadBindingsConfig(`${BRIDGE_HOME}/config/bindings.json`);
  if (mode === 'loop') {
    const tick = async () => {
      try {
        await dispatchOnce({ dbPath: `${BRIDGE_HOME}/state/pi.sqlite3`, bindings });
      } catch (e) { console.error(`[dispatch] ${e.message}`); }
      setTimeout(tick, 2000).unref?.();
    };
    tick();
    // keep alive
    setInterval(() => {}, 60000);
  } else {
    dispatchOnce({ dbPath: `${BRIDGE_HOME}/state/pi.sqlite3`, bindings })
      .then((r) => { console.log(JSON.stringify(r, null, 2)); })
      .catch((e) => { console.error(e.message); process.exit(1); });
  }
}
