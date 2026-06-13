/**
 * Domain-specific exceptions for the agy-provider extension.
 *
 * Each extension owns the exceptions its boundary surfaces. Unit 3 (the
 * bridge-server) needs one: dependency validation throws `McpBridgeError`
 * when a caller omits a required injection (listTools/onToolCall/onFinalAnswer)
 * or supplies a malformed stdio. Unit 6 (actor + pty-spawn) adds two more:
 * `SessionActorError` (actor lifecycle / held-call invariant violations) and
 * `AgySpawnReadinessTimeout` (agy's MCP initialize not seen in time). No
 * `new Error(...)` anywhere (manifesto §Exceptions).
 */

import { ProxyError } from '../../core/exceptions.js';

export class McpBridgeError extends ProxyError {
  constructor(message, props) {
    super(message, { operation: 'agy-mcp-bridge', ...props });
  }
}

export class SessionActorError extends McpBridgeError {
  constructor(message, props) {
    super(message, { ...props, phase: 'session-actor' });
  }
}

export class AgySpawnReadinessTimeout extends McpBridgeError {
  constructor(message, props) {
    super(message, { ...props, phase: 'agy-spawn-readiness' });
  }
}
