import { ANTHROPIC_HOST } from './headers.js';
import { RoutingResult, Option } from './types.js';
import { getModel, getMessages } from './api-adapter.js';

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
