import http from 'http';
import https from 'https';
import { randomBytes } from 'crypto';
import { URL } from 'url';
import { ProxyResponseContext } from './types.js';
import { filterResponseHeaders } from './headers.js';
import { SseResponseTransformer } from './sse-transformer.js';

/**
 * Generate a unique cc-bridge error ID.
 * Format: ccb-{timestamp_base36}-{random_hex}
 */
function generateErrorId() {
  return `ccb-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * Sleep for ms, resolving early if the client disconnects.
 */
function sleepAbortable(ms, ctx) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onGone = () => { clearTimeout(timer); resolve(); };
    ctx.req.on('close', onGone);
    ctx.req.on('aborted', onGone);
  });
}

/**
 * Check if an upstream TCP error is retryable.
 */
function isRetryableTcpError(err, retryConfig) {
  return retryConfig.retryOnTcpErrors.includes(err.code);
}

/**
 * Check if an HTTP status code is retryable.
 */
function isRetryableStatusCode(statusCode, retryConfig) {
  return retryConfig.retryOnStatusCodes.includes(statusCode);
}

/**
 * Check if a response body matches any retryable body pattern.
 */
function isRetryableBody(bodyStr, retryConfig) {
  for (const pattern of retryConfig.retryOnBodyPatterns) {
    try {
      if (new RegExp(pattern).test(bodyStr)) return true;
    } catch { /* invalid regex — skip */ }
  }
  return false;
}

/**
 * Forward the processed request to the upstream provider with retry support.
 *
 * Selects http or https transport based on targetBase protocol, handles
 * timeout, error forwarding, and pipes the response through SSE
 * transformation if needed.
 *
 * @param {object} params
 * @param {ProxyRequestContext} params.ctx - Request context with routing applied
 * @param {function} params.handleResponseEnd - Callback for completed responses
 * @param {ErrorReporter} params.errorReporter - Error reporter
 * @param {function} params.getConfig - Config accessor
 * @param {RoutingPolicy} params.policy - Active routing policy (for fallback resolution)
 * @param {function} params.emit - Emit function for logging fallback events
 */
export function forwardToUpstream({ ctx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, openaiProviders }) {
  const retryConfig = getConfig().retry;
  if (retryConfig.maxAttempts > 0) {
    return forwardWithRetry({ ctx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, retryConfig, attempt: 0, openaiProviders });
  }
  singleForwardAttempt({ ctx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, retryConfig: null, onRetryNeeded: null, openaiProviders });
}

/**
 * Retry wrapper around singleForwardAttempt with exponential backoff.
 */
function forwardWithRetry({ ctx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, retryConfig, attempt, openaiProviders }) {
  let settled = false;

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
      settled = true;
      attemptRetry();
    },
    errorReporter,
    getConfig,
    policy,
    extensions,
    emit,
    retryConfig,
    openaiProviders,
    onTcpError: (err) => {
      if (isRetryableTcpError(err, retryConfig) && attempt < retryConfig.maxAttempts) {
        retryState.shouldRetry = true;
        retryState.retryReason = err.code;
        settled = true;
        attemptRetry();
        return true; // signal: suppress error response, retry instead
      }
      // Retries exhausted — try fallback before sending proxy_error
      if (extensions && extensions.hasFallback && extensions.shouldAttemptFallbackForTcpError({ matchedRule: ctx.matchedRule, fallbackDepth: ctx.fallbackDepth })) {
        settled = true;
        emit(`[#${ctx.id}] Retry exhausted (${retryConfig.maxAttempts} attempts), falling back: ${err.code}`, ctx.sessionId).catch(() => {});
        attemptFallbackFromTcpError(ctx, extensions, handleResponseEnd, errorReporter, getConfig, policy, emit, openaiProviders);
        return true; // suppress normal error handling
      }
      return false;
    },
    onUpstreamResponse: (statusCode, bodyStr) => {
      if (attempt >= retryConfig.maxAttempts) return false;
      if (isRetryableStatusCode(statusCode, retryConfig)) {
        retryState.shouldRetry = true;
        retryState.retryReason = `HTTP ${statusCode}`;
        return true;
      }
      if (isRetryableBody(bodyStr, retryConfig)) {
        retryState.shouldRetry = true;
        retryState.retryReason = `body pattern match`;
        return true;
      }
      return false;
    },
    onRetryNeeded: () => {
      settled = true;
      attemptRetry();
    },
  });

  function attemptRetry() {
    if (ctx.clientAborted) {
      emit(`[#${ctx.id}] Retry aborted (client gone) after attempt ${attempt}`, ctx.sessionId).catch(() => {});
      return;
    }

    const nextAttempt = attempt + 1;
    const delay = Math.min(retryConfig.baseDelayMs * Math.pow(2, attempt), retryConfig.maxDelayMs);

    emit(`[#${ctx.id}] Retrying (attempt ${nextAttempt}/${retryConfig.maxAttempts}, ${delay}ms): ${retryState.retryReason}`, ctx.sessionId).catch(() => {});

    sleepAbortable(delay, ctx).then(() => {
      if (ctx.clientAborted) {
        emit(`[#${ctx.id}] Retry aborted (client gone) during backoff`, ctx.sessionId).catch(() => {});
        return;
      }
      forwardWithRetry({ ctx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, retryConfig, attempt: nextAttempt, openaiProviders });
    });
  }
}

/**
 * Attempt fallback after retry-exhausted TCP error.
 */
function attemptFallbackFromTcpError(ctx, extensions, handleResponseEnd, errorReporter, getConfig, policy, emit, openaiProviders) {
  const fallbackResult = extensions.buildFallbackRequest({ originalBody: ctx.originalBody, matchedRule: ctx.matchedRule, policy, routedHeaders: ctx.routedHeaders, openaiProviders });
  if (!fallbackResult) return;

  const fallbackCtx = ctx.withRouting({
    routeLabel: fallbackResult.label,
    reqModel: ctx.reqModel,
    sessionId: ctx.sessionId,
    routedHeaders: fallbackResult.routedHeaders,
    forwardBody: fallbackResult.forwardBody,
    targetBase: fallbackResult.targetBase,
    isCustom: true,
    rawBody: ctx.rawBody,
    originalBody: ctx.originalBody,
    sanitizationReport: fallbackResult.sanitizationReport,
    fallbackDepth: ctx.fallbackDepth + 1,
    matchedRule: null
  });

  forwardToUpstream({ ctx: fallbackCtx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, openaiProviders });
}

/**
 * Single attempt to forward the request upstream.
 *
 * @param {object} params
 * @param {function|null} params.onTcpError - Called on TCP error; return true to suppress error response
 * @param {function|null} params.onUpstreamResponse - Called with (statusCode, bodyStr) for 4xx/5xx; return true to buffer instead of stream
 */
function resolveUpstreamUrl(targetBase, reqUrl, isCustom) {
  const reqPath = reqUrl ?? '/';
  if (!isCustom) return new URL(targetBase + reqPath);
  const parsed = new URL(targetBase);
  if (parsed.pathname === '/' || parsed.pathname === '') {
    return new URL(targetBase + reqPath);
  }
  // Provider URL already has a path (e.g. https://api.example.com/openai/v1).
  // Strip the Anthropic /v1 prefix from the incoming request path and append
  // only the remainder, or use /chat/completions for the messages endpoint.
  let subPath = reqPath.replace(/^\/v1\/messages/, '/chat/completions');
  // If nothing matched (path is /v1/something-else or just /v1), append as-is
  if (subPath === reqPath) {
    subPath = reqPath.replace(/^\/v1/, '');
  }
  if (!subPath || subPath === '/') subPath = '/chat/completions';
  return new URL(targetBase + subPath);
}

function singleForwardAttempt({ ctx, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, retryConfig, onTcpError, onUpstreamResponse, onRetryNeeded, openaiProviders }) {
  const target = resolveUpstreamUrl(ctx.targetBase, ctx.req.url, ctx.isCustom);
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

  // Track whether the client is still interested in a response.
  // When Claude Code gives up on a request and retries, it closes the
  // original connection. The upstream may still be running and eventually
  // timeout — we must NOT write a 400 to a dead response.
  let clientGone = false;
  const markClientGone = () => { clientGone = true; proxyReq.destroy(); };
  ctx.req.on('aborted', markClientGone);
  ctx.req.on('close', () => { if (!ctx.res.writableEnded) markClientGone(); });

  const upstreamTimeout = getConfig().upstreamTimeoutMs;
  if (upstreamTimeout > 0) {
    proxyReq.setTimeout(upstreamTimeout, () => {
      const timeoutErr = new Error(`Upstream timed out after ${upstreamTimeout}ms`); // eslint-disable-line local/no-generic-error -- Node.js destroy() requires Error
      timeoutErr.code = 'ETIMEDOUT';
      proxyReq.destroy(timeoutErr);
    });
  }

  proxyReq.on('error', (err) => {
    const errorId = generateErrorId();

    // Check if retry wants to handle this TCP error
    if (onTcpError && onTcpError(err)) {
      emit(`[#${ctx.id}] ${errorId} Retriable TCP error: ${err.code}`, ctx.sessionId).catch(() => {});
      return;
    }

    // Use both the closure flag AND the live check — between retry attempts
    // the closure may be stale (close event already fired before new listeners
    // were registered), but ctx.clientAborted reads req.aborted/res.destroyed
    // live, catching the case where the client disconnected mid-retry.
    if (clientGone || ctx.clientAborted) {
      emit(`[#${ctx.id}] ${errorId} proxy_error (client gone): ${err.message}`, ctx.sessionId).catch(() => {});
      return;
    }

    // A newer request arrived on the same keep-alive socket. The client has
    // already moved on — writing this error would contaminate the new request.
    // Blackhole the response entirely, just log and report.
    if (ctx.superseded) {
      emit(`[#${ctx.id}] ${errorId} proxy_error (superseded, blackholed): ${err.message}`, ctx.sessionId).catch(() => {});
      proxyReq.destroy();
      return;
    }

    const isQuietError = err.code === 'ECONNRESET' && (ctx.req.aborted || ctx.req.closed);

    if (!isQuietError) {
      errorReporter.write(err, { requestId: ctx.id, route: ctx.routeLabel, method: ctx.req.method, url: ctx.req.url, sessionId: ctx.sessionId, headers: finalHeaders });
    }

    emit(`[#${ctx.id}] ${errorId} proxy_error: ${err.message}`, ctx.sessionId).catch(() => {});

    if (!ctx.res.headersSent) ctx.res.writeHead(400, { 'content-type': 'application/json', 'connection': 'close' });
    if (!ctx.res.writableEnded) ctx.res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: `Upstream connection failed: ${err.message}`, error_id: errorId } }));
  });

  proxyReq.write(ctx.forwardBody);
  proxyReq.end();
}

/**
 * Handle the upstream proxy response: stream to client, apply SSE transformation
 * for non-compliant providers, and delegate to handleResponseEnd on completion.
 *
 * When the upstream returns an error (4xx/5xx) and the matched rule has a fallback,
 * buffers the error response and re-routes to the fallback provider instead.
 *
 * When retry is configured and the error matches retry criteria, buffers the
 * response and signals retry instead of streaming to the client.
 */
export function handleProxyResponse({ reqCtx, proxyRes, headers, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, forwardToUpstream, onUpstreamResponse, onRetryNeeded, openaiProviders }) {
  if (reqCtx.clientAborted || reqCtx.superseded) {
    proxyRes.resume(); // drain the response
    return;
  }

  const statusCode = proxyRes.statusCode;
  const matchedRule = reqCtx.matchedRule;

  // ── Retry interception for error responses ──
  if (onUpstreamResponse && statusCode >= 400) {
    const errorChunks = [];
    proxyRes.on('data', (chunk) => errorChunks.push(chunk));
    proxyRes.on('end', () => {
      const bodyStr = Buffer.concat(errorChunks).toString('utf8');
      if (onUpstreamResponse(statusCode, bodyStr)) {
        if (onRetryNeeded) onRetryNeeded();
        return;
      }
      // Not retryable — fall through to fallback or normal streaming
      processProxyResponse(reqCtx, proxyRes, statusCode, headers, errorChunks, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, forwardToUpstream, matchedRule, openaiProviders);
    });
    proxyRes.on('error', () => { if (!reqCtx.res.writableEnded && !reqCtx.clientAborted) reqCtx.res.end(); });
    return;
  }

  processProxyResponse(reqCtx, proxyRes, statusCode, headers, null, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, forwardToUpstream, matchedRule, openaiProviders);
}

function identityChunk(chunk) { return chunk; }

function createChunkTransformer(extensions) {
  const transformer = new SseResponseTransformer(extensions);
  const fn = (chunk) => {
    const transformedStr = transformer.transformChunk(chunk.toString('utf8'));
    return transformedStr ? Buffer.from(transformedStr, 'utf8') : null;
  };
  fn.flush = () => transformer.flush();
  return fn;
}

/**
 * Process an upstream response: fallback interception, streaming, SSE transformation.
 */
function processProxyResponse(reqCtx, proxyRes, statusCode, headers, bufferedChunks, handleResponseEnd, errorReporter, getConfig, policy, extensions, emit, forwardToUpstream, matchedRule, openaiProviders) {
  // ── Fallback interception ──
  if (extensions && extensions.hasFallback && extensions.shouldAttemptFallback({ statusCode, matchedRule, fallbackDepth: reqCtx.fallbackDepth })) {
    const errorChunks = bufferedChunks ?? [];
    if (!bufferedChunks) {
      proxyRes.on('data', (chunk) => errorChunks.push(chunk));
    }

    const afterBuffer = () => {
      const fallbackResult = extensions.buildFallbackRequest({ originalBody: reqCtx.originalBody, matchedRule, policy, routedHeaders: reqCtx.routedHeaders, openaiProviders });
      if (!fallbackResult) {
        streamBufferedError(reqCtx, proxyRes, errorChunks, handleResponseEnd, headers);
        return;
      }

      if (emit) {
        emit(`[#${reqCtx.id}] Fallback: ${reqCtx.routeLabel} \u2192 ${fallbackResult.label} [upstream ${statusCode}]`, reqCtx.sessionId).catch(() => {});
      }

      const fallbackCtx = reqCtx.withRouting({
        routeLabel: fallbackResult.label,
        reqModel: reqCtx.reqModel,
        sessionId: reqCtx.sessionId,
        routedHeaders: fallbackResult.routedHeaders,
        forwardBody: fallbackResult.forwardBody,
        targetBase: fallbackResult.targetBase,
        isCustom: true,
        rawBody: reqCtx.rawBody,
        originalBody: reqCtx.originalBody,
        sanitizationReport: fallbackResult.sanitizationReport,
        fallbackDepth: reqCtx.fallbackDepth + 1,
        matchedRule: null
      });

      forwardToUpstream({ ctx: fallbackCtx, openaiProviders });
    };

    if (!bufferedChunks) {
      proxyRes.on('end', afterBuffer);
      return;
    }
    afterBuffer();
    proxyRes.on('error', () => {
      if (!reqCtx.res.headersSent && !reqCtx.clientAborted) {
        streamBufferedError(reqCtx, proxyRes, [], handleResponseEnd, headers);
      }
    });
    return;
  }

  // ── Normal streaming ──
  const isSse = (proxyRes.headers['content-type'] || '').includes('text/event-stream');
  const shouldTransform = reqCtx.isCustom && isSse;

  // If we already buffered the response (from retry check), stream it directly
  if (bufferedChunks) {
    streamBufferedResponse(reqCtx, proxyRes, bufferedChunks, handleResponseEnd, headers);
    return;
  }

  const resHeaders = filterResponseHeaders(proxyRes.headers);
  if (shouldTransform) {
    delete resHeaders['content-encoding'];
    delete resHeaders['content-length'];
  }

  if (reqCtx.clientAborted) return;
  reqCtx.res.writeHead(proxyRes.statusCode, resHeaders);

  reqCtx.res.on('error', (err) => {
    if (err.code === 'ECONNRESET') return;
    errorReporter.write(err, { requestId: reqCtx.id, operation: 'writing to client response' });
  });

  const resChunks = [];
  const transformChunk = shouldTransform ? createChunkTransformer(extensions) : identityChunk;

  proxyRes.on('data', (chunk) => {
    if (reqCtx.clientAborted) return;
    const transformed = transformChunk(chunk);
    if (transformed) {
      resChunks.push(transformed);
      if (!reqCtx.clientAborted) reqCtx.res.write(transformed);
    }
  });
  proxyRes.on('error', () => { if (!reqCtx.res.writableEnded && !reqCtx.clientAborted) reqCtx.res.end(); });
  proxyRes.on('end', () => {
    if (reqCtx.clientAborted) return;
    const rest = transformChunk.flush ? transformChunk.flush() : null;
    if (rest) {
      const buf = Buffer.from(rest, 'utf8');
      resChunks.push(buf);
      if (!reqCtx.clientAborted) reqCtx.res.write(buf);
    }
    const resCtx = new ProxyResponseContext({
      proxyRes, res: reqCtx.res, id: reqCtx.id, startTime: reqCtx.startTime,
      routeLabel: reqCtx.routeLabel, reqModel: reqCtx.reqModel, sessionId: reqCtx.sessionId,
      headers, req: reqCtx.req, isCustom: reqCtx.isCustom, rawBody: reqCtx.rawBody, forwardBody: reqCtx.forwardBody,
      sanitizationReport: reqCtx.sanitizationReport
    });
    handleResponseEnd({ resCtx, resChunks });
  });
}

/**
 * Stream a buffered response to the client (used after retry/fallback buffering).
 */
function streamBufferedResponse(reqCtx, proxyRes, chunks, handleResponseEnd, headers) {
  if (reqCtx.clientAborted) return;

  if (reqCtx.res.headersSent) {
    if (!reqCtx.res.writableEnded) reqCtx.res.end();
    return;
  }
  const resHeaders = filterResponseHeaders(proxyRes.headers);
  reqCtx.res.writeHead(proxyRes.statusCode, resHeaders);
  for (const chunk of chunks) {
    reqCtx.res.write(chunk);
  }

  const resCtx = new ProxyResponseContext({
    proxyRes, res: reqCtx.res, id: reqCtx.id, startTime: reqCtx.startTime,
    routeLabel: reqCtx.routeLabel, reqModel: reqCtx.reqModel, sessionId: reqCtx.sessionId,
    headers, req: reqCtx.req, isCustom: reqCtx.isCustom, rawBody: reqCtx.rawBody, forwardBody: reqCtx.forwardBody,
    sanitizationReport: reqCtx.sanitizationReport
  });
  handleResponseEnd({ resCtx, resChunks: chunks });
}

/**
 * Stream a buffered upstream error to the client when fallback is not possible.
 */
function streamBufferedError(reqCtx, proxyRes, chunks, handleResponseEnd, headers) {
  if (reqCtx.clientAborted) return;

  if (reqCtx.res.headersSent) {
    if (!reqCtx.res.writableEnded) reqCtx.res.end();
    return;
  }
  const resHeaders = filterResponseHeaders(proxyRes.headers);
  reqCtx.res.writeHead(proxyRes.statusCode, resHeaders);
  for (const chunk of chunks) {
    reqCtx.res.write(chunk);
  }
  reqCtx.res.end();
}
