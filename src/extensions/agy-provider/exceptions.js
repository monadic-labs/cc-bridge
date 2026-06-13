/**
 * Domain-specific exceptions for the agy-provider extension.
 *
 * Each extension owns the exceptions its boundary surfaces. Unit 3 (the
 * bridge-server) needs one: dependency validation throws `McpBridgeError`
 * when a caller omits a required injection (listTools/onToolCall/onFinalAnswer)
 * or supplies a malformed stdio. Later units (actor, registry) add their own
 * here rather than reaching for `new Error(...)` (manifesto §Exceptions).
 */

import { ProxyError } from '../../core/exceptions.js';

export class McpBridgeError extends ProxyError {
  constructor(message, props) {
    super(message, { operation: 'agy-mcp-bridge', ...props });
  }
}
