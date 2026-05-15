import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath, URL } from 'url';
import {
  CCB_VERSION,
  LOGS_DIR_NAME,
  PROVIDERS_FILENAME,
  CONFIG_FILENAME,
  ENV_FILENAME
} from './core/constants.js';
import { loadConfigFromFile, ProxyConfig } from './core/config.js';
import { ensureCompleteProviders, ensureCompleteConfig } from './core/migrator.js';
import { ProvidersMap, ProviderConfig } from './core/providers.js';
import { Result, ProxyRequestContext } from './core/types.js';
import { ConfigError, ArgumentError, ReadinessTimeoutException } from './core/exceptions.js';
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
import { detectFormat, convertV2ToInternal, convertV1ToV2 } from './core/config-adapter.js';
import { ExtensionRegistry } from './core/extension-registry.js';
import { discoverExtensions, buildRegistry, watchExtensions } from './core/extension-loader.js';
export { runKill };
export { loadEnv, ProxyState };

class ProxyState {
  #reqCount;
  #activeProviders;
  #extensions;
  #extensionConfigs;
  #activeConnections;

  constructor(reqCount, activeProviders, extensions, extensionConfigs, activeConnections) {
    this.#reqCount = reqCount;
    this.#activeProviders = activeProviders;
    this.#extensions = extensions;
    this.#extensionConfigs = extensionConfigs ?? {};
    this.#activeConnections = activeConnections ?? 0;
    Object.freeze(this);
  }

  get reqCount() { return this.#reqCount; }
  get providers() { return this.#activeProviders; }
  get extensions() { return this.#extensions; }
  get extensionConfigs() { return this.#extensionConfigs; }
  get openaiProviders() { return this.#extensionConfigs['openai-format']?.providers; }
  get activeConnections() { return this.#activeConnections; }

  withIncrement() { return new ProxyState(this.#reqCount + 1, this.#activeProviders, this.#extensions, this.#extensionConfigs, this.#activeConnections); }
  withConnectionBump(delta) {
    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      throw new ArgumentError('delta must be a finite number');
    }
    const newCount = this.#activeConnections + delta;
    if (newCount < 0) {
      throw new ArgumentError(`activeConnections cannot be negative (current: ${this.#activeConnections}, delta: ${delta})`);
    }
    return new ProxyState(this.#reqCount, this.#activeProviders, this.#extensions, this.#extensionConfigs, newCount);
  }
  withProviders(providers, extensions, extensionConfigs) { return new ProxyState(this.#reqCount, providers, extensions ?? this.#extensions, extensionConfigs ?? this.#extensionConfigs, this.#activeConnections); }
}

/**
 * Extract cc-bridge's own session ID from a URL path prefix.
 */
export function extractUrlSession(url) {
  if (!url) return { sessionId: '', strippedUrl: '/' };
  const m = url.match(/^\/s\/([^/]+)(\/.*)?$/);
  if (!m) return { sessionId: '', strippedUrl: url };
  return { sessionId: m[1], strippedUrl: m[2] || '/' };
}

function stripBom(str) {
  if (str.charCodeAt(0) === 0xFEFF) return str.slice(1);
  return str;
}

function tryParseProviders(data, filepath) {
  try {
    const raw = JSON.parse(stripBom(data));
    const format = detectFormat(raw);
    const merged = ensureCompleteProviders(raw);

    // Write v2 back to disk if it was v1 (auto-migration)
    if (filepath && (format === 'v1' || JSON.stringify(raw) !== JSON.stringify(merged))) {
      fs.writeFileSync(filepath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    }

    const internal = convertV2ToInternal(merged);
    const list = Array.isArray(internal.providers) ? internal.providers : [];
    const providerConfigs = list.map((p) => new ProviderConfig(p));
    const legacyMap = new ProvidersMap(providerConfigs);
    const policy = buildRoutingPolicy({
      rawPolicy: internal.routingPolicy ?? [],
      providerConfigs,
      legacyProvidersMap: legacyMap,
      defaultFallback: internal.defaultFallback ?? null
    });

    const extensionConfigs = merged.extensions ?? raw.extensions ?? {};

    return Result.ok({ policy, providerConfigs, extensionConfigs });
  } catch (e) {
    return Result.fail(e);
  }
}

function buildErrorResponse(res, error, startTime) {
  if (res.headersSent) return;
  const elapsedMs = startTime ? Date.now() - startTime : null;
  let payload;

  if (typeof error.toResponsePayload === 'function') {
    payload = error.toResponsePayload();
    // Inject timing if payload is a JSON string
    if (elapsedMs !== null && typeof payload === 'string') {
      try {
        const parsed = JSON.parse(payload);
        if (parsed.error && typeof parsed.error === 'object') {
          parsed.error.ccb_response_time_ms = elapsedMs;
          payload = JSON.stringify(parsed);
        }
      } catch {
        // Not valid JSON, leave as-is
      }
    }
  }

  if (typeof error.toResponsePayload !== 'function') {
    payload = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: error.message || String(error),
        ...(elapsedMs !== null && { ccb_response_time_ms: elapsedMs })
      }
    });
  }

  res.writeHead(400, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'connection': 'close'
  });
  res.end(payload);
}

export function createProxyCore({ configDir, port }) {
  const logsDir = path.join(configDir, LOGS_DIR_NAME);
  const providersPath = path.join(configDir, PROVIDERS_FILENAME);
  const daemonConfigPath = path.join(configDir, CONFIG_FILENAME);

  Object.assign(process.env, loadEnv(path.join(configDir, ENV_FILENAME)));

  const cachedConfig = loadConfigFromFile(configDir);
  const logger = new Logger({ logsDir, defaultLog: path.join(logsDir, 'proxy.log'), maxHistory: cachedConfig.historySize });
  const errorReporter = new ErrorReporter({ logsDir });
  const debugLogger = new DebugLogger({ logsDir, level: cachedConfig.loggingLevel });

  let shellState = new ProxyState(0, buildRoutingPolicy({ rawPolicy: [], providerConfigs: [], legacyProvidersMap: new ProvidersMap([]) }), new ExtensionRegistry());
  let activeKeepalives = 0;
  let hasReceivedKeepalive = false;
  const proxyStartTime = Date.now();
  let lastClaudeSessionId = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalRequests = 0;

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

  function recordSessionUpdate({ sessionId, inputTokens, outputTokens }) {
    if (sessionId) lastClaudeSessionId = sessionId;
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalRequests++;
  }

  // ── Response handler bound with deps ──

  function boundHandleResponseEnd({ resCtx, resChunks }) {
    return handleResponseEnd({
      resCtx,
      resChunks,
      deps: { logger, errorReporter, debugLogger, emit, getConfig, onSessionUpdate: recordSessionUpdate }
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
      extensions: shellState.extensions,
      emit,
      openaiProviders: shellState.openaiProviders
    });
  }

  // ── Provider lifecycle ──

  const BUILTIN_EXTENSIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'extensions');

  let reloadInProgress = false;

  async function rebuildExtensions(providerConfigs, extensionConfigs) {
    const dirs = [BUILTIN_EXTENSIONS_DIR];
    const userExtDir = path.join(configDir, 'extensions');
    if (fs.existsSync(userExtDir)) dirs.push(userExtDir);

    const allModules = [];
    for (const dir of dirs) {
      const modules = await discoverExtensions(dir);
      allModules.push(...modules);
    }

    const { registry, errors } = buildRegistry(allModules, providerConfigs, extensionConfigs);

    if (errors.length > 0) {
      process.stderr.write(`[extensions] Warnings: ${errors.join('; ')}\n`);
      for (const err of errors) {
        errorReporter.write(new ConfigError(err), { operation: 'extension loading' });
      }
    }

    return registry;
  }

  async function loadAndApplyProviders(data) {
    if (reloadInProgress) return;
    reloadInProgress = true;
    try {
      const parsed = tryParseProviders(data);
      if (!parsed.isSuccess) {
        process.stderr.write(`[providers] Parse failed: ${parsed.error.message}\n`);
        errorReporter.write(parsed.error, { operation: 'parsing providers.json' });
        return;
      }

      const { policy, providerConfigs, extensionConfigs } = parsed.value;
      const extensions = await rebuildExtensions(providerConfigs, extensionConfigs);
      shellState = shellState.withProviders(policy, extensions, extensionConfigs);
      process.stdout.write(`[providers] Loaded: ${shellState.providers.size} rule(s), ${shellState.providers.allTargetModels.length} model(s), ${shellState.extensions.size} extension(s)\n`);
    } catch (e) {
      errorReporter.write(e, { operation: 'loading providers and extensions' });
    } finally {
      reloadInProgress = false;
    }
  }

  async function reloadProviders() {
    try {
      Object.assign(process.env, loadEnv(path.join(configDir, ENV_FILENAME)));
      const data = await fs.promises.readFile(providersPath, 'utf8');
      await loadAndApplyProviders(data);
    } catch (e) {
      errorReporter.write(e, { operation: 'reading providers.json' });
    }
  }

  function initProviders() {
    if (!fs.existsSync(providersPath)) return Promise.resolve();
    const data = fs.readFileSync(providersPath, 'utf8');
    const loadPromise = loadAndApplyProviders(data);

    try {
      fs.watch(providersPath, () => { reloadProviders().catch((e) => errorReporter.write(e, { operation: 'providers reload callback' })); });
    } catch (e) {
      errorReporter.write(e, { operation: 'setting up providers.json watcher' });
    }

    const userExtDir = path.join(configDir, 'extensions');
    const watchDirs = [BUILTIN_EXTENSIONS_DIR];
    if (fs.existsSync(userExtDir)) watchDirs.push(userExtDir);

    watchExtensions(watchDirs, () => {
      process.stdout.write('[extensions] File change detected, reloading...\n');
      reloadProviders().catch((e) => errorReporter.write(e, { operation: 'extension hot-reload' }));
    });

    return loadPromise;
  }

  // ── Request handler ──

  const lastCtxPerSocket = new WeakMap();

  function createRequestHandler() {
    return (req, res) => {
      // Browsers auto-request /favicon.ico. We don't ship one — return a
      // bare 204 so it doesn't fall through to the upstream proxy and cause
      // a slow 404 from anthropic.com.
      if (req.method === 'GET' && req.url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      // ── GUI Static Files ──
      if (req.method === 'GET' && req.url.startsWith('/gui')) {
        let filePath = req.url === '/gui' || req.url === '/gui/'
          ? path.join(BUILTIN_EXTENSIONS_DIR, '..', 'infra', 'gui', 'index.html')
          : path.join(BUILTIN_EXTENSIONS_DIR, '..', 'infra', 'gui', req.url.replace('/gui/', ''));

        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          const ext = path.extname(filePath);
          const contentType = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : 'text/plain';
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(data);
        });
        return;
      }

      // ── API Endpoints ──
      if (req.method === 'GET' && req.url === '/api/config') {
        fs.readFile(providersPath, 'utf8', (err, data) => {
          if (err) {
            res.writeHead(500);
            res.end('Error reading config');
            return;
          }
          let payload = data;
          try {
            const raw = JSON.parse(stripBom(data));
            const normalized = detectFormat(raw) === 'v1' ? convertV1ToV2(raw) : raw;
            payload = JSON.stringify(normalized);
          } catch {
            // Pass raw through; the GUI will surface the parse error.
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(payload);
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/api/schema') {
        const schema = {
          extensions: shellState.extensions.getSchemas()
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(schema));
        return;
      }

      if (req.method === 'GET' && req.url === '/api/extensions') {
        const list = shellState.extensions.getAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/config') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            JSON.parse(body); // Validate JSON
            fs.writeFileSync(providersPath, body, 'utf8');
            res.writeHead(200);
            res.end('OK');
          } catch {
            res.writeHead(400);
            res.end('Invalid JSON');
          }
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/api/daemon-config') {
        fs.readFile(daemonConfigPath, 'utf8', (err, data) => {
          if (err) {
            res.writeHead(500);
            res.end('Error reading daemon config');
            return;
          }
          let payload = data;
          try {
            const raw = JSON.parse(stripBom(data));
            payload = JSON.stringify(ensureCompleteConfig(raw));
          } catch {
            // Pass raw through; the GUI will surface the parse error.
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(payload);
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/daemon-config') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const raw = JSON.parse(body);
            const complete = ensureCompleteConfig(raw);
            // Validate by constructing the config — throws ConfigError on bad input.
            new ProxyConfig(complete);
            fs.writeFileSync(daemonConfigPath, JSON.stringify(complete, null, 2) + '\n', 'utf8');
            res.writeHead(200);
            res.end('OK');
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end(e?.message ?? 'Invalid daemon config');
          }
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/restart') {
        if (!process.send) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('Restart is only available when running under the watchdog.');
          return;
        }
        process.send({ type: 'restart-request' });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'restarting' }));
        return;
      }

      if (req.method === 'GET' && req.url.startsWith('/api/logs')) {
        const url = new URL(req.url, 'http://localhost');
        const lines = Math.min(Math.max(parseInt(url.searchParams.get('lines') || '200', 10), 1), 5000);
        const logFile = path.join(logsDir, 'daemon.log');
        fs.readFile(logFile, 'utf8', (err, data) => {
          if (err && err.code === 'ENOENT') {
            // Log was rotated/cleared — return empty 200 rather than confusing a
            // dashboard with a 500.
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('');
            return;
          }
          if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`Cannot read ${logFile}: ${err.message}`);
            return;
          }
          const all = data.split('\n');
          const tail = all.slice(Math.max(0, all.length - lines)).join('\n');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(tail);
        });
        return;
      }

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

      if (req.method === 'GET' && req.url === '/__ccb_internal__/status') {
        const status = {
          version: CCB_VERSION,
          worker_pid: process.pid,
          uptime_sec: Math.round((Date.now() - proxyStartTime) / 1000),
          log_path: logsDir,
          config_path: configDir,
          active_connections: shellState.activeConnections,
          keepalives: activeKeepalives
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
      }

      if (req.method === 'GET' && req.url === '/__ccb_internal__/session') {
        const history = logger.getHistory();
        const session = {
          ccb_version: CCB_VERSION,
          worker_pid: process.pid,
          uptime_sec: Math.round((Date.now() - proxyStartTime) / 1000),
          claude_session_id: lastClaudeSessionId,
          total_requests: totalRequests,
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          log_path: logsDir,
          active_connections: shellState.activeConnections,
          history: history.map(s => s.toLogLine())
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(session));
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
      shellState = shellState.withConnectionBump(1);

      const { sessionId: urlSessionId, strippedUrl } = extractUrlSession(req.url);
      if (urlSessionId) req.url = strippedUrl;

      const ctx = new ProxyRequestContext({ req, res, id: shellState.reqCount, startTime: Date.now(), urlSessionId });
      res.on('close', () => {
        shellState = shellState.withConnectionBump(-1);
      });

      const socket = req.socket;
      if (socket) {
        const prevCtx = lastCtxPerSocket.get(socket);
        if (prevCtx) prevCtx.markSuperseded();
        lastCtxPerSocket.set(socket, ctx);
      }
      const chunks = [];
      req.on('error', () => { if (!res.headersSent) res.writeHead(400); res.end(); });
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        handleRequestEnd({
          ctx,
          chunks,
          deps: {
            policy: shellState.providers,
            extensions: shellState.extensions,
            openaiProviders: shellState.openaiProviders,
            decompress,
            compress,
            logger,
            errorReporter,
            debugLogger,
            getConfig,
            forwardToUpstream: boundForwardToUpstream,
            buildErrorResponse,
            activeConnections: shellState.activeConnections,
            logsDir,
            sessionMetadata: {
              version: CCB_VERSION,
              worker_pid: process.pid,
              uptime_sec: Math.round((Date.now() - proxyStartTime) / 1000),
              log_path: logsDir,
              config_path: configDir,
              active_connections: shellState.activeConnections,
              keepalives: activeKeepalives
            }
          }
        });
      });
    };
  }

  return {
    initProviders,
    createRequestHandler,
    get providerCount() { return shellState.providers.size; },
    get extensions() { return shellState.extensions; },
    get activeConnections() { return shellState.activeConnections; },
    getConfig,
    emit,
    logsDir,
    port: currentPort,
  };
}

// Per-worker port fallback: try the configured port first, then walk up to
// PORT_FALLBACK_RANGE adjacent ports, then OS-assigned (0). With reusePort,
// multiple workers can bind the same kernel socket — the OS load-balances
// new connections across them, which is the foundation for zero-downtime
// restart without socket-handle sharing across processes.
// reusePort isn't supported on Windows (Node bind throws ENOTSUP). The
// worker falls back to a plain listen in that case; the watchdog then has
// to do a sequential restart instead of a parallel one.
const WORKER_PORT_FALLBACK_RANGE = 10;

function listenOnce(server, opts) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts);
  });
}

async function bindWorkerServer(server, basePort) {
  const candidates = [];
  for (let i = 0; i < WORKER_PORT_FALLBACK_RANGE; i++) candidates.push(basePort + i);
  candidates.push(0);

  let useReusePort = true;
  let reusePortDisabledNote = false;

  for (const port of candidates) {
    try {
      const opts = useReusePort
        ? { port, host: '0.0.0.0', reusePort: true }
        : { port, host: '0.0.0.0' };
      await listenOnce(server, opts);
      return { port: server.address().port, reusePort: useReusePort };
    } catch (err) {
      if (err.code === 'ENOTSUP' && useReusePort) {
        // OS doesn't support SO_REUSEPORT (Windows, older kernels).
        // Retry the SAME port without it. Restart will need to be
        // sequential rather than parallel; watchdog handles that.
        useReusePort = false;
        if (!reusePortDisabledNote) {
          process.stdout.write('[worker] SO_REUSEPORT unsupported on this OS; falling back to single-binder mode\n');
          reusePortDisabledNote = true;
        }
        // Retry the same port immediately — don't skip past basePort.
        try {
          await listenOnce(server, { port, host: '0.0.0.0' });
          return { port: server.address().port, reusePort: false };
        } catch (retryErr) {
          if (retryErr.code !== 'EADDRINUSE') throw retryErr;
          if (port !== basePort) process.stdout.write(`[worker] Port ${port} unavailable, trying next...\n`);
        }
        continue;
      }
      if (err.code !== 'EADDRINUSE') throw err;
      if (port !== basePort) process.stdout.write(`[worker] Port ${port} unavailable, trying next...\n`);
    }
  }
  throw new ReadinessTimeoutException('All candidate ports exhausted');
}

export function runWorkerMode({ configDir, port }) {
  const core = createProxyCore({ configDir, port });
  const config = core.getConfig();
  let drained = false;
  let server = null;
  let drainInterval = null;
  let bindCompleted = false;

  // Workers self-bind with SO_REUSEPORT instead of receiving a TCP handle
  // from the watchdog. The watchdog assigns the target port via the env
  // var CCB_DAEMON_PORT (set when respawning after the first worker has
  // already established the actual bound port). First worker walks the
  // fallback range starting at config.port.
  const basePort = parseInt(process.env.CCB_DAEMON_PORT || String(config.port), 10);

  const startupTimeout = setTimeout(() => {
    if (!bindCompleted) {
      process.stderr.write('[worker] Failed to bind within startup timeout, exiting\n');
      process.exit(1);
    }
  }, config.workerInitTimeoutMs);

  (async () => {
    server = http.createServer(core.createRequestHandler());
    let bindResult;
    try {
      bindResult = await bindWorkerServer(server, basePort);
    } catch (e) {
      process.stderr.write(`[worker] Bind failed: ${e.message}\n`);
      if (process.send) process.send({ type: 'error', message: e.message });
      process.exit(1);
    }
    bindCompleted = true;
    clearTimeout(startupTimeout);
    process.stdout.write(`[worker] Listening on port ${bindResult.port}\n`);

    try {
      await core.initProviders();
      const readyMsg = {
        type: 'ready',
        pid: process.pid,
        port: bindResult.port,
        reusePort: bindResult.reusePort,
        routes: core.providerCount,
        extensions: core.extensions?.size ?? 0
      };
      if (process.send) process.send(readyMsg);
    } catch (e) {
      const errorMsg = { type: 'error', message: e.message };
      if (process.send) process.send(errorMsg);
      process.exit(1);
    }

    server.on('error', (err) => {
      process.stdout.write(`[worker] Server error: ${err.message}\n`);
      process.exit(1);
    });
  })();

  process.on('message', (msg) => {
    if (msg?.type === 'socket') {
      // Legacy handle-handoff path is no longer used. Kept as no-op to
      // tolerate stale watchdogs during a rolling upgrade.
      return;
    }

    if (msg?.type === 'drain' && !drained) {
      drained = true;
      clearTimeout(startupTimeout);
      process.stdout.write('[worker] Drain signal received, stopping new connections\n');

      const config = core.getConfig();
      const timeout = setTimeout(() => {
        clearInterval(drainInterval);
        process.stdout.write('[worker] Drain timeout exceeded, force exiting\n');
        process.exit(0);
      }, msg.timeout || config.drainTimeoutMs);

      const checkDrain = () => {
        if (core.activeConnections <= 0) {
          clearTimeout(timeout);
          clearInterval(drainInterval);
          process.stdout.write('[worker] All in-flight requests completed\n');
          process.exit(0);
        }
      };

      drainInterval = setInterval(checkDrain, config.pollIntervalMs);

      if (server) {
        server.close(() => {
          process.stdout.write('[worker] Server closed to new connections\n');
        });
      }
    }
  });
}
