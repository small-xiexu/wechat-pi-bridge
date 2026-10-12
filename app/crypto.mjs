// crypto.mjs - authenticated encryption for persisted bridge message bodies.
// The key is deliberately loaded only by the bridge process, never passed to Pi.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PREFIX = 'enc:v1:';

function keyFrom(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return value;
  if (typeof value === 'string' && value.length > 0) {
    const raw = Buffer.from(value.trim(), /^[0-9a-fA-F]{64}$/.test(value.trim()) ? 'hex' : 'base64');
    if (raw.length === 32) return raw;
    return createHash('sha256').update(value).digest();
  }
  throw new Error('database encryption key must be 32 bytes');
}

/** Load or create a 0600 key file. Existing deployments can set WB_DB_KEY_FILE. */
export function loadDbKey({ keyFile = process.env.WB_DB_KEY_FILE, bridgeHome = process.env.WB_HOME || '/home/hatch/workspace/wechat-pi-bridge/repo' } = {}) {
  if (process.env.WB_DB_KEY) return keyFrom(process.env.WB_DB_KEY);
  const file = resolve(keyFile || `${bridgeHome}/state/.db-key`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) {
    try { chmodSync(file, 0o600); } catch {}
    return keyFrom(readFileSync(file));
  }
  const key = randomBytes(32);
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, key); } finally { closeSync(fd); }
  try { chmodSync(file, 0o600); } catch {}
  return key;
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptText(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(key), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${body.toString('base64url')}`;
}

export function decryptText(ciphertext, key) {
  if (!isEncrypted(ciphertext)) return String(ciphertext ?? '');
  const [, version, iv64, tag64, body64] = ciphertext.split(':');
  // NOTE: body64 may legitimately be '' — a message with empty text (e.g. a
  // photo with no caption) encrypts to `enc:v1:<iv>:<tag>:` and must decrypt
  // back to ''. Rejecting empty bodies here poisoned every batch containing
  // a textless image message (found 2026-10-12, WeChat batch 40).
  if (version !== 'v1' || !iv64 || !tag64 || body64 === undefined) throw new Error('invalid encrypted text');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(key), Buffer.from(iv64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body64, 'base64url')), decipher.final()]).toString('utf8');
}

export { PREFIX };
