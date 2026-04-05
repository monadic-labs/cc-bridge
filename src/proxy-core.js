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
import { applyRouting, applyAuthHeaders, extractSessionId } from './core/routing.js';
import { parseSseMetadata } from './core/sse-parser.js';
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

export function loadEnv(envPath, envSource = process.env) {
  if (!fs.existsSync(envPath)) return;
  const env = fs.readFileSync(envPath, 'utf8');
  for (const line of env.split('\n')) {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) envSource[key.trim()] = valueParts.join('=').trim();
  }
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

function tryParseBody(rawBody) {
  if (rawBody.length === 0) return Option.none();
  try { return Option.some(JSON.parse(rawBody.toString())); }
  catch { return Option.none(); }
}

function buildErrorResponse(res, message) {
  const payload = JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message }
  });
  if (res.headersSent) return;
  res.writeHead(400, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'connection': 'close'
  });
  res.end(payload);
}

function appendPid(pidsFile) {
  if (!fs.existsSync(pidsFile)) {
    fs.writeFileSync(pidsFile, process.pid + '\n', 'utf8');
    return;
  }
  const existing = fs.readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number);
  if (existing.includes(process.pid)) return;
  fs.appendFileSync(pidsFile, process.pid + '\n', 'utf8');
}

export function createProxyCore({ configDir, port }) {
  const logsDir = path.join(configDir, 'logs');
  const providersPath = path.join(configDir, 'providers.json');
  const configPath = path.join(configDir, 'config.json');

  loadEnv(path.join(configDir, '.env'));

  const logger = new Logger({ logsDir, defaultLog: path.join(logsDir, 'proxy.log'), maxHistory: 10 });
  const errorReporter = new ErrorReporter({ logsDir });

  let shellState = new ProxyState(0, new ProvidersMap([]));

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
      loadEnv(path.join(configDir, '.env'));
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
    const routedHeaders = applyAuthHeaders(ctx.routedHeaders, match);

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
      targetBase: routing.targetBase
    });
  }

  async function handleRequestEnd(ctx, chunks) {
    const rawBody = Buffer.concat(chunks);

    let activeCtx = ctx.withRouting({
      routeLabel: `Unknown (${ctx.req.method})`,
      reqModel: 'unknown',
      sessionId: '',
      routedHeaders: copyRequestHeaders(ctx.req.headers),
      forwardBody: rawBody,
      targetBase: `https://${ANTHROPIC_HOST}`
    });

    const bodyOpt = tryParseBody(rawBody);
    if (bodyOpt.isNone) {
      forwardToUpstream(activeCtx);
      return;
    }

    try {
      activeCtx = await processRequestBody(activeCtx, bodyOpt.value);
    } catch (e) {
      errorReporter.write(e, { requestId: activeCtx.id, method: activeCtx.req.method, url: activeCtx.req.url, headers: activeCtx.req.headers, sessionId: activeCtx.sessionId });
      buildErrorResponse(activeCtx.res, e.message);
      return;
    }

    forwardToUpstream(activeCtx);
  }

  function forwardToUpstream(ctx) {
    const target = new URL(ctx.targetBase + (ctx.req.url ?? '/'));
    const finalHeaders = { ...ctx.routedHeaders, host: target.host, 'content-length': String(ctx.forwardBody.length) };

    const proxyReq = https.request(
      { hostname: target.hostname, port: 443, path: target.pathname + target.search, method: ctx.req.method, headers: finalHeaders },
      (proxyRes) => handleProxyResponse(ctx, proxyRes, finalHeaders)
    );

    proxyReq.on('error', (err) => {
      errorReporter.write(err, { requestId: ctx.id, route: ctx.routeLabel, method: ctx.req.method, url: ctx.req.url, sessionId: ctx.sessionId, headers: finalHeaders });
      if (!ctx.res.headersSent) ctx.res.writeHead(502);
      ctx.res.end(`Proxy error: ${err.message}`);
    });

    ctx.req.on('aborted', () => proxyReq.destroy());
    ctx.req.on('close', () => { if (!ctx.res.writableEnded) proxyReq.destroy(); });

    proxyReq.write(ctx.forwardBody);
    proxyReq.end();
  }

  function handleProxyResponse(reqCtx, proxyRes, headers) {
    const resHeaders = filterResponseHeaders(proxyRes.headers);
    reqCtx.res.writeHead(proxyRes.statusCode, resHeaders);

    const resChunks = [];
    proxyRes.on('data', (chunk) => { resChunks.push(chunk); reqCtx.res.write(chunk); });
    proxyRes.on('error', () => reqCtx.res.end());

    proxyRes.on('end', () => {
      const resCtx = new ProxyResponseContext({
        proxyRes, res: reqCtx.res, id: reqCtx.id, startTime: reqCtx.startTime,
        routeLabel: reqCtx.routeLabel, reqModel: reqCtx.reqModel, sessionId: reqCtx.sessionId,
        headers, req: reqCtx.req
      });
      handleResponseEnd(resCtx, resChunks);
    });
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

    if (status >= 400) {
      errorReporter.write(new ProxyError(`upstream ${status}`, { requestId: resCtx.id, route: resCtx.routeLabel, method: resCtx.req.method, url: resCtx.req.url, model: resCtx.reqModel, sessionId, headers: resCtx.headers, history: logger.getHistory(), responseBody: raw }));
    }

    resCtx.res.end();
  }

  function createRequestHandler() {
    return (req, res) => {
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
    _appendPid: () => appendPid(path.join(logsDir, 'proxy.pids')),
  };
}
