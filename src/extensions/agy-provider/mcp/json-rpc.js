/**
 * JSON-RPC 2.0 codec for the agy-provider MCP bridge (Seam0 — the wire layer).
 *
 * Pure, dependency-free, deterministic. No I/O: the bridge-server module owns
 * stdin/stdout; this module only parses one line into a message and builds
 * response/error/request envelopes. Fallible parsing returns a Result — it
 * never throws and never salvages malformed input (manifesto §Exceptions).
 *
 * JSON-RPC error codes are centralized below; never inline the literals.
 */

import { Result } from '../../../core/types.js';

export const JSONRPC_VERSION = '2.0';

/**
 * JSON-RPC 2.0 error codes (the subset the bridge emits).
 * Frozen so no caller can mutate the shared contract.
 */
export const ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/**
 * Parse one stdio line into a JSON-RPC message.
 *
 * Returns a Result: ok → { id?, method?, params? }; fail → { raw, reason }.
 * A bare scalar/array (valid JSON but not a JSON-RPC object) fails — the
 * bridge only speaks request/response objects and notifications.
 *
 * @param {string} line - One line read from the transport.
 * @returns {Result<{id?:*,method?:string,params?:object}, {raw:string,reason:string}>}
 */
export function parseMessage(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return Result.fail({ raw: line, reason: 'non-JSON input' });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return Result.fail({ raw: line, reason: 'JSON-RPC message must be an object' });
  }

  return Result.ok({
    id: parsed.id,
    method: typeof parsed.method === 'string' ? parsed.method : undefined,
    params: parsed.params,
  });
}

/**
 * Build a success-result envelope string.
 *
 * @param {*} id       - The request id being answered (number/string/null).
 * @param {object} result - The result payload (content/isError for tools/call).
 * @returns {string} `{"jsonrpc":"2.0","id":...,"result":...}`
 */
export function buildResult(id, result) {
  return JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result });
}

/**
 * Build an error envelope string.
 *
 * @param {*} id - The request id being answered (null when the id was unparseable).
 * @param {number} code - One of ERROR_CODES.
 * @param {string} message - Human-readable detail.
 * @returns {string} `{"jsonrpc":"2.0","id":...,"error":{"code":...,"message":...}}`
 */
export function buildError(id, code, message) {
  return JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } });
}

/**
 * Build a server-initiated request envelope string.
 *
 * @param {*} id - A server-chosen request id.
 * @param {string} method - The method name.
 * @param {object} params - The request params.
 * @returns {string} `{"jsonrpc":"2.0","id":...,"method":...,"params":...}`
 */
export function buildRequest(id, method, params) {
  return JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params });
}
