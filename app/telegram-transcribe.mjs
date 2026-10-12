// telegram-transcribe.mjs - local ASR for Telegram voice messages.
//
// Telegram's Bot API delivers voice as an .ogg/opus file with no transcript
// (unlike WeChat, whose upstream hands us voice_text). This module fills the
// gap with whisper.cpp (base q5_1 measured on this VM: ~200MB peak RSS,
// ~4-6s for short clips). Design constraints from the Pi review:
//   - never throw: callers always get { ok } and fall back to a placeholder
//   - single flight: transcriptions serialize, never run two at once
//   - memory guard: refuse to start when MemAvailable is too low
//   - hard timeout with process kill
import { execFile } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';

const WHISPER_BIN = process.env.WB_WHISPER_BIN
  || '/home/hatch/workspace/tools/whisper.cpp/build/bin/whisper-cli';
const WHISPER_MODEL = process.env.WB_WHISPER_MODEL
  || '/home/hatch/workspace/wechat-bridge/models/whisper/ggml-base-q5_1.bin';
const MIN_AVAILABLE_MB = Number(process.env.WB_ASR_MIN_AVAILABLE_MB || 220);
const LOWMEM_RETRIES = 3;        // memory pressure is transient (Pi runs come and go)
const LOWMEM_WAIT_MS = 20_000;   // wait between low-memory rechecks
const WHISPER_RETRIES = 2;       // one retry on transient whisper-cli failure
const WHISPER_RETRY_WAIT_MS = 2_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT_MS = Number(process.env.WB_ASR_TIMEOUT_MS || 120_000);

function memAvailableMb() {
  try {
    const m = readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+) kB/);
    return m ? Math.floor(Number(m[1]) / 1024) : 0;
  } catch { return 0; }
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => err ? reject(new Error(`${cmd}: ${err.message}`)) : resolve({ stdout, stderr }));
  });
}

let queue = Promise.resolve();

async function doTranscribe(oggPath) {
  if (!existsSync(oggPath)) return { ok: false, reason: 'audio-missing' };
  if (!existsSync(WHISPER_BIN) || !existsSync(WHISPER_MODEL)) {
    return { ok: false, reason: 'asr-not-installed' };
  }
  let avail = memAvailableMb();
  for (let i = 0; i < LOWMEM_RETRIES && avail < MIN_AVAILABLE_MB; i++) {
    await sleep(LOWMEM_WAIT_MS);
    avail = memAvailableMb();
  }
  if (avail < MIN_AVAILABLE_MB) return { ok: false, reason: `low-memory:${avail}MB` };
  const wavPath = oggPath.replace(/\.ogg$/, '.asr.wav');
  const outBase = oggPath.replace(/\.ogg$/, '.asr');
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-i', oggPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], 30_000);
    let lastErr = null;
    for (let i = 0; i < WHISPER_RETRIES; i++) {
      try {
        await run(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', wavPath, '-l', 'zh', '-t', '2',
          '--no-timestamps', '-otxt', '-of', outBase], TIMEOUT_MS);
        lastErr = null;
        break;
      } catch (e) { lastErr = e; if (i + 1 < WHISPER_RETRIES) await sleep(WHISPER_RETRY_WAIT_MS); }
    }
    if (lastErr) throw lastErr;
    const text = readFileSync(`${outBase}.txt`, 'utf8').replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, reason: 'empty-transcript' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 120) };
  } finally {
    for (const p of [wavPath, `${outBase}.txt`]) { try { unlinkSync(p); } catch {} }
  }
}

/** Serialize all transcriptions through a single-flight queue. */
export function transcribeVoice(oggPath) {
  const runIt = () => doTranscribe(oggPath).catch((e) => ({ ok: false, reason: String(e && e.message || e) }));
  const result = queue.then(runIt, runIt);
  queue = result.catch(() => {});
  return result;
}
