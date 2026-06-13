/**
 * Per-session mcp_config.json builder (pure).
 *
 * The per-session MCP config that points agy at THIS session's ccb-bridge MCP
 * server. Plain config — NO dispatcher-shim (dropped per the confirmed
 * isolation mechanism: per-session HOME + symlinked auth). agy reads
 * `$SESSION_HOME/.gemini/config/mcp_config.json` (HOME-scoped), so each session
 * gets its own bridge entry with zero config races across sessions.
 *
 * Pure: returns the config object, no I/O. The session-home shell writes it.
 */

import { McpBridgeError } from '../exceptions.js';

/** The single server key the bridge registers under (single source of truth). */
export const BRIDGE_SERVER_KEY = 'ccb-bridge';

/** The env var carrying the session id, passed to the bridge command. */
export const SESSION_ID_ENV = 'CCB_AGY_SESSION_ID';

/** The env var carrying the per-session runtime dir (where the adapter socket lives). */
export const RUNTIME_DIR_ENV = 'CCB_AGY_RUNTIME_DIR';

/** Domain error for malformed mcp-config inputs (named, not `new Error`). */
export class McpConfigError extends McpBridgeError {
  constructor(message, props) {
    super(message, { ...props, phase: 'mcp-config' });
  }
}

/**
 * Require a non-empty string; fail loud at this boundary rather than write a
 * config the bridge can't correlate on. Shared by bridgeCommand + sessionId + runtimeDir.
 */
function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new McpConfigError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Build the per-session mcp_config.json object.
 *
 * `bridgeCommand`, `sessionId`, and `runtimeDir` are all load-bearing: the
 * command launches the bridge subprocess; the session id + runtime dir let the
 * bridge-entry subprocess resolve the per-session adapter socket it connects to
 * (CCB_AGY_SESSION_ID + CCB_AGY_RUNTIME_DIR). Any undefined would silently yield
 * `env:{}` (JSON.stringify drops undefined), so all three are guarded symmetrically.
 *
 * @param {object} opts
 * @param {string} opts.bridgeCommand - the command that launches THIS session's bridge server.
 * @param {Array<string>} [opts.bridgeArgs=[]] - positional args for the bridge command.
 * @param {string} opts.sessionId       - the session id, surfaced to the bridge via env.
 * @param {string} opts.runtimeDir      - the per-session runtime dir (adapter socket root).
 * @returns {{mcpServers: object}} `{ mcpServers: { "ccb-bridge": { command, args, env } } }`.
 */
export function buildMcpConfig({ bridgeCommand, bridgeArgs, sessionId, runtimeDir }) {
  const command = requireNonEmptyString(bridgeCommand, 'bridgeCommand');
  requireNonEmptyString(sessionId, 'sessionId');
  requireNonEmptyString(runtimeDir, 'runtimeDir');
  const args = Array.isArray(bridgeArgs) ? [...bridgeArgs] : [];
  return {
    mcpServers: {
      [BRIDGE_SERVER_KEY]: {
        command,
        args,
        env: { [SESSION_ID_ENV]: sessionId, [RUNTIME_DIR_ENV]: runtimeDir },
      },
    },
  };
}
