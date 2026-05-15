import { ANTHROPIC_HOST } from './headers.js';
import { RoutingResult, Option } from './types.js';
import { getModel, getMessages as _getMessages } from './api-adapter.js';

/**
 * Route to Anthropic's API directly (no custom provider match).
 */
export function routeToAnthropic(body, anthropicBaseUrl = `https://${ANTHROPIC_HOST}`) {
  const modelStr = getModel(body);
  return new RoutingResult({
    forwardBody: Buffer.from(JSON.stringify(body)),
    targetBase: anthropicBaseUrl,
    label: `Anthropic (${modelStr})`,
    isCustom: false,
    sanitizationReport: { convertedCount: 0, convertedTypes: [] }
  });
}

/**
 * Route to a matched custom provider.
 *
 * Runs extension request transforms (sanitization, non-compliant transform,
 * web search, etc.) on the body, then builds the RoutingResult.
 */
export function routeToProvider(body, match, extensions) {
  const { provider, realModel, label } = match;

  let extBody = { ...body, model: realModel };
  if (extensions && extensions.requestTransformerCount > 0) {
    extBody = extensions.transformRequest({ body: extBody, provider, isCompliant: provider.anthropicCompliant });
  }

  const report = extBody._ccbSanitizationReport ?? { convertedCount: 0, convertedTypes: [] };
  const { _ccbSanitizationReport: _, ...cleanBody } = extBody;

  return new RoutingResult({
    forwardBody: Buffer.from(JSON.stringify(cleanBody)),
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

  return routeToProvider(body, match, null);
}

export function applyRoutingWithMatch(body, matchOpt, anthropicBaseUrl, extensions) {
  if (typeof body.model !== 'string') return routeToAnthropic(body, anthropicBaseUrl);
  if (matchOpt.isNone) return routeToAnthropic(body, anthropicBaseUrl);
  return routeToProvider(body, matchOpt.value, extensions);
}

export function applyAuthHeaders({ headers, match, apiKey = '', openaiProviders }) {
  if (!match) return { ...headers };

  const { provider } = match;
  const { authorization: _, 'anthropic-beta': beta, ...rest } = headers;
  const updated = { ...rest };

  const isOpenai = openaiProviders && openaiProviders[provider?.id]?.format === 'openai';

  if (provider.id && apiKey) {
    if (isOpenai) {
      updated['authorization'] = `Bearer ${apiKey}`;
    }
    if (!isOpenai) {
      // Anthropic-protocol providers: send BOTH x-api-key and Authorization
      // Bearer. Anthropic's official API reads x-api-key; z.ai's
      // /api/anthropic endpoint (and most Anthropic mirrors) route by
      // Authorization Bearer. Sending both lets ccb proxy to either
      // without per-provider auth-header config. The empirically-observed
      // case was z.ai's middleware choking on non-ASCII (em-dashes) only
      // on the x-api-key code path; Bearer goes through a UTF-8-safe
      // handler. Anthropic's API ignores the extra Bearer.
      updated['x-api-key'] = apiKey;
      updated['authorization'] = `Bearer ${apiKey}`;
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
    if (!parsed.session_id) return Option.none();
    return Option.some(parsed.session_id);
  } catch {
    return Option.none();
  }
}

export function extractSessionId(body) {
  if (!body) return '';

  // 1. Check metadata.user_id (often contains stringified JSON with session_id)
  const userIdStr = body.metadata?.user_id;
  if (typeof userIdStr === 'string') {
    const parsedUserId = tryParseUserId(userIdStr);
    if (parsedUserId.isSome) return parsedUserId.value;
  }

  // 2. Check direct metadata fields
  if (body.metadata?.session_id) return String(body.metadata.session_id);
  if (body.metadata?.sessionId) return String(body.metadata.sessionId);

  // 3. Check root level fields
  if (body.session_id) return String(body.session_id);
  if (body.sessionId) return String(body.sessionId);

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
