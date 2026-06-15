import path from 'path';
import { Result } from '../core/types.js';
import { ConfigError } from '../core/exceptions.js';

/**
 * Exact SKIP message logged by the dispatcher when the gate refuses (flag
 * unset / missing). Single-sourced here so the dispatcher never hard-codes it.
 */
export const REAL_CLAUDE_SKIP_MSG =
  '\nSKIP: real-claude interactive tests — live credentials protected by default' +
  ' (set CCB_TEST_REAL_CLAUDE_HOME to a throwaway HOME dir with its own' +
  ' `claude login` to enable).';

/**
 * Pure gate: resolves the opt-in throwaway HOME for real-claude interactive
 * tests. Functional core — NO side effects, no I/O, no directory creation.
 * Takes the process env as a plain object so it is fully injectable for tests.
 *
 * Returns Result<{ home: string }, ConfigError>:
 *   - ok({ home })  → flag is present and structurally valid; caller may proceed
 *   - fail(err)     → flag absent or invalid; dispatcher must skip / constructor must throw
 *
 * Refusal reasons (all return fail):
 *   1. Flag unset or empty string
 *   2. Value is not an absolute path
 *   3. Value equals env.HOME (would reuse the real home)
 *   4. Value resolves inside <env.HOME>/.claude (would reach the real creds dir)
 *
 * @param {Record<string, string|undefined>} env  Injected environment (typically process.env)
 * @returns {import('../core/types.js').Result}
 */
export function resolveRealClaudeTestHome(env) {
  const value = env.CCB_TEST_REAL_CLAUDE_HOME;
  const realHome = env.HOME ?? '';

  if (!value) {
    return Result.fail(new ConfigError(REAL_CLAUDE_SKIP_MSG, { code: 'CCB_GATE_UNSET' }));
  }

  if (!path.isAbsolute(value)) {
    return Result.fail(new ConfigError(
      'CCB_TEST_REAL_CLAUDE_HOME must be an absolute path',
      { code: 'CCB_GATE_NOT_ABSOLUTE' },
    ));
  }

  if (value === realHome) {
    return Result.fail(new ConfigError(
      'CCB_TEST_REAL_CLAUDE_HOME must not equal HOME (would reuse live credentials)',
      { code: 'CCB_GATE_REUSES_HOME' },
    ));
  }

  const realCredsDir = path.join(realHome, '.claude');
  // resolve() normalises trailing slashes / symlink chains so a path like
  // /real/home/.claude/ does not slip through the equality check.
  if (path.resolve(value) === path.resolve(realCredsDir) ||
      path.resolve(value).startsWith(path.resolve(realCredsDir) + path.sep)) {
    return Result.fail(new ConfigError(
      'CCB_TEST_REAL_CLAUDE_HOME must not resolve inside the real .claude directory',
      { code: 'CCB_GATE_INSIDE_CREDS' },
    ));
  }

  return Result.ok({ home: value });
}
