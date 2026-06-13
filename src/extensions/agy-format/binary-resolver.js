/**
 * Dynamic agy binary resolution.
 *
 * Resolution order:
 *  1. Explicit config.agyPath override — if provided, use as-is.
 *  2. `agy` found on PATH via `which` (POSIX) / `where` (Windows).
 *  3. Per-OS canonical fallback location.
 *  4. Fail loud — no silent fallback.
 *
 * The `probeSeam` parameter exists solely to inject a platform probe for
 * cross-platform boundary tests without dynamic mocking. It is not a test
 * backdoor: production always passes the default (undefined → live probe).
 *
 * A `probeSeam` object must implement:
 *   - platform: 'win32' | 'linux' | 'darwin' | string
 *   - homeDir(): string
 *   - localAppDataDir(): string | undefined   (Windows only; undefined on POSIX)
 *   - findOnPath(cmd: string): string | null   (null when not found)
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';
import { AgyBinaryNotFoundError } from './exceptions.js';

/**
 * The live probe — uses real process.platform, os.homedir(), LOCALAPPDATA,
 * execSync for `which`/`where`, and fs.existsSync for fallback path probing.
 */
export const liveProbe = Object.freeze({
  platform: process.platform,
  homeDir: () => os.homedir(),
  localAppDataDir: () => process.env.LOCALAPPDATA ?? undefined,
  findOnPath(cmd) {
    const isWin = this.platform === 'win32';
    try {
      // eslint-disable-next-line local/no-direct-spawn
      const result = execSync(
        isWin ? `where ${cmd}` : `which ${cmd}`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const first = result.split(/\r?\n/)[0].trim();
      return first || null;
    } catch {
      return null;
    }
  },
  fileExists: (p) => fs.existsSync(p),
});

/**
 * Canonical per-OS fallback when `agy` is not on PATH.
 *  POSIX: $HOME/.local/bin/agy
 *  Windows: %LOCALAPPDATA%\agy\bin\agy
 *
 * Uses platform-specific path.win32 / path.posix so that cross-platform
 * test probes produce the correct separator regardless of the host OS.
 */
function canonicalFallbackPath(probe) {
  if (probe.platform === 'win32') {
    const localAppData = probe.localAppDataDir() ?? path.win32.join(probe.homeDir(), 'AppData', 'Local');
    return path.win32.join(localAppData, 'agy', 'bin', 'agy');
  }
  return path.posix.join(probe.homeDir(), '.local', 'bin', 'agy');
}

/**
 * Resolve the agy binary path.
 *
 * @param {string|undefined} configAgyPath - Explicit override from config.
 * @param {typeof liveProbe} [probe]        - Platform probe (injectable for tests).
 * @returns {string} Absolute or shell-resolvable path to agy.
 * @throws {AgyBinaryNotFoundError} When the binary cannot be located.
 */
export function resolveAgyBinary(configAgyPath, probe = liveProbe) {
  // 1. Explicit config override
  if (configAgyPath) return configAgyPath;

  // 2. PATH lookup
  const onPath = probe.findOnPath('agy');
  if (onPath) return onPath;

  // 3. Per-OS canonical fallback
  const fallback = canonicalFallbackPath(probe);
  if (probe.fileExists(fallback)) return fallback;

  // 4. Fail loud — all locations exhausted
  throw new AgyBinaryNotFoundError(
    `agy binary not found. Tried: PATH lookup, canonical fallback (${fallback}). ` +
    `Install agy or set config.agyPath explicitly.`
  );
}

/**
 * Derive the directory portion of an agy binary path for PATH export.
 * Works on both POSIX and Windows paths.
 *
 * @param {string} agyBinaryPath - Resolved binary path.
 * @returns {string} Directory containing the binary.
 */
export function agyDir(agyBinaryPath) {
  return path.dirname(agyBinaryPath);
}
