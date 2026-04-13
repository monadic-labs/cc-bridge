import { RequestInfo, Option } from './types.js';
import { redactHeaders } from './headers.js';
import { applyRoutingWithMatch, applyAuthHeaders, extractSessionId } from './routing.js';
import { providerIdToEnvKey } from './providers.js';

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
export function resolveRouting({ policy, body, urlSessionId, routedHeaders, anthropicBaseUrl }) {
  const reqModel = body.model ?? 'unknown';
  const sessionId = urlSessionId || extractSessionId(body);

  const evalOpt = policy.evaluateWithRule(body);
  const matchOpt = evalOpt.isSome ? Option.some(evalOpt.value.match) : Option.none();
  const matchedRule = evalOpt.isSome ? evalOpt.value.rule : null;

  const routing = applyRoutingWithMatch(body, matchOpt, anthropicBaseUrl);
  const match = matchOpt.isSome ? matchOpt.value : null;

  let apiKey = '';
  if (match) {
    const envVar = providerIdToEnvKey(match.provider.id);
    apiKey = process.env[envVar] ?? '';
  }

  const finalHeaders = applyAuthHeaders({ headers: routedHeaders, match, apiKey });

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
export async function processRequestBody({ ctx, body, policy, anthropicBaseUrl, logger, getConfig }) {
  const { reqModel, sessionId, routing, routedHeaders, matchedRule } = resolveRouting({
    policy,
    body,
    urlSessionId: ctx.urlSessionId,
    routedHeaders: ctx.routedHeaders,
    anthropicBaseUrl
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
