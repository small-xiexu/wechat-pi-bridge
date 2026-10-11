// auth.mjs - request authentication and identity allowlist (fail-closed).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Load bindings config. Throws if missing/unreadable. */
export function loadBindingsConfig(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Verify the wx-bot webhook Bearer token for a binding.
 *  Returns the binding config on success, throws AuthError otherwise. */
export function checkBearer(bindingsCfg, bindingName, authHeader) {
  const b = bindingsCfg.bindings?.[bindingName];
  if (!b || !b.webhook_token) throw new AuthError('unknown binding or no token configured');
  const want = `Bearer ${b.webhook_token}`;
  if (typeof authHeader !== 'string' || authHeader.length !== want.length) {
    throw new AuthError('missing or malformed Authorization header');
  }
  const ok = timingSafeEqual(Buffer.from(authHeader), Buffer.from(want));
  if (!ok) throw new AuthError('bad bearer token');
  return b;
}

/** Optionally verify X-WxBot-Signature (HMAC-SHA256 of raw body) when a secret is configured. */
export function checkSignature(secret, rawBody, sigHeader, tsHeader) {
  if (!secret) return; // not configured -> skip (Bearer is primary)
  if (typeof sigHeader !== 'string' || !sigHeader.startsWith('sha256=')) {
    throw new AuthError('missing X-WxBot-Signature');
  }
  const mac = createHmac('sha256', secret).update(rawBody).digest('hex');
  const want = `sha256=${mac}`;
  if (sigHeader.length !== want.length ||
      !timingSafeEqual(Buffer.from(sigHeader), Buffer.from(want))) {
    throw new AuthError('bad webhook signature');
  }
  if (tsHeader) {
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
      throw new AuthError('stale webhook timestamp (replay?)');
    }
  }
}

/** Validate the event's identity against the binding's allowlist tuple.
 *  chat_kind 'self_chat': sender/recipient/conversation must equal the configured tuple.
 *  Anything unknown or mismatched -> AuthError (fail-closed). */
export function checkIdentity(bindingCfg, evt) {
  const need = ['sender_id', 'recipient_id', 'conversation_id'];
  for (const k of need) {
    const v = bindingCfg[k];
    if (typeof v !== 'string' || v.length === 0 || v.startsWith('REPLACE_')) {
      throw new AuthError(`binding identity not configured (${k}); refusing to process`);
    }
  }
  const got = {
    sender_id: evt.sender_id ?? evt.from_wxid,
    recipient_id: evt.recipient_id,
    conversation_id: evt.conversation_id ?? evt.from_wxid,
  };
  for (const k of need) {
    if (got[k] !== bindingCfg[k]) {
      throw new AuthError(`identity mismatch on ${k} (fail-closed)`);
    }
  }
  if (bindingCfg.chat_kind && evt.chat_kind && evt.chat_kind !== bindingCfg.chat_kind) {
    throw new AuthError('chat_kind mismatch (fail-closed)');
  }
  return true;
}

export class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; }
}
