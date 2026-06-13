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

/** Domain error for malformed mcp-config inputs (named, not `new Error`). */
export class McpConfigError extends McpBridgeError {
  constructor(message, props) {
    super(message, { ...props, phase: 'mcp-config' });
  }
}

/**
 * Require a non-empty bridge command; fail loud at this boundary rather than
 * write a config agy can't launch.
 */
function requireBridgeCommand(bridgeCommand) {
  if (typeof bridgeCommand !== 'string' || bridgeCommand.length === 0) {
    throw new McpConfigError('bridgeCommand must be a non-empty string');
  }
  return bridgeCommand;
}

/**
 * Build the per-session mcp_config.json object.
 *
 * @param {object} opts
 * @param {string} opts.bridgeCommand - the command that launches THIS session's bridge server.
 * @param {Array<string>} [opts.bridgeArgs=[]] - positional args for the bridge command.
 * @param {string} opts.sessionId       - the session id, surfaced to the bridge via env.
 * @returns {{mcpServers: object}} `{ mcpServers: { "ccb-bridge": { command, args, env } } }`.
 */
export function buildMcpConfig({ bridgeCommand, bridgeArgs, sessionId }) {
  const command = requireBridgeCommand(bridgeCommand);
  const args = Array.isArray(bridgeArgs) ? [...bridgeArgs] : [];
  return {
    mcpServers: {
      [BRIDGE_SERVER_KEY]: {
        command,
        args,
        env: { [SESSION_ID_ENV]: sessionId },
      },
    },
  };
}
