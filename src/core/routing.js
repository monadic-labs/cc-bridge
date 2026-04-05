import { ANTHROPIC_HOST } from './headers.js';
import { RoutingResult, Option, Result } from './types.js';
import { ConfigurationMissingException } from './exceptions.js';

export function resolveApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey) return '';
  if (!apiKey.startsWith('ENV:')) return apiKey;
  const envKey = apiKey.slice(4);
  const val = process.env[envKey];
  if (val === undefined || val === null || val === '') {
    throw new ConfigurationMissingException(`Missing environment variable: ${envKey}`, { context: { envKey } });
  }
  return val;
}

function processThinkingBlock(block) {
  if (typeof block !== 'object' || block === null) return block;
  if (block.type !== 'thinking') return block;
  const { signature: _, ...rest } = block;
  return rest;
}

function processMessageForSignatures(m) {
  if (!Array.isArray(m.content)) return m;
  const content = m.content.map(processThinkingBlock);
  return { ...m, content };
}

export function stripSignatures(body) {
  if (!body?.messages || !Array.isArray(body.messages)) return body;
  const messages = body.messages.map(processMessageForSignatures);
  return { ...body, messages };
}

function processToolResultContent(c) {
  if (typeof c !== 'object' || c === null) return c;
  const { cache_control: _, ...rest } = c;
  if (rest.type !== 'tool_result' || !Array.isArray(rest.content)) return rest;
  const joinedContent = rest.content
    .map((b) => (typeof b === 'string' ? b : b.text ?? JSON.stringify(b)))
    .join('\n');
  return { ...rest, content: joinedContent };
}

function processMessageForNonCompliant(m) {
  if (!Array.isArray(m.content)) return m;
  const content = m.content.map(processToolResultContent);
  return { ...m, content };
}

function flattenSystemPrompt(system) {
  if (!Array.isArray(system)) return system;
  const flattened = system
    .map((s) => (typeof s === 'string' ? s : s.text ?? ''))
    .join('\n')
    .trim();
  return flattened || undefined;
}

export function cleanForNonCompliant(body) {
  const { betas: _, system, messages, ...rest } = body;
  
  const cleaned = { ...rest };
  const flatSystem = flattenSystemPrompt(system);
  if (flatSystem !== undefined) cleaned.system = flatSystem;
  
  if (Array.isArray(messages)) {
    cleaned.messages = messages.map(processMessageForNonCompliant);
  }
  if (!Array.isArray(messages) && messages) {
    cleaned.messages = messages;
  }
  
  return cleaned;
}

export function routeToAnthropic(body) {
  const cleaned = stripSignatures(body);
  const modelStr = cleaned.model ?? 'unknown';
  return new RoutingResult({
    forwardBody: Buffer.from(JSON.stringify(cleaned)),
    targetBase: `https://${ANTHROPIC_HOST}`,
    label: `Anthropic (${modelStr})`,
  });
}

export function routeToProvider(body, match) {
  const { provider, realModel, label } = match;
  const initialRouted = { ...body, model: realModel };
  const stripped = stripSignatures(initialRouted);
  const finalRouted = provider.anthropicCompliant ? stripped : cleanForNonCompliant(stripped);
  
  return new RoutingResult({
    forwardBody: Buffer.from(JSON.stringify(finalRouted)),
    targetBase: provider.url,
    label: `Provider (${label})`,
  });
}

export function applyRouting(body, providersMap) {
  if (typeof body.model !== 'string') return routeToAnthropic(body);
  const match = providersMap.resolve(body.model);
  if (!match) return routeToAnthropic(body);
  return routeToProvider(body, match);
}

export function applyAuthHeaders(headers, match, env = process.env) {
  if (!match) return { ...headers };
  const { provider } = match;
  const { authorization: _, 'anthropic-beta': beta, ...rest } = headers;
  
  const updated = { ...rest };
  if (provider.id) {
    const envVar = `${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`;
    const val = env[envVar];
    if (val !== undefined && val !== null && val !== '') {
      updated['x-api-key'] = val;
    }
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
    return Option.some(parsed.session_id ?? '');
  } catch { 
    return Option.none();
  }
}

export function extractSessionId(body) {
  const userIdStr = body?.metadata?.user_id;
  const parsedUserId = tryParseUserId(userIdStr);
  if (parsedUserId.isSome && parsedUserId.value !== '') {
    return parsedUserId.value;
  }
  return body?.metadata?.session_id ?? body?.session_id ?? '';
}

export function tryParseBody(rawBody) {
  if (!rawBody || rawBody.length === 0) return Option.none();
  try { return Option.some(JSON.parse(rawBody.toString())); }
  catch { return Option.none(); }
}
