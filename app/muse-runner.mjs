// muse-runner.mjs - helper for the Muse binding (delivery: pull).
// The Muse agent is woken by ~/hooks/scripts/wechat-inbox-watch.sh, then uses
// this module (via bin/muse-batch) to pull leased events, format a batch,
// send the reply with `wx-bot send`, and ack. Inbound queue lives in wx-bot's
// own inbox.db (dedup by event_id, lease on pull) - this bridge does NOT
// re-queue Muse inbound events.
import { spawnSync } from 'node:child_process';

const WXBOT_BIN = process.env.WB_WXBOT_BIN || '/home/hatch/workspace/wechat-bridge/vendor/wx-bot/wx-bot';
const WXBOT_CONFIG = process.env.WB_WXBOT_MUSE_CONFIG || '/home/hatch/workspace/wechat-bridge/config/wx-bot-muse.json';
const BINDING = process.env.WB_MUSE_BINDING || 'muse';

function wxbot(args, input = null) {
  const r = spawnSync(WXBOT_BIN, ['--config', WXBOT_CONFIG, ...args], {
    input: input ?? undefined,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (r.error) throw new Error(`wx-bot spawn failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`wx-bot ${args[0]} failed: ${(r.stderr || '').slice(0, 500)}`);
  return (r.stdout || '').trim();
}

/** Pull up to `limit` leased events. Returns parsed event array. */
export function pullEvents({ limit = 20, lease = '10m' } = {}) {
  const out = wxbot(['inbox', 'pull', '--binding', BINDING, '--limit', String(limit), '--lease', lease]);
  if (!out) return [];
  try {
    const parsed = JSON.parse(out);
    return parsed.events || [];
  } catch {
    throw new Error('wx-bot inbox pull returned non-JSON');
  }
}

/** Number of currently claimable events (no side effects). */
export function countEvents() {
  const out = wxbot(['inbox', 'count', '--binding', BINDING]);
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Format pulled events as one agent batch (natural debounce: one pull = one batch). */
export function formatBatch(events) {
  return events
    .map((e, i) => {
      const ts = e.create_time ? new Date(e.create_time * 1000).toISOString() : '';
      const body = e.text || e.voice_text || (e.media && e.media.length ? '[媒体附件：当前不支持读取]' : '[空事件]');
      return `[微信消息 ${i + 1} | ${ts} | from=${e.from_wxid}]\n${body}`;
    })
    .join('\n');
}

/** Send a reply and ack the handled event_ids. Returns { sent, acked }. */
export function replyAndAck({ to, text, eventIds }) {
  const r = spawnSync(WXBOT_BIN,
    ['--config', WXBOT_CONFIG, 'send', '--binding', BINDING, '--to', to, '--text', '-'],
    { input: text, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) {
    throw new Error(`wx-bot send failed: ${(r.stderr || '').slice(0, 500)}`);
  }
  let acked = 0;
  if (eventIds && eventIds.length) {
    const out = wxbot(['inbox', 'ack', ...eventIds]);
    try { acked = JSON.parse(out).acked ?? 0; } catch { /* ignore */ }
  }
  return { sent: true, acked };
}

// CLI: node muse-runner.mjs pull|count|ack <ids...>|send --to <wxid> (stdin=text)
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (cmd === 'count') console.log(countEvents());
    else if (cmd === 'pull') console.log(formatBatch(pullEvents()));
    else if (cmd === 'pull-json') console.log(JSON.stringify(pullEvents(), null, 2));
    else if (cmd === 'ack') {
      const out = wxbot(['inbox', 'ack', ...rest]);
      console.log(out);
    } else if (cmd === 'send') {
      const toIdx = rest.indexOf('--to');
      const to = toIdx >= 0 ? rest[toIdx + 1] : null;
      if (!to) throw new Error('usage: send --to <wxid>  (text via stdin)');
      let text = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { text += d; });
      process.stdin.on('end', () => {
        const r = replyAndAck({ to, text, eventIds: [] });
        console.log(JSON.stringify(r));
      });
    } else {
      console.error('usage: pull|pull-json|count|ack <ids...>|send --to <wxid>');
      process.exit(2);
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
