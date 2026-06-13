/**
 * Per-session adapter-socket path resolver (pure — single source of truth).
 *
 * The bridge↔actor transport correlates on the session id: the actor listens on
 * `socketPathForSession(sessionId, runtimeDir)` and the bridge-entry subprocess
 * (agy spawns it) connects to the SAME path. Both ends compute it from the id,
 * so there is one path shape in one place (manifesto §Filesystem paths: same
 * path shape in two files → extract a shared constant/module).
 */

import path from 'node:path';

/** The filename (under the per-adapter runtime dir) for one session's socket. */
function socketFileName(sessionId) {
  return `ccb-agy-bridge-${sessionId}.sock`;
}

/**
 * Resolve the absolute unix-socket path for one session.
 *
 * @param {string} sessionId  - the session id (CCB_AGY_SESSION_ID).
 * @param {string} runtimeDir - the per-adapter runtime dir (a tmp/work area).
 * @returns {string} absolute socket path.
 */
export function socketPathForSession(sessionId, runtimeDir) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('sessionId must be a non-empty string');
  }
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) {
    throw new TypeError('runtimeDir must be a non-empty string');
  }
  return path.join(runtimeDir, socketFileName(sessionId));
}
