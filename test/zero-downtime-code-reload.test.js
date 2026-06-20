// Zero-downtime code-reload regression tests (Phase B).
//
// Verifies that editing src/proxy.js or src/proxy-core.js triggers a watchdog
// restart where the OLD worker finishes in-flight streams before exiting and
// the NEW worker serves new requests. Also verifies the debounce coalesces
// rapid editor save-storms into a single restart.
//
// Mechanism: the watchdog watches the src/ directory via watchConfigFile. On
// change it debounces (CODE_RELOAD_DEBOUNCE_MS = 300ms) then calls
// triggerRestart('proxy code change'). The existing parallel-restart path
// (SO_REUSEPORT) moves the old worker to the draining pool and spawns a new
// one from the live working tree. The old worker's drain handler polls
// core.activeConnections and exits only at zero — so an in-flight SSE stream
// keeps it alive until the stream closes.
//
// ⛔ ISOLATION CONTRACT — same as watchdog-true-orphan-reap.test.js: real
// binaries, per-test CCB_CONFIG_DIR, ephemeral ports, no live-9099 contact.
//
//     node --test test/zero-downtime-code-reload.test.js

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, '..');
const WATCHDOG_BIN = path.join(PKG_ROOT, 'bin', 'ccb-watchdog.js');

const CODE_RELOAD_DEBOUNCE_MS = 300;
const MIN_DRAIN_TIMEOUT_MS = 1000;

// ── Throwaway-resource bookkeeping ──────────────────────────────────────────
const spawnedPids = new Set();
const tmpDirs = new Set();
const socketsToClose = new Set();
const upstreamServers = new Set();

afterEach(async () => {
  for (const sock of socketsToClose) {
    try { sock.destroy(); } catch { /* already gone */ }
  }
  socketsToClose.clear();
  for (const pid of spawnedPids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  spawnedPids.clear();
  for (const srv of upstreamServers) {
    await new Promise(resolve => srv.close(resolve));
  }
  upstreamServers.clear();
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  tmpDirs.clear();
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function pollUntil(predicate, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result) return true;
    if (Date.now() >= deadline) return false;
    await delay(stepMs);
  }
}

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-reload-'));
  tmpDirs.add(dir);
  return dir;
}

function safeRead(logPath) {
  try { return fs.readFileSync(logPath, 'utf8'); } catch { return '(no log)'; }
}

function controlIpcPath(configDir, port) {
  return path.join(configDir, `ccb-ctrl-${port}.sock`);
}

function writeIsolatedConfig(configDir, { workerKeepaliveS = -1, drainTimeoutMs = MIN_DRAIN_TIMEOUT_MS, port = 0, upstreamPort } = {}) {
  const upstreamUrl = upstreamPort
    ? `http://127.0.0.1:${upstreamPort}/v1`
    : 'http://127.0.0.1:1/v1';

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
      isolated: { url: upstreamUrl, anthropicCompliant: true, models: ['test-model'] },
    },
    routes: { models: {}, properties: {}, payloadSize: {} },
  };
  fs.writeFileSync(path.join(configDir, 'providers.json'), JSON.stringify(providers, null, 2), 'utf8');
  fs.writeFileSync(path.join(configDir, '.env'), 'ZAI_KEY=throwaway-not-a-real-key\nISOLATED_KEY=throwaway-not-a-real-key\n', 'utf8');
}

async function pollUntilReady(configDir) {
  const runtimePath = path.join(configDir, 'runtime.json');
  const got = await pollUntil(() => {
    if (!fs.existsSync(runtimePath)) return false;
    try {
      const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
      return typeof runtime.port === 'number' && typeof runtime.watchdogPid === 'number';
    } catch { return false; }
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
  assert.ok(runtime !== null, `watchdog never came ready; log:\n${safeRead(logPath)}`);
  return { pid: child.pid, port: runtime.port, watchdogPid: runtime.watchdogPid, logPath };
}

async function activeWorkerPid(configDir, port) {
  const s = await sendControl(configDir, port, { cmd: 'sessions' });
  const active = Array.isArray(s.workers) ? s.workers.find(w => w.status === 'active') : null;
  return active ? active.pid : null;
}

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
        try { resolve(JSON.parse(buf.slice(0, nl))); socket.destroy(); }
        catch (e) { reject(e); }
      }
    });
    socket.on('error', reject);
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('control IPC timeout')); });
  });
}

function touchFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  fs.writeFileSync(filePath, content, 'utf8');
}

// ── (a) Touch src/proxy.js → watchdog triggers a code-reload restart ────────
//
// The core smoke test: editing a watched source file triggers
// triggerRestart('proxy code change'). The watchdog log shows the source-change
// detection and a new worker comes up on a different PID. The old worker (with
// no in-flight requests) is reaped by the true-orphan drain (Phase A).
test('(a) touching src/proxy.js triggers a code-reload restart', async () => {
  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, { workerKeepaliveS: -1, drainTimeoutMs: MIN_DRAIN_TIMEOUT_MS });
  const { port, logPath } = await spawnWatchdog(configDir);

  const firstPid = await activeWorkerPid(configDir, port);
  assert.ok(firstPid !== null, `no active worker; log:\n${safeRead(logPath)}`);

  touchFile(path.join(PKG_ROOT, 'src', 'proxy.js'));

  const restarted = await pollUntil(
    async () => {
      const pid = await activeWorkerPid(configDir, port);
      return pid !== null && pid !== firstPid;
    },
    { timeoutMs: 10000, stepMs: 150 }
  );
  assert.ok(restarted, `code-reload did not produce a new active worker; log:\n${safeRead(logPath)}`);

  const logContent = safeRead(logPath);
  assert.ok(
    /Source change detected.*proxy\.js.*triggering code reload|proxy code change/.test(logContent),
    `no code-reload log line; log tail:\n${logContent.split('\n').slice(-20).join('\n')}`
  );
});

// ── (b) In-flight stream survives reload — old worker drains, new serves ────
//
// A slow upstream response is in flight when the source file is touched. The
// old worker must NOT terminate until the stream closes. A new request after
// the new worker is ready must hit the new worker.
test('(b) in-flight stream completes on old worker during code reload', async () => {
  // Slow upstream: sends a first chunk immediately, then holds the connection
  // open until we explicitly resolve the promise. This ensures the proxy has an
  // in-flight activeConnection during the code-reload restart.
  let slowResolve;
  const slowReady = new Promise(r => { slowResolve = r; });
  let upstreamReqHandler;
  const upstreamDone = new Promise(r => { upstreamReqHandler = r; });
  const slowUpstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: chunk1\n\n');
    upstreamDone.then(() => {
      res.write('data: chunk2\n\n');
      res.end();
    });
    slowResolve();
  });
  await new Promise(resolve => slowUpstream.listen(0, '127.0.0.1', resolve));
  upstreamServers.add(slowUpstream);
  const upstreamPort = slowUpstream.address().port;

  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, {
    workerKeepaliveS: -1,
    drainTimeoutMs: 10000,
    upstreamPort,
  });
  const { port, logPath } = await spawnWatchdog(configDir);
  const firstPid = await activeWorkerPid(configDir, port);
  assert.ok(firstPid !== null);

  // Start a streaming request through the proxy to the slow upstream.
  const streamChunks = [];
  let streamEnded = false;
  let streamError = null;
  const streamReq = http.request(
    { hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'throwaway-not-a-real-key' } },
    (res) => {
      res.on('data', (chunk) => streamChunks.push(chunk.toString()));
      res.on('end', () => { streamEnded = true; });
      res.on('error', (e) => { streamError = e; });
    }
  );
  streamReq.on('error', (e) => { streamError = e; });
  streamReq.write(JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] }));
  streamReq.end();

  // Wait for the upstream to have received the request AND the first chunk to
  // arrive at the client — the stream is definitively in-flight.
  await slowReady;
  await pollUntil(() => streamChunks.length > 0, { timeoutMs: 5000, stepMs: 50 });

  // Trigger code reload while stream is in flight.
  touchFile(path.join(PKG_ROOT, 'src', 'proxy.js'));

  // Wait for a new active worker (different PID).
  const restarted = await pollUntil(
    async () => {
      const pid = await activeWorkerPid(configDir, port);
      return pid !== null && pid !== firstPid;
    },
    { timeoutMs: 10000, stepMs: 150 }
  );
  assert.ok(restarted, `code-reload restart did not complete; log:\n${safeRead(logPath)}`);

  // Old worker should still be alive (in-flight stream holds activeConnections > 0).
  assert.ok(isAlive(firstPid),
    `old worker (PID ${firstPid}) died before stream finished; log:\n${safeRead(logPath)}`);
  assert.ok(!streamEnded, 'stream should still be open');
  assert.ok(streamError === null, `stream error: ${streamError}`);

  // Complete the slow upstream response.
  upstreamReqHandler();

  // Stream finishes cleanly.
  await pollUntil(() => streamEnded, { timeoutMs: 5000, stepMs: 50 });
  assert.ok(streamEnded, 'stream did not end after upstream completed');
  assert.ok(streamError === null, `stream error after completion: ${streamError}`);
  assert.ok(streamChunks.some(c => c.includes('chunk2')),
    `did not receive final chunk; got: ${streamChunks.join('')}`);

  // After stream closes, old worker drains and exits.
  const exited = await pollUntil(() => !isAlive(firstPid),
    { timeoutMs: MIN_DRAIN_TIMEOUT_MS + 5000, stepMs: 100 });
  assert.ok(exited,
    `old worker (PID ${firstPid}) did not exit after stream closed; log:\n${safeRead(logPath)}`);
});

// ── (c) Debounce coalesces rapid saves into a single restart ────────────────
//
// An editor save-storm (N rapid saves within CODE_RELOAD_DEBOUNCE_MS) must
// produce only ONE restart, not N. We touch the file multiple times rapidly
// and assert only one "Restart requested" log line appears after the debounce.
test('(c) debounce coalesces rapid saves into one restart', async () => {
  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, { workerKeepaliveS: -1, drainTimeoutMs: MIN_DRAIN_TIMEOUT_MS });
  const { port, logPath } = await spawnWatchdog(configDir);

  const firstPid = await activeWorkerPid(configDir, port);
  assert.ok(firstPid !== null);

  // Rapid save-storm: 5 touches within 100ms (well within debounce window).
  const proxyPath = path.join(PKG_ROOT, 'src', 'proxy.js');
  for (let i = 0; i < 5; i++) {
    touchFile(proxyPath);
    await delay(20);
  }

  // Wait for the debounce to fire + restart to complete.
  const restarted = await pollUntil(
    async () => {
      const pid = await activeWorkerPid(configDir, port);
      return pid !== null && pid !== firstPid;
    },
    { timeoutMs: 10000, stepMs: 150 }
  );
  assert.ok(restarted, `no restart after save-storm; log:\n${safeRead(logPath)}`);

  // Count restart lines — should be exactly 1 from the code-reload path.
  const logContent = safeRead(logPath);
  const codeReloadLines = logContent.split('\n')
    .filter(l => /Source change detected/.test(l));
  assert.equal(codeReloadLines.length, 1,
    `expected 1 code-reload trigger from save-storm, got ${codeReloadLines.length}; ` +
    `lines:\n${codeReloadLines.join('\n')}\nfull log tail:\n${logContent.split('\n').slice(-20).join('\n')}`);
});

// ── (d) Touching src/proxy-core.js also triggers reload ─────────────────────
test('(d) touching src/proxy-core.js triggers code reload', async () => {
  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, { workerKeepaliveS: -1, drainTimeoutMs: MIN_DRAIN_TIMEOUT_MS });
  const { port, logPath } = await spawnWatchdog(configDir);

  const firstPid = await activeWorkerPid(configDir, port);
  assert.ok(firstPid !== null);

  touchFile(path.join(PKG_ROOT, 'src', 'proxy-core.js'));

  const restarted = await pollUntil(
    async () => {
      const pid = await activeWorkerPid(configDir, port);
      return pid !== null && pid !== firstPid;
    },
    { timeoutMs: 10000, stepMs: 150 }
  );
  assert.ok(restarted, `code-reload did not fire for proxy-core.js; log:\n${safeRead(logPath)}`);

  const logContent = safeRead(logPath);
  assert.ok(
    /Source change detected.*proxy-core\.js/.test(logContent),
    `no proxy-core.js change log line; log tail:\n${logContent.split('\n').slice(-20).join('\n')}`
  );
});
