// Regression test for the dead upstream-timeout knob (T-qcqzf3nn).
//
// The config carries daemon.upstreamTimeoutMs but the proxy never wired
// proxyReq.setTimeout(). A connected-but-hung upstream would hang indefinitely.
// After the fix, the proxy destroys the request after upstreamTimeoutMs of
// inactivity, surfacing ETIMEDOUT → 504 Gateway Timeout.
//
// ⛔ ISOLATION: real watchdog + worker on an ephemeral port, mock hung upstream,
// per-test CCB_CONFIG_DIR. Never touches live 9099.
//
//     node --test test/upstream-timeout.test.js

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, '..');
const WATCHDOG_BIN = path.join(PKG_ROOT, 'bin', 'ccb-watchdog.js');

const spawnedPids = new Set();
const tmpDirs = new Set();
const upstreamServers = new Set();
const openSockets = new Set();

afterEach(async () => {
  for (const pid of spawnedPids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  spawnedPids.clear();
  for (const sock of openSockets) {
    try { sock.destroy(); } catch { /* already gone */ }
  }
  openSockets.clear();
  for (const srv of upstreamServers) {
    await new Promise(resolve => srv.close(resolve));
  }
  upstreamServers.clear();
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  tmpDirs.clear();
});

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function pollUntil(predicate, { timeoutMs = 10000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result) return true;
    if (Date.now() >= deadline) return false;
    await delay(stepMs);
  }
}

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-timeout-'));
  tmpDirs.add(dir);
  return dir;
}

function writeIsolatedConfig(configDir, { upstreamPort, upstreamTimeoutMs }) {
  const config = {
    port: 0,
    daemon: {
      healthCheckTimeoutMs: 1000,
      pollIntervalMs: 100,
      pollMaxAttempts: 5,
      upstreamTimeoutMs,
      workerInitTimeoutMs: 5000,
      drainTimeoutMs: 1000,
      workerKeepaliveS: -1,
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
      hung: { url: `http://127.0.0.1:${upstreamPort}/v1`, anthropicCompliant: true, models: ['hung-model'] },
    },
    routes: { models: {}, properties: {}, payloadSize: {} },
  };
  fs.writeFileSync(path.join(configDir, 'providers.json'), JSON.stringify(providers, null, 2), 'utf8');
  fs.writeFileSync(path.join(configDir, '.env'), 'ZAI_KEY=throwaway\nHUNG_KEY=throwaway\n', 'utf8');
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

  const runtimePath = path.join(configDir, 'runtime.json');
  const ready = await pollUntil(() => {
    try {
      const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
      return typeof rt.port === 'number';
    } catch { return false; }
  }, { timeoutMs: 15000 });
  assert.ok(ready, `watchdog never came ready`);
  const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  return { port: rt.port, logPath };
}

// ── (a) Hung upstream returns 504 after upstreamTimeoutMs ───────────────────
test('hung upstream returns 504 after upstreamTimeoutMs', async () => {
  // Upstream accepts the connection but never sends a response.
  const hungUpstream = http.createServer((req, res) => {
    // Intentionally do nothing — simulate a connected-but-hung upstream.
  });
  hungUpstream.on('connection', (sock) => openSockets.add(sock));
  await new Promise(resolve => hungUpstream.listen(0, '127.0.0.1', resolve));
  upstreamServers.add(hungUpstream);
  const upstreamPort = hungUpstream.address().port;

  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, { upstreamPort, upstreamTimeoutMs: 1500 });
  const { port } = await spawnWatchdog(configDir);

  const start = Date.now();
  const response = await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify({ model: 'hung-model', messages: [{ role: 'user', content: 'test' }] }));
    req.end();
  });
  const elapsed = Date.now() - start;

  assert.equal(response.status, 504, `expected 504, got ${response.status}: ${response.body}`);
  assert.ok(elapsed < 10000, `timeout took ${elapsed}ms, expected ~1500ms`);
  assert.ok(elapsed >= 1000, `timeout fired too early (${elapsed}ms)`);

  const parsed = JSON.parse(response.body);
  assert.equal(parsed.error.type, 'upstream_error');
  assert.ok(/ETIMEDOUT|timeout/i.test(parsed.error.code || parsed.error.message),
    `error should mention timeout: ${JSON.stringify(parsed.error)}`);
});

// ── (b) upstreamTimeoutMs: 0 disables the timeout ──────────────────────────
// With timeout=0, a hung upstream should NOT get a 504 within the window
// that would otherwise trigger (1500ms from test a). We wait 2s and verify
// no response arrived, then abort the request ourselves.
test('upstreamTimeoutMs: 0 disables timeout (request hangs until cancelled)', { timeout: 12000 }, async () => {
  const hungUpstream = http.createServer(() => { /* never responds */ });
  hungUpstream.on('connection', (sock) => openSockets.add(sock));
  await new Promise(resolve => hungUpstream.listen(0, '127.0.0.1', resolve));
  upstreamServers.add(hungUpstream);
  const upstreamPort = hungUpstream.address().port;

  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, { upstreamPort, upstreamTimeoutMs: 0 });
  const { port } = await spawnWatchdog(configDir);

  let gotResponse = false;
  const req = http.request(
    { hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json' } },
    () => { gotResponse = true; }
  );
  req.on('error', () => {}); // suppress abort error
  req.write(JSON.stringify({ model: 'hung-model', messages: [{ role: 'user', content: 'test' }] }));
  req.end();

  await delay(2500);
  assert.equal(gotResponse, false, 'with timeout=0, proxy should not have responded within 2.5s');
  req.destroy();
});
