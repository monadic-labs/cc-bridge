import { ANTHROPIC_HOST } from './headers.js';
import { RoutingResult, Option } from './types.js';

function flattenSystemPrompt(system) {
  if (!Array.isArray(system)) return system;
  const flattened = system
    .map((s) => (typeof s === 'string' ? s : s.text ?? ''))
    .join('\n')
    .trim();
  if (!flattened) return undefined;
  return flattened;
}

function extractToolResultText(block) {
  if (typeof block === 'string') return block;
  if (block.text) return block.text;
  return JSON.stringify(block);
}

function sanitizeToolResult(block) {
  const { cache_control: _, ...rest } = block;
  if (!Array.isArray(rest.content)) return rest;
  const joinedContent = rest.content.map(extractToolResultText).join('\n');
  return { ...rest, content: joinedContent };
}

function sanitizeThinkingBlock(block, isCompliant) {
  const hasValidSignature = typeof block.signature === 'string' && block.signature.length > 0;
  if (isCompliant && hasValidSignature) return block;
  
  const textContent = block.thinking || '';
  return { type: 'text', text: `\`\`\`thinking\n${textContent}\n\`\`\`\n` };
}

function sanitizeRedactedThinking(block, isCompliant) {
  const hasValidSignature = typeof block.signature === 'string' && block.signature.length > 0;
  if (isCompliant && hasValidSignature) return block;
  
  const data = block.data || '[Redacted Thinking]';
  return { type: 'text', text: `\`\`\`thinking\n${data}\n\`\`\`\n` };
}

function sanitizeConnectorText(block, isCompliant) {
  const hasValidSignature = typeof block.signature === 'string' && block.signature.length > 0;
  if (isCompliant && hasValidSignature) return block;
  
  const textContent = block.text || '';
  return { type: 'text', text: `[Connector Text]\n${textContent}` };
}

function sanitizeGenericBlock(block, isCompliant) {
  if (isCompliant) return block;
  const { cache_control: _, ...rest } = block;
  return rest;
}

function sanitizeBlock(block, isCompliant) {
  if (typeof block !== 'object' || block === null) return block;

  if (block.type === 'thinking') return sanitizeThinkingBlock(block, isCompliant);
  if (block.type === 'redacted_thinking') return sanitizeRedactedThinking(block, isCompliant);
  if (block.type === 'connector_text') return sanitizeConnectorText(block, isCompliant);
  if (block.type === 'tool_result' && !isCompliant) return sanitizeToolResult(block);

  return sanitizeGenericBlock(block, isCompliant);
}

function mergeAdjacentTextBlocks(blocks) {
  const merged = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    if (last && last.type === 'text' && block.type === 'text') {
      last.text = (last.text || '') + '\n' + (block.text || '');
    } else {
      merged.push({ ...block }); 
    }
  }
  return merged;
}

function sanitizeContent(content, isCompliant) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const safeBlocks = content.map(b => sanitizeBlock(b, isCompliant));
    return mergeAdjacentTextBlocks(safeBlocks);
  }
  if (typeof content === 'object' && content !== null) {
    return sanitizeBlock(content, isCompliant);
  }
  return content;
}

function sanitizeMessage(m, isCompliant) {
  if (!m || typeof m !== 'object') return m;
  return { ...m, content: sanitizeContent(m.content, isCompliant) };
}

export function sanitizeMessages(messages, isCompliant) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(m => sanitizeMessage(m, isCompliant));
}

export function routeToAnthropic(body) {
  const modelStr = body.model ?? 'unknown';
  const safeBody = { 
    ...body, 
    system: sanitizeContent(body.system, true),
    messages: sanitizeMessages(body.messages, true) 
  };

  return new RoutingResult({
    forwardBody: Buffer.from(JSON.stringify(safeBody)),
    targetBase: `https://${ANTHROPIC_HOST}`,
    label: `Anthropic (${modelStr})`,
    isCustom: false
  });
}

function buildNonCompliantBody(body, realModel) {
  const { betas: _, system, messages, ...rest } = body;
  
  const safeBody = {
    ...rest,
    model: realModel,
    system: flattenSystemPrompt(system),
    messages: sanitizeMessages(messages, false)
  };
  
  return safeBody;
}

function buildCompliantBody(body, realModel) {
  return { 
    ...body, 
    model: realModel, 
    system: sanitizeContent(body.system, true),
    messages: sanitizeMessages(body.messages, true) 
  };
}

export function routeToProvider(body, match) {
  const { provider, realModel, label } = match;
  const isCompliant = provider.anthropicCompliant;
  
  const finalBody = isCompliant 
    ? buildCompliantBody(body, realModel)
    : buildNonCompliantBody(body, realModel);
  
  return new RoutingResult({
    forwardBody: Buffer.from(JSON.stringify(finalBody)),
    targetBase: provider.url,
    label: `Provider (${label})`,
    isCustom: true
  });
}

export function applyRouting(body, providersMap) {
  if (typeof body.model !== 'string') return routeToAnthropic(body);
  
  const match = providersMap.resolve(body.model);
  if (!match) return routeToAnthropic(body);
  
  return routeToProvider(body, match);
}

export function applyAuthHeaders({ headers, match, apiKey = '' }) {
  if (!match) return { ...headers };
  
  const { provider } = match;
  const { authorization: _, 'anthropic-beta': beta, ...rest } = headers;
  const updated = { ...rest };
  
  if (provider.id && apiKey) {
    updated['x-api-key'] = apiKey;
  }

  if (provider.anthropicCompliant && beta !== undefined) {
    updated['anthropic-beta'] = beta;
  }

  return updated;
}

function tryParseUserId(userIdStr) {
  if (typeof userIdStr !== 'string') return Option.none();
  try { 
    const parsed = JSON.parse(userIdStr);
    if (!parsed.session_id) return Option.none();
    return Option.some(parsed.session_id);
  } catch { 
    return Option.none();
  }
}

export function extractSessionId(body) {
  if (!body) return '';
  
  const userIdStr = body.metadata?.user_id;
  const parsedUserId = tryParseUserId(userIdStr);
  
  if (parsedUserId.isSome) return parsedUserId.value;
  
  if (body.metadata?.session_id) return body.metadata.session_id;
  if (body.session_id) return body.session_id;
  
  return '';
}

export function tryParseBody(rawBody) {
  if (!rawBody) return Option.none();
  if (rawBody.length === 0) return Option.none();
  
  try { 
    return Option.some(JSON.parse(rawBody.toString())); 
  } catch { 
    return Option.none(); 
  }
}
