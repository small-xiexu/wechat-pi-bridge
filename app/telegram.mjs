// telegram.mjs - minimal Telegram Bot API client (outbound-only usage).
// The bridge uses long-poll getUpdates (no inbound ports, no webhook) and
// sendMessage for replies. Token lives in config/telegram.json, never in code.
// NOTE: Telegram's Bot API puts the token in the URL path by design. We never
// log URLs or tokens; errors carry only method, HTTP status and description.

export class TelegramError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'TelegramError';
    this.telegram = info; // { status, description, errorCode, parameters }
  }
}

export class TelegramApi {
  constructor({ token, apiBase = 'https://api.telegram.org', timeoutMs = 40000 }) {
    if (!token || typeof token !== 'string' || token.startsWith('__REPLACE')) {
      throw new Error('telegram bot token not configured (refusing to start)');
    }
    this.token = token;
    this.apiBase = String(apiBase || 'https://api.telegram.org').replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async call(method, params = {}) {
    const url = `${this.apiBase}/bot${this.token}/${method}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: ctrl.signal,
      });
      let data = {};
      try { data = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok || data.ok === false) {
        throw new TelegramError(
          `telegram ${method} failed: http=${res.status} ${data.description || ''}`.trim(),
          { status: res.status, description: data.description || '', errorCode: data.error_code, parameters: data.parameters || {} }
        );
      }
      return data.result;
    } catch (e) {
      if (e instanceof TelegramError) throw e;
      // network / abort / DNS: wrap so callers can back off uniformly
      throw new TelegramError(`telegram ${method} transport error: ${e.message}`, { status: 0, transport: true });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Download a file by file_id. Returns Buffer. */
  async downloadFile(fileId) {
    const info = await this.call('getFile', { file_id: fileId });
    if (!info || !info.file_path) throw new Error('getFile returned no file_path');
    const url = `${this.apiBase}/file/bot${this.token}/${info.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`telegram file download failed: http=${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Long-poll for updates. Returns array of update objects. */
  getUpdates(offset, timeoutSecs = 30) {
    return this.call('getUpdates', { offset, timeout: timeoutSecs, allowed_updates: ['message'] });
  }

  /** Send a text message. Returns the sent message object. */
  sendMessage(chatId, text) {
    return this.call('sendMessage', { chat_id: chatId, text });
  }

  /** Send a photo from a local file path. Uses multipart/form-data. */
  async sendPhoto(chatId, photoPath, caption = '') {
    const { readFileSync } = await import('node:fs');
    const { basename } = await import('node:path');
    const url = `${this.apiBase}/bot${this.token}/sendPhoto`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const buf = readFileSync(photoPath);
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('photo', new Blob([buf], { type: 'image/png' }), basename(photoPath));
      if (caption) form.append('caption', caption);
      const res = await fetch(url, { method: 'POST', body: form, signal: ctrl.signal });
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok || data.ok === false) {
        throw new TelegramError(
          `telegram sendPhoto failed: http=${res.status} ${data.description || ''}`.trim(),
          { status: res.status, description: data.description || '' }
        );
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Cheap liveness probe (no side effects). */
  getMe() {
    return this.call('getMe', {});
  }
}

/** Extract a normalized inbound record from a getUpdates `message` object.
 *  Returns null for updates we deliberately ignore (non-private chats are
 *  rejected by the caller via allowlist, not here).
 *  Shape mirrors normalize.mjs conventions: { message_id, sender_id,
 *  conversation_id, recipient_id, text, kind }. */
export function extractTelegramMessage(update) {
  const msg = update && update.message;
  if (!msg || typeof msg !== 'object') return null;
  const from = msg.from || {};
  const chat = msg.chat || {};
  const text = typeof msg.text === 'string' ? msg.text
    : (typeof msg.caption === 'string' ? msg.caption : '');
  const hasMedia = !!(msg.photo || msg.document || msg.video || msg.voice ||
    msg.video_note || msg.audio || msg.sticker || msg.animation);
  if (!text && !hasMedia) return null; // e.g. service messages: ignore
  return {
    update_id: update.update_id,
    message_id: String(msg.message_id),
    sender_id: String(from.id || ''),
    conversation_id: String(chat.id || ''),
    recipient_id: String(chat.id || ''),
    chat_type: chat.type || '',
    text: text.slice(0, 20000),
    kind: text ? 'text' : 'media',
    photo_file_id: Array.isArray(msg.photo) && msg.photo.length > 0
      ? msg.photo[msg.photo.length - 1].file_id : null,
    media_placeholder: hasMedia && !text
      ? (msg.voice || msg.audio ? '[语音消息：Telegram 语音暂无转写，请改发文字]'
        : msg.video ? '[视频]'
        : msg.document ? '[文件]'
        : '[图片]')
      : null,
  };
}
