import { RequestInfo, Option } from './types.js';
import { redactHeaders } from './headers.js';
import { applyRoutingWithMatch, applyAuthHeaders, extractSessionId } from './routing.js';
import { providerIdToEnvKey, ProviderMatch } from './providers.js';

/**
 * Resolve routing for an incoming request body against the active policy.
 *
 * Pure orchestration — evaluates the policy, applies routing, and resolves
 * auth headers. All state is injected; no closure access.
 *
 * @param {object} params
 * @param {RoutingPolicy} params.policy - Active routing policy
 * @param {object} params.body - Parsed request body
 * @param {string} params.urlSessionId - Session ID from URL prefix (/s/{id}/)
 * @param {object} params.routedHeaders - Headers to forward upstream
 * @param {string} params.anthropicBaseUrl - Fallback Anthropic API base URL
 * @returns {{ reqModel: string, sessionId: string, routing: RoutingResult, routedHeaders: object, match: ProviderMatch|null }}
 */
export async function resolveRouting({ policy, body, urlSessionId, routedHeaders, anthropicBaseUrl, extensions, openaiProviders }) {
  const reqModel = body.model ?? 'unknown';
  const sessionId = urlSessionId || extractSessionId(body);

  const evalOpt = policy.evaluateWithRule(body);

  // No rule matched — try extension-based resolution (e.g. dot-notation models)
  if (evalOpt.isNone) {
    if (extensions && extensions.hasUnmatchedResolver && typeof body.model === 'string' && body.model.includes('.')) {
      const extResult = await extensions.resolveUnmatched({ modelName: body.model, policy });
      if (extResult) {
        const match = new ProviderMatch(extResult.provider, `direct:${extResult.providerId}→${extResult.model}`, extResult.model);
        const routing = applyRoutingWithMatch(body, Option.some(match), anthropicBaseUrl, extensions);
        const envVar = providerIdToEnvKey(match.provider.id);
        const apiKey = process.env[envVar] ?? '';
        const finalHeaders = applyAuthHeaders({ headers: routedHeaders, match, apiKey, openaiProviders });
        return { reqModel, sessionId, routing, routedHeaders: finalHeaders, match, matchedRule: null };
      }
    }

    const defaultRule = policy.defaultFallbackRule;
    const routing = applyRoutingWithMatch(body, Option.none(), anthropicBaseUrl, extensions);
    return {
      reqModel, sessionId, routing,
      routedHeaders: applyAuthHeaders({ headers: routedHeaders, match: null, apiKey: '' }),
      match: null,
      matchedRule: defaultRule.isSome ? defaultRule.value : null
    };
  }

  let rawMatch = evalOpt.value.match;
  const matchedRule = evalOpt.value.rule;

  // Let extensions potentially override the routing (e.g., load balancer picks a pool entry)
  if (extensions) {
    const resolved = extensions.resolveProvider({ body, matchedRule, policy, match: rawMatch });
    if (resolved) {
      const provider = policy.getProvider(resolved.providerId);
      if (provider.isSome) {
        rawMatch = new ProviderMatch(provider.value, `pool:${resolved.providerId}→${resolved.model}`, resolved.model);
      }
    }
  }

  // Passthrough rules (no target) have null match — route to Anthropic,
  // but keep matchedRule for fallback detection
  const matchOpt = rawMatch ? Option.some(rawMatch) : Option.none();
  const routing = applyRoutingWithMatch(body, matchOpt, anthropicBaseUrl, extensions);
  const match = rawMatch;

  let apiKey = '';
  if (match) {
    const envVar = providerIdToEnvKey(match.provider.id);
    apiKey = process.env[envVar] ?? '';
  }

  const finalHeaders = applyAuthHeaders({ headers: routedHeaders, match, apiKey, openaiProviders });

  return { reqModel, sessionId, routing, routedHeaders: finalHeaders, match, matchedRule };
}

/**
 * Process a parsed request body: resolve routing, log, and return enriched context.
 *
 * @param {object} params
 * @param {ProxyRequestContext} params.ctx - Current request context
 * @param {object} params.body - Parsed request body
 * @param {RoutingPolicy} params.policy - Active routing policy
 * @param {string} params.anthropicBaseUrl - Fallback Anthropic API base URL
 * @param {Logger} params.logger - Logger instance
 * @param {function} params.getConfig - Config accessor
 * @returns {Promise<ProxyRequestContext>} Context with routing applied
 */
export async function processRequestBody({ ctx, body, policy, extensions, anthropicBaseUrl, logger, getConfig, openaiProviders }) {
  const { reqModel, sessionId, routing, routedHeaders, matchedRule, match } = resolveRouting({
    policy,
    body,
    urlSessionId: ctx.urlSessionId,
    routedHeaders: ctx.routedHeaders,
    anthropicBaseUrl,
    extensions,
    openaiProviders
  });

  const requestInfo = new RequestInfo({
    id: ctx.id,
    route: routing.label,
    url: ctx.req.url ?? '/',
    headers: redactHeaders(routedHeaders),
    body,
    sessionId
  });

  await logger.logRequest(requestInfo, getConfig());

  return ctx.withRouting({
    routeLabel: routing.label,
    reqModel,
    sessionId,
    routedHeaders,
    forwardBody: routing.forwardBody,
    targetBase: routing.targetBase,
    isCustom: routing.isCustom,
    sanitizationReport: routing.sanitizationReport,
    matchedRule
  });
}
