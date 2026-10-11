// db.mjs - SQLite persistence for the bridge (Phase 1).
// Schema follows TECH_PLAN.md v3.1 §4.2 (field semantics must not be reduced).
// Uses node:sqlite (Node >= 22), WAL mode. One DB per binding:
//   state/muse.sqlite3  (muse side bookkeeping; inbound queue lives in wx-bot's inbox.db)
//   state/pi.sqlite3    (pi side: inbox events, batches, outbox)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadDbKey, encryptText, decryptText, isEncrypted } from './crypto.mjs';

const dbKeys = new WeakMap();
function dbKey(db) {
  const key = dbKeys.get(db);
  if (!key) throw new Error('database encryption key unavailable');
  return key;
}

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS binding_identities (
  binding TEXT PRIMARY KEY,
  authorized_principal TEXT NOT NULL,
  chat_kind TEXT NOT NULL CHECK (chat_kind IN ('self_chat', 'authorized_dm')),
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('wechat', 'app', 'telegram')),
  state_ref TEXT NOT NULL,
  socket_ref TEXT NOT NULL,
  config_version TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(chat_kind, conversation_id, sender_id, recipient_id, channel)
);

CREATE TABLE IF NOT EXISTS inbox_events (
  id INTEGER PRIMARY KEY,
  binding TEXT NOT NULL,
  upstream_event_id TEXT,
  message_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  chat_kind TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  media_file_id TEXT,
  media_files_json TEXT,
  received_at TEXT NOT NULL,
  upstream_seq INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  batch_id INTEGER,
  lease_owner TEXT,
  lease_until TEXT,
  fencing_token TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(binding, message_id),
  FOREIGN KEY(binding) REFERENCES binding_identities(binding),
  FOREIGN KEY(batch_id) REFERENCES batches(id)
);
CREATE INDEX IF NOT EXISTS inbox_due_idx ON inbox_events(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS inbox_identity_idx ON inbox_events(binding, conversation_id, sender_id, recipient_id, received_at);

CREATE TABLE IF NOT EXISTS inbox_conflicts (
  id INTEGER PRIMARY KEY,
  binding TEXT NOT NULL,
  message_id TEXT NOT NULL,
  existing_inbox_id INTEGER NOT NULL,
  conflicting_payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  details_json TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  FOREIGN KEY(existing_inbox_id) REFERENCES inbox_events(id)
);
CREATE INDEX IF NOT EXISTS inbox_conflicts_open_idx ON inbox_conflicts(binding, message_id, resolved_at);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY,
  batch_key TEXT NOT NULL UNIQUE,
  binding TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  authorized_principal TEXT NOT NULL,
  first_received_at TEXT NOT NULL,
  debounce_deadline TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_owner TEXT,
  lease_until TEXT,
  fencing_token TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  next_run_at TEXT NOT NULL,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(binding) REFERENCES binding_identities(binding)
);
CREATE INDEX IF NOT EXISTS batches_due_idx ON batches(status, next_run_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS batches_binding_fifo_idx ON batches(binding, conversation_id, first_received_at);

CREATE TABLE IF NOT EXISTS batch_messages (
  batch_id INTEGER NOT NULL,
  inbox_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(batch_id, inbox_id),
  UNIQUE(batch_id, ordinal),
  UNIQUE(inbox_id),
  FOREIGN KEY(batch_id) REFERENCES batches(id),
  FOREIGN KEY(inbox_id) REFERENCES inbox_events(id)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued',
  worker_id TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  fencing_token TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  next_run_at TEXT NOT NULL,
  last_error TEXT,
  result_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id),
  FOREIGN KEY(batch_id) REFERENCES batches(id)
);

CREATE TABLE IF NOT EXISTS delivery_targets (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  authorized_principal TEXT NOT NULL,
  channel TEXT NOT NULL,
  binding TEXT,
  conversation_id TEXT,
  recipient_id TEXT,
  app_session_id TEXT,
  context_version TEXT,
  target_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_owner TEXT,
  lease_until TEXT,
  fencing_token TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS delivery_parts (
  id INTEGER PRIMARY KEY,
  target_id INTEGER NOT NULL,
  part_no INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  part_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  remote_idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_owner TEXT,
  lease_until TEXT,
  fencing_token TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  sent_at TEXT,
  UNIQUE(target_id, part_no),
  FOREIGN KEY(target_id) REFERENCES delivery_targets(id)
);
CREATE INDEX IF NOT EXISTS delivery_parts_due_idx ON delivery_parts(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS delivery_parts_target_idx ON delivery_parts(target_id, part_no);

CREATE TABLE IF NOT EXISTS durable_wakes (
  id INTEGER PRIMARY KEY,
  binding TEXT NOT NULL,
  wake_key TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  next_run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  lease_owner TEXT,
  lease_until TEXT,
  fencing_token TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(binding) REFERENCES binding_identities(binding)
);
CREATE INDEX IF NOT EXISTS wakes_due_idx ON durable_wakes(status, next_run_at, next_attempt_at);

CREATE TABLE IF NOT EXISTS outbox_events (
  id INTEGER PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  request_id TEXT,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded',
  UNIQUE(event_type, event_key)
);
CREATE INDEX IF NOT EXISTS outbox_events_request_idx ON outbox_events(request_id, created_at);

CREATE TABLE IF NOT EXISTS poll_state (
  binding TEXT PRIMARY KEY,
  last_update_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dead_letters (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  request_id TEXT,
  reason TEXT NOT NULL,
  payload_hash TEXT,
  attempts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  request_id TEXT,
  principal TEXT,
  binding TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_request_idx ON audit_events(request_id, created_at);
`;

export function nowIso() {
  return new Date().toISOString();
}

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const key = loadDbKey({
    keyFile: process.env.WB_DB_KEY_FILE || `${dirname(dbPath)}/.db-key`,
    bridgeHome: process.env.WB_HOME,
  });
  const db = new DatabaseSync(dbPath);
  dbKeys.set(db, key);
  try { chmodSync(dbPath, 0o600); } catch { /* ignore */ }
  db.exec(SCHEMA);
  // Migration: add media_files_json to existing inbox_events tables
  try {
    const cols = db.prepare("PRAGMA table_info(inbox_events)").all().map(c => c.name);
    if (!cols.includes('media_files_json')) {
      db.exec("ALTER TABLE inbox_events ADD COLUMN media_files_json TEXT");
    }
  } catch { /* ignore */ }
  // Migrate old plaintext bodies before the handle is returned. A failure is
  // fatal: silently continuing would leave privacy-sensitive rows in plaintext.
  for (const table of ['inbox_events', 'delivery_parts']) {
    const rows = db.prepare(`SELECT rowid AS rowid, text FROM ${table} WHERE text IS NOT NULL AND text NOT LIKE 'enc:v1:%'`).all();
    for (const row of rows) {
      db.prepare(`UPDATE ${table} SET text = ? WHERE rowid = ?`).run(encryptText(row.text, key), row.rowid);
    }
  }
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort; rows are already encrypted */ }
  return db;
}

/** Insert an inbox event. Returns { inserted: bool, id, conflict: bool }.
 *  Dedup key: (binding, message_id). Same hash -> idempotent no-op.
 *  Different hash -> recorded in inbox_conflicts, never a second executable event. */
export function insertInboxEvent(db, evt) {
  const now = nowIso();
  const existing = db.prepare(
    'SELECT id, payload_hash FROM inbox_events WHERE binding = ? AND message_id = ?'
  ).get(evt.binding, evt.message_id);
  if (existing) {
    if (existing.payload_hash === evt.payload_hash) {
      return { inserted: false, id: existing.id, conflict: false, duplicate: true };
    }
    db.prepare(`INSERT INTO inbox_conflicts
      (binding, message_id, existing_inbox_id, conflicting_payload_hash, received_at, details_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(evt.binding, evt.message_id, existing.id, evt.payload_hash, now,
        JSON.stringify({ upstream_event_id: evt.upstream_event_id }));
    audit(db, { binding: evt.binding, event_type: 'inbox.conflict',
      entity_type: 'inbox_events', entity_id: existing.id,
      details: { message_id: evt.message_id } });
    return { inserted: false, id: existing.id, conflict: true, duplicate: false };
  }
  const r = db.prepare(`INSERT INTO inbox_events
    (binding, upstream_event_id, message_id, payload_hash, conversation_id,
     sender_id, recipient_id, chat_kind, kind, text, media_file_id, media_files_json,
     received_at, upstream_seq, status, next_attempt_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
    .run(evt.binding, evt.upstream_event_id, evt.message_id, evt.payload_hash,
      evt.conversation_id, evt.sender_id, evt.recipient_id, evt.chat_kind,
      evt.kind, encryptText(evt.text || '', dbKey(db)), evt.media_file_id || null,
      JSON.stringify(evt.media_files || []), now, evt.upstream_seq ?? null,
      now, now);
  return { inserted: true, id: Number(r.lastInsertRowid), conflict: false, duplicate: false };
}

/** Find an open batch for (binding, conversation) or create one.
 *  Debounce window: first_received_at + debounceMs. */
export function getOrCreateBatch(db, { binding, conversationId, principal, debounceMs, now }) {
  const open = db.prepare(`SELECT * FROM batches WHERE binding = ? AND conversation_id = ?
    AND status = 'pending' AND debounce_deadline > ? ORDER BY id DESC LIMIT 1`)
    .get(binding, conversationId, now);
  if (open) return open;
  const deadline = new Date(new Date(now).getTime() + debounceMs).toISOString();
  const batchKey = `${binding}:${conversationId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const r = db.prepare(`INSERT INTO batches
    (batch_key, binding, conversation_id, authorized_principal, first_received_at,
     debounce_deadline, created_at, status, next_attempt_at, next_run_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
    .run(batchKey, binding, conversationId, principal, now, deadline, now, deadline, deadline, now);
  return db.prepare('SELECT * FROM batches WHERE id = ?').get(Number(r.lastInsertRowid));
}

export function attachToBatch(db, batchId, inboxId) {
  const n = db.prepare('SELECT COUNT(*) AS c FROM batch_messages WHERE batch_id = ?').get(batchId).c;
  db.prepare('INSERT INTO batch_messages (batch_id, inbox_id, ordinal) VALUES (?, ?, ?)')
    .run(batchId, inboxId, n);
  db.prepare("UPDATE inbox_events SET status = 'batched', batch_id = ?, updated_at = ? WHERE id = ?")
    .run(batchId, nowIso(), inboxId);
}

/** Batches whose debounce window has passed and are due for processing. */
export function dueBatches(db, now) {
  return db.prepare(`SELECT * FROM batches WHERE status = 'pending'
    AND debounce_deadline <= ? AND next_run_at <= ? ORDER BY first_received_at ASC`).all(now, now);
}

/** Claim a batch with lease+fencing (compare-and-set). Returns row or null. */
export function claimBatch(db, batchId, owner, leaseMs, fencingToken, now) {
  const until = new Date(new Date(now).getTime() + leaseMs).toISOString();
  const r = db.prepare(`UPDATE batches SET status = 'processing', lease_owner = ?,
    lease_until = ?, fencing_token = ?, attempt = attempt + 1, updated_at = ?
    WHERE id = ? AND status = 'pending'`)
    .run(owner, until, fencingToken, now, batchId);
  if (r.changes === 0) return null;
  return db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
}

export function batchTexts(db, batchId) {
  return db.prepare(`SELECT e.text, e.message_id, e.received_at, e.kind, e.media_file_id, e.media_files_json
    FROM batch_messages m JOIN inbox_events e ON e.id = m.inbox_id
    WHERE m.batch_id = ? ORDER BY m.ordinal ASC`).all(batchId).map(r => ({
      ...r,
      text: decryptText(r.text, dbKey(db)),
      media_files: (() => { try { return JSON.parse(r.media_files_json || '[]'); } catch { return []; } })(),
    }));
}

export function setBatchStatus(db, batchId, status, { fencingToken = null, error = null, nextAttemptAt = null } = {}) {
  const now = nowIso();
  let sql = 'UPDATE batches SET status = ?, updated_at = ?';
  const args = [status, now];
  if (error !== null) { sql += ', last_error = ?'; args.push(error); }
  if (nextAttemptAt !== null) { sql += ', next_attempt_at = ?'; args.push(nextAttemptAt); }
  sql += ' WHERE id = ?';
  args.push(batchId);
  if (fencingToken) { sql += ' AND fencing_token = ?'; args.push(fencingToken); }
  db.prepare(sql).run(...args);
}

/** Create delivery parts for a batch's reply text. Returns part rows.
 *  `channel` selects the outbound sender ('wechat' default, 'telegram'). */
export function createDeliveryParts(db, { batchId, principal, binding, conversationId, recipientId, text, maxPartLen, channel = 'wechat' }) {
  const now = nowIso();
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  const runKey = `run:${batch.batch_key}`;
  let run = db.prepare('SELECT * FROM runs WHERE request_id = ?').get(runKey);
  if (!run) {
    const r = db.prepare(`INSERT INTO runs (batch_id, mode, request_id, status, next_attempt_at, next_run_at, created_at, updated_at)
      VALUES (?, 'pi_short', ?, 'completed', ?, ?, ?, ?)`)
      .run(batchId, runKey, now, now, now, now);
    run = db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(r.lastInsertRowid));
  }
  const targetKey = `t:${runKey}:${channel}`;
  let target = db.prepare('SELECT * FROM delivery_targets WHERE target_key = ?').get(targetKey);
  if (!target) {
    const r = db.prepare(`INSERT INTO delivery_targets
      (run_id, authorized_principal, channel, binding, conversation_id, recipient_id,
       target_key, status, next_attempt_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(run.id, principal, channel, binding, conversationId, recipientId, targetKey, now, now);
    target = db.prepare('SELECT * FROM delivery_targets WHERE id = ?').get(Number(r.lastInsertRowid));
  }
  const parts = splitText(text, maxPartLen);
  const rows = [];
  parts.forEach((p, i) => {
    const hash = partHash(p);
    const existing = db.prepare('SELECT * FROM delivery_parts WHERE target_id = ? AND part_no = ?')
      .get(target.id, i + 1);
    if (existing) { rows.push(existing); return; }
    const r = db.prepare(`INSERT INTO delivery_parts
      (target_id, part_no, part_count, part_hash, text, remote_idempotency_key, status, next_attempt_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(target.id, i + 1, parts.length, hash, encryptText(p, dbKey(db)), `${targetKey}:p${i + 1}`, now, now);
    rows.push(db.prepare('SELECT * FROM delivery_parts WHERE id = ?').get(Number(r.lastInsertRowid)));
  });
  return rows;
}

export function dueDeliveryParts(db, now, limit = 10) {
  return db.prepare(`SELECT p.*, t.binding, t.recipient_id, t.conversation_id, t.channel
    FROM delivery_parts p JOIN delivery_targets t ON t.id = p.target_id
    WHERE p.status = 'pending' AND p.next_attempt_at <= ?
    ORDER BY p.target_id ASC, p.part_no ASC LIMIT ?`).all(now, limit)
    .map((row) => ({ ...row, text: decryptText(row.text, dbKey(db)) }));
}

/** Telegram getUpdates offset persistence (per binding). Dedup by
 *  (binding, message_id) makes offset loss safe (re-fetch is idempotent). */
export function getPollOffset(db, binding) {
  const r = db.prepare('SELECT last_update_id FROM poll_state WHERE binding = ?').get(binding);
  return r ? r.last_update_id : 0;
}

export function setPollOffset(db, binding, updateId) {
  db.prepare(`INSERT INTO poll_state (binding, last_update_id, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(binding) DO UPDATE SET last_update_id = excluded.last_update_id, updated_at = excluded.updated_at`)
    .run(binding, updateId, nowIso());
}

export function setPartStatus(db, partId, status, { fencingToken = null, error = null, nextAttemptAt = null } = {}) {
  const now = nowIso();
  let sql = 'UPDATE delivery_parts SET status = ?, updated_at = ?';
  const args = [status, now];
  if (error !== null) { sql += ', last_error = ?'; args.push(error); }
  if (nextAttemptAt !== null) { sql += ', next_attempt_at = ?'; args.push(nextAttemptAt); }
  if (status === 'sent') { sql += ', sent_at = ?'; args.push(now); }
  sql += ' WHERE id = ?';
  args.push(partId);
  if (fencingToken) { sql += ' AND fencing_token = ?'; args.push(fencingToken); }
  db.prepare(sql).run(...args);
}

/** Mark a part's delivery target done when none of its parts are still open. */
export function maybeCompleteTarget(db, partId) {
  const p = db.prepare('SELECT target_id FROM delivery_parts WHERE id = ?').get(partId);
  if (!p) return;
  const open = db.prepare(`SELECT COUNT(*) c FROM delivery_parts
    WHERE target_id = ? AND status IN ('pending','sending')`).get(p.target_id).c;
  if (open === 0) {
    db.prepare(`UPDATE delivery_targets SET status = 'done', updated_at = ? WHERE id = ?`)
      .run(nowIso(), p.target_id);
  }
}

/** Delete records older than `days` from growth tables. Deletes are batched
 *  (500 rows via id subqueries; SQLite DELETE has no LIMIT). Child tables are
 *  pruned before parents to respect FK constraints. Returns { table: count }.
 *  Safe to run hourly; no-ops when nothing is old. */
export function pruneOldRecords(db, days = 7) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const out = {};
  const del = (table, where, ...args) => {
    let total = 0;
    for (;;) {
      const r = db.prepare(
        `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${where} ORDER BY id ASC LIMIT 500)`
      ).run(...args);
      total += r.changes;
      if (r.changes < 500) break;
    }
    out[table] = total;
  };
  // 1. leaf / diagnostic tables (no FK children)
  del('audit_events', 'created_at < ?', cutoff);
  del('inbox_conflicts', 'received_at < ?', cutoff);
  del('delivery_parts', "status = 'sent' AND updated_at < ?", cutoff);
  del('outbox_events', 'created_at < ?', cutoff);
  // 2. cascade for old done batches (children first)
  const batchIds = db.prepare(
    `SELECT id FROM batches WHERE status = 'done' AND updated_at < ? ORDER BY id ASC LIMIT 500`
  ).all(cutoff).map((r) => r.id);
  if (batchIds.length > 0) {
    const ph = batchIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM delivery_parts WHERE target_id IN (
      SELECT t.id FROM delivery_targets t JOIN runs r ON r.id = t.run_id
      WHERE r.batch_id IN (${ph}))`).run(...batchIds);
    db.prepare(`DELETE FROM delivery_targets WHERE run_id IN (
      SELECT id FROM runs WHERE batch_id IN (${ph}))`).run(...batchIds);
    db.prepare(`DELETE FROM runs WHERE batch_id IN (${ph})`).run(...batchIds);
    db.prepare(`DELETE FROM batch_messages WHERE batch_id IN (${ph})`).run(...batchIds);
    // inbox events of pruned batches (all statuses; batch done => fully processed).
    // inbox_conflicts referencing them were pruned in step 1 (same age cutoff);
    // keep the NOT EXISTS guard for the rare new-conflict-on-old-event case.
    const ie = db.prepare(`DELETE FROM inbox_events WHERE batch_id IN (${ph})
      AND NOT EXISTS (SELECT 1 FROM inbox_conflicts c WHERE c.existing_inbox_id = inbox_events.id)`).run(...batchIds);
    out.inbox_events_batched = ie.changes;
    const b = db.prepare(`DELETE FROM batches WHERE id IN (${ph})`).run(...batchIds);
    out.batches = b.changes;
  } else {
    out.batches = 0;
    out.inbox_events_batched = 0;
  }
  // 3. standalone done inbox events (muse side: pulled+acked, never batched).
  // Skip any still referenced by a surviving conflict row.
  del('inbox_events',
    `status = 'done' AND batch_id IS NULL AND updated_at < ?
     AND NOT EXISTS (SELECT 1 FROM inbox_conflicts c WHERE c.existing_inbox_id = inbox_events.id)`,
    cutoff);
  return out;
}

export function audit(db, { requestId = null, principal = null, binding = null, eventType = null, event_type = null, entityType = null, entity_type = null, entityId = null, entity_id = null, details = {} }) {
  const eid = `ae_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const et = eventType ?? event_type;
  const entT = entityType ?? entity_type;
  const entI = entityId ?? entity_id;
  if (!et) throw new Error('audit() requires eventType');
  db.prepare(`INSERT INTO audit_events (event_id, request_id, principal, binding, event_type, entity_type, entity_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eid, requestId, principal, binding, et, entT, entI, JSON.stringify(details), nowIso());
}

function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + '\n' + line).length > maxLen && cur) { parts.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : [text];
}

function partHash(s) {
  let h1 = 0x811c9dc5, h2 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 ^ s.charCodeAt(i + 1 < s.length ? i + 1 : 0), 16777619);
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}

export function payloadHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}
