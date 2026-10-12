// session-images.mjs - shrink image parts stored inside a Pi session file.
// Why: images embedded in session history are re-sent (and re-viewed by the
// model) on EVERY later turn. A few MB-sized photos push the request past the
// relay's practical limits (observed: a 24MB request carrying 5 images got a
// 503 after ~38s while small requests sailed through). After each dispatch
// turn we downscale images from OLDER exchanges to small JPEG thumbnails:
// Pi keeps a visual memory of the image at ~1/100 of the bytes. The most
// recent exchange keeps its full-size images untouched.
import { readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// Only touch images bigger than this (base64 chars; ~90KB binary). Our
// thumbnails land well under it, so already-shrunk images are never
// re-processed (no repeated quality loss).
const BIG_IMAGE_B64 = Number(process.env.WB_SESSION_IMAGE_MIN_B64 || 120000);
const MAX_DIM = Number(process.env.WB_SESSION_IMAGE_MAX_DIM || 512);

export function findSessionFile(sessionDir, sessionId, depth = 0) {
  if (!sessionDir || depth > 3) return null;
  let entries;
  try { entries = readdirSync(sessionDir, { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const e of entries) {
    const p = join(sessionDir, e.name);
    if (e.isFile() && e.name.endsWith(`_${sessionId}.jsonl`)) {
      const m = statSync(p).mtimeMs;
      if (!best || m > best.m) best = { path: p, m };
    } else if (e.isDirectory()) {
      const rp = findSessionFile(p, sessionId, depth + 1);
      if (rp) {
        const m = statSync(rp).mtimeMs;
        if (!best || m > best.m) best = { path: rp, m };
      }
    }
  }
  return best?.path || null;
}

function downscaleViaFfmpeg(buf, mimeType) {
  const ext = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : mimeType === 'image/gif' ? '.gif' : '.png';
  const tag = randomBytes(6).toString('hex');
  const inPath = join(tmpdir(), `sessimg-${tag}${ext}`);
  const outPath = join(tmpdir(), `sessimg-${tag}.jpg`);
  try {
    writeFileSync(inPath, buf);
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', inPath,
      '-vf', `scale=${MAX_DIM}:${MAX_DIM}:force_original_aspect_ratio=decrease`, '-q:v', '6', outPath],
      { timeout: 30_000 });
    if (r.status !== 0) return null;
    const out = readFileSync(outPath);
    if (!out.length || out.length >= buf.length) return null;
    return { data: out.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return null;
  } finally {
    try { writeFileSync(inPath, ''); } catch { /* best effort */ }
  }
}

function shrinkParts(node, stats) {
  if (Array.isArray(node)) { for (const v of node) shrinkParts(v, stats); return; }
  if (!node || typeof node !== 'object') return;
  if (node.type === 'image' && typeof node.data === 'string' && node.data.length > BIG_IMAGE_B64) {
    const small = downscaleViaFfmpeg(Buffer.from(node.data, 'base64'), node.mimeType || 'image/png');
    if (small) {
      stats.savedBytes += Math.floor((node.data.length - small.data.length) * 3 / 4);
      node.data = small.data;
      node.mimeType = small.mimeType;
      stats.replaced += 1;
    }
  }
  for (const v of Object.values(node)) shrinkParts(v, stats);
}

/**
 * Downscale big images in all exchanges except the most recent one.
 * Returns { file, replaced, savedBytes, beforeBytes, afterBytes } or null
 * when there is nothing to do. Never throws.
 */
export function shrinkSessionImages(sessionDir, sessionId) {
  try {
    const file = findSessionFile(sessionDir, sessionId);
    if (!file) return null;
    const raw = readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } });
    let lastUser = -1;
    entries.forEach((e, i) => { if (e?.message?.role === 'user') lastUser = i; });
    if (lastUser <= 0) return null; // only the current exchange exists
    const stats = { replaced: 0, savedBytes: 0 };
    for (let i = 0; i < lastUser; i++) {
      if (entries[i]) shrinkParts(entries[i], stats);
    }
    if (!stats.replaced) return null;
    const out = entries.map((e, i) => (e && i < lastUser ? JSON.stringify(e) : lines[i])).join('\n');
    const tmp = `${file}.shrink-${process.pid}`;
    writeFileSync(tmp, out);
    renameSync(tmp, file);
    return { file, replaced: stats.replaced, savedBytes: stats.savedBytes, beforeBytes: raw.length, afterBytes: out.length };
  } catch {
    return null;
  }
}
