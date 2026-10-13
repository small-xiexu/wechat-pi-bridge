// debounce.mjs - per-binding debounce window policy (Phase 1).
// Rule: first message opens a batch; messages arriving within debounceMs join it;
// once debounce_deadline passes, the batch is sealed and dispatched exactly once.
import { getOrCreateBatch, attachToBatch, batchTexts, audit, nowIso, inboxPlainText } from './db.mjs';

export const DEFAULT_DEBOUNCE_MS = 2500;

/** Add an inbox event to the current open batch (or open a new one).
 *  Returns { batch, isNew }. Enforces max messages / max bytes per batch. */
export function addToBatch(db, evt, {
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxMessages = 20,
  maxBytes = 200_000,
  now = new Date().toISOString(),
} = {}) {
  let batch = getOrCreateBatch(db, {
    binding: evt.binding,
    conversationId: evt.conversation_id,
    principal: evt.authorized_principal,
    debounceMs,
    now,
  });
  const members = batchTexts(db, batch.id);
  const isNew = members.length === 0;
  const totalBytes = members.reduce((n, m) => n + (m.text || '').length, 0);
  if (members.length >= maxMessages || totalBytes + evt.text.length > maxBytes) {
    // Seal current batch now and open a fresh one.
    db.prepare("UPDATE batches SET status = 'done', debounce_deadline = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, now, batch.id);
    batch = getOrCreateBatch(db, {
      binding: evt.binding,
      conversationId: evt.conversation_id,
      principal: evt.authorized_principal,
      debounceMs,
      now,
    });
  }
  attachToBatch(db, batch.id, evt.inbox_id);
  return { batch: db.prepare('SELECT * FROM batches WHERE id = ?').get(batch.id), isNew };
}

/** Reap inbox events stuck in 'queued' with no batch: the webhook crashed or
 *  threw between insertInboxEvent and addToBatch (e.g. the 2026-10-12 empty-text
 *  decrypt poison left events 47/49 stranded). Feeds them back through the normal
 *  debounce path. Idempotent: only rows still 'queued' AND batch_id IS NULL older
 *  than graceMs; already-batched rows are never re-attached (UNIQUE(inbox_id) is
 *  the backstop). A per-row failure is recorded on the row and retried next sweep.
 *  Returns the number of events re-batched. */
export function sweepQueuedOrphans(db, {
  bindings = null,
  graceMs = 120_000,
  limit = 50,
  now = nowIso(),
} = {}) {
  const cutoff = new Date(Date.now() - graceMs).toISOString();
  const orphans = db.prepare(
    `SELECT id, binding, conversation_id, message_id, text, received_at
     FROM inbox_events
     WHERE status = 'queued' AND batch_id IS NULL AND received_at < ?
     ORDER BY received_at ASC LIMIT ?`
  ).all(cutoff, limit);
  let swept = 0;
  for (const o of orphans) {
    try {
      const cur = db.prepare(`SELECT status, batch_id FROM inbox_events WHERE id = ?`).get(o.id);
      if (!cur || cur.status !== 'queued' || cur.batch_id !== null) continue; // raced, already handled
      const bCfg = bindings?.bindings?.[o.binding] || {};
      addToBatch(db, {
        binding: o.binding,
        conversation_id: o.conversation_id,
        authorized_principal: bCfg.authorized_principal || 'sean',
        text: inboxPlainText(db, o.text),
        inbox_id: o.id,
      }, { debounceMs: bindings?.debounce_ms || DEFAULT_DEBOUNCE_MS, now });
      db.prepare(`UPDATE inbox_events SET last_error = NULL, updated_at = ? WHERE id = ?`).run(now, o.id);
      audit(db, {
        binding: o.binding, eventType: 'inbox.orphan_swept',
        entityType: 'inbox_events', entityId: o.id,
        details: { message_id: o.message_id },
      });
      swept++;
    } catch (e) {
      db.prepare(`UPDATE inbox_events SET last_error = ?, updated_at = ? WHERE id = ?`)
        .run(String(e?.message || e).slice(0, 200), nowIso(), o.id);
    }
  }
  return swept;
}
