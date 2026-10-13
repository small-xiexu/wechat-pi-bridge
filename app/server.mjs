// server.mjs - webhook receiver for the Pi binding (delivery: webhook).
// Listens ONLY on 127.0.0.1. wx-bot POSTs wxbot.event.v1 JSON here.
// Flow: Bearer check -> optional HMAC -> schema validate -> identity allowlist
// -> dedup insert -> debounce batch -> durable wake record -> 2xx.
// The Muse binding uses pull mode and never touches this server.
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { openDb, insertInboxEvent, audit, nowIso, payloadHash } from './db.mjs';
import { loadBindingsConfig, checkBearer, checkSignature, checkIdentity, AuthError } from './auth.mjs';
import { normalizeEvent, SchemaError } from './normalize.mjs';
import { addToBatch, sweepQueuedOrphans } from './debounce.mjs';
import { readAuthState } from './wx-auth-state.mjs';

const BRIDGE_HOME = process.env.WB_HOME || '/home/hatch/workspace/wechat-bridge';
const BINDINGS_PATH = `${BRIDGE_HOME}/config/bindings.json`;
const DB_PATH = `${BRIDGE_HOME}/state/pi.sqlite3`;

const bindings = loadBindingsConfig(BINDINGS_PATH);
const piCfg = bindings.bindings?.pi || {};
const BODY_LIMIT = bindings.webhook_body_limit_bytes || 1_048_576;
const DEBOUNCE_MS = bindings.debounce_ms || 2500;

const db = openDb(DB_PATH);
// Seed identity row for pi binding (idempotent).
(function seedIdentity() {
  const now = nowIso();
  db.prepare(`INSERT OR IGNORE INTO binding_identities
    (binding, authorized_principal, chat_kind, conversation_id, sender_id, recipient_id,
     channel, state_ref, socket_ref, config_version, config_hash, enabled, created_at, updated_at)
    VALUES ('pi', ?, 'self_chat', ?, ?, ?, 'wechat', 'state/wx-pi', 'n/a', 'v3.1', 'seed', 1, ?, ?)`)
    .run(piCfg.authorized_principal || 'sean',
      piCfg.conversation_id || 'UNCONFIGURED', piCfg.sender_id || 'UNCONFIGURED',
      piCfg.recipient_id || 'UNCONFIGURED', now, now);
})();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleWebhook(req, res) {
  let raw;
  try { raw = await readBody(req); }
  catch { res.writeHead(413); res.end('body too large'); return; }

  let evt;
  try {
    checkBearer(bindings, 'pi', req.headers['authorization']);
    checkSignature(piCfg.webhook_secret, raw, req.headers['x-wxbot-signature'], req.headers['x-wxbot-timestamp']);
    const parsed = JSON.parse(raw.toString('utf8'));
    evt = normalizeEvent(parsed);
  } catch (e) {
    const code = (e instanceof AuthError) ? 401 : 422;
    res.writeHead(code); res.end(`rejected: ${e.message}`);
    return;
  }

  // Empty events (no text/voice/media): ack as handled, do not enqueue.
  if (evt.empty) { res.writeHead(200); res.end('empty event ignored'); return; }

  try {
    checkIdentity(piCfg, { ...evt, recipient_id: evt.recipient_id || piCfg.recipient_id });
  } catch (e) {
    audit(db, { binding: 'pi', eventType: 'webhook.identity_rejected', details: { event_id: evt.event_id, reason: e.message } });
    res.writeHead(403); res.end(`identity rejected: ${e.message}`);
    return;
  }

  const hash = payloadHash(JSON.stringify([evt.event_id, evt.text, evt.create_time]));
  const ins = insertInboxEvent(db, {
    binding: 'pi',
    upstream_event_id: evt.event_id,
    message_id: evt.message_id,
    payload_hash: hash,
    conversation_id: piCfg.conversation_id,
    sender_id: piCfg.sender_id,
    recipient_id: piCfg.recipient_id,
    chat_kind: 'self_chat',
    kind: evt.kind,
    text: evt.text,
    media_file_id: evt.media_file_id || null,
    media_files: evt.media_files || [],
    upstream_seq: null,
  });

  if (ins.conflict) {
    // Same message_id, different payload: recorded as conflict, never double-executed.
    res.writeHead(200); res.end('conflict recorded');
    return;
  }
  if (!ins.duplicate) {
    addToBatch(db, {
      binding: 'pi',
      conversation_id: piCfg.conversation_id,
      authorized_principal: piCfg.authorized_principal || 'sean',
      text: evt.text,
      inbox_id: ins.id,
    }, { debounceMs: DEBOUNCE_MS });
    // Durable wake record: dispatcher scans by next_run_at, never relies on memory timers.
    const now = nowIso();
    const deadline = new Date(Date.now() + DEBOUNCE_MS).toISOString();
    db.prepare(`INSERT OR IGNORE INTO durable_wakes (binding, wake_key, reason, next_run_at, status, next_attempt_at, updated_at)
      VALUES ('pi', ?, 'batch_due', ?, 'queued', ?, ?)`)
      .run(`batch:${ins.id}`, deadline, deadline, now);
    audit(db, { binding: 'pi', eventType: 'webhook.enqueued', entityType: 'inbox_events', entityId: ins.id, details: { event_id: evt.event_id } });
  }
  res.writeHead(200); res.end('ok');
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/webhook/pi') {
    // Never let a handler exception kill the process: 500 tells wx-bot to retry.
    handleWebhook(req, res).catch((e) => {
      console.error(`[webhook] unhandled: ${e.message}`);
      try { res.writeHead(500); res.end('internal error, retry later'); } catch {}
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: nowIso() }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/readyz') {
    try {
      db.prepare('SELECT 1').get();
      const pending = db.prepare("SELECT COUNT(*) c FROM batches WHERE status = 'pending'").get().c;
      const auth = readAuthState({ bridgeHome: BRIDGE_HOME });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        pending_batches: pending,
        wechat_auth: {
          status: auth.status,
          reason: auth.reason,
          source: auth.source,
          first_seen_at: auth.first_seen_at,
          last_seen_at: auth.last_seen_at,
          last_valid_at: auth.last_valid_at,
        },
        ts: nowIso(),
      }));
    } catch (e) { res.writeHead(500); res.end('db not ready'); }
    return;
  }
  res.writeHead(404); res.end('not found');
});

const [host, port] = (piCfg.listen || '127.0.0.1:18791').split(':');
if (host !== '127.0.0.1' && host !== 'localhost') {
  console.error('FATAL: refusing to listen on non-loopback address');
  process.exit(1);
}
mkdirSync(`${BRIDGE_HOME}/state`, { recursive: true, mode: 0o700 });
server.listen(Number(port), '127.0.0.1', () => {
  console.log(`[wechat-bridge] pi webhook on 127.0.0.1:${port}`);
});

// In-process dispatcher tick (separate systemd unit runs dispatch.mjs loop in prod;
// the in-process tick keeps single-process dev/test simple).
const TICK_MS = 2000;
const ORPHAN_SWEEP_MS = 30_000;
let lastOrphanSweep = 0;
setInterval(async () => {
  try {
    if (Date.now() - lastOrphanSweep >= ORPHAN_SWEEP_MS) {
      lastOrphanSweep = Date.now();
      try {
        const n = sweepQueuedOrphans(db, { bindings });
        if (n > 0) console.log(`[orphan-sweep] re-batched ${n} queued orphan event(s)`);
      } catch (e) { console.error(`[orphan-sweep] ${e.message}`); }
    }
    const { dispatchOnce } = await import('./dispatch.mjs');
    await dispatchOnce({ dbPath: DB_PATH, bindings });
  } catch (e) { console.error(`[dispatch-tick] ${e.message}`); }
}, TICK_MS).unref();
