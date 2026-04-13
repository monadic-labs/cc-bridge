import { copyRequestHeaders } from './headers.js';
import { tryParseBody } from './routing.js';
import { processRequestBody } from './proxy-routing.js';

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
  const { decompress, compress, errorReporter, debugLogger, getConfig, forwardToUpstream, buildErrorResponse, policy, logger } = deps;

  const rawBuffer = Buffer.concat(chunks);
  const encoding = ctx.req.headers['content-encoding'];

  let decompressedBody = rawBuffer;
  if (encoding) {
    const decompressRes = await decompress(rawBuffer, encoding);
    if (decompressRes.isSuccess) {
      decompressedBody = decompressRes.value;
    } else {
      errorReporter.write(decompressRes.error, { operation: 'decompressing request body', headers: ctx.req.headers });
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
      errorReporter.write(new Error('Failed to parse JSON request body. Bypassing sanitization.'), {
        requestId: activeCtx.id,
        headers: activeCtx.req.headers,
        operation: 'parsing request body',
        debugMode: debugLogger.isDebug
      });
    }

    forwardToUpstream(activeCtx);
    return;
  }

  try {
    activeCtx = await processRequestBody({
      ctx: activeCtx,
      body: bodyOpt.value,
      policy,
      anthropicBaseUrl: getConfig().anthropicBaseUrl,
      logger,
      getConfig
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
      } else {
        delete activeCtx.routedHeaders['content-encoding'];
      }
    } else {
      delete activeCtx.routedHeaders['content-encoding'];
    }

    if (debugLogger.isTrace) {
      await debugLogger.logPayload(activeCtx.id, 'raw', rawBuffer);
      await debugLogger.logPayload(activeCtx.id, 'sanitized', activeCtx.forwardBody);
    }
  } catch (e) {
    errorReporter.write(e, {
      requestId: activeCtx.id,
      method: activeCtx.req.method,
      url: activeCtx.req.url,
      headers: activeCtx.req.headers,
      sessionId: activeCtx.sessionId,
      requestBody: bodyOpt.value,
      debugMode: debugLogger.isDebug
    });
    buildErrorResponse(activeCtx.res, e);
    return;
  }

  forwardToUpstream(activeCtx);
}
