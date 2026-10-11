// telegram-muse-runner.mjs - agent-side helper for the Telegram Muse binding.
// Mirrors bin/muse-batch's pull/count/ack/send contract, but the inbound queue
// lives in the bridge's own state/telegram-muse.sqlite3 (there is no wx-bot
// holding it) and replies go out via the Telegram Bot API.
// CLI: node telegram-muse-runner.mjs pull|pull-json|count|ack <inbox_ids...>|send --to <chat_id> (stdin=text)
import { readFileSync, realpathSync } from 'node:fs';
import { openDb, nowIso } from './db.mjs';
import { TelegramApi } from './telegram.mjs';
import { markdownToPlain } from './normalize.mjs';

const BRIDGE_HOME = process.env.WB_HOME || '/home/hatch/workspace/wechat-bridge';
const TG_CONFIG_PATH = process.env.WB_TG_CONFIG || `${BRIDGE_HOME}/config/telegram.json`;
const DB_PATH = process.env.WB_TG_MUSE_DB || `${BRIDGE_HOME}/state/telegram-muse.sqlite3`;
const BINDING = 'telegram-muse';
const LEASE_MS = 10 * 60 * 1000;

function loadToken() {
  const tg = JSON.parse(readFileSync(TG_CONFIG_PATH, 'utf8')).telegram || {};
  const t = tg.muse_bot_token;
  if (!t || String(t).startsWith('__REPLACE')) throw new Error('telegram.muse_bot_token not configured');
  return { token: t, apiBase: tg.api_base || 'https://api.telegram.org' };
}

/** Number of claimable events (no side effects). */
export function countEvents(dbPath = DB_PATH) {
  const db = openDb(dbPath);
  try {
    return db.prepare(`SELECT COUNT(*) c FROM inbox_events
      WHERE binding = ? AND status = 'queued'`).get(BINDING).c;
  } finally { db.close(); }
}

/** Claim up to `limit` queued events with a lease. Returns rows. */
export function pullEvents({ limit = 20, dbPath = DB_PATH } = {}) {
  const db = openDb(dbPath);
  try {
    const now = nowIso();
    const until = new Date(Date.now() + LEASE_MS).toISOString();
    const ids = db.prepare(`SELECT id FROM inbox_events
      WHERE binding = ? AND status = 'queued' ORDER BY id ASC LIMIT ?`)
      .all(BINDING, limit).map((r) => r.id);
    if (ids.length === 0) return [];
    const owner = `muse-agent-${process.pid}`;
    db.prepare(`UPDATE inbox_events SET status = 'processing', lease_owner = ?,
      lease_until = ?, attempt = attempt + 1, updated_at = ?
      WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'queued'`)
      .run(owner, until, now, ...ids);
    return db.prepare(`SELECT id, message_id, sender_id, conversation_id, recipient_id,
      text, kind, received_at FROM inbox_events WHERE id IN (${ids.map(() => '?').join(',')})
      ORDER BY id ASC`).all(...ids);
  } finally { db.close(); }
}

/** Mark inbox events done. */
export function ackEvents(ids, dbPath = DB_PATH) {
  const db = openDb(dbPath);
  try {
    const now = nowIso();
    const r = db.prepare(`UPDATE inbox_events SET status = 'done', updated_at = ?
      WHERE binding = ? AND id IN (${ids.map(() => '?').join(',')})`)
      .run(now, BINDING, ...ids);
    return r.changes;
  } finally { db.close(); }
}

/** Format pulled events as one agent batch. */
export function formatBatch(events) {
  return events
    .map((e, i) => {
      const body = e.text || '[空事件]';
      return `[Telegram消息 ${i + 1} | chat_id=${e.conversation_id} | inbox_id=${e.id} | msg_id=${e.message_id} | ${e.received_at}]\n${body}`;
    })
    .join('\n');
}

/** Send a reply via the Telegram Bot API. Text is plain-texted first. */
export async function sendReply({ to, text, dbPath = DB_PATH } = {}) {
  const { token, apiBase } = loadToken();
  if (process.env.TG_SEND_MOCK === '1') {
    process.stderr.write(`[mock-tg-send to=${to} len=${text.length}] ${text.slice(0, 80)}\n`);
    return { sent: true, mock: true };
  }
  const api = new TelegramApi({ token, apiBase });
  await api.sendMessage(to, markdownToPlain(text));
  return { sent: true };
}

// realpath comparison: also works when invoked through a symlinked WB_HOME.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1] || '') === new URL(import.meta.url).pathname;
  } catch { return false; }
})();

if (isMain) {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (cmd === 'count') console.log(countEvents());
    else if (cmd === 'pull') console.log(formatBatch(pullEvents()));
    else if (cmd === 'pull-json') console.log(JSON.stringify(pullEvents(), null, 2));
    else if (cmd === 'ack') {
      const ids = rest.map(Number).filter(Number.isFinite);
      if (!ids.length) throw new Error('usage: ack <inbox_ids...>');
      console.log(JSON.stringify({ acked: ackEvents(ids) }));
    } else if (cmd === 'send') {
      const toIdx = rest.indexOf('--to');
      const to = toIdx >= 0 ? rest[toIdx + 1] : null;
      if (!to) throw new Error('usage: send --to <chat_id>  (text via stdin)');
      let text = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { text += d; });
      process.stdin.on('end', async () => {
        try {
          console.log(JSON.stringify(await sendReply({ to, text })));
        } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      });
    } else {
      console.error('usage: pull|pull-json|count|ack <inbox_ids...>|send --to <chat_id>');
      process.exit(2);
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
