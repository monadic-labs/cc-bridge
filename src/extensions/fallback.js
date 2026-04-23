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

import { Option } from '../core/types.js';
import { ProviderMatch } from '../core/providers.js';
import { providerIdToEnvKey } from '../core/providers.js';
import { MAX_FALLBACK_DEPTH } from '../core/routing-rules.js';
import { tryParseBody, routeToProvider, applyAuthHeaders } from '../core/routing.js';

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
        build: ({ originalBody, matchedRule, policy, routedHeaders, extensions }) =>
          buildFallbackRequest(originalBody, matchedRule, policy, routedHeaders, extensions),
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

function buildFallbackRequest(originalBody, matchedRule, policy, routedHeaders, extensions) {
  const providerOpt = policy.getProvider(matchedRule.fallbackProviderId);
  if (providerOpt.isNone) return null;

  const fallbackMatch = new ProviderMatch(providerOpt.value, `fallback:${matchedRule.toLabel()}`, matchedRule.fallbackModel);
  const bodyOpt = tryParseBody(originalBody);
  if (bodyOpt.isNone) return null;

  const body = bodyOpt.value;
  const bodyWithFallbackModel = { ...body, model: fallbackMatch.realModel };
  const routing = routeToProvider(bodyWithFallbackModel, fallbackMatch, extensions);

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
