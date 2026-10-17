// telegram-poll.mjs - per-bot long-poll for the Telegram channel.
//
// Two usage modes:
//   1. Standalone CLI:  node app/telegram-poll.mjs --bot muse|pi [--once]
//      --bot muse : polls bot A -> state/telegram-muse.sqlite3 (agent pulls later)
//      --bot pi   : polls bot B -> state/telegram-pi.sqlite3 (debounce + dispatch)
//      --once    : process currently-available updates once, then exit (tests)
//   2. Embedded (single-process bridge): import { boot, runPollLoop, createShutdown }
//      from './telegram-poll.mjs' and run both bots' loops in one Node runtime.
//      Error isolation: one bot's transport error backs off only that bot's loop.
//
// Identity: Telegram DM only (chat.type === 'private'); sender must be in
// allowed_user_ids (fail-closed). Dedup by (binding, message_id); update
// offset persisted in poll_state (loss is safe: re-fetch is idempotent).
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { TelegramApi, TelegramError, extractTelegramMessage } from './telegram.mjs';
import { transcribeVoice } from './telegram-transcribe.mjs';
import { openDb, insertInboxEvent, getPollOffset, setPollOffset, audit, nowIso, payloadHash } from './db.mjs';
import { addToBatch } from './debounce.mjs';

const BRIDGE_HOME = process.env.WB_HOME || '/home/hatch/workspace/wechat-bridge';
const TG_CONFIG_PATH = process.env.WB_TG_CONFIG || `${BRIDGE_HOME}/config/telegram.json`;

export const BOTS = {
  muse: { binding: 'telegram-muse', dbFile: 'state/telegram-muse.sqlite3', tokenKey: 'muse_bot_token', debounce: false },
  pi:   { binding: 'telegram-pi',   dbFile: 'state/telegram-pi.sqlite3',   tokenKey: 'pi_bot_token',   debounce: true },
};

export function loadTelegramConfig(path = TG_CONFIG_PATH) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`cannot read ${path}: ${e.message}`); }
  const tg = raw.telegram || {};
  for (const k of ['muse_bot_token', 'pi_bot_token']) {
    if (!tg[k] || String(tg[k]).startsWith('__REPLACE')) {
      throw new Error(`config/telegram.json: telegram.${k} not configured (refusing to start)`);
    }
  }
  return tg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shared shutdown flag for the single-process bridge. */
export function createShutdown() {
  return { stopped: false };
}

/** Build the per-bot runtime context (config + DB + API). Throws on bad config. */
export function boot(botName, { bridgeHome = BRIDGE_HOME, tgConfigPath = TG_CONFIG_PATH } = {}) {
  const bot = BOTS[botName];
  if (!bot) throw new Error(`unknown bot: ${botName}`);
  const tg = loadTelegramConfig(tgConfigPath);
  const dbPath = `${bridgeHome}/${bot.dbFile}`;
  const db = openDb(dbPath);
  // Seed identity row (idempotent). channel='telegram' per v3.1 schema.
  const now = nowIso();
  db.prepare(`INSERT OR IGNORE INTO binding_identities
    (binding, authorized_principal, chat_kind, conversation_id, sender_id, recipient_id,
     channel, state_ref, socket_ref, config_version, config_hash, enabled, created_at, updated_at)
    VALUES (?, 'sean', 'self_chat', 'tg-dm', 'tg-allowlist', 'tg-dm',
            'telegram', ?, 'n/a', 'v3.1', 'seed', 1, ?, ?)`)
    .run(bot.binding, `state/${bot.binding}.sqlite3`, now, now);
  const api = new TelegramApi({ token: tg[bot.tokenKey], apiBase: tg.api_base });
  return {
    botName, bot, tg, db, api,
    allowedUsers: new Set((tg.allowed_user_ids || []).map(String)),
    debounceMs: tg.debounce_ms || 2500,
    pollTimeout: tg.poll_timeout_secs || 30,
  };
}

export async function handleUpdate(ctx, u) {
  const { bot, db, allowedUsers, debounceMs, api } = ctx;
  const m = extractTelegramMessage(u);
  if (!m) return 'ignored-empty';
  // Download media if present -> save to media dir, store local paths
  const mediaFiles = [];
  let mediaPath = null;
  if (api) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const mediaDir = `${process.env.WB_HOME || '/home/hatch/workspace/wechat-bridge'}/state/telegram-media`;
    const dl = async (fileId, ext, label) => {
      try {
        mkdirSync(mediaDir, { recursive: true });
        const buf = await api.downloadFile(fileId);
        const p = `${mediaDir}/tg-${m.message_id}.${ext}`;
        writeFileSync(p, buf);
        mediaFiles.push(p);
        if (!mediaPath) mediaPath = p;
      } catch (e) {
        console.error(`[tg-poll:${bot.binding}] ${label} download failed: ${e.message}`);
      }
    };
    if (m.photo_file_id) await dl(m.photo_file_id, 'jpg', 'photo');
    // Documents: download too (bot API getFile caps at 20MB). Pi receives the
    // file via @file; without this it only ever saw the '[文件]' placeholder.
    if (m.document_file_id) {
      const MAX_DOC_BYTES = 20 * 1024 * 1024;
      if (m.document_file_size && m.document_file_size > MAX_DOC_BYTES) {
        console.error(`[tg-poll:${bot.binding}] document too large, skipped: ${m.document_file_name || '?'} (${m.document_file_size} bytes)`);
      } else {
        const rawName = typeof m.document_file_name === 'string' ? m.document_file_name : '';
        const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'file';
        const extMatch = safeName.match(/\.([a-zA-Z0-9]{1,10})$/);
        const ext = extMatch ? extMatch[1].toLowerCase() : 'bin';
        try {
          mkdirSync(mediaDir, { recursive: true });
          const buf = await api.downloadFile(m.document_file_id);
          const p = `${mediaDir}/tg-${m.message_id}-${safeName}`;
          writeFileSync(p, buf);
          mediaFiles.push(p);
          if (!mediaPath) mediaPath = p;
        } catch (e) {
          console.error(`[tg-poll:${bot.binding}] document download failed: ${e.message}`);
        }
      }
    }
  }
  if (m.chat_type !== 'private') {
    audit(db, { binding: bot.binding, eventType: 'tg.non_private_ignored', details: { update_id: u.update_id, chat_type: m.chat_type } });
    return 'ignored-non-private';
  }
  if (!m.sender_id || !allowedUsers.has(m.sender_id)) {
    audit(db, { binding: bot.binding, eventType: 'tg.identity_rejected', details: { update_id: u.update_id, sender_id: m.sender_id || '?' } });
    return 'rejected-identity';
  }
  // Voice: download + local transcription (after identity checks, before
  // enqueue). Any failure degrades to the placeholder text; never throws,
  // so the poll offset semantics stay safe.
  let voiceText = null;
  if (api && m.voice_file_id) {
    const mediaDir = `${process.env.WB_HOME || '/home/hatch/workspace/wechat-bridge'}/state/telegram-media`;
    const voicePath = `${mediaDir}/tg-voice-${m.message_id}.ogg`;
    const sidecar = `${voicePath}.txt`;
    try {
      if (existsSync(sidecar)) {
        voiceText = readFileSync(sidecar, 'utf8').trim() || null;
      } else {
        if (!existsSync(voicePath)) {
          const { mkdirSync } = await import('node:fs');
          mkdirSync(mediaDir, { recursive: true });
          writeFileSync(voicePath, await api.downloadFile(m.voice_file_id));
        }
        if (m.voice_duration && m.voice_duration > 120) {
          audit(db, { binding: bot.binding, eventType: 'tg.voice_too_long', details: { update_id: u.update_id, duration: m.voice_duration } });
        } else {
          const r = await transcribeVoice(voicePath);
          if (r.ok) {
            voiceText = r.text;
            try { writeFileSync(sidecar, r.text); } catch {}
            audit(db, { binding: bot.binding, eventType: 'tg.voice_transcribed', details: { update_id: u.update_id, chars: r.text.length } });
          } else {
            audit(db, { binding: bot.binding, eventType: 'tg.voice_transcribe_failed', details: { update_id: u.update_id, reason: r.reason } });
          }
        }
      }
    } catch (e) {
      console.error(`[tg-poll:${bot.binding}] voice handling failed: ${e.message}`);
      audit(db, { binding: bot.binding, eventType: 'tg.voice_transcribe_failed', details: { update_id: u.update_id, reason: String(e.message).slice(0, 120) } });
    }
  }
  const text = voiceText ? `[语音转写]${voiceText}` : (m.media_placeholder || m.text);
  const kind = voiceText ? 'transcript' : m.kind;
  const payload_hash = payloadHash(JSON.stringify([`tg:${u.update_id}`, m.message_id, text]));

  const ins = insertInboxEvent(db, {
    binding: bot.binding,
    upstream_event_id: `tg:${u.update_id}`,
    message_id: m.message_id,
    payload_hash,
    conversation_id: m.conversation_id,
    sender_id: m.sender_id,
    recipient_id: m.recipient_id,
    chat_kind: 'self_chat',
    kind,
    text,
    media_file_id: mediaPath,
    media_files: mediaFiles,
    upstream_seq: u.update_id,
  });
  if (ins.conflict) return 'conflict-recorded';
  if (ins.duplicate) return 'duplicate';
  if (bot.debounce) {
    addToBatch(db, {
      binding: bot.binding,
      conversation_id: m.conversation_id,
      authorized_principal: 'sean',
      text,
      inbox_id: ins.id,
    }, { debounceMs });
    const deadline = new Date(Date.now() + debounceMs).toISOString();
    const now = nowIso();
    db.prepare(`INSERT OR IGNORE INTO durable_wakes (binding, wake_key, reason, next_run_at, status, next_attempt_at, updated_at)
      VALUES (?, ?, 'batch_due', ?, 'queued', ?, ?)`)
      .run(bot.binding, `batch:${ins.id}`, deadline, deadline, now);
  }
  audit(db, { binding: bot.binding, eventType: 'tg.enqueued', entityType: 'inbox_events', entityId: ins.id, details: { update_id: u.update_id } });
  return 'enqueued';
}

export async function pollOnce(ctx) {
  const { bot, db, api, pollTimeout, botName } = ctx;
  const offset = getPollOffset(db, bot.binding);
  const updates = await api.getUpdates(offset, pollTimeout);
  let maxId = offset;
  const counts = {};
  for (const u of updates || []) {
    if (typeof u.update_id === 'number') maxId = Math.max(maxId, u.update_id + 1);
    let outcome;
    try { outcome = await handleUpdate(ctx, u); }
    catch (e) {
      console.error(`[tg-poll:${botName}] handle update ${u.update_id}: ${e.message}`);
      outcome = 'error';
    }
    counts[outcome] = (counts[outcome] || 0) + 1;
  }
  if (maxId !== offset) setPollOffset(db, bot.binding, maxId);
  return counts;
}

/** Long-poll loop for one bot. Transport errors back off only this bot's
 *  loop; a 401 (bad token) stops this loop via onFatal (default: just stop,
 *  keeping a merged process alive). Never throws for poll errors. */
export async function runPollLoop(ctx, shutdown, { onFatal } = {}) {
  const name = ctx.botName;
  console.log(`[tg-poll:${name}] polling -> ${ctx.bot.dbFile}`);
  let backoffMs = 1000;
  while (!shutdown.stopped) {
    try {
      await pollOnce(ctx);
      backoffMs = 1000;
    } catch (e) {
      if (e instanceof TelegramError && e.telegram.status === 401) {
        console.error(`[tg-poll:${name}] FATAL: 401 bad bot token; fix config/telegram.json`);
        if (onFatal) onFatal(name, e);
        return;
      }
      if (e instanceof TelegramError && e.telegram.status === 409) {
        console.error(`[tg-poll:${name}] 409 conflict (another poller running?) - backing off`);
      } else {
        console.error(`[tg-poll:${name}] poll error: ${e.message}`);
      }
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60000);
    }
  }
  console.log(`[tg-poll:${name}] stopped`);
}

// ---- standalone CLI: node app/telegram-poll.mjs --bot muse|pi [--once] ----
function usage() {
  console.error('usage: node app/telegram-poll.mjs --bot muse|pi [--once]');
  process.exit(2);
}

const isMain = typeof process.argv[1] === 'string' && process.argv[1].endsWith('telegram-poll.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  const botArg = argv[argv.indexOf('--bot') + 1];
  const once = argv.includes('--once');
  if (!BOTS[botArg]) usage();
  const shutdown = createShutdown();
  process.on('SIGTERM', () => { shutdown.stopped = true; });
  process.on('SIGINT', () => { shutdown.stopped = true; });
  (async () => {
    const ctx = boot(botArg);
    if (once) {
      const counts = await pollOnce(ctx);
      console.log(JSON.stringify({ bot: botArg, ...counts }));
      ctx.db.close();
      return;
    }
    await runPollLoop(ctx, shutdown, { onFatal: () => process.exit(1) });
    ctx.db.close();
    console.log(`[tg-poll:${botArg}] stopped`);
  })().catch((e) => {
    console.error(`[tg-poll:${botArg}] fatal: ${e.message}`);
    process.exit(1);
  });
}
