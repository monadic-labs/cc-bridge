/**
 * Seam2 — MCP tool call → Anthropic tool_use (pure).
 *
 * When agy calls an MCP tool, the bridge:
 *   1. builds an Anthropic tool_use content block (the adapter owns id correlation
 *      — agy's _meta carries progressToken/conversation_id but no usable tool id),
 *   2. emits the full SSE event sequence for one tool-bearing assistant turn, and
 *   3. CLOSES the HTTP response after message_stop.
 *
 * Closing after tool_use is protocol-correct: the stateless Messages API forbids
 * holding an HTTP response across Claude Code's tool execution. The only thing
 * held open is agy's MCP call (held by the bridge-server); the SSE ends here.
 * (Spec HTTP/SSE coordination Q2.)
 *
 * Synthesized usage: CC's context-tracking needs the token fields present even
 * though agy gives no real counts — we emit plausible zeros rather than omit
 * the fields (spec Schema mapping, "synthesize plausible usage").
 */

/** Build one Anthropic tool_use content block. */
export function buildToolUseBlock(toolUseId, name, input) {
  return { type: 'tool_use', id: toolUseId, name, input };
}

/**
 * Build the complete SSE event sequence for an assistant turn that issues one or
 * more tool_use blocks, then ends the stream.
 *
 * @param {object} opts
 * @param {string} opts.messageId
 * @param {string} opts.model
 * @param {Array<{type:'tool_use',id:string,name:string,input:object}>} opts.toolUseBlocks
 * @param {{inputTokens:number, outputTokens:number}} opts.usage
 * @returns {string} `event: message_start ... message_stop` joined by blank lines.
 */
export function buildToolUseSseSequence({ messageId, model, toolUseBlocks, usage }) {
  const blocks = Array.isArray(toolUseBlocks) ? toolUseBlocks : [];
  const inTokens = usage?.inputTokens ?? 0;
  const outTokens = usage?.outputTokens ?? 0;

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
      usage: { input_tokens: inTokens, output_tokens: 0 },
    },
  })}`);

  blocks.forEach((block, index) => {
    events.push(`event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
    })}`);
    events.push(`event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
    })}`);
    events.push(`event: content_block_stop\ndata: ${JSON.stringify({
      type: 'content_block_stop',
      index,
    })}`);
  });

  events.push(`event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: outTokens },
  })}`);

  events.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`);

  return events.join('\n\n') + '\n\n';
}
