import http from 'http';
import https from 'https';
import { URL } from 'url';
import { ProxyResponseContext } from './types.js';
import { filterResponseHeaders } from './headers.js';
import { extractUrlSession } from '../proxy-core.js';
import { UpstreamError } from './exceptions.js';
import { SseResponseTransformer } from './sse-transformer.js';
import { 
  shouldAttemptFallback, 
  shouldAttemptFallbackForTcpError, 
  resolveFallbackMatch,
  buildFallbackRequest
} from './fallback-handler.js';
/**
 * Forward the request to the target upstream provider.
 * Implements the retry loop and handles both SSE and normal responses.
 */
export function forwardToUpstream({ ctx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, openaiProviders }) {
  const retryConfig = getConfig().retry;
  if (retryConfig.maxAttempts > 0) {
    return forwardWithRetry({ ctx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, retryConfig, attempt: 0, openaiProviders });
  }
  singleForwardAttempt({ ctx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, _retryConfig: null, onRetryNeeded: null, openaiProviders });
}

/**
 * Retry wrapper around singleForwardAttempt with exponential backoff.
 */
function forwardWithRetry({ ctx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, retryConfig, attempt, openaiProviders }) {
  const retryState = {
    shouldRetry: false,
    retryReason: '',
  };

  singleForwardAttempt({
    ctx,
    handleResponseEnd: ({ resCtx, resChunks }) => {
      if (!retryState.shouldRetry) {
        handleResponseEnd({ resCtx, resChunks });
        return;
      }
      attemptRetry();
    },
    errorReporter,
    getConfig,
    policy,
    extensions,
    emit,
    _retryConfig: retryConfig,
    onRetryNeeded: (reason) => {
      retryState.shouldRetry = true;
      retryState.retryReason = reason;
    },
    openaiProviders
  });

  async function attemptRetry() {
    if (attempt >= retryConfig.maxAttempts || ctx.clientAborted) {
      // Out of retries or client gone — attempt fallback if enabled, else stream the last failure
      if (shouldAttemptFallbackForTcpError(ctx.matchedRule, ctx.fallbackDepth)) {
        const fallbackMatchOpt = resolveFallbackMatch(policy, ctx.matchedRule);
        if (fallbackMatchOpt.isSome) {
          const fallbackMatch = fallbackMatchOpt.value;
          const fallbackReq = buildFallbackRequest(ctx.originalBody, fallbackMatch, ctx.routedHeaders, openaiProviders);
          if (fallbackReq) {
            emit(`[#${ctx.id}] Retry exhausted (TCP), falling back to ${fallbackMatch.label}`, ctx.sessionId);
            return forwardToUpstream({
              ctx: ctx.withRouting({
                routeLabel: fallbackReq.label,
                reqModel: fallbackMatch.realModel,
                routedHeaders: fallbackReq.routedHeaders,
                forwardBody: fallbackReq.forwardBody,
                targetBase: fallbackReq.targetBase,
                isCustom: true,
                sanitizationReport: fallbackReq.sanitizationReport,
                fallbackDepth: ctx.fallbackDepth + 1
              }),
              handleResponseEnd,
              errorReporter,
              getConfig,
              policy,
              extensions,
              emit,
              openaiProviders
            });
          }
        }
      }
      handleResponseEnd({ resCtx: ctx, resChunks: [] });
      return;
    }

    const delay = Math.min(retryConfig.baseDelayMs * Math.pow(2, attempt), retryConfig.maxDelayMs);
    emit(`[#${ctx.id}] Retrying (attempt ${attempt + 1}/${retryConfig.maxAttempts}, ${delay}ms): ${retryState.retryReason}`, ctx.sessionId);

    await new Promise(r => setTimeout(r, delay));
    if (ctx.clientAborted) return;

    forwardWithRetry({ ctx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, retryConfig, attempt: attempt + 1, openaiProviders });
  }
}

/**
 * Extract provider ID from route label (e.g. "exact:z→Ha-4.7" -> "z")
 */
function extractProviderIdFromLabel(label) {
  if (!label) return null;
  const arrowMatch = label.match(/:(.+?)→/);
  if (arrowMatch) return arrowMatch[1];
  const colonParts = label.split(':');
  const base = colonParts.length > 1 ? colonParts[1] : colonParts[0];
  return base.split('.')[0];
}

function singleForwardAttempt({ ctx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, _retryConfig, onUpstreamResponse, onRetryNeeded, openaiProviders }) {
  const providerId = extractProviderIdFromLabel(ctx.routeLabel);
  const isOpenaiFormat = !!(openaiProviders && providerId && openaiProviders[providerId]?.format === 'openai');
  const target = resolveUpstreamUrl(ctx.targetBase, ctx.req.url, ctx.isCustom, isOpenaiFormat);
  const finalHeaders = { ...ctx.routedHeaders, host: target.host, 'content-length': String(ctx.forwardBody.length) };
  if (ctx.isCustom) delete finalHeaders['accept-encoding'];

  const transport = target.protocol === 'https:' ? https : http;
  const defaultPort = target.protocol === 'https:' ? 443 : 80;

  const proxyReq = transport.request(
    { hostname: target.hostname, port: target.port || defaultPort, path: target.pathname + target.search, method: ctx.req.method, headers: finalHeaders },
    (proxyRes) => handleProxyResponse({
      reqCtx: ctx, proxyRes, headers: finalHeaders, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit,
      forwardToUpstream: ({ ctx: fallbackCtx }) => forwardToUpstream({ ctx: fallbackCtx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, openaiProviders }),    
      onUpstreamResponse,
      onRetryNeeded,
      openaiProviders
    })
  );

  proxyReq.on('error', (err) => {
    if (ctx.clientAborted) return;
    errorReporter.write(new UpstreamError(err.message, { code: err.code }), {
      requestId: ctx.id,
      route: ctx.routeLabel,
      method: ctx.req.method,
      url: ctx.req.url,
      model: ctx.reqModel,
      sessionId: ctx.sessionId,
      operation: 'upstream_tcp_error',
      upstreamUrl: target.href,
      elapsedMs: Date.now() - ctx.startTime
    });

    if (onRetryNeeded && shouldRetryTcpError(err, _retryConfig)) {
      onRetryNeeded(err.code);
      handleResponseEnd({ resCtx: ctx, resChunks: [] });
      return;
    }

    if (!ctx.res.headersSent) {
      buildErrorResponse(ctx.res, new UpstreamError(`Upstream connection failed: ${err.message}`, { code: err.code }), ctx.startTime);
    }
  });

  proxyReq.write(ctx.forwardBody);
  proxyReq.end();
}

function shouldRetryTcpError(err, config) {
  if (!config || !config.retryOnTcpErrors) return false;
  return config.retryOnTcpErrors.includes(err.code);
}

function resolveUpstreamUrl(targetBase, reqUrl, isCustom, isOpenaiFormat) {
  const base = new URL(targetBase);
  const { strippedUrl } = extractUrlSession(reqUrl);

  let path = strippedUrl;
  if (isOpenaiFormat) {
    path = '/chat/completions';
  }
  
  // Ensure base pathname ends with a slash to allow relative joining
  const basePath = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
  
  // Strip leading slash from path to make it relative to the base path
  const relativePath = path.startsWith('/') ? path.slice(1) : path;
  
  return new URL(relativePath, new URL(basePath, base.origin + base.search));
}

function handleProxyResponse({ reqCtx, proxyRes, headers, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, forwardToUpstream, onUpstreamResponse, onRetryNeeded, openaiProviders }) {
  if (onUpstreamResponse) onUpstreamResponse(proxyRes);

  const isError = proxyRes.statusCode >= 400;
  const isSse = (proxyRes.headers['content-type'] ?? '').includes('text/event-stream');
  const chunks = [];

  // For non-error SSE, we stream immediately
  let transformer = null;
  if (!isError && isSse && !reqCtx.clientAborted) {
    const resHeaders = filterResponseHeaders(proxyRes.headers);
    reqCtx.res.writeHead(proxyRes.statusCode, resHeaders);
    const providerId = extractProviderIdFromLabel(reqCtx.routeLabel);
    const provider = providerId ? policy.getProvider(providerId).unwrapOr(null) : null;
    transformer = new SseResponseTransformer(extensions, provider);
  }

  proxyRes.on('data', (chunk) => {
    if (reqCtx.clientAborted) return;
    chunks.push(chunk);

    if (transformer) {
      const transformed = transformer.transformChunk(chunk.toString());
      if (transformed) reqCtx.res.write(transformed);
    }
  });

  proxyRes.on('end', () => {
    if (transformer) {
      const remaining = transformer.flush();
      if (remaining) reqCtx.res.write(remaining);
      // No res.end() here, handleNormalResponse will do it
    }

    const retryConfig = getConfig().retry;

    if (isError && onRetryNeeded && retryConfig.retryOnStatusCodes.includes(proxyRes.statusCode)) {
      onRetryNeeded(`HTTP ${proxyRes.statusCode}`);
      handleResponseEnd({ resCtx: reqCtx, resChunks: [] });
      return;
    }

    if (isError && onRetryNeeded && retryConfig.retryOnBodyPatterns.length > 0) {
      const body = Buffer.concat(chunks).toString();
      for (const pattern of retryConfig.retryOnBodyPatterns) {
        if (new RegExp(pattern).test(body)) {
          onRetryNeeded(`Body pattern match: ${pattern}`);
          handleResponseEnd({ resCtx: reqCtx, resChunks: [] });
          return;
        }
      }
    }

    if (isError) {
      if (shouldAttemptFallback(proxyRes.statusCode, reqCtx.matchedRule, reqCtx.fallbackDepth)) {
        const fallbackMatchOpt = resolveFallbackMatch(policy, reqCtx.matchedRule);
        if (fallbackMatchOpt.isSome) {
          const fallbackMatch = fallbackMatchOpt.value;
          const fallbackReq = buildFallbackRequest(reqCtx.originalBody, fallbackMatch, reqCtx.routedHeaders, openaiProviders);
          if (fallbackReq) {
            emit(`[#${reqCtx.id}] Upstream error ${proxyRes.statusCode}, falling back to ${fallbackMatch.label}`, reqCtx.sessionId);
            forwardToUpstream({
              ctx: reqCtx.withRouting({
                routeLabel: fallbackReq.label,
                reqModel: fallbackMatch.realModel,
                routedHeaders: fallbackReq.routedHeaders,
                forwardBody: fallbackReq.forwardBody,
                targetBase: fallbackReq.targetBase,
                isCustom: true,
                sanitizationReport: fallbackReq.sanitizationReport,
                fallbackDepth: reqCtx.fallbackDepth + 1
              })
            });
            return;
          }
        }
      }
      streamBufferedError(reqCtx, proxyRes, chunks, handleResponseEnd, headers, errorReporter);
      return;
    }

    handleNormalResponse(reqCtx, proxyRes, chunks, handleResponseEnd, headers, extensions);
  });
}
function handleNormalResponse(reqCtx, proxyRes, chunks, handleResponseEnd, headers, _extensions) {
  if (reqCtx.clientAborted) return;

  const resCtx = new ProxyResponseContext({
    proxyRes,
    res: reqCtx.res,
    id: reqCtx.id,
    startTime: reqCtx.startTime,
    routeLabel: reqCtx.routeLabel,
    reqModel: reqCtx.reqModel,
    sessionId: reqCtx.sessionId,
    headers,
    req: reqCtx.req,
    isCustom: reqCtx.isCustom,
    rawBody: reqCtx.rawBody,
    forwardBody: reqCtx.forwardBody,
    sanitizationReport: reqCtx.sanitizationReport
  });
  handleResponseEnd({ resCtx, resChunks: chunks });
}
function streamBufferedError(reqCtx, proxyRes, chunks, _handleResponseEnd, _headers, errorReporter) {
  if (reqCtx.clientAborted) return;

  let errorId = null;
  const body = Buffer.concat(chunks).toString();
  if (errorReporter) {
    const result = errorReporter.write(new UpstreamError(`Upstream HTTP ${proxyRes.statusCode}`), {
      requestId: reqCtx.id,
      route: reqCtx.routeLabel,
      method: reqCtx.req.method,
      url: reqCtx.req.url,
      model: reqCtx.reqModel,
      sessionId: reqCtx.sessionId,
      headers: proxyRes.headers,
      responseBody: body,
      operation: 'upstream_error',
      statusCode: proxyRes.statusCode,
      upstreamUrl: reqCtx.targetBase,
      elapsedMs: Date.now() - reqCtx.startTime
    });
    if (result) errorId = result.errorId;
  }

  if (reqCtx.res.headersSent) {
    if (!reqCtx.res.writableEnded) reqCtx.res.end();
    return;
  }
  const resHeaders = filterResponseHeaders(proxyRes.headers);
  if (errorId) resHeaders['x-ccb-error-id'] = errorId;
  reqCtx.res.writeHead(proxyRes.statusCode, resHeaders);

  let outBody = body;
  if (errorId && body) {
    try {
      const parsed = JSON.parse(body);
      if (parsed.error && typeof parsed.error === 'object') {
        parsed.error.ccb_error_id = errorId;
        outBody = JSON.stringify(parsed);
      }
    } catch { }
  }
  reqCtx.res.write(outBody);
  reqCtx.res.end();
}

function buildErrorResponse(res, error, startTime) {
  if (res.headersSent) return;
  const elapsedMs = startTime ? Date.now() - startTime : null;
  const payload = JSON.stringify({
    type: 'error',
    error: {
      type: 'upstream_error',
      message: error.message,
      code: error.code,
      ...(elapsedMs !== null && { ccb_response_time_ms: elapsedMs })
    }
  });
  res.writeHead(400, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'connection': 'close'
  });
  res.end(payload);
}
