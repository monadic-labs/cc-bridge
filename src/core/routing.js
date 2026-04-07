import { ANTHROPIC_HOST } from './headers.js';
import { RoutingResult, Option } from './types.js';

/**
 * Message sanitization for multi-provider routing.
 *
 * ## Why sanitization exists
 *
 * When switching providers mid-session (e.g. GLM → Opus), the CLI's session
 * history may contain thinking blocks with empty signatures from custom providers.
 * Anthropic's API requires valid signatures on every thinking block and rejects
 * requests with 400 if any signature is missing or empty.
 *
 * The CLI's own `stripSignatureBlocks()` only runs for Anthropic employees
 * (`USER_TYPE === 'ant'`) during model fallback, or for all users during `/login`.
 * Neither covers provider switching via cc-bridge — so for external users, this
 * proxy's sanitization is the **only defense**.
 *
 * ## Two-layer defense
 *
 * - **Layer 1 (SSE transformer):** Converts thinking blocks in SSE responses
 *   from custom providers to text blocks before the CLI stores them. Prevents
 *   future contamination, but has a known gap (see vault/evidence/).
 *
 * - **Layer 2 (this file):** Sanitizes outgoing requests. Converts unsigned
 *   thinking blocks to text. This is the essential backstop.
 *
 * ## Signature heuristic
 *
 * `signature.length > 0` is used to detect valid signatures. This works because
 * only Anthropic produces non-empty signatures (they're cryptographic and bound
 * to the API key). Custom providers either produce `""` or omit the field.
 */

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
  if (typeof block !== 'object' || block === null) return { block, converted: false };

  const originalType = block.type;
  let result;

  if (block.type === 'thinking') result = sanitizeThinkingBlock(block, isCompliant);
  else if (block.type === 'redacted_thinking') result = sanitizeRedactedThinking(block, isCompliant);
  else if (block.type === 'connector_text') result = sanitizeConnectorText(block, isCompliant);
  else if (block.type === 'tool_result' && !isCompliant) result = sanitizeToolResult(block);
  else result = sanitizeGenericBlock(block, isCompliant);

  const converted = result.type !== originalType;
  return { block: result, converted, originalType: converted ? originalType : undefined };
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
  if (typeof content === 'string') return { content, conversions: [] };
  if (Array.isArray(content)) {
    const conversions = [];
    const safeBlocks = content.map(b => {
      const { block, converted, originalType } = sanitizeBlock(b, isCompliant);
      if (converted) conversions.push(originalType);
      return block;
    });
    return { content: mergeAdjacentTextBlocks(safeBlocks), conversions };
  }
  if (typeof content === 'object' && content !== null) {
    const { block, converted, originalType } = sanitizeBlock(content, isCompliant);
    return { content: block, conversions: converted ? [originalType] : [] };
  }
  return { content, conversions: [] };
}

function sanitizeMessage(m, isCompliant) {
  if (!m || typeof m !== 'object') return { message: m, conversions: [] };
  const { content, conversions } = sanitizeContent(m.content, isCompliant);
  return { message: { ...m, content }, conversions };
}

/**
 * Sanitize messages array and return a conversion report.
 * @param {Array} messages - The messages array from the request body
 * @param {boolean} isCompliant - true for Anthropic-compatible endpoints
 * @returns {{ messages: Array, report: { convertedCount: number, convertedTypes: string[] } }}
 */
export function sanitizeMessages(messages, isCompliant) {
  if (!Array.isArray(messages)) return { messages, report: { convertedCount: 0, convertedTypes: [] } };
  const allConversions = [];
  const sanitized = messages.map(m => {
    const { message, conversions } = sanitizeMessage(m, isCompliant);
    allConversions.push(...conversions);
    return message;
  });
  return { messages: sanitized, report: { convertedCount: allConversions.length, convertedTypes: [...new Set(allConversions)] } };
}

/**
 * Route to Anthropic's API with compliant sanitization.
 *
 * Sanitizes with isCompliant=true: preserves thinking blocks that have valid
 * signatures (Anthropic-produced), converts unsigned ones to text. This is the
 * backstop for the provider-switching scenario — when session history contains
 * thinking blocks from custom providers with empty signatures.
 */
export function routeToAnthropic(body) {
  const modelStr = body.model ?? 'unknown';
  const { content: safeSystem } = sanitizeContent(body.system, true);
  const { messages: safeMessages, report } = sanitizeMessages(body.messages, true);
  const safeBody = { ...body, system: safeSystem, messages: safeMessages };

  return new RoutingResult({
    forwardBody: Buffer.from(JSON.stringify(safeBody)),
    targetBase: `https://${ANTHROPIC_HOST}`,
    label: `Anthropic (${modelStr})`,
    isCustom: false,
    sanitizationReport: report
  });
}

/**
 * Build request body for non-Anthropic-compliant endpoints.
 *
 * Strips ALL Anthropic-specific types (thinking, redacted_thinking, connector_text)
 * regardless of signature, because these providers don't support them. Also strips
 * betas header, flattens system prompt to string, removes cache_control, and joins
 * tool_result content arrays.
 */
function buildNonCompliantBody(body, realModel) {
  const { betas: _, system, messages, ...rest } = body;
  const { messages: safeMessages, report } = sanitizeMessages(messages, false);

  return {
    body: { ...rest, model: realModel, system: flattenSystemPrompt(system), messages: safeMessages },
    report
  };
}

function buildCompliantBody(body, realModel) {
  const { content: safeSystem } = sanitizeContent(body.system, true);
  const { messages: safeMessages, report } = sanitizeMessages(body.messages, true);
  return {
    body: { ...body, model: realModel, system: safeSystem, messages: safeMessages },
    report
  };
}

export function routeToProvider(body, match) {
  const { provider, realModel, label } = match;
  const isCompliant = provider.anthropicCompliant;

  const { body: finalBody, report } = isCompliant
    ? buildCompliantBody(body, realModel)
    : buildNonCompliantBody(body, realModel);

  return new RoutingResult({
    forwardBody: Buffer.from(JSON.stringify(finalBody)),
    targetBase: provider.url,
    label: `Provider (${label})`,
    isCustom: true,
    sanitizationReport: report
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
