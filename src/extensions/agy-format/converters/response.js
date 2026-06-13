/**
 * Convert agy CLI plain-text output into Anthropic response format.
 *
 * Two converters:
 *  - convertFullResponse: agy text → complete Anthropic message JSON
 *  - buildSseStream: agy text → complete Anthropic SSE event sequence
 *
 * Both are pure functions with no side effects.
 */

/**
 * Build a complete Anthropic message object from agy text output.
 *
 * @param {string} agyOutput - Raw text from agy CLI (ANSI already stripped)
 * @param {{ model: string }} meta - Request metadata
 * @returns {object} Anthropic message response
 */
export function convertFullResponse(agyOutput, { model }) {
  const text = typeof agyOutput === 'string' ? agyOutput : '';
  const timestamp = Date.now();

  return {
    id: `msg_agy_${timestamp.toString(36)}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    },
  };
}

/**
 * Build a complete SSE event sequence from agy text output.
 * Since agy does not stream tokens, the entire output is emitted in one shot.
 *
 * @param {string} agyOutput - Raw text from agy CLI (ANSI already stripped)
 * @param {{ model: string }} meta - Request metadata
 * @returns {string} Complete SSE event sequence
 */
export function buildSseStream(agyOutput, { model }) {
  const text = typeof agyOutput === 'string' ? agyOutput : '';
  const timestamp = Date.now();
  const messageId = `msg_agy_${timestamp.toString(36)}`;

  const events = [];

  events.push(`event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    },
  })}`);

  events.push(`event: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })}`);

  if (text) {
    events.push(`event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })}`);
  }

  events.push(`event: content_block_stop\ndata: ${JSON.stringify({
    type: 'content_block_stop',
    index: 0,
  })}`);

  events.push(`event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 0 },
  })}`);

  events.push(`event: message_stop\ndata: ${JSON.stringify({
    type: 'message_stop',
  })}`);

  return events.join('\n\n') + '\n\n';
}
