import http from 'http';
import https from 'https';
import { URL } from 'url';
import { ProxyResponseContext } from './types.js';
import { filterResponseHeaders } from './headers.js';
import { SseResponseTransformer } from './sse-transformer.js';
import { shouldAttemptFallback, resolveFallbackMatch, buildFallbackRequest } from './fallback-handler.js';

/**
 * Forward the processed request to the upstream provider.
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
export function forwardToUpstream({ ctx, handleResponseEnd, errorReporter, getConfig, policy, emit }) {
  const target = new URL(ctx.targetBase + (ctx.req.url ?? '/'));
  const finalHeaders = { ...ctx.routedHeaders, host: target.host, 'content-length': String(ctx.forwardBody.length) };
  if (ctx.isCustom) delete finalHeaders['accept-encoding'];

  const transport = target.protocol === 'https:' ? https : http;
  const defaultPort = target.protocol === 'https:' ? 443 : 80;

  const proxyReq = transport.request(
    { hostname: target.hostname, port: target.port || defaultPort, path: target.pathname + target.search, method: ctx.req.method, headers: finalHeaders },
    (proxyRes) => handleProxyResponse({
      reqCtx: ctx, proxyRes, headers: finalHeaders, handleResponseEnd, errorReporter, getConfig, policy, emit,
      forwardToUpstream: ({ ctx: fallbackCtx }) => forwardToUpstream({ ctx: fallbackCtx, handleResponseEnd, errorReporter, getConfig, policy, emit })
    })
  );

  const upstreamTimeout = getConfig().upstreamTimeoutMs;
  if (upstreamTimeout > 0) {
    proxyReq.setTimeout(upstreamTimeout, () => {
      proxyReq.destroy(new Error(`Upstream timed out after ${upstreamTimeout}ms`));
    });
  }

  proxyReq.on('error', (err) => {
    const isQuietError = err.code === 'ECONNRESET' && (ctx.req.aborted || ctx.req.closed);

    if (!isQuietError) {
      errorReporter.write(err, { requestId: ctx.id, route: ctx.routeLabel, method: ctx.req.method, url: ctx.req.url, sessionId: ctx.sessionId, headers: finalHeaders });
    }

    if (!ctx.res.headersSent) ctx.res.writeHead(400, { 'content-type': 'application/json' });
    if (!ctx.res.writableEnded) ctx.res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: `Upstream connection failed: ${err.message}` } }));
  });

  ctx.req.on('aborted', () => proxyReq.destroy());
  ctx.req.on('close', () => { if (!ctx.res.writableEnded) proxyReq.destroy(); });

  proxyReq.write(ctx.forwardBody);
  proxyReq.end();
}

/**
 * Handle the upstream proxy response: stream to client, apply SSE transformation
 * for non-compliant providers, and delegate to handleResponseEnd on completion.
 *
 * When the upstream returns an error (4xx/5xx) and the matched rule has a fallback,
 * buffers the error response and re-routes to the fallback provider instead.
 */
export function handleProxyResponse({ reqCtx, proxyRes, headers, handleResponseEnd, errorReporter, getConfig, policy, emit, forwardToUpstream }) {
  const statusCode = proxyRes.statusCode;
  const matchedRule = reqCtx.matchedRule;

  // ── Fallback interception ──
  if (shouldAttemptFallback(statusCode, matchedRule, reqCtx.fallbackDepth)) {
    const errorChunks = [];
    proxyRes.on('data', (chunk) => errorChunks.push(chunk));
    proxyRes.on('end', () => {
      const fallbackMatchOpt = resolveFallbackMatch(policy, matchedRule);
      if (fallbackMatchOpt.isNone) {
        streamBufferedError(reqCtx, proxyRes, errorChunks, handleResponseEnd, headers);
        return;
      }

      const fallbackResult = buildFallbackRequest(reqCtx.originalBody, fallbackMatchOpt.value, reqCtx.routedHeaders);
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

      forwardToUpstream({ ctx: fallbackCtx });
    });
    proxyRes.on('error', () => {
      if (!reqCtx.res.headersSent) {
        streamBufferedError(reqCtx, proxyRes, [], handleResponseEnd, headers);
      }
    });
    return;
  }

  // ── Normal streaming ──
  const isSse = (proxyRes.headers['content-type'] || '').includes('text/event-stream');
  const shouldTransform = reqCtx.isCustom && isSse;

  const resHeaders = filterResponseHeaders(proxyRes.headers);
  if (shouldTransform) {
    delete resHeaders['content-encoding'];
    delete resHeaders['content-length'];
  }

  reqCtx.res.writeHead(proxyRes.statusCode, resHeaders);

  reqCtx.res.on('error', (err) => {
    if (err.code === 'ECONNRESET') return;
    errorReporter.write(err, { requestId: reqCtx.id, operation: 'writing to client response' });
  });

  const resChunks = [];

  if (shouldTransform) {
    const transformer = new SseResponseTransformer();
    proxyRes.on('data', (chunk) => {
      const transformedStr = transformer.transformChunk(chunk.toString('utf8'));
      if (transformedStr) {
        const buf = Buffer.from(transformedStr, 'utf8');
        resChunks.push(buf);
        reqCtx.res.write(buf);
      }
    });
    proxyRes.on('end', () => {
      const rest = transformer.flush();
      if (rest) {
        const buf = Buffer.from(rest, 'utf8');
        resChunks.push(buf);
        reqCtx.res.write(buf);
      }
      const resCtx = new ProxyResponseContext({
        proxyRes, res: reqCtx.res, id: reqCtx.id, startTime: reqCtx.startTime,
        routeLabel: reqCtx.routeLabel, reqModel: reqCtx.reqModel, sessionId: reqCtx.sessionId,
        headers, req: reqCtx.req, isCustom: reqCtx.isCustom, rawBody: reqCtx.rawBody, forwardBody: reqCtx.forwardBody,
        sanitizationReport: reqCtx.sanitizationReport
      });
      handleResponseEnd({ resCtx, resChunks });
    });
    proxyRes.on('error', () => { if (!reqCtx.res.writableEnded) reqCtx.res.end(); });
  } else {
    proxyRes.on('data', (chunk) => { resChunks.push(chunk); reqCtx.res.write(chunk); });
    proxyRes.on('error', () => { if (!reqCtx.res.writableEnded) reqCtx.res.end(); });

    proxyRes.on('end', () => {
      const resCtx = new ProxyResponseContext({
        proxyRes, res: reqCtx.res, id: reqCtx.id, startTime: reqCtx.startTime,
        routeLabel: reqCtx.routeLabel, reqModel: reqCtx.reqModel, sessionId: reqCtx.sessionId,
        headers, req: reqCtx.req, isCustom: reqCtx.isCustom, rawBody: reqCtx.rawBody, forwardBody: reqCtx.forwardBody,
        sanitizationReport: reqCtx.sanitizationReport
      });
      handleResponseEnd({ resCtx, resChunks });
    });
  }
}

/**
 * Stream a buffered upstream error to the client when fallback is not possible.
 */
function streamBufferedError(reqCtx, proxyRes, chunks, handleResponseEnd, headers) {
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
