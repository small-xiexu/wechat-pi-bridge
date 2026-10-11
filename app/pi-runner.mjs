// pi-runner.mjs - run the fixed Pi CLI for one batch.
// Safety: user text travels via stdin ONLY. It is never interpolated into
// shell arguments, env vars, or file paths. Fixed argv, fixed binary.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const DEFAULT_PI_BIN = '/home/hatch/workspace/tools/pi/bin/pi';

/**
 * Run pi --print with `input` on stdin.
 * @returns {Promise<{ok, code, signal, stdout, stderr, timedOut}>}
 */
export function runPi(input, {
  piBin = process.env.WB_PI_BIN || DEFAULT_PI_BIN,
  workdir = process.env.WB_PI_WORKDIR || '/home/hatch/workspace/wechat-bridge/sandbox/pi-work',
  timeoutMs = 600_000,
  maxOutputBytes = 200_000,
  sessionId = null,
  images = [],
} = {}) {
  return new Promise((resolve) => {
    try { mkdirSync(workdir, { recursive: true, mode: 0o700 }); }
    catch (e) {
      resolve({ ok: false, code: null, signal: null, stdout: '', stderr: `workdir: ${e.message}`, timedOut: false, spawnError: true });
      return;
    }
    const args = ['--print'];
    if (sessionId) args.push('--session-id', sessionId);
    for (const img of images) args.push('@' + img);
    const child = spawn(piBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workdir,
      detached: true,          // own process group -> kill tree on timeout
      env: { ...process.env }, // Pi reads ~/.pi/agent config itself; no key material added here
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killTree = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (d) => {
      if (stdout.length < maxOutputBytes) stdout += d.toString('utf8').slice(0, maxOutputBytes - stdout.length);
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < maxOutputBytes) stderr += d.toString('utf8').slice(0, maxOutputBytes - stderr.length);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, signal: null, stdout, stderr: String(err && err.message || err), timedOut: false, spawnError: true });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, signal, stdout, stderr, timedOut });
    });
    // stdin carries the user text as DATA. End stream so pi sees EOF.
    child.stdin.on('error', () => {});
    child.stdin.write(input, 'utf8', () => child.stdin.end());
  });
}
