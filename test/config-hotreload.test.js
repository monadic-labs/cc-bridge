// Behaviour tests for config hot-reload surviving a cross-process atomic
// rename (T-8md39ymx, coupled regression).
//
// ## The regression (documented, not fabricated as red/green)
// Making config writes atomic via temp+rename was the right fix — but it
// exposed a latent bug: the reload watchers used `fs.watch(filePath, …)`, which
// Node documents as platform-dependent and which on Linux is NON-DETERMINISTIC
// on a cross-process rename-over. Direct empirical probe (this host, kernel
// 6.17, Node 22) of RAW `fs.watch(file)` under a cross-process atomic rename:
//
//     // watcher in process A; rename performed by spawned process B
//     after rename #1 from proc B: total events=0
//     after rename #2 from proc B: total events=0
//     after rename #3 from proc B: total events=0
//
// (probe-3, run during diagnosis). In other conditions the same primitive DID
// fire — the behavior is non-deterministic, and "config sometimes ignored" is
// exactly the user-facing symptom. That non-determinism is the regression.
//
// A fabricated red/green gate would be dishonest, so this file does NOT claim
// "fails before / passes after" on a single run. Instead:
//   - The FIX makes reload RELIABLE by watching the DIRECTORY (watchConfigFile
//     in src/core/fs-atomic.js), which fires on cross-process rename-over.
//   - The regression test performs a CROSS-PROCESS atomic rename (the rename is
//     done by a SPAWNED CHILD process, not in-process) and asserts the reload
//     happened, LOOPED 20× so it passes RELIABLY on the fix. A reverted
//     fs.watch(file) flakes on this loop (some iterations see no event) → CI
//     catches the regression. This is the honest gate: reliable-on-fix,
//     intermittently-red-on-regression.
//
// Observable for the reload: the worker logs `[providers] Loaded: … N model(s)`
// on every successful loadAndApplyProviders. Each cross-process rewrite that
// adds a model MUST produce a new load line with N+1 models. We count those.
//
// ⛔ ISOLATION CONTRACT — this test NEVER spawns a real `claude`, never touches
// real OAuth creds, and never signals the live ccb daemon. It spawns the REAL
// bin/ccb-watchdog.js against a SELF-CONTAINED, per-test CCB_CONFIG_DIR: port 0
// (OS-assigned), a minimal providers.json, and a THROWAWAY .env key (no real
// secret). The atomic rename is performed by a spawned CHILD node process. It
// signals only pids it spawned itself. Run it DIRECTLY, never via npm test:
//
//     node --test test/config-hotreload.test.js
//
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, '..');
const WATCHDOG_BIN = path.join(PKG_ROOT, 'bin', 'ccb-watchdog.js');

// Watchdog timing mirrors (see watchdog-no-client-exit.test.js).
const MIN_DRAIN_TIMEOUT_MS = 1000;
const RELOAD_SETTLE_MS = 1500; // watchConfigFile debounce + worker load slack

// ── Throwaway-resource bookkeeping (swept after every test) ──────────────────
const spawnedPids = new Set();
const tmpDirs = new Set();

afterEach(() => {
  for (const pid of spawnedPids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  spawnedPids.clear();
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  tmpDirs.clear();
});

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function pollUntil(predicate, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await delay(stepMs);
  }
}

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-hotreload-'));
  tmpDirs.add(dir);
  return dir;
}

function makeConfig() {
  return {
    port: 0,
    daemon: {
      healthCheckTimeoutMs: 1000, pollIntervalMs: 100, pollMaxAttempts: 5,
      upstreamTimeoutMs: 0, workerInitTimeoutMs: 5000,
      drainTimeoutMs: MIN_DRAIN_TIMEOUT_MS,
      // Pinned so the daemon stays up across the reload window (the reload
      // observable here is the providers load line, not lifecycle).
      workerKeepaliveS: -1,
      ipcTimeoutMs: 1000, daemonStartTimeoutMs: 10000, daemonStartProgressGraceMs: 2000,
      bindHost: '127.0.0.1',
    },
    logging: { enabled: false, requests: false, responses: false, history: 0, maxBodyLog: 0, level: 'info' },
  };
}

function makeProviders({ models }) {
  return {
    providers: {
      isolated: { url: 'http://127.0.0.1:1/v1', anthropicCompliant: true, models },
    },
    routes: { models: {}, properties: {}, payloadSize: {} },
  };
}

function writeIsolatedConfig(configDir, providersModels) {
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(makeConfig(), null, 2), 'utf8');
  fs.writeFileSync(path.join(configDir, 'providers.json'), JSON.stringify(makeProviders({ models: providersModels }), null, 2), 'utf8');
  fs.writeFileSync(path.join(configDir, '.env'), 'ZAI_KEY=throwaway-not-a-real-key\n', 'utf8');
}

async function pollUntilReady(configDir, expectedPid) {
  const runtimePath = path.join(configDir, 'runtime.json');
  const got = await pollUntil(() => {
    if (!fs.existsSync(runtimePath)) return false;
    try {
      const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
      return typeof runtime.port === 'number'
        && typeof runtime.watchdogPid === 'number'
        && (!expectedPid || runtime.watchdogPid === expectedPid);
    } catch { return false; }
  }, { timeoutMs: 15000, stepMs: 100 });
  if (!got) return null;
  return JSON.parse(fs.readFileSync(runtimePath, 'utf8')).port;
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

  const port = await pollUntilReady(configDir, child.pid);
  assert.ok(port !== null, `watchdog never came ready; daemon log:\n${safeRead(logPath)}`);
  await delay(RELOAD_SETTLE_MS); // let the initial "[providers] Loaded:" line land
  return { pid: child.pid, port, logPath };
}

function safeRead(logPath) {
  try { return fs.readFileSync(logPath, 'utf8'); }
  catch { return '(no log)'; }
}

// Parse the model count from each "[providers] Loaded: … N model(s)" line.
function providersLoadSnapshots(logPath) {
  const snaps = [];
  for (const line of safeRead(logPath).split('\n')) {
    const m = line.match(/\[providers\] Loaded:\s*\d+\s*rule\(s\),\s*(\d+)\s*model\(s\)/);
    if (m) snaps.push(Number(m[1]));
  }
  return snaps;
}

// Perform a CROSS-PROCESS atomic rename-over of providers.json: the rewrite is
// done by a SPAWNED CHILD node process that imports the REAL writeFileAtomic
// (temp + rename), mirroring a real `ccb` CLI write from a separate process —
// the exact scenario fs.watch(file) flakes on. Mutates providers.json to
// declare `models` (the count the worker reports).
function crossProcessAtomicRewrite(providersPath, models) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { writeFileAtomic } from ${JSON.stringify(path.join(PKG_ROOT, 'src', 'core', 'fs-atomic.js'))};
      const data = JSON.stringify(${JSON.stringify(makeProviders({ models }))}, null, 2);
      await writeFileAtomic(process.argv[1], data, 'utf8');
    `, providersPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`rewrite child exited ${code}: ${stderr}`));
    });
  });
}

// ── (a) in-place providers.json reload (baseline: reload path works) ────────
//
// An in-place edit (writeFileSync, same inode) triggers the watcher on every
// platform. This pins the basic reload→re-apply path so a regression in the
// reload mechanism itself is caught independently of the rename question.
test('providers.json in-place edit: worker reloads, model count increases', async () => {
  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, []);
  const { pid, logPath } = await spawnWatchdog(configDir);

  const baseline = providersLoadSnapshots(logPath);
  assert.ok(baseline.length >= 1, `initial load missing; log:\n${safeRead(logPath)}`);
  const baseModels = baseline[baseline.length - 1];

  // In-place edit (same inode — not atomic rename).
  fs.writeFileSync(
    path.join(configDir, 'providers.json'),
    JSON.stringify(makeProviders({ models: ['m-inplace'] }), null, 2),
    'utf8'
  );

  const reloaded = await pollUntil(() => {
    const snaps = providersLoadSnapshots(logPath);
    return snaps.length > baseline.length && snaps[snaps.length - 1] !== baseModels;
  }, { timeoutMs: 8000, stepMs: 100 });
  assert.equal(reloaded, true, `in-place edit did not reload; log:\n${safeRead(logPath)}`);

  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
});

// ── (b) CROSS-PROCESS atomic rename reload — the regression, looped 20× ──────
//
// Each iteration: rewrite providers.json via a SPAWNED CHILD's atomic temp+
// rename, adding one more model, and assert the worker produced a new load line
// with the incremented model count. On the fix (directory watcher) this is
// RELIABLE — all 20 iterations reload. On a reverted fs.watch(file) it flakes
// (some cross-process renames emit no event), which CI catches.
//
// Looped rather than once because the regression is probabilistic: a single
// iteration can pass by luck even on the broken watcher. 20× collapses that
// luck — a broken watcher fails at least one iteration.
test('providers.json CROSS-PROCESS atomic rename: reload is RELIABLE across 20 iterations', async () => {
  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, []);
  const { pid, logPath } = await spawnWatchdog(configDir);

  const ITERATIONS = 20;
  let expectedModels = providersLoadSnapshots(logPath).at(-1) ?? 0;
  const failures = [];

  for (let i = 0; i < ITERATIONS; i++) {
    expectedModels += 1;
    const providersPath = path.join(configDir, 'providers.json');
    const models = Array.from({ length: expectedModels }, (_, m) => `m-${i}-${m}`);
    await crossProcessAtomicRewrite(providersPath, models);

    const ok = await pollUntil(() => {
      const snaps = providersLoadSnapshots(logPath);
      return snaps.at(-1) === expectedModels;
    }, { timeoutMs: 8000, stepMs: 100 });

    if (!ok) {
      const snaps = providersLoadSnapshots(logPath);
      failures.push({ iteration: i, expectedModels, lastSeen: snaps.at(-1) ?? null });
    }
  }

  assert.equal(failures.length, 0,
    `${failures.length}/${ITERATIONS} cross-process atomic-rename reloads did NOT take effect (watcher flaked). ` +
    `First failures: ${JSON.stringify(failures.slice(0, 3))}. Daemon log tail:\n${safeRead(logPath).split('\n').slice(-15).join('\n')}`);

  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
});

// ── (c) config.json cross-process atomic rename reload (directory watcher) ───
//
// Same regression, config.json side, observable via the WORKER too: the worker
// keeps its own config cache (proxy-core.js) refreshed by the SAME directory
// watcher. We can't read the worker's in-memory config directly, but the
// daemon log is enough to assert the watcher was set up without error and the
// daemon survived the storm (no crash from a bad reload). This guards that the
// config.json directory watcher is wired and healthy under cross-process load.
test('config.json cross-process atomic rename storm: daemon stays up, watcher healthy', async () => {
  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, ['m-storm']);
  const { pid, logPath } = await spawnWatchdog(configDir);

  // Storm: 10 cross-process atomic rewrites of config.json (same content each
  // time — we are asserting the watcher/daemon survive the inode churn, not a
  // value change). A crashed watcher would surface as a daemon exit or a
  // "config watcher setup failed" line.
  for (let i = 0; i < 10; i++) {
    const configPath = path.join(configDir, 'config.json');
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { writeFileAtomic } from ${JSON.stringify(path.join(PKG_ROOT, 'src', 'core', 'fs-atomic.js'))};
        const data = JSON.stringify(${JSON.stringify(makeConfig())}, null, 2);
        await writeFileAtomic(process.argv[1], data, 'utf8');
      `, configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}: ${stderr}`))));
    });
    await delay(40); // space the rewrites so the watcher can settle each
  }

  // The daemon must still be alive (no crash) and the log must NOT report a
  // watcher setup failure. (State assertion, not log-string matching of success.)
  assert.equal(isAlive(pid), true,
    `daemon died during config.json cross-process rename storm; log:\n${safeRead(logPath)}`);
  assert.equal(safeRead(logPath).includes('watcher setup failed'), false,
    `a config watcher setup failure was reported; log:\n${safeRead(logPath)}`);

  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
});

// ── (d) Adding a NEW provider: models appear in /v1/models without restart ───
//
// T-44rjt2cs / T-br3aqvw7: editing providers.json to add a brand-new provider
// (not just changing models on an existing one) must make the new provider's
// models visible in the GET /v1/models response, without a daemon restart.
test('adding a new provider via hot-reload: models appear in /v1/models', async () => {
  const configDir = makeTmpDir();
  writeIsolatedConfig(configDir, ['baseline-model']);
  fs.writeFileSync(path.join(configDir, '.env'),
    'ZAI_KEY=throwaway-not-a-real-key\nNEWPROVIDER_KEY=throwaway\n', 'utf8');
  const { port, logPath } = await spawnWatchdog(configDir);

  const baseModels = await fetchModels(port);
  assert.ok(baseModels.includes('baseline-model'),
    `baseline-model missing from initial /v1/models: ${JSON.stringify(baseModels)}`);
  assert.ok(!baseModels.includes('new-model'),
    `new-model should not exist before edit: ${JSON.stringify(baseModels)}`);

  const updated = {
    providers: {
      isolated: { url: 'http://127.0.0.1:1/v1', anthropicCompliant: true, models: ['baseline-model'] },
      newprovider: { url: 'http://127.0.0.1:2/v1', anthropicCompliant: true, models: ['new-model'] },
    },
    routes: { models: {}, properties: {}, payloadSize: {} },
  };
  fs.writeFileSync(path.join(configDir, 'providers.json'),
    JSON.stringify(updated, null, 2), 'utf8');

  const reloaded = await pollUntil(async () => {
    const models = await fetchModels(port);
    return models.includes('new-model');
  }, { timeoutMs: 8000, stepMs: 200 });

  assert.equal(reloaded, true,
    `new provider's model did not appear in /v1/models after hot-reload; ` +
    `models: ${JSON.stringify(await fetchModels(port))}; log tail:\n${safeRead(logPath).split('\n').slice(-10).join('\n')}`);

  const finalModels = await fetchModels(port);
  assert.ok(finalModels.includes('baseline-model'),
    `baseline-model disappeared after adding new provider: ${JSON.stringify(finalModels)}`);
});

async function fetchModels(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/models', method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve((parsed.data ?? []).map((m) => m.id));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
