// Behaviour tests for atomic + locked config writes (T-8md39ymx).
//
// The bug class: three config writers (.env / config.json / providers.json)
// truncated-and-rewrote IN PLACE. Two concurrent read-modify-write cycles lost
// updates (last-writer-wins → a key vanishes), and an interrupted write left a
// truncated file. The fix: every write is atomic (temp + rename) and every
// read-modify-write is serialized by a cross-process lockfile.
//
// ## Why writers are BARRIER-SYNCHRONIZED PROCESSES (not in-process promises)
// updateEnvKey is fully SYNCHRONOUS (read → mutate → write). Two failure modes
// if we get the test wrong:
//   (A) In-process "concurrent" promises never overlap — sync code blocks the
//       event loop, so the RMW windows can't interleave → false-pass.
//   (B) Staggered PROCESS spawns (each writer writing as it comes up) also
//       don't contend — the writers are up at different times → false-pass.
//
// The REQUIRED pattern below is a SYNCHRONIZED-START BARRIER: spawn N>=8
// SEPARATE writer processes; each fully loads + initializes, then BLOCKS at a
// barrier (signals readiness via its own ready-file, then spin-waits on a
// shared go-file the parent creates ONLY once all N are ready). When the
// go-file appears, ALL N fire their writes AT THE SAME TIME, many rounds each.
// That simultaneous start is what reliably forces the lost-update race and
// proves the lock: under the lock all keys survive; lock-free, keys are lost.
//
// ⛔ ISOLATION CONTRACT — this test NEVER spawns a real `claude`, never touches
// real OAuth creds, and never signals the live ccb daemon. Each writer drives
// the REAL updateEnvKey / writeFileAtomic / withConfigLock code against a
// SELF-CONTAINED, per-test CCB_CONFIG_DIR tmp dir holding only THROWAWAY keys
// (no real secret). Run it DIRECTLY, never via npm test:
//
//     node --test test/atomic-config-writes.test.js
//
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/core/env-file.js';
import { writeFileAtomic } from '../src/core/fs-atomic.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, '..');

// ── Throwaway-resource bookkeeping (swept after every test) ──────────────────
const tmpDirs = new Set();
const tmpFiles = new Set();
const childPids = new Set();

afterEach(() => {
  for (const pid of childPids) {
    // Every pid here is a short-lived writer we spawned against a per-test tmp
    // dir; it never binds a port and never touches the live daemon.
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  childPids.clear();
  for (const file of tmpFiles) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
  tmpFiles.clear();
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  tmpDirs.clear();
});

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-atomic-'));
  tmpDirs.add(dir);
  return dir;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function pollUntil(predicate, { timeoutMs = 10000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await delay(stepMs);
  }
}

// The barrier-synchronized writer script. Each writer:
//   1. imports the REAL env-file/fs-atomic code (loaded + initialized BEFORE
//      the barrier — load cost is NOT part of the race window).
//   2. signals readiness by creating its ready-file.
//   3. SPIN-WAITS on the shared go-file — blocks here, writes nothing, until
//      the parent confirms ALL N writers are ready and creates the go-file.
//   4. once released, fires `rounds` writes of its distinct key as fast as
//      possible, SIMULTANEOUSLY with the other N-1 writers.
//
// useLock=true → the production locked updateEnvKey (the fix).
// useLock=false → a raw lock-free RMW mirroring updateEnvKey's body (the
// pre-fix behavior), so the SAME barrier harness proves the race reproduces
// (keys lost) and that the lock closes it (keys survive).
//
// The script is plain ESM passed via --input-type=module; values are injected
// as JSON literals so the writer needs no args beyond its index.
function writerScript({ envPath, index, rounds, readyFile, goFile, useLock }) {
  return `
    import fs from 'fs';
    import { updateEnvKey } from ${JSON.stringify(path.join(PKG_ROOT, 'src', 'core', 'env-file.js'))};
    const envPath = ${JSON.stringify(envPath)};
    const key = 'PROVIDER_${index}_KEY';
    const val = 'v-${index}';
    const rounds = ${rounds};

    // (1) already imported (loaded) above.

    // (2) signal readiness — we are at the barrier, loaded, about to block.
    fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready', 'utf8');

    // (3) spin-wait on the go-file. Block here — write NOTHING — until the
    // parent confirms every writer is ready and creates the go-file.
    while (!fs.existsSync(${JSON.stringify(goFile)})) { /* spin */ }

    // (4) BARRIER RELEASED — fire all rounds as fast as possible, racing the
    // other writers. (There is no per-round yield: we want maximum overlap.)
    ${
      useLock
        ? `for (let r = 0; r < rounds; r++) updateEnvKey(envPath, key, val);`
        : `for (let r = 0; r < rounds; r++) {
             const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
             const lines = content.split('\\n');
             let found = false;
             const out = lines.map((line) => {
               const t = line.trim();
               if (t.startsWith(key + '=') || t.startsWith('# ' + key + '=')) { found = true; return key + '=' + val; }
               return line;
             });
             if (!found) out.push(key + '=' + val);
             fs.writeFileSync(envPath, out.join('\\n').trim() + '\\n', 'utf8');
           }`
    }
  `;
}

// Spawn N barrier-synchronized writers, wait for ALL to be ready, then release
// them simultaneously via the go-file. Resolves once every writer has exited
// (all rounds complete). useLock selects the locked (fix) vs lock-free
// (pre-fix) RMW; the barrier machinery is identical for both.
async function runBarrierWriters({ envPath, n, rounds, useLock, goFile }) {
  const barrierDir = path.dirname(goFile);
  const children = [];
  for (let i = 0; i < n; i++) {
    const readyFile = path.join(barrierDir, `ready-${i}`);
    tmpFiles.add(readyFile);
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      writerScript({ envPath, index: i, rounds, readyFile, goFile, useLock })],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    childPids.add(child.pid);
    const errs = [];
    child.stderr.on('data', (d) => { errs.push(d.toString()); });
    child.exitCode = null;
    child.on('exit', (code) => { child.exitCode = code; child._errs = errs.join(''); });
    children.push(child);
  }

  // Wait until ALL N writers have posted their ready-files (all at the barrier).
  const allReady = await pollUntil(
    () => Array.from({ length: n }, (_, i) => fs.existsSync(path.join(barrierDir, `ready-${i}`))).every(Boolean),
    { timeoutMs: 15000, stepMs: 10 }
  );
  assert.equal(allReady, true, 'not all writers reached the barrier in time');

  // RELEASE — create the go-file so all N fire simultaneously.
  fs.writeFileSync(goFile, 'go', 'utf8');

  // Wait for every writer to finish all rounds.
  await Promise.all(children.map((c) => new Promise((resolve) => {
    if (c.exitCode !== null) return resolve();
    c.on('exit', () => resolve());
  })));
  for (const c of children) {
    assert.equal(c.exitCode, 0, `writer exited ${c.exitCode}: ${c._errs ?? ''}`);
  }
}

// ── D1: barrier-synchronized writers — lock-free LOSES, locked KEEPS all ────
//
// The decisive lost-update test. Under the SAME barrier-synchronized harness:
//   half A (lock-free, the pre-fix behavior): N simultaneous writers → some
//     keys are LOST (asserts the race is reproduced, so the test is valid).
//   half B (locked, the production fix): the SAME N simultaneous writers →
//     EVERY key survives (the lock serializes the RMW).
//
// Both halves use the identical barrier, so the only variable is the lock —
// the test is self-proving: no stash needed for the lost-update case.
test('lost-update race: barrier-synced lock-free writers LOSE keys; locked writers keep ALL', async () => {
  const N = 8;
  const ROUNDS = 5;
  const barrierDir = makeTmpDir();

  // ── half A: lock-free → expect losses ──
  const dirA = path.join(barrierDir, 'a');
  fs.mkdirSync(dirA);
  const envA = path.join(dirA, '.env');
  const goFileA = path.join(barrierDir, 'goA');
  tmpFiles.add(goFileA);
  await runBarrierWriters({ envPath: envA, n: N, rounds: ROUNDS, useLock: false, goFile: goFileA });
  const envLockFree = loadEnv(envA);
  const lockFreePresent = Array.from({ length: N }, (_, i) => envLockFree[`PROVIDER_${i}_KEY`] === `v-${i}`).filter(Boolean).length;
  assert.ok(lockFreePresent < N,
    `lock-free barrier-synced writers should LOSE some keys, but all ${N} survived (race NOT reproduced — test invalid)`);

  // ── half B: locked (fix) → expect ALL survive ──
  const dirB = path.join(barrierDir, 'b');
  fs.mkdirSync(dirB);
  const envB = path.join(dirB, '.env');
  const goFileB = path.join(barrierDir, 'goB');
  tmpFiles.add(goFileB);
  await runBarrierWriters({ envPath: envB, n: N, rounds: ROUNDS, useLock: true, goFile: goFileB });
  const envLocked = loadEnv(envB);
  for (let i = 0; i < N; i++) {
    assert.equal(envLocked[`PROVIDER_${i}_KEY`], `v-${i}`,
      `key PROVIDER_${i}_KEY was LOST despite the lock (got ${JSON.stringify(envLocked[`PROVIDER_${i}_KEY`])})`);
  }
});

// ── D2: atomicity — .env never observed truncated/partial during a storm ────
//
// While barrier-synced writers race (production locked path), every read of the
// file must see a well-formed .env (every non-blank line has an '='), never a
// truncated or half-written line. The atomic temp+rename guarantees this: a
// reader sees either the complete old content or the complete new content.
test('atomicity: .env never observed truncated/partial during barrier-synced concurrent writes', async () => {
  const barrierDir = makeTmpDir();
  const dir = path.join(barrierDir, 'env');
  fs.mkdirSync(dir);
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'SEED_KEY=seed\n', 'utf8');
  const goFile = path.join(barrierDir, 'go');
  tmpFiles.add(goFile);

  let sawMalformed = false;
  const stopper = { stop: false };

  // Start the reader BEFORE the barrier releases so it is actively reading
  // during the simultaneous write burst.
  const reader = (async () => {
    while (!stopper.stop) {
      try {
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
          const t = line.trim();
          if (!t || t.startsWith('#')) continue;
          if (!t.includes('=')) sawMalformed = true;
        }
      } catch { /* transient ENOENT during rename — not a malformed read */ }
      await delay(0);
    }
  })();

  await runBarrierWriters({ envPath, n: 8, rounds: 6, useLock: true, goFile });
  stopper.stop = true;
  await reader;

  assert.equal(sawMalformed, false,
    'observed a malformed (no "=") .env line mid-write — write was not atomic');
});

// ── D3: writeFileAtomic unit — temp+rename leaves no .tmp behind, exact content ─
//
// Direct contract test on the shared helper: writing produces the exact bytes,
// no `<file>.tmp` lingers after success, and the original is replaced (not
// appended). The building block both layers above rely on.
test('writeFileAtomic: exact content, no lingering .tmp, replaces in place', () => {
  const dir = makeTmpDir();
  const target = path.join(dir, 'target.json');
  tmpFiles.add(target);
  fs.writeFileSync(target, 'OLD\n', 'utf8');

  writeFileAtomic(target, 'NEW-CONTENT\n', 'utf8');

  assert.equal(fs.readFileSync(target, 'utf8'), 'NEW-CONTENT\n', 'exact new content');
  assert.equal(fs.existsSync(`${target}.tmp`), false, 'no .tmp lingers after atomic rename');
  assert.equal(fs.existsSync(`${target}.lock`), false, 'writeFileAtomic itself does not lock (lock is the RMW caller)');
});

// ── D4: writeFileAtomic is robust to a pre-existing stale .tmp ──────────────
//
// A prior crashed write could leave a `<file>.tmp`. The next writeFileAtomic
// must still succeed — the temp is opened with 'w' (not 'wx') so a stale temp
// is overwritten rather than wedging the write with EEXIST.
test('writeFileAtomic: succeeds despite a pre-existing stale .tmp from a crashed prior write', () => {
  const dir = makeTmpDir();
  const target = path.join(dir, 'target.json');
  tmpFiles.add(target);
  fs.writeFileSync(`${target}.tmp`, 'STALE-CRASH-LEFTOVER\n', 'utf8');

  writeFileAtomic(target, 'FRESH\n', 'utf8');

  assert.equal(fs.readFileSync(target, 'utf8'), 'FRESH\n', 'fresh content wins over stale temp');
});
