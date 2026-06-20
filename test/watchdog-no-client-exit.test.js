// Behaviour test for the level-triggered no-client watchdog exit (T-3p6xca5k).
//
// The bug: ccb-watchdog.js self-exited ONLY from socket 'close' (an edge
// trigger). A daemon that never received a keepalive connection (every test
// daemon; any client that died before opening one) never ran that handler and
// leaked forever. The fix adds a periodic poll that re-evaluates the zero-client
// condition independent of socket events.
//
// ⛔ ISOLATION CONTRACT — this test NEVER spawns a real `claude`, never touches
// real OAuth creds, and never signals the live ccb daemon. It spawns the REAL
// bin/ccb-watchdog.js against a SELF-CONTAINED, per-test CCB_CONFIG_DIR: an
// isolated config.json (port: 0 — OS-assigned, read back from runtime.json),
// a minimal providers.json, and a THROWAWAY .env key (no real secret). The real
// worker reaches "ready" offline (it only binds + parses providers.json; real
// upstream calls happen per-request, which this test never makes). It signals
// only pids it spawned itself. Run it DIRECTLY, never via npm test:
//
//     node --test test/watchdog-no-client-exit.test.js
//
// Note: --test-shuffle is unavailable on this Node (v22); order-independence is
// structural — each test owns its CCB_CONFIG_DIR + spawned watchdog + afterEach
// cleanup, zero shared state — and is proven by repeated green runs.
//
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, '..');
const WATCHDOG_BIN = path.join(PKG_ROOT, 'bin', 'ccb-watchdog.js');

// Mirror the watchdog's own constants so the test's timing expectations track
// the real implementation, not magic numbers. If the impl changes these the
// test's bounds stay meaningful.
const KEEPALIVE_GRACE_MS = 5000;
const MIN_DRAIN_TIMEOUT_MS = 1000; // ProxyConfig enforces drainTimeoutMs >= 1000
const POLL_INTERVAL_MS = 1000; // impl: max(500, floor(KEEPALIVE_GRACE_MS / 5))

// ── Throwaway-resource bookkeeping (swept after every test) ──────────────────
const spawnedPids = new Set();
const tmpDirs = new Set();

afterEach(async () => {
  // SIGTERM first so the watchdog's gracefulShutdown drains and reaps its
  // own worker — prevents orphaning the child proxy process to init (PID 1).
  for (const pid of spawnedPids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  // Brief grace for graceful exit, then SIGKILL any stragglers.
  if (spawnedPids.size > 0) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    for (const pid of spawnedPids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  spawnedPids.clear();
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  tmpDirs.clear();
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function pollUntil(predicate, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await delay(stepMs);
  }
}

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-no-client-'));
  tmpDirs.add(dir);
  return dir;
}

// Write a fully self-contained isolated config dir. port: 0 → OS-assigned,
// read back from runtime.json. providers.json is the minimal shape the worker
// parses offline to reach "ready". The .env holds a THROWAWAY key only.
function writeIsolatedConfig(configDir, { workerKeepaliveS, drainTimeoutMs }) {
  const config = {
    port: 0,
    daemon: {
      healthCheckTimeoutMs: 1000,
      pollIntervalMs: 100,
      pollMaxAttempts: 5,
      upstreamTimeoutMs: 0,
      workerInitTimeoutMs: 5000,
      drainTimeoutMs,
      workerKeepaliveS,
      ipcTimeoutMs: 1000,
      daemonStartTimeoutMs: 10000,
      daemonStartProgressGraceMs: 2000,
      bindHost: '127.0.0.1',
    },
    logging: { enabled: false, requests: false, responses: false, history: 0, maxBodyLog: 0, level: 'info' },
  };
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  const providers = {
    providers: {
      isolated: { url: 'http://127.0.0.1:1/v1', anthropicCompliant: true },
    },
    routes: { models: {}, properties: {}, payloadSize: {} },
  };
  fs.writeFileSync(path.join(configDir, 'providers.json'), JSON.stringify(providers, null, 2), 'utf8');

  // Throwaway key — never a real secret. loadEnv tolerates absence, but we write
  // one so the isolated dir holds NOTHING real and looks like a normal ccb dir.
  fs.writeFileSync(path.join(configDir, '.env'), 'ZAI_KEY=throwaway-not-a-real-key\n', 'utf8');
}

// Spawn the REAL watchdog against an isolated config dir. Resolves with the
// daemon's pid once the worker has published its bound port (runtime.json) —
// i.e. the daemon is fully up with a ready worker. Captures stdout/stderr to a
// log so a failure surfaces the daemon's own diagnostics, not just a timeout.
async function spawnWatchdog(configDir) {
  const logPath = path.join(configDir, 'watchdog.out');
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [WATCHDOG_BIN], {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, CCB_CONFIG_DIR: configDir },
  });
  child.unref();
  spawnedPids.add(child.pid);

  const port = await pollUntilReady(configDir, child.pid);
  assert.ok(port !== null, `watchdog never came ready; daemon log:\n${safeRead(logPath)}`);
  return { pid: child.pid, port, logPath };
}

// Poll runtime.json for the actually-bound port, correlating watchdogPid with
// the spawned child PID to prevent reading a stale runtime.json from a prior
// or concurrent watchdog (T-b6m7d5k2).
async function pollUntilReady(configDir, expectedPid) {
  const runtimePath = path.join(configDir, 'runtime.json');
  const got = await pollUntil(() => {
    if (!fs.existsSync(runtimePath)) return false;
    try {
      const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
      return typeof runtime.port === 'number'
        && typeof runtime.watchdogPid === 'number'
        && (!expectedPid || runtime.watchdogPid === expectedPid);
    } catch { return false; /* mid-write */ }
  }, { timeoutMs: 15000, stepMs: 100 });
  if (!got) return null;
  return JSON.parse(fs.readFileSync(runtimePath, 'utf8')).port;
}

function safeRead(logPath) {
  try { return fs.readFileSync(logPath, 'utf8'); } catch { return '(no log)'; }
}

// The control-IPC socket path for a port, resolved against an EXPLICIT config
// dir — never the env-reading helper getControlIpcPath(), which reads
// process.env.CCB_CONFIG_DIR and would fall back to the user's REAL
// ~/.claude/.ccb in the test process (where CCB_CONFIG_DIR is unset). Building
// the path from the isolated dir keeps this test from ever reaching toward the
// live ccb dir. POSIX-only shape (matches getControlIpcPath's non-Windows arm);
// the leak fix itself is OS-agnostic.
function controlIpcPath(configDir, port) {
  return path.join(configDir, `ccb-ctrl-${port}.sock`);
}

// A control-IPC keepalive client: connects to the per-port Unix socket and
// sends one keepalive line. Returns the open socket (caller keeps it alive to
// hold the keepalive; destroying it closes the keepalive). Rejects on connect
// failure so a down daemon is caught explicitly, not masked as "idle".
function openKeepalive(configDir, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlIpcPath(configDir, port), () => {
      socket.write(JSON.stringify({ cmd: 'keepalive' }) + '\n');
      resolve(socket);
    });
    socket.on('error', reject);
  });
}

// ── S1: the regression — a daemon that NEVER gets a keepalive self-exits ─────
//
// Before the fix this FAILED: the edge-triggered close handler never fired (no
// keepalive socket ever opened/closed), so the daemon stayed alive until the
// test's own liveness timeout. After the fix the level-triggered poll sees the
// zero-client condition and reaps it within grace + drain.
test('no-client daemon self-exits: zero keepalives, level-triggered poll reaps it', async () => {
  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, { workerKeepaliveS: 0, drainTimeoutMs: MIN_DRAIN_TIMEOUT_MS });

  const { pid, logPath } = await spawnWatchdog(configDir);
  // Daemon is fully up with a ready worker and zero keepalives. Upper bound on
  // self-exit = first poll tick + grace + drain + slack.
  const deadline = POLL_INTERVAL_MS + KEEPALIVE_GRACE_MS + MIN_DRAIN_TIMEOUT_MS + 3000;

  const exited = await pollUntil(() => !isAlive(pid), { timeoutMs: deadline, stepMs: 100 });
  assert.equal(exited, true,
    `daemon (pid ${pid}) should have self-exited with no client within ${deadline}ms; daemon log:\n${safeRead(logPath)}`);
});

// ── S2: guard — a daemon WITH a live keepalive is NOT reaped ─────────────────
//
// The poll must be gated strictly on zero keepalives: a daemon actively serving
// via a live control keepalive must stay up. We hold a keepalive open across a
// window comfortably longer than grace + drain; if the poll reaped it, the
// daemon would die mid-window.
test('guard: a daemon WITH a live keepalive is not reaped by the poll', async () => {
  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, { workerKeepaliveS: 0, drainTimeoutMs: MIN_DRAIN_TIMEOUT_MS });

  const { pid, port } = await spawnWatchdog(configDir);
  const keepalive = await openKeepalive(configDir, port);
  try {
    // Wait well past grace + drain + a couple of poll ticks. If the poll ignored
    // the live keepalive, the daemon stays alive here.
    const survived = await pollUntil(() => !isAlive(pid),
      { timeoutMs: KEEPALIVE_GRACE_MS + MIN_DRAIN_TIMEOUT_MS + POLL_INTERVAL_MS * 2 + 2000, stepMs: 200 });
    assert.equal(survived, false, `daemon (pid ${pid}) must NOT be reaped while a keepalive is open`);
    assert.equal(isAlive(pid), true, 'daemon still alive with a live keepalive');
  } finally {
    keepalive.destroy();
  }
});

// ── S3: guard — workerKeepaliveS === -1 (pinned) is NOT reaped ───────────────
//
// workerKeepaliveS === -1 means "never auto-drain" (keepalive disabled / the
// daemon is pinned up). The poll must honor this gate and never exit such a
// daemon even with zero clients.
test('guard: workerKeepaliveS === -1 daemon is not reaped (never auto-drain)', async () => {
  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, { workerKeepaliveS: -1, drainTimeoutMs: MIN_DRAIN_TIMEOUT_MS });

  const { pid } = await spawnWatchdog(configDir);
  // Zero keepalives, but policy is -1. Wait past the window that would otherwise
  // reap a workerKeepaliveS: 0 daemon.
  const reaped = await pollUntil(() => !isAlive(pid),
    { timeoutMs: KEEPALIVE_GRACE_MS + MIN_DRAIN_TIMEOUT_MS + POLL_INTERVAL_MS * 2 + 2000, stepMs: 200 });
  assert.equal(reaped, false, `daemon (pid ${pid}) must NOT be reaped when workerKeepaliveS === -1`);
  assert.equal(isAlive(pid), true, '-1 daemon still alive');
});
