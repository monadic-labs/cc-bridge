/**
 * z.ai web search tool transformation extension.
 *
 * Converts Anthropic-format web_search tool definitions to z.ai's native
 * format on outgoing requests, and strips z.ai-specific response metadata
 * before forwarding to Claude Code CLI.
 */

const WEB_SEARCH_TOOL_RE = /^web_search(_\d{8})?$/;

/**
 * Create a web-search-zai extension configured with the given params.
 *
 * @param {object} params - z.ai web_search params from provider config
 * @returns {{ name: string, hooks: object }}
 */
export function createWebSearchZaiExtension(params) {
  const searchConfig = {
    enable: 'True',
    search_result: 'True',
    search_engine: params.search_engine ?? 'search-prime',
    count: params.count ?? '5',
    search_recency_filter: params.search_recency_filter ?? 'noLimit',
    content_size: params.content_size ?? 'high',
  };
  if (params.search_domain_filter) searchConfig.search_domain_filter = params.search_domain_filter;
  if (params.search_prompt) searchConfig.search_prompt = params.search_prompt;

  return {
    name: 'web-search-zai',

    hooks: {
      requestTransform: {
        order: 80,
        transform: (ctx) => transformRequest(ctx, searchConfig),
      },
      responseTransform: {
        order: 80,
        transform: transformFullResponse,
      },
      sseChunkTransform: {
        order: 80,
        transform: transformSseChunk,
      },
    },
  };
}

// ── Request Transform ─────────────────────────────────────────────────────

/**
 * Transform request body: rewrite web_search tools to z.ai format and
 * sanitize multi-turn history.
 */
function transformRequest({ body, provider }, searchConfig) {
  if (!provider?.toolTransforms?.web_search) return body;

  let transformed = false;
  const tools = Array.isArray(body.tools) ? [...body.tools] : null;

  // Rewrite tool definitions
  if (tools) {
    for (let i = 0; i < tools.length; i++) {
      if (typeof tools[i]?.type === 'string' && WEB_SEARCH_TOOL_RE.test(tools[i].type)) {
        tools[i] = { type: 'web_search', web_search: { ...searchConfig } };
        transformed = true;
      }
    }
  }

  // Sanitize history: convert web_search tool_use/tool_result to text blocks
  const messages = Array.isArray(body.messages) ? sanitizeWebSearchHistory(body.messages) : body.messages;
  if (messages !== body.messages) transformed = true;

  if (!transformed) return body;
  return { ...body, ...(tools ? { tools } : {}), messages };
}

/**
 * Convert web_search tool_use and matching tool_result blocks to text
 * so z.ai doesn't choke on Anthropic-format tool cycles from history.
 */
export function sanitizeWebSearchHistory(messages) {
  const wsToolUseIds = new Set();

  // First pass: collect tool_use IDs for web_search
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.name === 'web_search' && block.id) {
          wsToolUseIds.add(block.id);
        }
      }
    }
  }

  if (wsToolUseIds.size === 0) return messages;

  let changed = false;
  const result = messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;

    const newContent = msg.content.map((block) => {
      if (block.type === 'tool_use' && block.name === 'web_search') {
        changed = true;
        const query = block.input?.query ?? JSON.stringify(block.input ?? {});
        return { type: 'text', text: `[web_search query: ${query}]` };
      }
      if (block.type === 'tool_result' && wsToolUseIds.has(block.tool_use_id)) {
        changed = true;
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? {});
        return { type: 'text', text: `[web_search results: ${content}]` };
      }
      return block;
    });

    return changed ? { ...msg, content: newContent } : msg;
  });

  return changed ? result : messages;
}

// ── Response Transform (full body) ────────────────────────────────────────

function transformFullResponse({ response, provider }) {
  if (!provider?.toolTransforms?.web_search) return response;
  if (typeof response !== 'string') return response;

  // Fast check before parsing
  if (!response.includes('"web_search"')) return response;

  try {
    const parsed = JSON.parse(response);
    if (!parsed.web_search) return response;
    delete parsed.web_search;
    return JSON.stringify(parsed);
  } catch {
    return response;
  }
}

// ── Response Transform (SSE chunk) ────────────────────────────────────────

function transformSseChunk({ chunk, provider }) {
  if (!provider?.toolTransforms?.web_search) return chunk;
  if (!chunk.includes('"web_search"')) return chunk;

  // SSE chunks are multi-line. Process each data: line independently.
  const lines = chunk.split('\n');
  const result = [];
  let modified = false;

  for (const line of lines) {
    if (!line.startsWith('data: ')) {
      result.push(line);
      continue;
    }
    try {
      const evt = JSON.parse(line.slice(6));
      if (evt.type === 'message_start' && evt.message?.web_search) {
        delete evt.message.web_search;
        result.push('data: ' + JSON.stringify(evt));
        modified = true;
        continue;
      }
    } catch {
      // not JSON — leave as-is
    }
    result.push(line);
  }

  return modified ? result.join('\n') : chunk;
}
