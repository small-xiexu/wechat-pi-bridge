// wx-auth-state.mjs - durable, token-free WeChat authentication state.
// The state file is deliberately separate from wx-bot's credentials.  It is
// written atomically so a watchdog/readiness probe never sees a partial JSON.
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const VALID_STATUSES = new Set(['unknown', 'valid', 'invalid']);

function bridgeHomeOf(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  return process.env.WB_HOME || '/home/hatch/workspace/wechat-pi-bridge';
}

function optionsOf(value) {
  if (typeof value === 'string') return { bridgeHome: value };
  return value || {};
}

function stateDefaults() {
  return {
    status: 'unknown',
    reason: null,
    source: null,
    first_seen_at: null,
    last_seen_at: null,
    last_valid_at: null,
    last_alert_at: null,
  };
}

function safeValue(value, max = 200) {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\b(?:bearer|token|access_token|refresh_token)\s*[=:]\s*[^ ]+/gi, '[redacted]')
    .slice(0, max);
}

function sanitizeState(value) {
  const defaults = stateDefaults();
  if (!value || typeof value !== 'object') return defaults;
  const status = VALID_STATUSES.has(value.status) ? value.status : defaults.status;
  const isoOrNull = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    status,
    reason: safeValue(value.reason),
    source: safeValue(value.source),
    first_seen_at: isoOrNull(value.first_seen_at),
    last_seen_at: isoOrNull(value.last_seen_at),
    last_valid_at: isoOrNull(value.last_valid_at),
    last_alert_at: isoOrNull(value.last_alert_at),
  };
}

export function authStatePath({ bridgeHome } = {}) {
  return join(bridgeHomeOf(bridgeHome), 'state', 'wx-auth.json');
}

function writeState(path, state) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(sanitizeState(state), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
  }
}

export function readAuthState(options = {}) {
  const path = authStatePath(optionsOf(options));
  try {
    chmodSync(path, 0o600);
    return sanitizeState(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return stateDefaults();
  }
}

function emitAudit(options, event) {
  const fn = options.audit || options.auditFn;
  if (typeof fn !== 'function') return;
  try {
    fn(event);
  } catch (error) {
    // State persistence must not be rolled back because an audit sink is
    // temporarily unavailable.  dispatch.mjs also records the auth-invalid
    // event in SQLite at the point where the wx-bot send failed.
    console.error(`[wx-auth-state] audit sink failed: ${error.message}`);
  }
}

function nowFrom(options) {
  if (options.now instanceof Date) return options.now.toISOString();
  if (typeof options.now === 'string' && !Number.isNaN(Date.parse(options.now))) {
    return new Date(options.now).toISOString();
  }
  if (typeof options.now === 'number' && Number.isFinite(options.now)) {
    return new Date(options.now).toISOString();
  }
  return new Date().toISOString();
}

/** Mark the current WeChat login state invalid. No token or wx-bot stderr is stored. */
export function markWxAuthInvalid(options = {}) {
  options = optionsOf(options);
  const path = authStatePath(options);
  const previous = readAuthState(options);
  const now = nowFrom(options);
  const changed = previous.status !== 'invalid';
  const next = {
    ...previous,
    status: 'invalid',
    reason: safeValue(options.reason || 'errcode=-14'),
    source: safeValue(options.source || 'unknown'),
    first_seen_at: changed ? now : previous.first_seen_at || now,
    last_seen_at: now,
    // A new invalid episode should not inherit the previous episode's cooldown.
    last_alert_at: changed ? null : previous.last_alert_at,
  };
  writeState(path, next);
  if (changed) {
    emitAudit(options, {
      eventType: 'wechat.auth_state_changed',
      details: {
        previous_status: previous.status,
        status: 'invalid',
        source: next.source,
        reason: next.reason,
      },
    });
  }
  return { ...next, changed, path };
}

/** Mark the current WeChat login state valid after an external recovery check. */
export function markWxAuthValid(options = {}) {
  options = optionsOf(options);
  const path = authStatePath(options);
  const previous = readAuthState(options);
  const now = nowFrom(options);
  const changed = previous.status !== 'valid';
  const next = {
    ...previous,
    status: 'valid',
    reason: null,
    source: safeValue(options.source || 'unknown'),
    first_seen_at: null,
    last_seen_at: now,
    last_valid_at: now,
    // Let the next invalid episode alert immediately.
    last_alert_at: null,
  };
  writeState(path, next);
  if (changed) {
    emitAudit(options, {
      eventType: 'wechat.auth_state_changed',
      details: {
        previous_status: previous.status,
        status: 'valid',
        source: next.source,
      },
    });
  }
  return { ...next, changed, path };
}

function cooldownOf(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  const env = Number(process.env.WB_WX_AUTH_ALERT_COOLDOWN_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return DEFAULT_COOLDOWN_MS;
}

/**
 * Reserve the next invalid-state notification slot.
 *
 * It returns true once per cooldown window and records last_alert_at in the
 * same 0600 state file.  This makes repeated wx-bot -14 failures harmless
 * even when dispatch loops faster than the alert transport.
 *
 * Accepted forms:
 *   shouldNotify({ bridgeHome, cooldownMs, now })
 *   shouldNotify(stateObject, cooldownMs)  // useful for callers/tests
 */
export function shouldNotify(value = {}, legacyCooldownMs) {
  const isState = value && typeof value === 'object' &&
    typeof value.status === 'string' && !('bridgeHome' in value) &&
    !('cooldownMs' in value) && !('now' in value);
  const options = isState ? {} : optionsOf(value);
  const state = isState ? sanitizeState(value) : readAuthState(options);
  if (state.status !== 'invalid') return false;

  const cooldownMs = cooldownOf(legacyCooldownMs ?? options.cooldownMs);
  const now = nowFrom(options);
  const nowMs = Date.parse(now);
  const lastMs = state.last_alert_at ? Date.parse(state.last_alert_at) : NaN;
  if (Number.isFinite(lastMs) && Number.isFinite(nowMs) && nowMs - lastMs < cooldownMs) {
    return false;
  }

  const next = { ...state, last_alert_at: now };
  writeState(authStatePath(options), next);
  return true;
}

export { DEFAULT_COOLDOWN_MS };
