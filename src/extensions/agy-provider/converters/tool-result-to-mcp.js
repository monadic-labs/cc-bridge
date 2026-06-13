/**
 * Seam3 — Anthropic tool_result → MCP structured result (pure).
 *
 * When Claude Code returns a tool_result, the bridge resolves the held MCP call
 * with this converted payload. Content may be a string or an array of content
 * blocks (Anthropic permits both); is_error maps to the MCP isError flag (the
 * exception path). Malformed payloads are guard-rejected as a Result failure —
 * the adapter never salvages (manifesto §Exceptions: predictable failures →
 * Result; never salvage malformed).
 */

import { Result } from '../../../core/types.js';

/**
 * Normalize Anthropic content (string | array of blocks) into MCP content parts.
 * A string becomes a single text part; an array is mapped to text parts.
 *
 * @param {string|Array} content
 * @returns {Array<{type:'text', text:string}>}
 */
function toContentParts(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content.map((part) => ({
      type: part.type ?? 'text',
      text: typeof part.text === 'string' ? part.text : JSON.stringify(part),
    }));
  }
  return [{ type: 'text', text: '' }];
}

/**
 * Convert an Anthropic tool_result into an MCP structured result.
 *
 * @param {object} toolResult - { tool_use_id, content, is_error? }
 * @returns {Result<{content: Array, isError: boolean}, {reason:string}>}
 *   Fails (never salvages) when tool_use_id is missing or the input is not an object.
 */
export function convertToolResult(toolResult) {
  if (toolResult === null || typeof toolResult !== 'object' || Array.isArray(toolResult)) {
    return Result.fail({ reason: 'tool_result must be an object' });
  }

  if (toolResult.tool_use_id === undefined || toolResult.tool_use_id === null) {
    return Result.fail({ reason: 'tool_result missing tool_use_id' });
  }

  return Result.ok({
    content: toContentParts(toolResult.content),
    isError: toolResult.is_error === true,
  });
}
