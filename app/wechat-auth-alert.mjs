// wechat-auth-alert.mjs - Telegram notification for a dead WeChat login.
// This module only sends a notification.  It deliberately does not start a
// wx-bot login command because wx-bot versions expose different login flows.
// A caller may optionally provide a QR image path or URL when its wx-bot
// integration can provide one; without either, the text alert is sufficient.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { sendTelegramPhoto, sendTelegramText } from './outbox.mjs';

const DEFAULT_BRIDGE_HOME = process.env.WB_HOME || '/home/hatch/workspace/wechat-pi-bridge';
const DEFAULT_CONFIG_PATH = process.env.WB_TG_CONFIG || `${DEFAULT_BRIDGE_HOME}/config/telegram.json`;
const MAX_QR_BYTES = 10 * 1024 * 1024;

function configured(value) {
  return value !== undefined && value !== null && String(value).length > 0 &&
    !String(value).startsWith('__REPLACE');
}

function telegramSection(config) {
  if (!config || typeof config !== 'object') return {};
  return config.telegram && typeof config.telegram === 'object' ? config.telegram : config;
}

function readTelegramConfig(path = DEFAULT_CONFIG_PATH) {
  try {
    return telegramSection(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    return { _configError: `cannot read Telegram config: ${error.message}` };
  }
}

function loadOptions(options = {}) {
  const tg = telegramSection(options.telegramConfig || readTelegramConfig(options.telegramConfigPath));
  return {
    tg,
    token: options.token || tg.auth_alert_bot_token || tg.pi_bot_token,
    chatId: options.chatId ?? tg.auth_alert_chat_id,
    apiBase: options.apiBase || tg.api_base,
  };
}

function describeReason(reason) {
  const text = String(reason || 'errcode=-14').replace(/[\r\n]+/g, ' ').trim();
  return text.slice(0, 240);
}

function describeSource(source) {
  const text = String(source || '微信出站发送').replace(/[\r\n]+/g, ' ').trim();
  return text.slice(0, 160);
}

function buildAlertText({ reason, source, qrPath, qrUrl }) {
  const lines = [
    '⚠️ 微信登录态已失效',
    `来源：${describeSource(source)}`,
    `原因：${describeReason(reason)}`,
    '请重新扫码登录 wx-bot；本告警不会自动执行登录命令。',
  ];
  if (qrPath || qrUrl) lines.push('检测到二维码来源，正在尝试附图发送。');
  else lines.push('当前没有可用的二维码文件或 URL，请按现有 wx-bot 部署流程重新扫码。');
  return lines.join('\n');
}

function localQrPath(value) {
  if (!configured(value)) return null;
  try {
    const st = statSync(String(value));
    if (!st.isFile() || st.size <= 0 || st.size > MAX_QR_BYTES) return null;
    return String(value);
  } catch {
    return null;
  }
}

async function downloadQrUrl(url) {
  if (!configured(url)) return null;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const dir = mkdtempSync(join(tmpdir(), 'wechat-auth-qr-'));
  const path = join(dir, `qr-${randomBytes(6).toString('hex')}.png`);
  try {
    const response = await fetch(parsed, { signal: ctrl.signal });
    if (!response.ok) throw new Error(`QR URL returned HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_QR_BYTES) {
      throw new Error('QR image is too large');
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0 || body.length > MAX_QR_BYTES) throw new Error('QR image has invalid size');
    writeFileSync(path, body, { mode: 0o600, flag: 'wx' });
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a WeChat-auth-invalid alert.
 *
 * `qrPath` and `qrUrl` are optional integration outputs from wx-bot.  The
 * function sends text first, then tries a photo.  A bad/missing QR source
 * never prevents the plain-text degradation path.
 */
export async function notifyWxAuthInvalid({
  telegramConfigPath = DEFAULT_CONFIG_PATH,
  telegramConfig,
  token,
  apiBase,
  chatId,
  reason = 'errcode=-14',
  source = '微信出站发送',
  qrPath = process.env.WB_WX_AUTH_QR_PATH,
  qrUrl = process.env.WB_WX_AUTH_QR_URL,
  timeoutMs,
} = {}) {
  const cfg = loadOptions({ telegramConfigPath, telegramConfig, token, apiBase, chatId });
  if (!configured(cfg.token) || !configured(cfg.chatId)) {
    return {
      ok: false,
      kind: 'not_configured',
      text: null,
      photo: null,
      error: cfg.tg._configError || 'telegram auth alert token/chat_id not configured',
    };
  }

  const path = localQrPath(qrPath);
  const qr = path ? { path, cleanup: null } : await downloadQrUrl(qrUrl);
  const text = buildAlertText({ reason, source, qrPath: path, qrUrl: qrUrl && !path ? qrUrl : null });
  let textResult;
  try {
    textResult = await sendTelegramText({
      token: cfg.token,
      apiBase: cfg.apiBase,
      chatId: cfg.chatId,
      text,
      timeoutMs,
    });
  } catch (error) {
    textResult = { ok: false, kind: 'exception', stderr: String(error.message).slice(0, 500) };
  }

  let photoResult = null;
  if (qr) {
    try {
      photoResult = await sendTelegramPhoto({
        token: cfg.token,
        apiBase: cfg.apiBase,
        chatId: cfg.chatId,
        photoPath: qr.path,
        caption: '微信重新登录二维码（请按 wx-bot 当前登录流程扫码）',
        timeoutMs,
      });
    } catch (error) {
      photoResult = { ok: false, kind: 'exception', stderr: String(error.message).slice(0, 500) };
    } finally {
      try { qr.cleanup?.(); } catch { /* best effort */ }
    }
  }

  return {
    ok: !!textResult?.ok,
    kind: textResult?.ok ? (photoResult && !photoResult.ok ? 'text_sent_photo_failed' : 'sent') : (textResult?.kind || 'failed'),
    text: textResult,
    photo: photoResult,
    qr_attached: !!qr,
  };
}

export { buildAlertText, localQrPath };
