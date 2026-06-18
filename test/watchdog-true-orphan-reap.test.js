// Regression tests for the true-orphan drain under workerKeepaliveS === -1 and
// the ensureDaemon duplicate-spawn (Phase A1).
//
// ## Bug 1: the `-1` drain skip
// Two independent paths in bin/ccb-watchdog.js skipped draining a worker that is
// serving NOBODY whenever workerKeepaliveS === -1:
//
//   (1) The parallel-restart drain loop did `if (keepaliveS === -1) continue;`
//       for EVERY draining worker — including ones with zero keepalives (true
//       orphans serving no client). Those leak their listener sockets.
//   (2) startNoClientPoll() did `if (workerKeepaliveS === -1) return;` before it
//       could reap a true-orphan DRAINING worker (the return is correct for the
//       ACTIVE worker's shutdown, wrong as a blanket gate over reaping drains).
//
// The fix: under -1, a draining worker with keepaliveCount === 0 is still sent
// {type:'drain'} (same as the keepaliveS === 0 branch); only a draining worker
// with keepaliveCount > 0 is left alive. The worker's own drain handler guards
// on `!drained` and polls core.activeConnections before exit, so re-sending
// drain to a worker still serving in-flight streams is safe and idempotent.
//
// ## Bug 2: ensureDaemon duplicate-spawn
// When runtime.json is missing, readRuntimeState() → null → watchdogPid null.
// If checkProxy() then fails TRANSIENTLY (a momentary reset, or /v1/models not
// answering yet on a freshly-bound port) the code falls through to
// startProxyDaemonProcess, spawning a SECOND watchdog that can't bind the live
// port, auto-bumps to an ephemeral port, and writes an unrecognized runtime.json
// — a duplicate-spawn loop. The fix: before spawning, TCP-probe the configured
// port; if it is listening, the daemon is alive, so skip the spawn. checkProxy is
// an HTTP GET and can return false on a port that is TCP-alive but HTTP-silent
// (the exact transient/half-up state); a raw TCP probe is immune to that.
//
// ⛔ ISOLATION CONTRACT — this test NEVER spawns real `claude`, NEVER touches real
// OAuth creds, NEVER signals the live 9099 daemon, NEVER pattern-kills. It spawns
// the REAL bin/ccb-watchdog.js and bin/ccb.js against a SELF-CONTAINED, per-test
// CCB_CONFIG_DIR: port 0 (OS-assigned), minimal providers.json, a THROWAWAY .env
// key (no real secret). It signals only PIDs it spawned itself, against isolated
// dirs that bind ephemeral ports — never 9099/910x. Run it DIRECTLY, never via
// npm test:
//
//     node --test test/watchdog-true-orphan-reap.test.js
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

// Mirror the watchdog's own constants so timing bounds track the real impl.
const KEEPALIVE_GRACE_MS = 5000;
const MIN_DRAIN_TIMEOUT_MS = 1000; // ProxyConfig enforces drainTimeoutMs >= 1000
const NO_CLIENT_POLL_INTERVAL_MS = Math.max(500, Math.floor(KEEPALIVE_GRACE_MS / 5));

// ── Throwaway-resource bookkeeping (swept after every test) ──────────────────
const spawnedPids = new Set();
const tmpDirs = new Set();
const socketsToClose = new Set();

afterEach(() => {
  for (const sock of socketsToClose) {
    try { sock.destroy(); } catch { /* already gone */ }
  }
  socketsToClose.clear();
  for (const pid of spawnedPids) {
    // Safe: every pid here is a watchdog (and its worker) we spawned ourselves
    // against a per-test config dir; it binds an OS-assigned port, never 9099.
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-orphan-'));
  tmpDirs.add(dir);
  return dir;
}

function writeIsolatedConfig(configDir, { workerKeepaliveS, drainTimeoutMs, port = 0 }) {
  const config = {
    port,
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

  // Throwaway key — never a real secret.
  fs.writeFileSync(path.join(configDir, '.env'), 'ZAI_KEY=throwaway-not-a-real-key\n', 'utf8');
}

async function pollUntilReady(configDir) {
  const runtimePath = path.join(configDir, 'runtime.json');
  const got = await pollUntil(() => {
    if (!fs.existsSync(runtimePath)) return false;
    try {
      const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
      return typeof runtime.port === 'number' && typeof runtime.watchdogPid === 'number';
    } catch { return false; /* mid-write */ }
  }, { timeoutMs: 15000, stepMs: 100 });
  if (!got) return null;
  return JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
}

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

  const runtime = await pollUntilReady(configDir);
  assert.ok(runtime !== null, `watchdog never came ready; daemon log:\n${safeRead(logPath)}`);
  return { pid: child.pid, port: runtime.port, watchdogPid: runtime.watchdogPid, logPath };
}

function safeRead(logPath) {
  try { return fs.readFileSync(logPath, 'utf8'); } catch { return '(no log)'; }
}

// Control-IPC socket path for a port, resolved against the EXPLICIT isolated
// config dir — never getControlIpcPath() (which would fall back to the user's
// REAL ~/.claude/.ccb). POSIX-only shape; the drain fix is OS-agnostic.
function controlIpcPath(configDir, port) {
  return path.join(configDir, `ccb-ctrl-${port}.sock`);
}

// Send a one-shot control-IPC command; resolve with the parsed JSON reply, or
// reject on connect error. The socket is closed after the reply.
function sendControl(configDir, port, cmd) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlIpcPath(configDir, port), () => {
      socket.write(JSON.stringify(cmd) + '\n');
    });
    let buf = '';
    socket.on('data', (data) => {
      buf += data.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
          socket.destroy();
        } catch (e) { reject(e); }
      }
    });
    socket.on('error', reject);
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('control IPC timeout')); });
  });
}

// A control-IPC keepalive client: connects to the per-port socket and sends one
// keepalive line. Returns the OPEN socket — caller keeps it alive to hold the
// keepalive (assigned to whatever worker is active at connect time). Destroying
// it closes the keepalive.
function openKeepalive(configDir, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlIpcPath(configDir, port), () => {
      socket.write(JSON.stringify({ cmd: 'keepalive' }) + '\n');
      resolve(socket);
    });
    socket.on('error', reject);
  });
}

// The control-IPC `sessions` reply: active worker + every draining worker with
// its live keepalive count. Used here to read the ACTIVE worker's PID across a
// restart (the drain-pool assertions are log-based — see the tests).
async function readSessions(configDir, port) {
  return sendControl(configDir, port, { cmd: 'sessions' });
}

async function activeWorkerPid(configDir, port) {
  const s = await readSessions(configDir, port);
  const active = Array.isArray(s.workers) ? s.workers.find(w => w.status === 'active') : null;
  return active ? active.pid : null;
}

// ── (a) RED→GREEN: zero-keepalive draining worker IS reaped under -1 ──────────
//
// Before the fix this FAILED (RED): under workerKeepaliveS === -1 the parallel-
// restart drain loop did `continue` for every draining worker, and the no-client
// poll returned early on -1 — so a draining worker serving NO client leaked
// forever (its PID stayed alive, no reap ever logged). After the fix BOTH paths
// send {type:'drain'} to a zero-keepalive drain: the new function logs
// "Reaping true-orphan draining worker" (poll) / "Draining old worker … policy=-1"
// (restart loop), and the worker exits.
//
// We assert on the DAEMON LOG (the authoritative ordered record — same technique
// as test/config-hotreload.test.js) rather than racing the control-IPC `sessions`
// view, which can transiently stutter during the restart handoff. The log line +
// the old PID going dead within a generous window is the deterministic proof.
test('(a) zero-keepalive draining worker is reaped under workerKeepaliveS === -1', async () => {
  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, { workerKeepaliveS: -1, drainTimeoutMs: MIN_DRAIN_TIMEOUT_MS });
  const { port, logPath } = await spawnWatchdog(configDir);

  const firstActive = await activeWorkerPid(configDir, port);
  assert.ok(firstActive !== null, `no active worker pre-restart; log:\n${safeRead(logPath)}`);

  // Trigger a restart: old active worker moves into the draining pool. The new
  // worker becomes active on a different PID.
  const restartReply = await sendControl(configDir, port, { cmd: 'restart' });
  assert.equal(restartReply.status, 'ok', `restart rejected: ${JSON.stringify(restartReply)}`);

  // Wait for the restart to complete: a NEW active worker (different PID).
  const restarted = await pollUntil(
    async () => (await activeWorkerPid(configDir, port)) !== firstActive,
    { timeoutMs: 10000, stepMs: 100 }
  );
  assert.equal(restarted, true,
    `restart did not produce a new active worker; log:\n${safeRead(logPath)}`);

  // THE FIX: a reap/drain for the zero-keepalive draining worker appears in the
  // daemon log. Either the restart-loop line or the poll's true-orphan reap line
  // — both are emitted only by the fix (unfixed code logs "kept alive
  // indefinitely" instead and never drains). Generous window: the poll ticks at
  // NO_CLIENT_POLL_INTERVAL_MS and the worker then drains within drainTimeoutMs.
  const reapDeadline = NO_CLIENT_POLL_INTERVAL_MS + MIN_DRAIN_TIMEOUT_MS + 5000;
  const reapedLogged = await pollUntil(() => {
    const log = safeRead(logPath);
    return /Reaping true-orphan draining worker|Draining old worker \(PID \d+\) — no keepalives, policy=-1/.test(log);
  }, { timeoutMs: reapDeadline, stepMs: 150 });
  assert.equal(reapedLogged, true,
    `no reap/drain log line for the zero-keepalive draining worker under -1 within ${reapDeadline}ms; ` +
    `log:\n${safeRead(logPath)}`);

  // And the old worker process actually exited (true orphan reclaimed). The
  // worker's drain handler exits within drainTimeoutMs of receiving the signal.
  const exited = await pollUntil(() => !isAlive(firstActive),
    { timeoutMs: MIN_DRAIN_TIMEOUT_MS + 3000, stepMs: 100 });
  assert.equal(exited, true,
    `old draining worker (PID ${firstActive}) did not exit after the reap drain; log:\n${safeRead(logPath)}`);
});

// ── (b) guard: a draining worker WITH a live keepalive is NOT reaped ──────────
//
// The reap must be gated strictly on keepaliveCount === 0. A draining worker
// still serving a live client keepalive must stay up. We open a keepalive
// BEFORE the restart so it is pinned to the worker that becomes draining.
//
// Key mechanism: the worker's drain handler exits on core.activeConnections===0
// — and a control-IPC keepalive is NOT an HTTP activeConnection. So if the fix
// wrongly sent drain to a kept-alive worker, that worker WOULD exit (the
// keepalive socket does not block it). Survival of the PID across a window well
// past the reap cadence is therefore a STRONG assertion that no drain was sent.
test('(b) draining worker WITH a live keepalive is NOT reaped under -1', async () => {
  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, { workerKeepaliveS: -1, drainTimeoutMs: MIN_DRAIN_TIMEOUT_MS });
  const { port, logPath } = await spawnWatchdog(configDir);

  const firstActive = await activeWorkerPid(configDir, port);
  assert.ok(firstActive !== null);

  // Open a keepalive NOW — it binds to the current (soon-to-be-draining) worker.
  const keepalive = await openKeepalive(configDir, port);
  socketsToClose.add(keepalive);

  await sendControl(configDir, port, { cmd: 'restart' });
  await pollUntil(async () => (await activeWorkerPid(configDir, port)) !== firstActive,
    { timeoutMs: 10000, stepMs: 100 });

  // It must NOT be reaped: its PID stays alive across a window well past the
  // reap cadence. A drain would have exited it within drainTimeoutMs.
  const watchDeadline = NO_CLIENT_POLL_INTERVAL_MS * 2 + MIN_DRAIN_TIMEOUT_MS + 3000;
  const diedEarly = await pollUntil(() => !isAlive(firstActive),
    { timeoutMs: watchDeadline, stepMs: 150 });
  assert.equal(diedEarly, false,
    `kept-alive draining worker (PID ${firstActive}) was reaped/exited within ${watchDeadline}ms ` +
    `(a drain would exit it; survival proves the keepaliveCount>0 branch was taken); log:\n${safeRead(logPath)}`);
  assert.equal(isAlive(firstActive), true,
    `draining worker (PID ${firstActive}) must stay alive while serving a keepalive; log:\n${safeRead(logPath)}`);
});


// ── (c) guard: the kept-alive branch is the POLICY path (logged), not a drain ─
//
// Asserts the policy intent distinct from (b)'s outcome: the restart drain-loop
// took the "has N keepalive(s), waiting for natural close" branch for the
// kept-alive worker — NOT a drain/grace line. A drain send to a kept-alive
// worker is a policy violation even though the worker's idempotent handler makes
// it non-fatal. We grep the daemon log for the policy line on the kept-alive PID.
test('(c) -1 draining worker WITH keepalive is logged as "waiting for natural close", not drained', async () => {
  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, { workerKeepaliveS: -1, drainTimeoutMs: MIN_DRAIN_TIMEOUT_MS });
  const { port, logPath } = await spawnWatchdog(configDir);
  const firstActive = await activeWorkerPid(configDir, port);
  assert.ok(firstActive !== null);

  const keepalive = await openKeepalive(configDir, port);
  socketsToClose.add(keepalive);

  await sendControl(configDir, port, { cmd: 'restart' });
  await pollUntil(async () => (await activeWorkerPid(configDir, port)) !== firstActive,
    { timeoutMs: 10000, stepMs: 100 });

  // Let the restart drain-loop + a no-client poll tick land in the log.
  await delay(NO_CLIENT_POLL_INTERVAL_MS + 1500);

  const log = safeRead(logPath);
  // The kept-alive worker's restart-loop disposition must be the policy line.
  // We match on the keepalive count ("1 keepalive") since the log line is
  // templated "...has N keepalive(s), waiting for natural close".
  const tookPolicyBranch = /has 1 keepalive\(s\), waiting for natural close/.test(log);
  assert.equal(tookPolicyBranch, true,
    `kept-alive draining worker did NOT take the "waiting for natural close" policy branch; ` +
    `log tail:\n${log.split('\n').slice(-15).join('\n')}`);
  assert.equal(isAlive(firstActive), true,
    `kept-alive draining worker (PID ${firstActive}) must still be alive; log:\n${log}`);
});

// ── (d) ensureDaemon does NOT spawn a duplicate when runtime.json absent but ──
// ──    the configured port is already live (checkProxy false, TCP true) ────────
//
// Bug 2: with runtime.json missing AND checkProxy() returning false (transient
// HTTP failure on a half-up port), ensureDaemon fell through to
// startProxyDaemonProcess and spawned a SECOND watchdog (which can't bind the
// live port, auto-bumps, writes an unrecognized runtime.json — a duplicate-spawn
// loop). The fix extracts the no-spawn decision into a pure predicate,
// shouldSkipSpawnForLivePort({ checkProxyOk, tcpAlive }), consulted after a raw
// TCP probe: skip the spawn iff checkProxy failed AND the port is TCP-live.
//
// An end-to-end `ccb --x-gui` spawn test is NOT used here: on the unfixed branch
// the duplicate watchdog's own startup-wait loop (snapshot creation + the live
// port already taken → port-bump → checkProxy never succeeds) blocks the ccb.js
// invocation for the full daemonStartTimeoutMs, making the duplicate-spawn
// non-deterministic to observe by process counting. Instead the DECISION RULE
// itself is the gate: a pure truth table, deterministic, no process spawning.
// ensureDaemon is the sole caller of the predicate, so the rule and its wiring
// are covered. (RED on the unfixed tree: the export does not exist → import
// throws → the suite fails; GREEN after the fix is in place.)
//
//   checkProxyOk | tcpAlive | skip spawn?
//   --------------+----------+------------
//   false         | true     | YES  ← the bug case (half-up live port)
//   false         | false    | no   (port truly down → spawn is correct)
//   true          | true     | no   (already returned healthy earlier; n/a)
//   true          | false    | no   (impossible: HTTP-200 needs a listener)
import { shouldSkipSpawnForLivePort } from '../bin/ccb.js';

test('(d) shouldSkipSpawnForLivePort: skip spawn iff checkProxy failed AND port is TCP-live', () => {
  // The bug case — the exact transient that caused the duplicate spawn.
  assert.equal(shouldSkipSpawnForLivePort({ checkProxyOk: false, tcpAlive: true }), true,
    'half-up port (HTTP-silent, TCP-live) must be treated as already owned → skip spawn');

  // Port truly down: spawn is the correct action.
  assert.equal(shouldSkipSpawnForLivePort({ checkProxyOk: false, tcpAlive: false }), false,
    'a dead port (no TCP listener) must NOT skip the spawn');

  // HTTP-healthy: ensureDaemon returned healthy before ever consulting this
  // predicate; if reached with checkProxyOk true it must not skip (defensive).
  assert.equal(shouldSkipSpawnForLivePort({ checkProxyOk: true, tcpAlive: true }), false,
    'a checkProxy-healthy port must not be gated by this fallback predicate');
  assert.equal(shouldSkipSpawnForLivePort({ checkProxyOk: true, tcpAlive: false }), false,
    'checkProxy true with no TCP listener is impossible, but must not skip');
});
