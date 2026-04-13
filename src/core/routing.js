import { ANTHROPIC_HOST } from './headers.js';
import { RoutingResult, Option, BLOCK_TYPES } from './types.js';
import {
  getSystemBlockText,
  getBlockType, getBlockText, getBlockThinking, getBlockRedactedData, getBlockToolContent,
  hasValidSignature, omitCacheControl,
  getModel, getSystem, getMessages,
} from './api-adapter.js';

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
    .map((s) => (typeof s === 'string' ? s : getSystemBlockText(s)))
    .join('\n')
    .trim();
  if (!flattened) return undefined;
  return flattened;
}

function extractToolResultText(block) {
  if (typeof block === 'string') return block;
  const text = getBlockText(block);
  if (text) return text;
  return JSON.stringify(block);
}

function sanitizeToolResult(block) {
  const rest = omitCacheControl(block);
  const toolContent = getBlockToolContent(rest);
  if (!Array.isArray(toolContent)) return rest;
  const joinedContent = toolContent.map(extractToolResultText).join('\n');
  return { ...rest, content: joinedContent };
}

function sanitizeThinkingBlock(block, isCompliant) {
  if (isCompliant && hasValidSignature(block)) return block;
  return { type: BLOCK_TYPES.TEXT, text: `\`\`\`thinking\n${getBlockThinking(block)}\n\`\`\`\n` };
}

function sanitizeRedactedThinking(block, isCompliant) {
  if (isCompliant && hasValidSignature(block)) return block;
  const data = getBlockRedactedData(block) || '[Redacted Thinking]';
  return { type: BLOCK_TYPES.TEXT, text: `\`\`\`thinking\n${data}\n\`\`\`\n` };
}

function sanitizeConnectorText(block, isCompliant) {
  if (isCompliant && hasValidSignature(block)) return block;
  return { type: BLOCK_TYPES.TEXT, text: `[Connector Text]\n${getBlockText(block)}` };
}

function sanitizeGenericBlock(block, isCompliant) {
  if (isCompliant) return block;
  return omitCacheControl(block);
}

function sanitizeBlock(block, isCompliant) {
  if (typeof block !== 'object' || block === null) return { block, converted: false };

  const originalType = getBlockType(block);
  let result;

  if (originalType === BLOCK_TYPES.THINKING) result = sanitizeThinkingBlock(block, isCompliant);
  else if (originalType === BLOCK_TYPES.REDACTED_THINKING) result = sanitizeRedactedThinking(block, isCompliant);
  else if (originalType === BLOCK_TYPES.CONNECTOR_TEXT) result = sanitizeConnectorText(block, isCompliant);
  else if (originalType === BLOCK_TYPES.TOOL_RESULT && !isCompliant) result = sanitizeToolResult(block);
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
export function routeToAnthropic(body, anthropicBaseUrl = `https://${ANTHROPIC_HOST}`) {
  const modelStr = getModel(body);
  const { content: safeSystem } = sanitizeContent(getSystem(body), true);
  const { messages: safeMessages, report } = sanitizeMessages(getMessages(body), true);
  const safeBody = { ...body, system: safeSystem, messages: safeMessages };

  return new RoutingResult({
    forwardBody: Buffer.from(JSON.stringify(safeBody)),
    targetBase: anthropicBaseUrl,
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
  const { betas: _, ...rest } = body; // strip betas — not understood by non-compliant providers
  const { messages: safeMessages, report } = sanitizeMessages(getMessages(body), false);

  return {
    body: { ...rest, model: realModel, system: flattenSystemPrompt(getSystem(body)), messages: safeMessages },
    report
  };
}

function buildCompliantBody(body, realModel) {
  const { content: safeSystem } = sanitizeContent(getSystem(body), true);
  const { messages: safeMessages, report } = sanitizeMessages(getMessages(body), true);
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

export function applyRouting(body, providersMap, anthropicBaseUrl) {
  if (typeof body.model !== 'string') return routeToAnthropic(body, anthropicBaseUrl);

  const match = providersMap.resolve(body.model);
  if (!match) return routeToAnthropic(body, anthropicBaseUrl);

  return routeToProvider(body, match);
}

/**
 * Route using a pre-resolved Option<ProviderMatch> from the RoutingPolicy pipeline.
 *
 * Accepts the result of `policy.evaluate(body)` directly, avoiding a second
 * evaluation pass when the caller already has the match (e.g. for auth header
 * resolution in proxy-core.js).
 */
export function applyRoutingWithMatch(body, matchOpt, anthropicBaseUrl) {
  if (typeof body.model !== 'string') return routeToAnthropic(body, anthropicBaseUrl);
  if (matchOpt.isNone) return routeToAnthropic(body, anthropicBaseUrl);
  return routeToProvider(body, matchOpt.value);
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
