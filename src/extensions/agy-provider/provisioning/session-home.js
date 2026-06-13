/**
 * Per-session HOME provisioner (imperative shell — owns fs/symlink I/O).
 *
 * This is the confirmed isolation mechanism (NOT the dropped dispatcher-shim):
 * each session gets its own `HOME` dir whose `.gemini/` tree holds per-session
 * config, plus SYMLINKS to the 3 real auth files. agy is spawned with
 * `HOME=$homeDir`, so it reads the session's isolated config AND authenticates
 * via the shared real OAuth tokens (read-only symlinks — one source of truth).
 *
 * Functional core / imperative shell: the pure builders (gemini-md.js,
 * permissions.js, mcp-config.js) produce the CONTENT; this module owns the
 * filesystem — mkdir, writeFile, symlink. `fs` is injected so tests run on a
 * per-test tmp tree (real fs, no mock).
 */

import path from 'node:path';
import fsDefault from 'node:fs';
import { McpBridgeError } from '../exceptions.js';

/**
 * The `.gemini` tree layout under a session HOME. Single source of truth for
 * the path segments this shell creates (a rename is a one-line edit here).
 */
export const GEMINI_LAYOUT = Object.freeze({
  ROOT: '.gemini',
  CONFIG_DIR: 'config',
  MCP_CONFIG_FILE: 'mcp_config.json',
  ANTIGRAVITY_DIR: 'antigravity-cli',
  SETTINGS_FILE: 'settings.json',
});

/** The sandbox file agy reads as its operating manual. */
export const SANDBOX_MANUAL_FILE = 'GEMINI.md';

/**
 * The 3 real auth files symlinked read-only into each session HOME. Paths are
 * RELATIVE to the real `~/.gemini` dir (realGeminiDir) and mirrored under the
 * session's `~/.gemini`. Frozen — the auth contract must not drift silently.
 */
export const AUTH_FILES = Object.freeze([
  path.join(GEMINI_LAYOUT.ANTIGRAVITY_DIR, 'antigravity-oauth-token'),
  'oauth_creds.json',
  'google_accounts.json',
]);

/**
 * Provision one session's HOME directory tree.
 *
 * Creates `homeDir/.gemini/config/` + `homeDir/.gemini/antigravity-cli/` + the
 * `sandboxDir`, writes the per-session config/settings/manual, and symlinks
 * the 3 real auth files into the session HOME. Returns the resolved paths and
 * the `HOME` value to spawn agy with.
 *
 * @param {object} deps
 * @param {string} deps.homeDir             - the per-session HOME (created if absent).
 * @param {string} deps.realGeminiDir       - the user's real ~/.gemini (auth source).
 * @param {string} deps.sandboxDir          - the per-session cwd sandbox (GEMINI.md lives here).
 * @param {string} deps.geminiMd            - GEMINI.md content (buildGeminiMd()).
 * @param {object} deps.permissionsSettings - settings content (buildPermissionsSettings()).
 * @param {object} deps.mcpConfig           - mcp_config content (buildMcpConfig()).
 * @param {object} [deps.fs]                - injected fs (real node:fs in prod; tmp tree in tests).
 * @returns {{home:string, sandboxDir:string, geminiDir:string, mcpConfigPath:string, settingsPath:string, geminiMdPath:string, symlinkPaths:string[]}}
 */
export function provisionSessionHome(deps) {
  const validated = validateDeps(deps);
  const { homeDir, realGeminiDir, sandboxDir, geminiMd, permissionsSettings, mcpConfig, fs } = validated;

  const geminiDir = path.join(homeDir, GEMINI_LAYOUT.ROOT);
  const configDir = path.join(geminiDir, GEMINI_LAYOUT.CONFIG_DIR);
  const antigravityDir = path.join(geminiDir, GEMINI_LAYOUT.ANTIGRAVITY_DIR);
  const mcpConfigPath = path.join(configDir, GEMINI_LAYOUT.MCP_CONFIG_FILE);
  const settingsPath = path.join(antigravityDir, GEMINI_LAYOUT.SETTINGS_FILE);
  const geminiMdPath = path.join(sandboxDir, SANDBOX_MANUAL_FILE);

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(antigravityDir, { recursive: true });
  fs.mkdirSync(sandboxDir, { recursive: true });

  writeFileJson(fs, mcpConfigPath, mcpConfig);
  writeFileJson(fs, settingsPath, permissionsSettings);
  fs.writeFileSync(geminiMdPath, geminiMd, 'utf8');

  const symlinkPaths = AUTH_FILES.map((rel) => {
    const source = path.join(realGeminiDir, rel);
    const target = path.join(geminiDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    createSymlink(fs, source, target);
    return target;
  });

  return {
    home: homeDir,
    sandboxDir,
    geminiDir,
    mcpConfigPath,
    settingsPath,
    geminiMdPath,
    symlinkPaths,
  };
}

function writeFileJson(fs, filePath, obj) {
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function createSymlink(fs, source, target) {
  // Remove a stale link/file first so provisioning is idempotent on an
  // existing session tree; then create a fresh symlink pointing at the real auth.
  try { fs.rmSync(target, { force: true }); } catch { /* absent — fine */ }
  try {
    fs.symlinkSync(source, target);
    return;
  } catch (err) {
    throw new McpBridgeError(`failed to symlink auth file ${source} -> ${target}: ${err.message}`, { cause: err });
  }
}

function validateDeps(deps) {
  if (deps === null || typeof deps !== 'object') {
    throw new McpBridgeError('provisionSessionHome deps must be an object');
  }
  requireNonEmptyString(deps.homeDir, 'homeDir');
  requireNonEmptyString(deps.realGeminiDir, 'realGeminiDir');
  requireNonEmptyString(deps.sandboxDir, 'sandboxDir');
  requireNonEmptyString(deps.geminiMd, 'geminiMd');
  if (deps.permissionsSettings === null || typeof deps.permissionsSettings !== 'object' || Array.isArray(deps.permissionsSettings)) {
    throw new McpBridgeError('permissionsSettings must be an object');
  }
  if (deps.mcpConfig === null || typeof deps.mcpConfig !== 'object' || Array.isArray(deps.mcpConfig)) {
    throw new McpBridgeError('mcpConfig must be an object');
  }
  return { ...deps, fs: deps.fs ?? fsDefault };
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new McpBridgeError(`${name} must be a non-empty string`);
  }
}
