// Behaviour test for the serial-graceful shutdown (T-y53je8g9).
//
// ⛔ ISOLATION CONTRACT — this test NEVER spawns a real `claude`, never touches
// real OAuth creds, and never signals the live ccb daemon. It drives only
// self-spawned DETACHED fake processes (test/fixtures/*) that bind no ports,
// and signals only pids it spawned itself. Run it DIRECTLY, never via npm test:
//
//     node --test test/kill-shutdown.test.js
//
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planShutdown } from '../src/infra/kill-planner.js';
import { executeShutdown } from '../src/infra/kill-executor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

// ── Throwaway-resource bookkeeping (swept after every test) ──────────────────
const spawnedPids = new Set();
const tmpDirs = new Set();

afterEach(() => {
  for (const pid of spawnedPids) {
    // Safe: every pid here is a fake we spawned ourselves; they bind no ports.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-kill-test-'));
  tmpDirs.add(dir);
  return dir;
}

async function spawnFake(script, args) {
  const child = spawn(process.execPath, [path.join(FIXTURES, script), ...args], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  spawnedPids.add(child.pid);
  return child.pid;
}

async function spawnReadyFake(script, args, readyPath) {
  const pid = await spawnFake(script, args);
  const ready = await pollUntil(() => fs.existsSync(readyPath));
  assert.ok(ready, `${script} (pid ${pid}) failed to signal ready`);
  return pid;
}

// Build a fake ccb+claude session under one tmp dir. Returns the pids + paths.
async function spawnSession(criticalMs) {
  const dir = makeTmpDir();
  const lockPath = path.join(dir, 'oauth_refresh.lock');
  const markerPath = path.join(dir, 'clean-exit.marker');
  const ccbReady = path.join(dir, 'ccb.ready');
  const claudeReady = path.join(dir, 'claude.ready');

  const ccbPid = await spawnReadyFake('fake-ccb.js', [ccbReady], ccbReady);
  const claudePid = await spawnReadyFake(
    'fake-claude.js',
    [lockPath, markerPath, claudeReady, String(criticalMs)],
    claudeReady,
  );

  const snapshot = [
    { pid: ccbPid, ppid: 1, cmd: `node ${path.join('bin', 'ccb.js')}` },
    { pid: claudePid, ppid: ccbPid, cmd: 'claude --some-flag' },
  ];
  return { ccbPid, claudePid, lockPath, markerPath, snapshot };
}

// Real, effectful env for executeShutdown — scoped to the given fake pids only.
function fakeEnv(trackedPids, config) {
  return {
    listPids: () => trackedPids.filter(isAlive),
    signalGraceful: (pid) => { try { process.kill(pid, 'SIGINT'); } catch { /* gone */ } },
    signalForce: (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } },
    sleep: delay,
    now: () => Date.now(),
    config,
  };
}

function row(pid, ppid, cmd) { return { pid, ppid, cmd }; }
function signalOrderOf(unit) {
  const order = [];
  unit.signalEach((pid) => order.push(pid));
  return order;
}

// ── Pure planner — ZOMBIES boundaries (0 / 1 / N) ────────────────────────────
test('planner: 0 processes -> empty plan', () => {
  const plan = planShutdown([], 999);
  assert.equal(plan.isEmpty(), true);
  assert.equal(plan.size(), 0);
});

test('planner: 1 ccb + 1 claude -> one unit, claude signalled before launcher', () => {
  const plan = planShutdown([row(100, 1, 'node bin/ccb.js'), row(200, 100, 'claude')], 9);
  assert.equal(plan.size(), 1);
  assert.deepEqual(signalOrderOf(plan.units()[0]), [200, 100]);
  assert.equal(plan.units()[0].describe(), 'ccb#100');
});

test('planner: N sessions -> N units, each claude-before-launcher, in order', () => {
  const snapshot = [
    row(100, 1, 'node bin/ccb.js'), row(200, 100, 'claude'),
    row(101, 1, 'ccb'), row(201, 101, 'claude'),
  ];
  const plan = planShutdown(snapshot, 9);
  assert.equal(plan.size(), 2);
  assert.deepEqual(signalOrderOf(plan.units()[0]), [200, 100]);
  assert.deepEqual(signalOrderOf(plan.units()[1]), [201, 101]);
});

test('planner: excludes the current pid', () => {
  const plan = planShutdown([row(777, 1, 'node bin/ccb.js'), row(200, 777, 'claude')], 777);
  assert.equal(plan.isEmpty(), true);
});

test('planner: claude not parented by a ccb is ignored', () => {
  const plan = planShutdown([row(200, 1, 'claude')], 9);
  assert.equal(plan.isEmpty(), true);
});

test('planner: proxy daemon -> its own single-pid unit', () => {
  const plan = planShutdown([row(300, 1, 'node src/proxy.js')], 9);
  assert.equal(plan.size(), 1);
  assert.deepEqual(signalOrderOf(plan.units()[0]), [300]);
  assert.equal(plan.units()[0].describe(), 'daemon#300');
});

test('planner: survivingPids filters to the live set', () => {
  const unit = planShutdown([row(100, 1, 'node bin/ccb.js'), row(200, 100, 'claude')], 9).units()[0];
  assert.deepEqual(unit.survivingPids(new Set([200])), [200]);
  assert.deepEqual(unit.survivingPids(new Set()), []);
});

// ── Executor behaviour — real detached fakes ─────────────────────────────────
test('executor: empty plan resolves to no outcomes (ZOMBIES 0)', async () => {
  const outcomes = await executeShutdown(planShutdown([], process.pid), fakeEnv([], {}));
  assert.deepEqual(outcomes, []);
});

test('NEW strategy: double-SIGINT + poll-for-exit shuts a session cleanly (marker written, lock released, no force)', async () => {
  const session = await spawnSession(300);
  const plan = planShutdown(session.snapshot, process.pid);

  const outcomes = await executeShutdown(plan, fakeEnv(
    [session.ccbPid, session.claudePid],
    { sigintGapMs: 60, pollIntervalMs: 40, graceMs: 8000, forceAfterGrace: false },
  ));

  assert.equal(isAlive(session.claudePid), false, 'claude exited');
  assert.equal(isAlive(session.ccbPid), false, 'ccb exited');
  assert.equal(fs.existsSync(session.markerPath), true, 'clean-exit marker present');
  assert.equal(fs.existsSync(session.lockPath), false, 'lock released');

  const marker = JSON.parse(fs.readFileSync(session.markerPath, 'utf8'));
  assert.equal(marker.pid, session.claudePid);

  const outcome = outcomes.find(o => o.unit === `ccb#${session.ccbPid}`);
  assert.equal(outcome.exitedGracefully, true);
  assert.equal(outcome.forced.length, 0, 'no force-kill used');
});

test('regression guard: a SINGLE Ctrl-C never closes claude — the double-SIGINT requirement is load-bearing', async () => {
  const session = await spawnSession(300);
  const plan = planShutdown(session.snapshot, process.pid);

  const outcomes = await executeShutdown(plan, fakeEnv(
    [session.ccbPid, session.claudePid],
    { sigintCount: 1, pollIntervalMs: 40, graceMs: 600, forceAfterGrace: false },
  ));

  assert.equal(isAlive(session.claudePid), true, 'claude survives a single Ctrl-C');
  assert.equal(fs.existsSync(session.markerPath), false, 'no clean-exit marker');
  assert.equal(fs.existsSync(session.lockPath), true, 'lock still held');

  const outcome = outcomes.find(o => o.unit === `ccb#${session.ccbPid}`);
  assert.equal(outcome.exitedGracefully, false);
});

test('CORRUPTION CONTROL: old strategy (signal ccb only, fixed sleep, then SIGKILL claude) leaves no marker + leftover lock', async () => {
  const session = await spawnSession(400);

  // Old bug #1 — signal mis-targeted: the double SIGINT hits only the ccb pid.
  process.kill(session.ccbPid, 'SIGINT');
  await delay(60);
  try { process.kill(session.ccbPid, 'SIGINT'); } catch { /* gone */ }

  // Old bug #2 — fixed sleep, then an un-trappable SIGKILL to claude while it
  // still holds the lock and has written no marker.
  await delay(200);
  process.kill(session.claudePid, 'SIGKILL');
  await pollUntil(() => !isAlive(session.claudePid));

  assert.equal(fs.existsSync(session.markerPath), false, 'no clean-exit marker (corruption)');
  assert.equal(fs.existsSync(session.lockPath), true, 'lock left behind (corruption)');
});

test('SERIAL: N sessions shut down one at a time — no two critical sections overlap (ZOMBIES N)', async () => {
  const sessions = [await spawnSession(250), await spawnSession(250), await spawnSession(250)];
  const snapshot = sessions.flatMap(s => s.snapshot);
  const trackedPids = sessions.flatMap(s => [s.ccbPid, s.claudePid]);
  const plan = planShutdown(snapshot, process.pid);
  assert.equal(plan.size(), 3);

  await executeShutdown(plan, fakeEnv(trackedPids, {
    sigintGapMs: 50, pollIntervalMs: 30, graceMs: 10_000, forceAfterGrace: false,
  }));

  const markers = sessions.map((s) => {
    assert.equal(fs.existsSync(s.markerPath), true, `session ${s.ccbPid} wrote its marker`);
    assert.equal(isAlive(s.claudePid), false, `session ${s.ccbPid} claude exited`);
    return JSON.parse(fs.readFileSync(s.markerPath, 'utf8'));
  }).sort((a, b) => a.enteredAt - b.enteredAt);

  for (let i = 1; i < markers.length; i++) {
    assert.ok(
      markers[i].enteredAt >= markers[i - 1].exitedAt,
      `critical sections must not overlap: section ${i} entered at ${markers[i].enteredAt} before section ${i - 1} exited at ${markers[i - 1].exitedAt}`,
    );
  }
});

test('LAST RESORT: a process that ignores SIGINT is force-killed only after the grace elapses', async () => {
  const dir = makeTmpDir();
  const readyPath = path.join(dir, 'stubborn.ready');
  const stubbornPid = await spawnReadyFake('fake-stubborn.js', [readyPath], readyPath);

  const plan = planShutdown([row(stubbornPid, 1, 'node src/proxy.js')], process.pid);
  const outcomes = await executeShutdown(plan, fakeEnv([stubbornPid], {
    sigintGapMs: 40, pollIntervalMs: 40, graceMs: 400, forceAfterGrace: true,
  }));

  assert.equal(await pollUntil(() => !isAlive(stubbornPid)), true, 'force-killed as last resort');
  const outcome = outcomes.find(o => o.unit === `daemon#${stubbornPid}`);
  assert.equal(outcome.exitedGracefully, false);
  assert.deepEqual(outcome.forced, [stubbornPid]);
});
