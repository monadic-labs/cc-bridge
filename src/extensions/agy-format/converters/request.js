/**
 * Convert an Anthropic /v1/messages request body into a single prompt string
 * for the `agy -p` CLI interface.
 *
 * Lossy by design — agy has no tools, no multi-turn, no streaming.
 * The conversation is flattened into a single text prompt.
 */

/**
 * Extract text content from a message content block.
 * Returns empty string for non-text blocks (tool_use, tool_result, thinking, etc.).
 */
function extractText(block) {
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  if (block.type === 'tool_result') return '[Tool result]';
  return '';
}

/**
 * Extract text content from a content array or string.
 */
function extractContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(extractText).filter(t => t.length > 0).join('\n');
}

/**
 * Flatten the system prompt into a prefix string.
 */
function extractSystem(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');
}

/**
 * Convert an Anthropic messages body into a single prompt string for agy.
 *
 * @param {object} body - Anthropic /v1/messages request body
 * @returns {string} Flat prompt string
 */
export function convertRequest(body) {
  if (!body || typeof body !== 'object') return '';

  const parts = [];

  const systemText = extractSystem(body.system);
  if (systemText) parts.push(`System: ${systemText}`);

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    const text = extractContent(msg.content);
    if (!text) continue;

    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    parts.push(`${role}: ${text}`);
  }

  return parts.join('\n\n');
}
