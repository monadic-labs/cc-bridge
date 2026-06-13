/**
 * PTY-wrapped agy spawn (imperative shell — child-process owner).
 *
 * Spawns ONE long-lived `agy -p` per session under a PTY. PTY is REQUIRED for
 * tool use (spec: a plain pipe silently skips tools — agy detects no TTY and
 * drops its tool loop). The PTY is allocated by util-linux `script` wrapping
 * the agy command; Node talks to `script` over piped stdio, and `script`
 * provides agy the pseudo-TTY. This is the same wrapper agy-format uses for its
 * one-shot prompt path, here kept ALIVE across the held-call round.
 *
 * Readiness is deterministic: the bridge server's `onReady` callback fires
 * once agy has completed the MCP initialize handshake (initialize + tools/list
 * answered). There are NO arbitrary sleeps — `spawnPtyAgy` resolves on that
 * signal, or rejects with `AgySpawnReadinessTimeout` if it never fires in time.
 *
 * Reuses the shared local-vs-SSH decision (`buildAgyInvocation`) and binary
 * resolution (`resolveAgyBinary`/`agyDir`) from agy-format — single source for
 * how agy is located and invoked, no duplication.
 */

import { agyDir } from '../../agy-format/binary-resolver.js';
import { buildAgyInvocation } from '../../agy-format/invocation-builder.js';
import { spawnCommand } from '../../../infra/process-manager.js';
import { AgySpawnReadinessTimeout, SessionActorError } from '../exceptions.js';

const DEFAULT_READY_TIMEOUT_MS = 10_000;

/**
 * Escape a single-quoted shell string. agy model labels go inside '...' in the
 * `script -qec "agy --model '<label>' -p"` command, so a stray quote must not
 * break out. The POSIX idiom: close quote, insert escaped quote, reopen.
 */
function shellQuoteSingle(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Spawn one PTY-wrapped `agy -p` for the session.
 *
 * @param {object} deps
 * @param {string} deps.agyPath        - resolved agy binary (resolveAgyBinary output).
 * @param {string} deps.model          - agy display name (e.g. "Gemini 3.1 Pro").
 * @param {string} deps.prompt         - the full task prompt (agy -p takes it as its argument).
 * @param {string} deps.sandboxDir     - per-session cwd (the isolated sandbox).
 * @param {object} deps.env            - per-session env; MUST carry HOME (Unit 4 output).
 * @param {object} deps.server         - the bridge server exposing onReady(cb).
 * @param {number} [deps.readyTimeoutMs=10000] - readiness deadline.
 * @param {string} [deps.sshHost]      - optional SSH host (forwarded to buildAgyInvocation).
 * @returns {Promise<{child:*, onDeath:(cb)=>void}>} resolves when onReady fires.
 * @throws {AgySpawnReadinessTimeout} if initialize is not seen within readyTimeoutMs.
 */
export function spawnPtyAgy(deps) {
  const { agyPath, model, prompt, sandboxDir, env, server } = deps;
  const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const sshHost = deps.sshHost;

  requireNonEmpty(agyPath, 'agyPath');
  requireNonEmpty(model, 'model');
  requireNonEmpty(prompt, 'prompt');
  requireNonEmpty(sandboxDir, 'sandboxDir');
  if (!env || typeof env.HOME !== 'string' || env.HOME.length === 0) {
    throw new SessionActorError('spawnPtyAgy: env.HOME must be set (per-session isolation)');
  }
  if (!server || typeof server.onReady !== 'function') {
    throw new SessionActorError('spawnPtyAgy: server.onReady is required for readiness');
  }

  const agyDirectory = agyDir(agyPath);
  // agy's -p/--print takes the prompt AS ITS ARGUMENT (verified: the spike and
  // agy-format both invoke `agy --model '...' -p '<prompt>'`; a bare `-p` errors
  // `flag needs an argument: -p`). The prompt is shell-single-quoted to survive
  // the `script -qec "..."` wrapper. Each `agy -p` is one full agentic loop.
  const escapedModel = shellQuoteSingle(model);
  const escapedPrompt = shellQuoteSingle(prompt);
  const shellCommand = `export PATH=${agyDirectory}:$PATH; script -qec "agy --model ${escapedModel} -p ${escapedPrompt}" /dev/null`;
  const invocation = buildAgyInvocation(shellCommand, sshHost);

  const child = spawnCommand(invocation.cmd, invocation.args, {
    cwd: sandboxDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let readinessTimer = null;

    const ready = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(readinessTimer);
      resolve({ child, onDeath: registerDeath(child) });
    };

    const timeout = () => {
      if (settled) {
        return;
      }
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      reject(new AgySpawnReadinessTimeout(`agy MCP initialize not seen within ${readyTimeoutMs}ms`));
    };

    // Readiness = the bridge's onReady (initialize + tools/list answered).
    server.onReady(ready);
    // Bounded deadline: no arbitrary sleep, a deterministic readiness timeout.
    readinessTimer = setTimeout(timeout, readyTimeoutMs);

    child.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(readinessTimer);
        // agy exited before readiness — the readiness signal will never come.
        reject(new AgySpawnReadinessTimeout('agy exited before the MCP initialize handshake'));
      }
    });

    // Hardening: a spawn-level failure (binary missing, EACCES) emits 'error'
    // rather than 'close'. Today's tests spawn bash (always present) so this is
    // not hit, but a missing agy on some host surfaces here — settle loudly with
    // a domain error rather than letting the timer run to its deadline.
    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(readinessTimer);
      reject(new SessionActorError(`spawnPtyAgy: child error before readiness (${err.message})`));
    });
  });
}

/**
 * Build the onDeath registration for a spawned child. The callback fires once
 * on process exit (close). Returns the registration fn so the actor/registry
 * can subscribe without owning the child handle directly.
 */
function registerDeath(child) {
  return (cb) => {
    child.on('close', (code, signal) => cb({ code, signal }));
  };
}

function requireNonEmpty(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SessionActorError(`spawnPtyAgy: ${label} must be a non-empty string`);
  }
}
