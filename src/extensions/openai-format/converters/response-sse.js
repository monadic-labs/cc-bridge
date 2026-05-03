/**
 * Convert OpenAI streaming SSE chunks to Anthropic SSE event format.
 *
 * OpenAI sends `data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{...}}]}`
 * Anthropic expects separate events: message_start, content_block_start, content_block_delta,
 * content_block_stop, message_delta, message_stop.
 *
 * This converter maintains state across chunks to track block indices, tool call IDs, etc.
 */

export function createState() {
  return {
    messageId: null,
    model: null,
    blockIndex: 0,
    currentBlockType: null,
    toolCallIndex: 0,
    started: false,
    finished: false,
    inputTokens: 0,
    outputTokens: 0,
  };
}

export function convertChunk(chunk, state) {
  if (!chunk || state.finished) return '';

  const lines = chunk.split('\n');
  const output = [];

  for (const line of lines) {
    if (!line.startsWith('data: ')) {
      if (line.startsWith('event: ') || line === '') {
        // Pass through event type lines and empty separators for structure
        // but we generate our own Anthropic events
      }
      continue;
    }

    const data = line.slice(6).trim();
    if (data === '[DONE]') {
      output.push(...finishMessage(state));
      state.finished = true;
      continue;
    }

    try {
      const parsed = JSON.parse(data);
      output.push(...processChunk(parsed, state));
    } catch {
      // Non-JSON data line — skip
    }
  }

  const result = output.join('\n\n');
  return result ? result + '\n\n' : '';
}

function processChunk(chunk, state) {
  const events = [];

  if (!state.started) {
    state.messageId = chunk.id ?? `msg_${Date.now()}`;
    state.model = chunk.model ?? '';
    state.started = true;
    events.push(messageStartEvent(state));
  }

  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) return events;

  const choice = choices[0];
  const delta = choice.delta ?? {};

  // Handle role (usually just the first chunk)
  if (delta.role && delta.role === 'assistant' && state.currentBlockType === null) {
    // Role chunk — no content action needed, Anthropic doesn't have this
  }

  // Text content
  if (delta.content !== undefined && delta.content !== null) {
    if (state.currentBlockType !== 'text') {
      if (state.currentBlockType !== null) {
        events.push(contentBlockStopEvent(state));
      }
      events.push(contentBlockStartEvent(state, { type: 'text', text: '' }));
      state.currentBlockType = 'text';
    }
    events.push(contentBlockDeltaEvent(state, { type: 'text_delta', text: delta.content }));
  }

  // Tool calls
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (tc.function?.name) {
        // New tool call starting
        if (state.currentBlockType !== null) {
          events.push(contentBlockStopEvent(state));
        }
        const toolId = tc.id ?? `toolu_${state.blockIndex}`;
        events.push(contentBlockStartEvent(state, {
          type: 'tool_use',
          id: toolId,
          name: tc.function.name,
          input: {},
        }));
        state.currentBlockType = 'tool_use';
        state.currentToolId = toolId;
        state.currentToolName = tc.function.name;
      }

      if (tc.function?.arguments) {
        if (state.currentBlockType !== 'tool_use') {
          if (state.currentBlockType !== null) {
            events.push(contentBlockStopEvent(state));
          }
          events.push(contentBlockStartEvent(state, {
            type: 'tool_use',
            id: tc.id ?? state.currentToolId ?? `toolu_${state.blockIndex}`,
            name: '',
            input: {},
          }));
          state.currentBlockType = 'tool_use';
        }
        events.push(contentBlockDeltaEvent(state, {
          type: 'input_json_delta',
          partial_json: tc.function.arguments,
        }));
      }
    }
  }

  // Finish reason
  if (choice.finish_reason) {
    if (state.currentBlockType !== null) {
      events.push(contentBlockStopEvent(state));
      state.currentBlockType = null;
    }

    const stopReason = convertStopReason(choice.finish_reason);
    events.push(messageDeltaEvent(state, stopReason));
  }

  // Usage
  if (chunk.usage) {
    state.inputTokens = chunk.usage.prompt_tokens ?? state.inputTokens;
    state.outputTokens = chunk.usage.completion_tokens ?? state.outputTokens;
  }

  return events;
}

function finishMessage(state) {
  const events = [];
  if (state.currentBlockType !== null) {
    events.push(contentBlockStopEvent(state));
  }
  if (!state.finished) {
    events.push(messageDeltaEvent(state, 'end_turn'));
    events.push(messageStopEvent());
  }
  return events;
}

function convertStopReason(reason) {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

// ── Anthropic SSE Event Builders ──

function messageStartEvent(state) {
  return `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: state.inputTokens, output_tokens: 0 },
    },
  })}`;
}

function contentBlockStartEvent(state, block) {
  const idx = state.blockIndex;
  state.blockIndex++;
  return `event: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start',
    index: idx,
    content_block: block,
  })}`;
}

function contentBlockDeltaEvent(state, delta) {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index: state.blockIndex - 1,
    delta,
  })}`;
}

function contentBlockStopEvent(state) {
  return `event: content_block_stop\ndata: ${JSON.stringify({
    type: 'content_block_stop',
    index: state.blockIndex - 1,
  })}`;
}

function messageDeltaEvent(state, stopReason) {
  return `event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: state.outputTokens },
  })}`;
}

function messageStopEvent() {
  return `event: message_stop\ndata: ${JSON.stringify({
    type: 'message_stop',
  })}`;
}

/**
 * Convert a full (non-streaming) OpenAI response to Anthropic format.
 */
export function convertFullResponse(responseStr) {
  try {
    const parsed = JSON.parse(responseStr);

    const content = [];
    const choice = parsed.choices?.[0];
    if (choice) {
      if (choice.message?.content) {
        content.push({ type: 'text', text: choice.message.content });
      }
      if (Array.isArray(choice.message?.tool_calls)) {
        for (const tc of choice.message.tool_calls) {
          let input = {};
          try {
            input = JSON.parse(tc.function?.arguments ?? '{}');
          } catch { /* keep empty */ }
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name ?? '',
            input,
          });
        }
      }
    }

    return JSON.stringify({
      id: parsed.id ?? `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content,
      model: parsed.model ?? '',
      stop_reason: convertStopReason(choice?.finish_reason),
      stop_sequence: null,
      usage: {
        input_tokens: parsed.usage?.prompt_tokens ?? 0,
        output_tokens: parsed.usage?.completion_tokens ?? 0,
      },
    });
  } catch {
    return responseStr;
  }
}
