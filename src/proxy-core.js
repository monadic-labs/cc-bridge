import fs from 'fs';
import path from 'path';
import { loadConfigFromFile } from './core/config.js';
import { ensureCompleteProviders } from './core/migrator.js';
import { ProvidersMap, ProviderConfig } from './core/providers.js';
import { Result, ProxyRequestContext } from './core/types.js';
import { buildRoutingPolicy } from './core/routing-rules.js';
import { loadEnv } from './core/env-file.js';
import { decompress, compress } from './core/compression.js';
import { handleRequestEnd } from './core/proxy-request.js';
import { handleResponseEnd } from './core/proxy-response.js';
import { forwardToUpstream } from './core/proxy-upstream.js';
import { Logger } from './infra/logger.js';
import { ErrorReporter } from './infra/error-reporter.js';
import { DebugLogger } from './core/debug-logger.js';
import { runKill } from './infra/process-manager.js';
import { detectFormat, convertV2ToInternal } from './core/config-adapter.js';

export { runKill };
export { loadEnv };

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

/**
 * Extract cc-bridge's own session ID from a URL path prefix.
 *
 * `bin/ccb.js` embeds the session ID in ANTHROPIC_BASE_URL as
 * `http://localhost:{port}/s/{ownSessionId}`, so the CLI sends requests
 * to `/s/{ownSessionId}/v1/messages`. This function strips the prefix and
 * returns both the ID and the real downstream path.
 *
 * If the URL does not match the prefix pattern the session ID is '' and the
 * URL is returned unchanged — this preserves behaviour for callers that
 * bypass ccb (e.g. curl tests, old daemons).
 *
 * @param {string} url - The raw request URL from Node.js `req.url`.
 * @returns {{ sessionId: string, strippedUrl: string }}
 */
export function extractUrlSession(url) {
  if (!url) return { sessionId: '', strippedUrl: '/' };
  const m = url.match(/^\/s\/([^/]+)(\/.*)?$/);
  if (!m) return { sessionId: '', strippedUrl: url };
  return { sessionId: m[1], strippedUrl: m[2] || '/' };
}

function tryParseProviders(data, filepath) {
  try {
    const raw = JSON.parse(data);
    const format = detectFormat(raw);
    const merged = ensureCompleteProviders(raw);

    // Write v2 back to disk if it was v1 (auto-migration)
    if (filepath && format === 'v1') {
      fs.writeFileSync(filepath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    } else if (filepath && JSON.stringify(raw) !== JSON.stringify(merged)) {
      fs.writeFileSync(filepath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    }

    const internal = convertV2ToInternal(merged);
    const list = Array.isArray(internal.providers) ? internal.providers : [];
    const providerConfigs = list.map((p) => new ProviderConfig(p));
    const legacyMap = new ProvidersMap(providerConfigs);
    const policy = buildRoutingPolicy({
      rawPolicy: internal.routingPolicy ?? [],
      providerConfigs,
      legacyProvidersMap: legacyMap
    });
    return Result.ok(policy);
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

  Object.assign(process.env, loadEnv(path.join(configDir, '.env')));

  const cachedConfig = loadConfigFromFile(configDir);
  const logger = new Logger({ logsDir, defaultLog: path.join(logsDir, 'proxy.log'), maxHistory: cachedConfig.historySize });
  const errorReporter = new ErrorReporter({ logsDir });
  const debugLogger = new DebugLogger({ logsDir, level: cachedConfig.loggingLevel });

  let shellState = new ProxyState(0, buildRoutingPolicy({ rawPolicy: [], providerConfigs: [], legacyProvidersMap: new ProvidersMap([]) }));
  let activeKeepalives = 0;
  let hasReceivedKeepalive = false;

  const keepaliveSecret = process.env.CCB_KEEPALIVE_SECRET ?? '';
  if (keepaliveSecret) {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, 'proxy.secret'), keepaliveSecret, 'utf8');
      if (process.platform !== 'win32') {
        try { fs.chmodSync(path.join(logsDir, 'proxy.secret'), 0o600); } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
  }

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

  // ── Response handler bound with deps ──

  function boundHandleResponseEnd({ resCtx, resChunks }) {
    return handleResponseEnd({
      resCtx,
      resChunks,
      deps: { logger, errorReporter, debugLogger, emit, getConfig }
    });
  }

  // ── Upstream forward bound with deps ──

  function boundForwardToUpstream(ctx) {
    return forwardToUpstream({
      ctx,
      handleResponseEnd: boundHandleResponseEnd,
      errorReporter,
      getConfig,
      policy: shellState.providers,
      emit
    });
  }

  // ── Provider lifecycle ──

  function handleProvidersReload(parsedResult) {
    if (parsedResult.isSuccess) {
      shellState = shellState.withProviders(parsedResult.value);
      process.stdout.write(`[providers] Hot-reloaded: ${shellState.providers.size} rule(s), ${shellState.providers.allTargetModels.length} model(s)\n`);
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

  // ── Request handler ──

  function createRequestHandler() {
    return (req, res) => {
      if (req.method === 'GET' && req.url === '/__ccb_internal__/keepalive') {
        if (keepaliveSecret && req.headers['x-ccb-keepalive-secret'] !== keepaliveSecret) {
          res.writeHead(401, { 'content-type': 'text/plain' });
          res.end('Unauthorized');
          return;
        }
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
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/models') {
        const models = shellState.providers.allTargetModels.map((name) => ({
          id: name,
          object: 'model',
          created: Date.now(),
          owned_by: 'custom',
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models }));
        return;
      }
      shellState = shellState.withIncrement();

      const { sessionId: urlSessionId, strippedUrl } = extractUrlSession(req.url);
      if (urlSessionId) req.url = strippedUrl;

      const ctx = new ProxyRequestContext({ req, res, id: shellState.reqCount, startTime: Date.now(), urlSessionId });
      const chunks = [];
      req.on('error', () => { if (!res.headersSent) res.writeHead(400); res.end(); });
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        handleRequestEnd({
          ctx,
          chunks,
          deps: {
            policy: shellState.providers,
            decompress,
            compress,
            logger,
            errorReporter,
            debugLogger,
            getConfig,
            forwardToUpstream: boundForwardToUpstream,
            buildErrorResponse
          }
        });
      });
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
