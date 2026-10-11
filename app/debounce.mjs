// debounce.mjs - per-binding debounce window policy (Phase 1).
// Rule: first message opens a batch; messages arriving within debounceMs join it;
// once debounce_deadline passes, the batch is sealed and dispatched exactly once.
import { getOrCreateBatch, attachToBatch, batchTexts } from './db.mjs';

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
