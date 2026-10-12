// telegram-bridge.mjs - single-process Telegram channel bridge.
//
// ONE Node runtime runs all three loops (memory optimization, 2026-10-11):
//   - poll loop: bot A (muse) -> state/telegram-muse.sqlite3
//   - poll loop: bot B (pi)   -> state/telegram-pi.sqlite3
//   - dispatch tick: telegram-pi batches -> pi --print -> Telegram send
// Error isolation: a transport error backs off only that bot's poll loop;
// one bot never takes down the other. SIGTERM/SIGINT stops all loops and
// closes both DBs before exit.
// The Muse side is pull-based: ~/hooks/scripts/telegram-inbox-watch.sh wakes
// the agent, which uses bin/telegram-muse-batch to pull/reply/ack.
// Outbound-only: long-poll getUpdates, no inbound ports.
import { readFileSync } from 'node:fs';
import { dispatchOnce } from './dispatch.mjs';
import { boot, runPollLoop, createShutdown } from './telegram-poll.mjs';
import { pruneOldRecords } from './db.mjs';

const BRIDGE_HOME = process.env.WB_HOME || '/home/hatch/workspace/wechat-bridge';
const TG_CONFIG_PATH = process.env.WB_TG_CONFIG || `${BRIDGE_HOME}/config/telegram.json`;
const PI_DB = `${BRIDGE_HOME}/state/telegram-pi.sqlite3`;

function loadTelegramConfig() {
  const tg = JSON.parse(readFileSync(TG_CONFIG_PATH, 'utf8')).telegram || {};
  for (const k of ['muse_bot_token', 'pi_bot_token']) {
    if (!tg[k] || String(tg[k]).startsWith('__REPLACE')) {
      console.error(`FATAL: config/telegram.json telegram.${k} not configured`);
      process.exit(1);
    }
  }
  return tg;
}

const tg = loadTelegramConfig();
const telegramCfg = { telegram: tg };
// Minimal bindings view for dispatchOnce (mirrors bindings.json shape).
const tgBindings = {
  bindings: {
    'telegram-pi': {
      channel: 'telegram',
      pi_workdir: `${BRIDGE_HOME}/sandbox/pi-work-tg`,
      pi_model: 'sub2api/gpt-6.1-sol',
      pi_timeout_ms: 600_000,
      pi_session_dir: process.env.WB_PI_SESSION_DIR || '/home/hatch/.pi/agent/sessions',
      media_roots: [`${BRIDGE_HOME}/state/telegram-media`],
    },
  },
  debounce_ms: tg.debounce_ms || 2500,
};

const shutdown = createShutdown();
process.on('SIGTERM', () => { shutdown.stopped = true; });
process.on('SIGINT', () => { shutdown.stopped = true; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TICK_MS = 2000;
const PRUNE_INTERVAL_MS = 3600_000; // hourly retention cleanup
let lastPrune = 0;

// Dispatch tick for the pi binding (lease + fencing inside dispatchOnce).
async function dispatchLoop(piDb, _unused) {
  while (!shutdown.stopped) {
    try {
      await dispatchOnce({ dbPath: PI_DB, bindings: tgBindings, telegramCfg });
    } catch (e) {
      console.error(`[telegram-bridge] dispatch: ${e.message}`);
    }
    const now = Date.now();
    if (now - lastPrune >= PRUNE_INTERVAL_MS) {
      lastPrune = now;
      for (const [label, db] of [['pi', piDb]]) {
        try {
          const r = pruneOldRecords(db, 7);
          const total = Object.values(r).reduce((a, b) => a + b, 0);
          if (total > 0) console.log(`[telegram-bridge] prune ${label}: ${JSON.stringify(r)}`);
        } catch (e) {
          console.error(`[telegram-bridge] prune ${label}: ${e.message}`);
        }
      }
    }
    await sleep(TICK_MS);
  }
  console.log('[telegram-bridge] dispatch loop stopped');
}

async function main() {
  const piCtx = boot('pi');
  console.log('[telegram-bridge] starting (single process: pi poll loop + pi dispatch; muse bot disabled)');
  await Promise.all([
    runPollLoop(piCtx, shutdown),
    dispatchLoop(piCtx.db, piCtx.db),
  ]);
  try { piCtx.db.close(); } catch { /* ignore */ }
  console.log('[telegram-bridge] stopped');
}

main().catch((e) => {
  console.error(`[telegram-bridge] fatal: ${e.message}`);
  process.exit(1);
});
