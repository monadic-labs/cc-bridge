import { copyRequestHeaders } from './headers.js';
import { tryParseBody } from './routing.js';
import { processRequestBody } from './proxy-routing.js';
import { ProxyError } from './exceptions.js';

/**
 * Handle the end of an incoming request: decompress, parse, route, compress, forward.
 *
 * Orchestrates the full request pipeline by delegating to extracted modules.
 * Dependencies are injected so the function is testable without the closure.
 *
 * @param {object} params
 * @param {ProxyRequestContext} params.ctx - Request context
 * @param {Buffer[]} params.chunks - Raw request body chunks
 * @param {object} params.deps - Injected dependencies
 * @param {RoutingPolicy} params.deps.policy - Active routing policy
 * @param {function} params.deps.decompress - Decompress function
 * @param {function} params.deps.compress - Compress function
 * @param {Logger} params.deps.logger - Logger instance
 * @param {ErrorReporter} params.deps.errorReporter - Error reporter
 * @param {DebugLogger} params.deps.debugLogger - Debug logger
 * @param {function} params.deps.getConfig - Config accessor
 * @param {function} params.deps.forwardToUpstream - Upstream forward function
 * @param {function} params.deps.buildErrorResponse - Error response builder
 */
export async function handleRequestEnd({ ctx, chunks, deps }) {
  const { 
    decompress, compress, errorReporter, debugLogger, getConfig, 
    forwardToUpstream, buildErrorResponse, policy, extensions, 
    logger, openaiProviders, sessionMetadata 
  } = deps;

  const rawBuffer = Buffer.concat(chunks);
  const encoding = ctx.req.headers['content-encoding'];

  let decompressedBody = rawBuffer;
  if (encoding) {
    const decompressRes = await decompress(rawBuffer, encoding);
    if (!decompressRes.isSuccess) {
      errorReporter.write(decompressRes.error, {
        operation: 'request_decompression',
        requestId: ctx.id,
        route: ctx.routeLabel,
        method: ctx.req.method,
        url: ctx.req.url,
        headers: ctx.req.headers
      });
    }
    if (decompressRes.isSuccess) {
      decompressedBody = decompressRes.value;
    }
  }

  let activeCtx = ctx.withRouting({
    routeLabel: `Unknown (${ctx.req.method})`,
    reqModel: 'unknown',
    sessionId: '',
    routedHeaders: copyRequestHeaders(ctx.req.headers),
    forwardBody: decompressedBody,
    targetBase: getConfig().anthropicBaseUrl,
    rawBody: rawBuffer,
    originalBody: decompressedBody
  });

  const bodyOpt = tryParseBody(decompressedBody);

  if (bodyOpt.isNone) {
    if (encoding) {
      delete activeCtx.routedHeaders['content-encoding'];
    }

    if (decompressedBody.length > 0) {
      errorReporter.write(new ProxyError('Failed to parse JSON request body. Bypassing sanitization.', { operation: 'parsing request body' }), {
        requestId: activeCtx.id,
        route: activeCtx.routeLabel,
        method: activeCtx.req.method,
        url: activeCtx.req.url,
        model: activeCtx.reqModel,
        sessionId: activeCtx.sessionId,
        headers: activeCtx.req.headers,
        operation: 'request_body_parse',
        elapsedMs: Date.now() - activeCtx.startTime,
        debugMode: debugLogger.isDebug
      });
    }

    forwardToUpstream(activeCtx, logger, getConfig, extensions);
    return;
  }

  try {
    activeCtx = await processRequestBody({
      ctx: activeCtx,
      body: bodyOpt.value,
      policy,
      extensions,
      anthropicBaseUrl: getConfig().anthropicBaseUrl,
      logger,
      getConfig,
      openaiProviders,
      sessionMetadata
    });

    const config = getConfig();
    if (config.recompressRequests && encoding) {
      const compressRes = await compress(activeCtx.forwardBody, encoding);
      if (compressRes.isSuccess) {
        activeCtx = activeCtx.withRouting({
          routeLabel: activeCtx.routeLabel,
          reqModel: activeCtx.reqModel,
          sessionId: activeCtx.sessionId,
          routedHeaders: activeCtx.routedHeaders,
          forwardBody: compressRes.value,
          targetBase: activeCtx.targetBase,
          isCustom: activeCtx.isCustom,
          rawBody: activeCtx.rawBody
        });
      }
      if (!compressRes.isSuccess) {
        delete activeCtx.routedHeaders['content-encoding'];
      }
    }
    if (!(config.recompressRequests && encoding)) {
      delete activeCtx.routedHeaders['content-encoding'];
    }

    if (debugLogger.isTrace) {
      await debugLogger.logPayload(activeCtx.sessionId, activeCtx.id, 'raw', rawBuffer);
      await debugLogger.logPayload(activeCtx.sessionId, activeCtx.id, 'sanitized', activeCtx.forwardBody);
    }
  } catch (e) {
    errorReporter.write(e, {
      requestId: activeCtx.id,
      method: activeCtx.req.method,
      url: activeCtx.req.url,
      headers: activeCtx.req.headers,
      sessionId: activeCtx.sessionId,
      requestBody: bodyOpt.value,
      operation: 'request_processing',
      elapsedMs: Date.now() - activeCtx.startTime,
      debugMode: debugLogger.isDebug
    });
    buildErrorResponse(activeCtx.res, e, activeCtx.startTime);
    return;
  }

  forwardToUpstream(activeCtx, logger, getConfig, extensions);
}
