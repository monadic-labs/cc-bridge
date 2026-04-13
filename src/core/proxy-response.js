import { RequestSummary, Result } from './types.js';
import { ProxyError } from './exceptions.js';
import { parseSseMetadata } from './sse-parser.js';
import { extractSessionId, tryParseBody } from './routing.js';

/**
 * Decompress response chunks safely, returning a Result.
 */
export async function decompressBodySafe(resChunks, encoding, logger) {
  try {
    const decompressed = await logger.decompressChunks(resChunks, encoding);
    return Result.ok(decompressed);
  } catch (e) {
    return Result.fail(e);
  }
}

/**
 * Extract token counts from SSE response content if applicable.
 */
export function extractTokensIfSse(raw, contentType) {
  const isSse = (contentType ?? '').includes('text/event-stream');
  if (!isSse) return { inputTokens: 0, outputTokens: 0 };
  const meta = parseSseMetadata(raw);
  return { inputTokens: meta.inputTokens, outputTokens: meta.outputTokens };
}

/**
 * Handle the end of a proxy response: decompress, log, report errors, close.
 *
 * @param {object} params
 * @param {ProxyResponseContext} params.resCtx - Response context
 * @param {Buffer[]} params.resChunks - Collected response chunks
 * @param {object} params.deps - Injected dependencies
 * @param {Logger} params.deps.logger - Logger instance
 * @param {ErrorReporter} params.deps.errorReporter - Error reporter
 * @param {DebugLogger} params.deps.debugLogger - Debug logger
 * @param {function} params.deps.emit - Emit function for logging
 * @param {function} params.deps.getConfig - Config accessor
 */
export async function handleResponseEnd({ resCtx, resChunks, deps }) {
  const { logger, errorReporter, debugLogger, emit, getConfig } = deps;

  const status = resCtx.proxyRes.statusCode;
  const duration = Date.now() - resCtx.startTime;
  const encoding = resCtx.proxyRes.headers['content-encoding'];

  const decompressRes = await decompressBodySafe(resChunks, encoding, logger);
  const raw = decompressRes.isSuccess ? decompressRes.value : Buffer.concat(resChunks).toString();
  if (!decompressRes.isSuccess) {
    errorReporter.write(decompressRes.error, { requestId: resCtx.id, headers: resCtx.proxyRes.headers });
  }

  let sessionId = resCtx.sessionId;
  if (!sessionId) {
    const bodyOpt = tryParseBody(Buffer.from(raw));
    if (bodyOpt.isSome) sessionId = extractSessionId(bodyOpt.value);
  }

  try {
    const cfg = getConfig();
    await logger.logResponse(resCtx.id, status, resCtx.proxyRes.headers, raw, sessionId, cfg);
  } catch (e) {
    errorReporter.write(e, { operation: 'logging response' });
  }

  const { inputTokens, outputTokens } = extractTokensIfSse(raw, resCtx.proxyRes.headers['content-type']);

  logger.addSummary(new RequestSummary({ id: resCtx.id, route: resCtx.routeLabel, model: resCtx.reqModel, status, duration, inputTokens, outputTokens }));

  const report = resCtx.sanitizationReport;
  if (report && report.convertedCount > 0) {
    await emit(`[DEBUG #${resCtx.id}] Sanitized ${report.convertedCount} block(s): [${report.convertedTypes.join(', ')}]`, sessionId);
  }

  if (status >= 400) {
    const requestBodyOpt = tryParseBody(resCtx.forwardBody);
    const requestBody = requestBodyOpt.isSome ? requestBodyOpt.value : null;

    errorReporter.write(new ProxyError(`upstream ${status}`, {
      requestId: resCtx.id,
      route: resCtx.routeLabel,
      method: resCtx.req.method,
      url: resCtx.req.url,
      model: resCtx.reqModel,
      sessionId,
      headers: resCtx.headers,
      history: logger.getHistory(),
      responseBody: raw,
      requestBody,
      debugMode: debugLogger.isDebug
    }));

    if (debugLogger.isDebug) {
      await debugLogger.dumpErrorPayloads(resCtx.id, {
        raw: resCtx.rawBody,
        sanitized: resCtx.forwardBody
      });
    }
  }

  resCtx.res.end();
}
