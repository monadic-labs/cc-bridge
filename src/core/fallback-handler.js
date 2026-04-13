import { Option } from './types.js';
import { tryParseBody, routeToProvider, applyAuthHeaders } from './routing.js';
import { ProviderMatch } from './providers.js';
import { providerIdToEnvKey } from './providers.js';
import { MAX_FALLBACK_DEPTH } from './routing-rules.js';

/**
 * Determine whether a failed upstream response should trigger fallback.
 *
 * @param {number} statusCode - Upstream HTTP status code
 * @param {object|null} matchedRule - The routing rule that matched (has hasFallback)
 * @param {number} fallbackDepth - Current fallback depth (0 = initial request)
 * @returns {boolean}
 */
export function shouldAttemptFallback(statusCode, matchedRule, fallbackDepth) {
  if (!matchedRule) return false;
  if (!matchedRule.hasFallback) return false;
  if (statusCode < 400) return false;
  if (fallbackDepth >= MAX_FALLBACK_DEPTH) return false;
  return true;
}

/**
 * Resolve the fallback ProviderMatch from the routing policy's provider map.
 *
 * @param {RoutingPolicy} policy - Active routing policy
 * @param {object} matchedRule - The rule that matched, with fallbackProviderId/fallbackModel
 * @returns {Option<ProviderMatch>}
 */
export function resolveFallbackMatch(policy, matchedRule) {
  const providerOpt = policy.getProvider(matchedRule.fallbackProviderId);
  if (providerOpt.isNone) return Option.none();
  return Option.some(new ProviderMatch(providerOpt.value, `fallback:${matchedRule.toLabel()}`, matchedRule.fallbackModel));
}

/**
 * Build a fallback request from the original (pre-sanitization) body.
 *
 * Re-parses the original body, overrides the model, applies full sanitization
 * for the fallback provider's compliance mode, and swaps auth headers.
 *
 * @param {Buffer} originalBody - Decompressed, pre-sanitization request body
 * @param {ProviderMatch} fallbackMatch - Resolved fallback provider match
 * @param {object} routedHeaders - Current routed headers (may contain OAuth)
 * @returns {{ forwardBody: Buffer, routedHeaders: object, targetBase: string, label: string, sanitizationReport: object|null }|null}
 */
export function buildFallbackRequest(originalBody, fallbackMatch, routedHeaders) {
  const bodyOpt = tryParseBody(originalBody);
  if (bodyOpt.isNone) return null;

  const body = bodyOpt.value;
  const bodyWithFallbackModel = { ...body, model: fallbackMatch.realModel };
  const routing = routeToProvider(bodyWithFallbackModel, fallbackMatch);

  const envVar = providerIdToEnvKey(fallbackMatch.provider.id);
  const apiKey = process.env[envVar] ?? '';
  const finalHeaders = applyAuthHeaders({ headers: routedHeaders, match: fallbackMatch, apiKey });

  return {
    forwardBody: routing.forwardBody,
    routedHeaders: finalHeaders,
    targetBase: routing.targetBase,
    label: `Fallback (${fallbackMatch.label})`,
    sanitizationReport: routing.sanitizationReport
  };
}
