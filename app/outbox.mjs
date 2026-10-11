// outbox.mjs - deliver reply parts back to WeChat (wx-bot) or Telegram (Bot API).
// WeChat: uses the wx-bot CLI (pinned binary) with explicit --config per binding.
//   Retry policy per protocol v1: 502/timeout -> backoff; 400/401/403/404/409/413 -> no retry.
// Telegram: uses the official Bot API sendMessage.
//   401/400/403 -> no retry; 429 -> retry honoring retry_after; network/5xx -> backoff.
import { spawn } from 'node:child_process';
import { TelegramApi } from './telegram.mjs';

const DEFAULT_WXBOT_BIN = '/home/hatch/workspace/wechat-bridge/vendor/wx-bot/wx-bot';

// stderr markers -> classification. Conservative: unknown errors are retried.
const NO_RETRY_PATTERNS = [
  /401/, /unauthorized/i, /token/i, /expired/i, /login/i, /-14/,
  /403/, /whitelist/i,
  /404/, /no such binding/i,
  /409/, /context_token/i,
  /400/, /bad request/i, /invalid/i,
  /413/, /too large/i,
];

export function classifySendError(stderr, code) {
  const s = String(stderr || '');
  for (const p of NO_RETRY_PATTERNS) {
    if (p.test(s)) {
      if (/401|expired|login|-14/i.test(s)) return { retry: false, kind: 'auth_invalid' };
      if (/409|context_token/i.test(s)) return { retry: false, kind: 'no_context' };
      return { retry: false, kind: 'rejected' };
    }
  }
  return { retry: true, kind: 'transient' };
}

/** Send one text part. Returns { ok, kind, stderr }. */
export function sendText({ wxbotBin = process.env.WB_WXBOT_BIN || DEFAULT_WXBOT_BIN,
    wxbotConfig, binding, to, text, timeoutMs = 30000 } = {}) {
  if (process.env.WB_SEND_MOCK === '1') {
    const line = `[mock-send binding=${binding} to=${to} len=${text.length}] ${text.slice(0, 80)}\n`;
    process.stderr.write(line);
    return Promise.resolve({ ok: true, kind: 'mock', stderr: '' });
  }
  return new Promise((resolve) => {
    const args = ['--config', wxbotConfig, 'send', '--binding', binding, '--to', to, '--text', '-'];
    const child = spawn(wxbotBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, kind: 'spawn_error', stderr: String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true, kind: 'sent', stderr: err });
      const c = classifySendError(err, code);
      resolve({ ok: false, kind: c.kind, retry: c.retry, stderr: err.slice(0, 2000) });
    });
    child.stdin.on('error', () => {});
    child.stdin.write(text, 'utf8', () => child.stdin.end());
  });
}

/** Backoff schedule for transient send failures (ms). */
export function backoffMs(attempt) {
  const table = [2000, 8000, 30000, 120000];
  return table[Math.min(attempt, table.length - 1)];
}

/** Classify a Telegram send error. Returns { retry, kind, retryAfterMs? }. */
export function classifyTelegramError(err) {
  const p = (err && err.telegram) || {};
  if (p.status === 401) return { retry: false, kind: 'auth_invalid' };
  if (p.status === 403) return { retry: false, kind: 'forbidden' }; // blocked by user / not started
  if (p.status === 400) return { retry: false, kind: 'rejected' };
  if (p.status === 429) {
    return { retry: true, kind: 'rate_limited', retryAfterMs: (p.parameters?.retry_after || 5) * 1000 };
  }
  return { retry: true, kind: 'transient' };
}

/** Send one text part via the Telegram Bot API. Returns { ok, kind, retry, stderr, retryAfterMs? }.
 *  Token is never logged (Telegram puts it in the URL path by API design). */
export async function sendTelegramPhoto({ token, apiBase = 'https://api.telegram.org', chatId, photoPath, caption = '', timeoutMs = 60000 } = {}) {
  if (process.env.TG_SEND_MOCK === '1') {
    process.stderr.write(`[mock-tg-photo chat=${chatId} file=${photoPath}]\n`);
    return { ok: true, kind: 'mock', stderr: '' };
  }
  const api = new TelegramApi({ token, apiBase, timeoutMs });
  try {
    await api.sendPhoto(chatId, photoPath, caption);
    return { ok: true, kind: 'sent', stderr: '' };
  } catch (e) {
    const c = classifyTelegramError(e);
    return { ok: false, kind: c.kind, retry: c.retry, stderr: String(e.message).slice(0, 2000), retryAfterMs: c.retryAfterMs };
  }
}

export async function sendTelegramText({ token, apiBase = 'https://api.telegram.org', chatId, text, timeoutMs = 30000 } = {}) {
  if (process.env.TG_SEND_MOCK === '1') {
    const line = `[mock-tg-send chat=${chatId} len=${text.length}] ${text.slice(0, 80)}\n`;
    process.stderr.write(line);
    return { ok: true, kind: 'mock', stderr: '' };
  }
  const api = new TelegramApi({ token, apiBase, timeoutMs });
  try {
    await api.sendMessage(chatId, text);
    return { ok: true, kind: 'sent', stderr: '' };
  } catch (e) {
    const c = classifyTelegramError(e);
    return { ok: false, kind: c.kind, retry: c.retry, stderr: String(e.message).slice(0, 2000), retryAfterMs: c.retryAfterMs };
  }
}
