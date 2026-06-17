// Behaviour tests for src/platform/definePlatform.js — the OS functional-parity
// abstraction (T-whtmar9s, reference implementation, no divergent consumer yet).
//
// ## Why this abstraction exists (spec)
// A feature that needs different OS APIs is wrapped in definePlatform with BOTH
// real implementations present. Forgetting to port an OS branch must be
// structurally IMPOSSIBLE: definePlatform throws at call time if either `unix`
// or `windows` key is missing. The per-OS values are PURE descriptor functions;
// the imperative shell calls selectForPlatform ONCE and dependency-injects the
// chosen branch into the core, so effects (spawn/fs/syscall) stay injectable by
// the caller and BOTH branches are unit-testable on this Linux host without
// running Windows. Platform selection is INJECTABLE via the `platform` param
// (default process.platform), so tests pick either branch with NO global mock.
//
// ⛔ ISOLATION CONTRACT — this test never spawns a process, never touches real
// creds, never signals the daemon, never mutates process.platform. It imports
// the module under test and asserts pure function behaviour. Run it DIRECTLY,
// never via npm test:
//
//     node --test test/platform-define.test.js
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definePlatform, selectForPlatform, PlatformParityError } from '../src/platform/definePlatform.js';

// ── (1) Structural parity: a missing OS branch is impossible to ship ─────────
//
// definePlatform MUST reject a map lacking `unix` or `windows` at call time.
// The whole point of the abstraction is that "forgot the Windows port" cannot
// compile-past into a silent runtime gap — it throws where the capability is
// defined, not where it is first used on Windows. We assert the typed error
// AND its stable machine code (not the message string).
test('definePlatform throws PlatformParityError (code PLATFORM_PARITY) when windows is omitted', () => {
  assert.throws(
    () => definePlatform({ unix: 'u' }),
    (err) => {
      assert.ok(err instanceof PlatformParityError, 'error is PlatformParityError');
      assert.equal(err.name, 'PlatformParityError');
      assert.equal(err.code, 'PLATFORM_PARITY', 'stable machine code');
      return true;
    }
  );
});

test('definePlatform throws PlatformParityError (code PLATFORM_PARITY) when unix is omitted', () => {
  assert.throws(
    () => definePlatform({ windows: 'w' }),
    (err) => {
      assert.ok(err instanceof PlatformParityError);
      assert.equal(err.code, 'PLATFORM_PARITY');
      return true;
    }
  );
});

test('definePlatform throws PlatformParityError when BOTH keys are omitted', () => {
  assert.throws(
    () => definePlatform({}),
    (err) => err instanceof PlatformParityError && err.code === 'PLATFORM_PARITY'
  );
});

// ── (2) Happy path: both branches present → frozen map preserving both ───────
test('definePlatform returns a FROZEN map containing both branches when both are given', () => {
  const map = definePlatform({ unix: 'u', windows: 'w' });

  assert.equal(Object.isFrozen(map), true, 'returned map is frozen');
  assert.equal(map.unix, 'u');
  assert.equal(map.windows, 'w');
});

test('definePlatform preserves extra alias keys alongside the mandatory pair', () => {
  const map = definePlatform({ unix: 'u', windows: 'w', darwin: 'd' });

  assert.equal(Object.isFrozen(map), true);
  assert.equal(map.unix, 'u');
  assert.equal(map.windows, 'w');
  assert.equal(map.darwin, 'd', 'explicit alias preserved on the frozen map');
});

// ── (3) Platform selection via the INJECTABLE platform param (no global mock) ─
//
// selectForPlatform takes the platform as its 2nd arg (default process.platform),
// so tests exercise every branch deterministically without monkey-patching
// process.platform. win32 → windows; any other platform → unix (default), with
// an explicit alias key (e.g. darwin) winning over the unix fallback.
test("selectForPlatform returns the windows branch for 'win32'", () => {
  const map = definePlatform({ unix: 'u', windows: 'w' });
  assert.equal(selectForPlatform(map, 'win32'), 'w');
});

test("selectForPlatform falls back to unix for 'linux' and 'darwin' when no alias is given", () => {
  const map = definePlatform({ unix: 'u', windows: 'w' });
  assert.equal(selectForPlatform(map, 'linux'), 'u');
  assert.equal(selectForPlatform(map, 'darwin'), 'u');
});

test('an explicit alias key wins over the unix fallback for that platform', () => {
  const map = definePlatform({ unix: 'u', windows: 'w', darwin: 'd' });
  assert.equal(selectForPlatform(map, 'darwin'), 'd', 'explicit darwin alias used');
  assert.equal(selectForPlatform(map, 'linux'), 'u', 'no linux alias → unix fallback');
});

// ── (4) Worked example: BOTH branches asserted on THIS Linux host ─────────────
//
// A tiny capability defined as pure descriptor FUNCTIONS — the realistic shape.
// selectForPlatform returns the chosen descriptor; the test CALLS it to obtain
// the concrete plan. Because selection is param-driven, we assert BOTH the
// unix plan (the branch that would run here) AND the windows plan (which would
// run on win32) from a single Linux process, with zero mocking — proving the
// abstraction makes every branch unit-testable cross-platform.
test('worked example: flock/lockfile-ex capability, BOTH branches testable on Linux', () => {
  const fileLock = definePlatform({
    unix: () => 'flock-plan',
    windows: () => 'lockfileex-plan',
  });

  // The branch that would actually execute on this Linux host (default param).
  const unixDescriptor = selectForPlatform(fileLock, 'linux');
  assert.equal(unixDescriptor(), 'flock-plan');

  // The branch that would execute on win32 — asserted here, no Windows needed.
  const windowsDescriptor = selectForPlatform(fileLock, 'win32');
  assert.equal(windowsDescriptor(), 'lockfileex-plan');
});
