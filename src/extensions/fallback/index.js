/**
 * Fallback extension for provider failover.
 *
 * When an upstream provider returns an error (4xx/5xx) or a TCP connection
 * fails, this extension decides whether to re-route the request to a
 * fallback provider and builds the fallback request.
 *
 * Configuration comes from the routing rule's `fallback` field:
 *   { fallbackProviderId, fallbackModel, hasFallback }
 */

import { ProviderMatch } from '../../core/providers.js';
import { requireProviderApiKey } from '../../core/api-key-resolver.js';
import { MAX_FALLBACK_DEPTH } from '../../core/routing-rules.js';
import { tryParseBody, routeToProvider, applyAuthHeaders } from '../../core/routing.js';

export const EXTENSION_META = {
  activation: 'route-driven',
  title: 'Fallback',
  description: 'Re-routes to the routing rule\'s declared fallback provider when an upstream returns 4xx/5xx or the TCP connection fails. Configured per route, not globally.',
  configuredBy: 'routes.models[*].fallback / routes.defaults.fallback',
};

export function createFallbackExtension() {
  return {
    name: 'fallback',

    hooks: {
      shouldAttemptFallback: {
        order: 50,
        check: ({ statusCode, matchedRule, fallbackDepth }) =>
          checkFallback(statusCode, matchedRule, fallbackDepth),
      },
      shouldAttemptFallbackForTcpError: {
        order: 50,
        check: ({ matchedRule, fallbackDepth }) =>
          checkFallbackForTcpError(matchedRule, fallbackDepth),
      },
      buildFallbackRequest: {
        order: 50,
        build: ({ originalBody, matchedRule, policy, routedHeaders, extensions, openaiProviders }) =>
          buildFallbackRequest(originalBody, matchedRule, policy, routedHeaders, extensions, openaiProviders),
      },
    },
  };
}

function checkFallback(statusCode, matchedRule, fallbackDepth) {
  if (!matchedRule) return false;
  if (!matchedRule.hasFallback) return false;
  if (statusCode < 400) return false;
  if (fallbackDepth >= MAX_FALLBACK_DEPTH) return false;
  return true;
}

function checkFallbackForTcpError(matchedRule, fallbackDepth) {
  if (!matchedRule) return false;
  if (!matchedRule.hasFallback) return false;
  if (fallbackDepth >= MAX_FALLBACK_DEPTH) return false;
  return true;
}

function buildFallbackRequest(originalBody, matchedRule, policy, routedHeaders, extensions, openaiProviders) {
  const providerOpt = policy.getProvider(matchedRule.fallbackProviderId);
  if (providerOpt.isNone) return null;

  const fallbackMatch = new ProviderMatch(providerOpt.value, `fallback:${matchedRule.toLabel()}`, matchedRule.fallbackModel);
  const bodyOpt = tryParseBody(originalBody);
  if (bodyOpt.isNone) return null;

  const body = bodyOpt.value;
  const bodyWithFallbackModel = { ...body, model: fallbackMatch.realModel };
  const routing = routeToProvider(bodyWithFallbackModel, fallbackMatch, extensions);

  const keyRes = requireProviderApiKey(fallbackMatch.provider.id);
  if (!keyRes.isSuccess) throw keyRes.error;
  const finalHeaders = applyAuthHeaders({ headers: routedHeaders, match: fallbackMatch, apiKey: keyRes.value, openaiProviders });

  return {
    forwardBody: routing.forwardBody,
    routedHeaders: finalHeaders,
    targetBase: routing.targetBase,
    label: `Fallback (${fallbackMatch.label})`,
    sanitizationReport: routing.sanitizationReport
  };
}
