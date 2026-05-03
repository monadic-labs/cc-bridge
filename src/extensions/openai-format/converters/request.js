/**
 * Convert an Anthropic-format request body to OpenAI chat completion format.
 */

export function convertRequest(body) {
  const messages = [];

  // System prompt → system role message
  if (body.system) {
    let systemText = '';
    if (typeof body.system === 'string') {
      systemText = body.system;
    }
    if (Array.isArray(body.system)) {
      systemText = body.system.map(s => (typeof s === 'string' ? s : s.text ?? '')).join('\n');
    }
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  // Convert Anthropic messages to OpenAI format
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const converted = convertMessage(msg);
      if (converted) {
        if (Array.isArray(converted)) {
          messages.push(...converted);
          continue;
        }
        messages.push(converted);
      }
    }
  }

  const result = {
    model: body.model,
    messages,
  };

  if (body.max_tokens) {
    result.max_tokens = body.max_tokens;
  }

  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    result.stop = body.stop_sequences.length === 1 ? body.stop_sequences[0] : body.stop_sequences;
  }

  if (body.stream === true) {
    result.stream = true;
  }

  if (typeof body.temperature === 'number') {
    result.temperature = body.temperature;
  }

  if (typeof body.top_p === 'number') {
    result.top_p = body.top_p;
  }

  if (body.tools) {
    result.tools = convertTools(body.tools);
  }

  if (body.tool_choice) {
    result.tool_choice = convertToolChoice(body.tool_choice);
  }

  return result;
}

function convertMessage(msg) {
  if (msg.role === 'user') {
    return { role: 'user', content: convertContent(msg.content) };
  }

  if (msg.role === 'assistant') {
    // Check for tool_use blocks → need tool_calls format
    const content = Array.isArray(msg.content) ? msg.content : msg.content;
    const hasToolUse = Array.isArray(content) && content.some(b => b.type === 'tool_use');

    if (hasToolUse) {
      const toolCalls = [];
      const textParts = [];

      for (const block of content) {
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
            },
          });
          continue;
        }
        if (block.type === 'text') {
          textParts.push(block.text ?? '');
          continue;
        }
        // Skip thinking/redacted_thinking blocks
      }

      return {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('') : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    }

    return { role: 'assistant', content: convertContent(content) };
  }

  return null;
}

function convertContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;

  const parts = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text ?? '' });
      continue;
    }
    if (block.type === 'image') {
      const url = block.source?.data
        ? `data:${block.source.media_type ?? 'image/png'};base64,${block.source.data}`
        : block.source?.url ?? '';
      parts.push({ type: 'image_url', image_url: { url } });
      continue;
    }
    if (block.type === 'tool_result') {
      const resultContent = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content ?? {});
      parts.push({ type: 'text', text: `[Tool result for ${block.tool_use_id}]: ${resultContent}` });
      continue;
    }
    // Skip thinking/redacted_thinking blocks
  }

  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

function convertTools(tools) {
  return tools.map((tool) => {
    if (tool.type === 'web_search' || tool.type === 'computer_20250124' || tool.type === 'text_editor_20250409' || tool.type === 'bash_20250124') {
      // Anthropic built-in tools — skip, OpenAI doesn't have equivalents
      return null;
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? tool.parameters ?? {},
      },
    };
  }).filter(Boolean);
}

function convertToolChoice(toolChoice) {
  if (toolChoice === 'auto') return 'auto';
  if (toolChoice === 'any') return 'required';
  if (toolChoice === 'none') return 'none';
  if (typeof toolChoice === 'object' && toolChoice.type === 'tool') {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return 'auto';
}
