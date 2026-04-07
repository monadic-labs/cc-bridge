import http from 'http';
import https from 'https';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { loadConfigFromFile } from './core/config.js';
import { ensureCompleteProviders } from './core/migrator.js';
import { ProvidersMap, ProviderConfig } from './core/providers.js';
import { RequestInfo, RequestSummary, Result, Option, ProxyRequestContext, ProxyResponseContext } from './core/types.js';
import { ProxyError } from './core/exceptions.js';
import { copyRequestHeaders, filterResponseHeaders, redactHeaders, ANTHROPIC_HOST } from './core/headers.js';
import { applyRouting, applyAuthHeaders, extractSessionId, tryParseBody } from './core/routing.js';
import { providerIdToEnvKey } from './core/providers.js';
import { decompress, compress } from './core/compression.js';
import { parseSseMetadata } from './core/sse-parser.js';
import { SseResponseTransformer } from './core/sse-transformer.js';
import { DebugLogger } from './core/debug-logger.js';
import { Logger } from './infra/logger.js';
import { ErrorReporter } from './infra/error-reporter.js';
import { runKill } from './infra/process-manager.js';

export { runKill };

class ProxyState {
  #reqCount;
  #activeProviders;

  constructor(reqCount, activeProviders) {
    this.#reqCount = reqCount;
    this.#activeProviders = activeProviders;
    Object.freeze(this);
  }

  get reqCount() { return this.#reqCount; }
  get providers() { return this.#activeProviders; }

  withIncrement() { return new ProxyState(this.#reqCount + 1, this.#activeProviders); }
  withProviders(providers) { return new ProxyState(this.#reqCount, providers); }
}

export function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return Object.freeze({});
  const env = fs.readFileSync(envPath, 'utf8');
  const result = {};
  for (const line of env.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) result[key.trim()] = valueParts.join('=').trim();
  }
  return Object.freeze(result);
}

function tryParseProviders(data, filepath) {
  try {
    const raw = JSON.parse(data);
    const merged = ensureCompleteProviders(raw);
    if (filepath && JSON.stringify(raw) !== JSON.stringify(merged)) {
      fs.writeFileSync(filepath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    }
    const list = Array.isArray(merged.providers) ? merged.providers : [];
    return Result.ok(new ProvidersMap(list.map((p) => new ProviderConfig(p))));
  } catch (e) {
    return Result.fail(e);
  }
}


function buildErrorResponse(res, error) {
  if (res.headersSent) return;
  const payload = typeof error.toResponsePayload === 'function' 
    ? error.toResponsePayload() 
    : JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: error.message || String(error) }
      });
  res.writeHead(400, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'connection': 'close'
  });
  res.end(payload);
}

export function createProxyCore({ configDir, port }) {
  const logsDir = path.join(configDir, 'logs');
  const providersPath = path.join(configDir, 'providers.json');
  const configPath = path.join(configDir, 'config.json');

  Object.assign(process.env, loadEnv(path.join(configDir, '.env')));

  const cachedConfig = loadConfigFromFile(configDir);
  const logger = new Logger({ logsDir, defaultLog: path.join(logsDir, 'proxy.log'), maxHistory: cachedConfig.historySize });
  const errorReporter = new ErrorReporter({ logsDir });
  const debugLogger = new DebugLogger({ logsDir, level: cachedConfig.loggingLevel });

  let shellState = new ProxyState(0, new ProvidersMap([]));
  let activeKeepalives = 0;
  let hasReceivedKeepalive = false;

  function getConfig() {
    try {
      return loadConfigFromFile(configDir);
    } catch (e) {
      errorReporter.write(e, { operation: 'parsing config.json' });
      throw e;
    }
  }

  const currentPort = port ?? getConfig().port;

  async function emit(msg, sessionId) {
    await logger.emit(msg, sessionId);
  }

  function handleProvidersReload(parsedResult) {
    if (parsedResult.isSuccess) {
      shellState = shellState.withProviders(parsedResult.value);
      process.stdout.write(`[providers] Hot-reloaded: ${shellState.providers.size} route(s) active\n`);
      return;
    }
    process.stderr.write(`[providers] Reload failed: ${parsedResult.error.message}\n`);
    errorReporter.write(parsedResult.error, { operation: 'hot-reloading providers.json' });
  }

  async function reloadProviders() {
    try {
      Object.assign(process.env, loadEnv(path.join(configDir, '.env')));
      const data = await fs.promises.readFile(providersPath, 'utf8');
      handleProvidersReload(tryParseProviders(data));
    } catch (e) {
      errorReporter.write(e, { operation: 'reading providers.json' });
    }
  }

  function initProviders() {
    if (!fs.existsSync(providersPath)) return;
    const data = fs.readFileSync(providersPath, 'utf8');
    const parsed = tryParseProviders(data, providersPath);
    if (parsed.isSuccess) shellState = shellState.withProviders(parsed.value);

    try {
      fs.watch(providersPath, () => { reloadProviders().catch((e) => errorReporter.write(e, { operation: 'providers reload callback' })); });
    } catch (e) {
      errorReporter.write(e, { operation: 'setting up providers.json watcher' });
    }
  }

  function resolveRouting(ctx, body) {
    const activeProviders = shellState.providers;
    const reqModel = body.model ?? 'unknown';
    const sessionId = extractSessionId(body);
    const routing = applyRouting(body, activeProviders);
    const match = typeof body.model === 'string' ? activeProviders.resolve(body.model) : null;

    let apiKey = '';
    if (match) {
      const envVar = providerIdToEnvKey(match.provider.id);
      apiKey = process.env[envVar] ?? '';
    }

    const routedHeaders = applyAuthHeaders({ headers: ctx.routedHeaders, match, apiKey });

    return { reqModel, sessionId, routing, routedHeaders, match };
  }

  async function processRequestBody(ctx, body) {
    const { reqModel, sessionId, routing, routedHeaders } = resolveRouting(ctx, body);

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
      sanitizationReport: routing.sanitizationReport
    });
  }

  async function handleRequestEnd(ctx, chunks) {
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
      targetBase: `https://${ANTHROPIC_HOST}`,
      rawBody: rawBuffer
    });

    const bodyOpt = tryParseBody(decompressedBody);
    if (bodyOpt.isNone) {
      if (encoding) {
        delete activeCtx.routedHeaders['content-encoding'];
      }
      
      // Only log as error if there was actually content that failed to parse
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
      activeCtx = await processRequestBody(activeCtx, bodyOpt.value);
      
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

  function forwardToUpstream(ctx) {
    const target = new URL(ctx.targetBase + (ctx.req.url ?? '/'));
    const finalHeaders = { ...ctx.routedHeaders, host: target.host, 'content-length': String(ctx.forwardBody.length) };
    if (ctx.isCustom) delete finalHeaders['accept-encoding'];

    const proxyReq = https.request(
      { hostname: target.hostname, port: 443, path: target.pathname + target.search, method: ctx.req.method, headers: finalHeaders },
      (proxyRes) => handleProxyResponse(ctx, proxyRes, finalHeaders)
    );

    proxyReq.on('error', (err) => {
      // If client already aborted, don't scream about socket hang ups (ECONNRESET)
      const isQuietError = err.code === 'ECONNRESET' && (ctx.req.aborted || ctx.req.closed);
      
      if (!isQuietError) {
        errorReporter.write(err, { requestId: ctx.id, route: ctx.routeLabel, method: ctx.req.method, url: ctx.req.url, sessionId: ctx.sessionId, headers: finalHeaders });
      }
      
      if (!ctx.res.headersSent) ctx.res.writeHead(502);
      if (!ctx.res.writableEnded) ctx.res.end(`Proxy error: ${err.message}`);
    });

    ctx.req.on('aborted', () => proxyReq.destroy());
    ctx.req.on('close', () => { if (!ctx.res.writableEnded) proxyReq.destroy(); });

    proxyReq.write(ctx.forwardBody);
    proxyReq.end();
  }

  function handleProxyResponse(reqCtx, proxyRes, headers) {
    const isSse = (proxyRes.headers['content-type'] || '').includes('text/event-stream');
    const shouldTransform = reqCtx.isCustom && isSse;

    const resHeaders = filterResponseHeaders(proxyRes.headers);
    if (shouldTransform) {
      delete resHeaders['content-encoding'];
      delete resHeaders['content-length'];
    }
    
    reqCtx.res.writeHead(proxyRes.statusCode, resHeaders);

    // Resilience: prevent crashes if the client socket closes abruptly
    reqCtx.res.on('error', (err) => {
      if (err.code === 'ECONNRESET') return; // Expected if client aborts
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
        handleResponseEnd(resCtx, resChunks);
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
        handleResponseEnd(resCtx, resChunks);
      });
    }
  }

  async function decompressBodySafe(resChunks, encoding) {
    try {
      const decompressed = await logger.decompressChunks(resChunks, encoding);
      return Result.ok(decompressed);
    } catch (e) {
      return Result.fail(e);
    }
  }

  function extractTokensIfSse(raw, contentType) {
    const isSse = (contentType ?? '').includes('text/event-stream');
    if (!isSse) return { inputTokens: 0, outputTokens: 0 };
    const meta = parseSseMetadata(raw);
    return { inputTokens: meta.inputTokens, outputTokens: meta.outputTokens };
  }

  async function handleResponseEnd(resCtx, resChunks) {
    const status = resCtx.proxyRes.statusCode;
    const duration = Date.now() - resCtx.startTime;
    const encoding = resCtx.proxyRes.headers['content-encoding'];

    const decompressRes = await decompressBodySafe(resChunks, encoding);
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

    // Logging: Notify only when blocks were actually converted (semantic, not byte-level)
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

  function createRequestHandler() {
    return (req, res) => {
      if (req.method === 'GET' && req.url === '/__ccb_internal__/keepalive') {
        hasReceivedKeepalive = true;
        activeKeepalives++;
        
        const cleanup = () => {
          activeKeepalives--;
          if (activeKeepalives === 0 && hasReceivedKeepalive) {
            emit('All keepalives closed, shutting down proxy daemon.').then(() => {
              process.exit(0);
            });
          }
        };
        
        req.on('close', cleanup);
        // Do not call res.end() - keep the connection hanging open
        return;
      }
      
      if (req.method === 'GET' && req.url === '/v1/models') {
        const models = shellState.providers.allAliases.map((alias) => ({
          id: alias,
          object: 'model',
          created: Date.now(),
          owned_by: 'custom',
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models }));
        return;
      }
      shellState = shellState.withIncrement();
      const ctx = new ProxyRequestContext({ req, res, id: shellState.reqCount, startTime: Date.now() });
      const chunks = [];
      req.on('error', () => { if (!res.headersSent) res.writeHead(400); res.end(); });
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => handleRequestEnd(ctx, chunks));
    };
  }

  return {
    initProviders,
    createRequestHandler,
    get providerCount() { return shellState.providers.size; },
    getConfig,
    emit,
    logsDir,
    port: currentPort,
  };
}
