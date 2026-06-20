// Regression test for spawnWithStdin EPIPE crash (T-pk3akqr2).
//
// A child that closes stdin immediately (or exits before the write completes)
// must NOT crash the parent with an unhandled EPIPE. The returned promise must
// settle (reject with the child's exit error), not throw an uncaught exception.
//
//     node --test test/spawn-stdin-epipe.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnWithStdin } from '../src/infra/process-manager.js';

test('spawnWithStdin does not crash on EPIPE when child closes stdin immediately', async () => {
  // Spawn a child that destroys its own stdin and exits immediately.
  // A large input maximizes the chance of a write racing the close.
  const largeInput = 'x'.repeat(1024 * 1024);

  const result = await spawnWithStdin(
    process.execPath,
    ['-e', 'process.stdin.destroy(); process.exit(0)'],
    largeInput,
  ).then(
    (stdout) => ({ ok: true, stdout }),
    (err) => ({ ok: false, err }),
  );

  // The child exits with code 0, so the promise may resolve or reject
  // depending on timing — either outcome is acceptable. The key assertion
  // is that we REACH this line (no unhandled exception crashed the process).
  assert.ok(
    result.ok === true || result.ok === false,
    'promise settled without crashing the process',
  );
});

test('spawnWithStdin does not crash on EPIPE when child exits with non-zero', async () => {
  const largeInput = 'x'.repeat(1024 * 1024);

  const result = await spawnWithStdin(
    process.execPath,
    ['-e', 'process.stdin.destroy(); process.exit(1)'],
    largeInput,
  ).then(
    (stdout) => ({ ok: true, stdout }),
    (err) => ({ ok: false, err }),
  );

  // Non-zero exit → promise rejects. Again, the assertion is that we
  // reach this line without an unhandled exception.
  assert.equal(result.ok, false, 'non-zero exit rejects the promise');
});
