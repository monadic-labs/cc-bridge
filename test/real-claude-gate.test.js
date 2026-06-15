// unit-role: contract — proves resolveRealClaudeTestHome() honours its
// Result<{home},ConfigError> contract for every refusal code + the happy path,
// and that the function is a pure side-effect-free gate (no process.env mutation).
// Isolated behaviour tests for the real-claude safety gate.
//
// ⛔ ISOLATION CONTRACT — this test NEVER spawns a real `claude`, never touches
// real OAuth creds, and never reads process.env for gate decisions. It drives
// only the pure resolveRealClaudeTestHome() function with INJECTED env objects.
// Run it DIRECTLY, never via npm test:
//
//     node --test test/real-claude-gate.test.js
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveRealClaudeTestHome, REAL_CLAUDE_SKIP_MSG } from '../src/infra/test-claude-gate.js';
import { ConfigError } from '../src/core/exceptions.js';

// Substantiates the contract role-marker: the boundary under test is the
// exported resolveRealClaudeTestHome function from test-claude-gate.js.
export { resolveRealClaudeTestHome };

const FAKE_HOME = '/home/throwaway-user';
const THROWAWAY = '/tmp/ccb-throwaway-home';

// ── Refusal paths ─────────────────────────────────────────────────────────────

test('gate: flag unset → fail with ConfigError', () => {
  const result = resolveRealClaudeTestHome({ HOME: FAKE_HOME });
  assert.equal(result.isSuccess, false);
  assert.ok(result.error instanceof ConfigError, 'error must be a ConfigError');
  assert.equal(result.error.code, 'CCB_GATE_UNSET');
  assert.equal(result.error.message, REAL_CLAUDE_SKIP_MSG,
    'unset message must match the exported SKIP constant (single source of truth)');
});

test('gate: flag empty string → fail', () => {
  const result = resolveRealClaudeTestHome({ HOME: FAKE_HOME, CCB_TEST_REAL_CLAUDE_HOME: '' });
  assert.equal(result.isSuccess, false);
  assert.ok(result.error instanceof ConfigError);
  assert.equal(result.error.code, 'CCB_GATE_UNSET');
});

test('gate: flag is a relative path → fail', () => {
  const result = resolveRealClaudeTestHome({
    HOME: FAKE_HOME,
    CCB_TEST_REAL_CLAUDE_HOME: 'relative/dir',
  });
  assert.equal(result.isSuccess, false);
  assert.ok(result.error instanceof ConfigError);
  assert.equal(result.error.code, 'CCB_GATE_NOT_ABSOLUTE');
});

test('gate: flag equals HOME exactly → fail (would reuse real home)', () => {
  const result = resolveRealClaudeTestHome({
    HOME: FAKE_HOME,
    CCB_TEST_REAL_CLAUDE_HOME: FAKE_HOME,
  });
  assert.equal(result.isSuccess, false);
  assert.ok(result.error instanceof ConfigError);
  assert.equal(result.error.code, 'CCB_GATE_REUSES_HOME');
});

test('gate: flag equals <HOME>/.claude → fail (real creds dir)', () => {
  const result = resolveRealClaudeTestHome({
    HOME: FAKE_HOME,
    CCB_TEST_REAL_CLAUDE_HOME: `${FAKE_HOME}/.claude`,
  });
  assert.equal(result.isSuccess, false);
  assert.ok(result.error instanceof ConfigError);
  assert.equal(result.error.code, 'CCB_GATE_INSIDE_CREDS');
});

test('gate: flag resolves inside <HOME>/.claude subdirectory → fail', () => {
  const result = resolveRealClaudeTestHome({
    HOME: FAKE_HOME,
    CCB_TEST_REAL_CLAUDE_HOME: `${FAKE_HOME}/.claude/nested`,
  });
  assert.equal(result.isSuccess, false);
  assert.ok(result.error instanceof ConfigError);
  assert.equal(result.error.code, 'CCB_GATE_INSIDE_CREDS');
});

// ── Happy path ────────────────────────────────────────────────────────────────

test('gate: valid absolute throwaway dir → ok with home value', () => {
  const result = resolveRealClaudeTestHome({
    HOME: FAKE_HOME,
    CCB_TEST_REAL_CLAUDE_HOME: THROWAWAY,
  });
  assert.equal(result.isSuccess, true);
  assert.equal(result.value.home, THROWAWAY);
});

// ── Side-effect proof ─────────────────────────────────────────────────────────
//
// resolveRealClaudeTestHome reads exactly two keys (CCB_TEST_REAL_CLAUDE_HOME,
// HOME) and must never write. We assert purity by snapshotting those two keys
// on process.env across calls — NOT a full deepEqual(process.env, before),
// which is non-deterministic: `node --test` itself mutates process.env during a
// run (NODE_TEST_CONTEXT etc.), so a whole-env snapshot can never round-trip and
// would flake regardless of what the gate does.

test('gate: pure function does not mutate process.env', () => {
  const keysRead = ['CCB_TEST_REAL_CLAUDE_HOME', 'HOME'];
  const before = Object.fromEntries(keysRead.map(k => [k, process.env[k]]));

  // Call once with the flag unset (refusal path) — most likely to add a key if buggy.
  resolveRealClaudeTestHome({ HOME: FAKE_HOME });
  // Call once with a valid opt-in (ok path).
  resolveRealClaudeTestHome({ HOME: FAKE_HOME, CCB_TEST_REAL_CLAUDE_HOME: THROWAWAY });

  const after = Object.fromEntries(keysRead.map(k => [k, process.env[k]]));
  assert.deepEqual(after, before,
    'resolveRealClaudeTestHome must not add, remove, or change the keys it reads on process.env');
});

// ── Constructor belt-and-suspenders (structural — no tmux spawned) ────────────
//
// InteractiveSession is not exported from src/test.js (and importing that file
// runs the whole suite + spawns real claude), so we cannot construct it here.
// Instead we prove the defense-in-depth claim MECHANICALLY: the constructor's
// gate call is the FIRST statement — it precedes requireMux() (and thus the
// tmux spawn), so an ungated `new InteractiveSession(...)` throws the gate's
// ConfigError before any tmux side effect can fire. Asserted by source
// inspection of the constructor body, which is deterministic and isolated.

test('InteractiveSession constructor: gate is the first statement, before requireMux/tmux', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'test.js'), 'utf8'
  );
  // Slice the constructor body from its signature to the first `this.` assignment
  // (the real field init that follows requireMux). The gate must appear inside.
  const ctorStart = src.indexOf('class InteractiveSession');
  const ctorBlock = src.slice(ctorStart, src.indexOf('this.output ='));
  // Match the requireMux CALL (trailing `;`) — NOT the gate comment, which
  // mentions `requireMux()` in prose and would otherwise win indexOf.
  const gateIdx = ctorBlock.indexOf('resolveRealClaudeTestHome');
  const muxCallIdx = ctorBlock.indexOf('requireMux();');
  assert.ok(gateIdx > -1, 'constructor must call resolveRealClaudeTestHome');
  assert.ok(muxCallIdx > -1, 'constructor must call requireMux (anchor present)');
  assert.ok(gateIdx < muxCallIdx,
    'gate must fire before requireMux so the throw beats the tmux spawn');
});
