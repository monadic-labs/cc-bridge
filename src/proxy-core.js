import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath, URL } from 'url';
import {
  CCB_VERSION,
  LOGS_DIR_NAME,
  PROVIDERS_FILENAME,
  CONFIG_FILENAME,
  ENV_FILENAME
} from './core/constants.js';
import { loadConfigFromFile, ProxyConfig, DAEMON_CONFIG_SCHEMA } from './core/config.js';
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
import { resolveGuiPath } from './core/gui-path.js';
import { redactProviderApiKeys, hasLiteralApiKey } from './core/api-secrets.js';
import {
  AuthSecret,
  isLoopbackAddress,
  isAuthorizedRequest,
  buildSetCookieHeader
} from './core/auth-gate.js';
import { ConfigCache } from './core/config-cache.js';
export { runKill };
export { loadEnv, ProxyState, SessionMetrics, KeepaliveState };

// Lifetime metrics for the worker. Immutable; one slot in the orchestrator
// closure swaps to the next instance on each request via withSessionUpdate.
// sessionId is sticky: a token-only update preserves the previous value so
// /__ccb_internal__/session can show the most recent Claude session id even
// when an in-flight request hasn't carried a session header.
class SessionMetrics {
  #totalRequests;
  #totalInputTokens;
  #totalOutputTokens;
  #lastClaudeSessionId;

  constructor(totalRequests = 0, totalInputTokens = 0, totalOutputTokens = 0, lastClaudeSessionId = '') {
    this.#totalRequests = totalRequests;
    this.#totalInputTokens = totalInputTokens;
    this.#totalOutputTokens = totalOutputTokens;
    this.#lastClaudeSessionId = lastClaudeSessionId;
    Object.freeze(this);
  }

  get totalRequests() { return this.#totalRequests; }
  get totalInputTokens() { return this.#totalInputTokens; }
  get totalOutputTokens() { return this.#totalOutputTokens; }
  get lastClaudeSessionId() { return this.#lastClaudeSessionId; }

  withSessionUpdate(update) {
    if (!update || typeof update !== 'object') {
      throw new ArgumentError('SessionMetrics.withSessionUpdate: update must be an object');
    }
    const { sessionId, inputTokens, outputTokens } = update;
    if (typeof sessionId !== 'string') {
      throw new ArgumentError('SessionMetrics.withSessionUpdate: sessionId must be a string (empty string preserves prior id)');
    }
    if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens < 0) {
      throw new ArgumentError('SessionMetrics.withSessionUpdate: inputTokens must be a non-negative finite number');
    }
    if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens < 0) {
      throw new ArgumentError('SessionMetrics.withSessionUpdate: outputTokens must be a non-negative finite number');
    }
    const nextSessionId = sessionId.length > 0 ? sessionId : this.#lastClaudeSessionId;
    return new SessionMetrics(
      this.#totalRequests + 1,
      this.#totalInputTokens + inputTokens,
      this.#totalOutputTokens + outputTokens,
      nextSessionId
    );
  }
}

// Keepalive lifecycle. Two fields, one concept (the keepalive connection's
// presence over time). hasReceivedKeepalive is a sticky one-way flip:
// distinguishes "CLI never connected" from "CLI was here and all closed",
// which is the trigger for graceful daemon exit.
class KeepaliveState {
  #activeKeepalives;
  #hasReceivedKeepalive;

  constructor(activeKeepalives = 0, hasReceivedKeepalive = false) {
    this.#activeKeepalives = activeKeepalives;
    this.#hasReceivedKeepalive = hasReceivedKeepalive;
    Object.freeze(this);
  }

  get activeKeepalives() { return this.#activeKeepalives; }
  get hasReceivedKeepalive() { return this.#hasReceivedKeepalive; }
  get shouldShutDown() { return this.#hasReceivedKeepalive && this.#activeKeepalives === 0; }

  withConnect() {
    return new KeepaliveState(this.#activeKeepalives + 1, true);
  }

  withDisconnect() {
    if (this.#activeKeepalives <= 0) {
      throw new ArgumentError(`KeepaliveState.withDisconnect: cannot decrement below zero (current: ${this.#activeKeepalives})`);
    }
    return new KeepaliveState(this.#activeKeepalives - 1, this.#hasReceivedKeepalive);
  }
}

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
  let keepaliveState = new KeepaliveState();
  let sessionMetrics = new SessionMetrics();
  const proxyStartTime = Date.now();

  // Always generate a secret. CCB_KEEPALIVE_SECRET overrides for watchdog-coordinated
  // restarts (so child workers share the same secret across rolling reload); otherwise
  // we mint a fresh 32-byte hex value on every worker start. The same secret gates
  // every admin endpoint and is what the CLI sends as Authorization: Bearer.
  const keepaliveSecret = process.env.CCB_KEEPALIVE_SECRET || crypto.randomBytes(32).toString('hex');
  const authSecret = new AuthSecret(keepaliveSecret);
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'proxy.secret'), keepaliveSecret, 'utf8');
    if (process.platform !== 'win32') {
      try { fs.chmodSync(path.join(logsDir, 'proxy.secret'), 0o600); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }

  // Eager initial load — fail loud at startup on a bad config. Subsequent
  // hot-reloads via fs.watch are best-effort: a malformed user edit logs
  // via errorReporter but doesn't disturb the running daemon's snapshot.
  // Eliminates the per-request sync FS read previously paid 4-6 times per
  // request across proxy-request, proxy-response, and proxy-upstream.
  const configCache = (() => {
    try {
      return new ConfigCache(() => loadConfigFromFile(configDir));
    } catch (e) {
      errorReporter.write(e, { operation: 'parsing config.json' });
      throw e;
    }
  })();

  function getConfig() { return configCache.get(); }

  try {
    const configPath = path.join(configDir, CONFIG_FILENAME);
    fs.watch(configPath, () => {
      const refreshResult = configCache.tryRefresh();
      if (!refreshResult.isSuccess) {
        errorReporter.write(refreshResult.error, { operation: 'config hot-reload' });
      }
    });
  } catch (e) {
    errorReporter.write(e, { operation: 'setting up config.json watcher' });
  }

  const currentPort = port ?? getConfig().port;

  async function emit(msg, sessionId) {
    await logger.emit(msg, sessionId);
  }

  function recordSessionUpdate({ sessionId, inputTokens, outputTokens }) {
    sessionMetrics = sessionMetrics.withSessionUpdate({
      sessionId: sessionId ?? '',
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0
    });
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

  const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
  const BUILTIN_EXTENSIONS_DIR = path.join(MODULE_DIR, 'extensions');
  const GUI_DIR = path.join(MODULE_DIR, 'infra', 'gui');

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

  async function loadAndApplyProviders(data, { throwOnFailure = false } = {}) {
    if (reloadInProgress) return;
    reloadInProgress = true;
    try {
      const parsed = tryParseProviders(data);
      if (!parsed.isSuccess) {
        process.stderr.write(`[providers] Parse failed: ${parsed.error.message}\n`);
        errorReporter.write(parsed.error, { operation: 'parsing providers.json' });
        if (throwOnFailure) throw parsed.error;
        return;
      }

      const { policy, providerConfigs, extensionConfigs } = parsed.value;
      const extensions = await rebuildExtensions(providerConfigs, extensionConfigs);
      shellState = shellState.withProviders(policy, extensions, extensionConfigs);
      process.stdout.write(`[providers] Loaded: ${shellState.providers.size} rule(s), ${shellState.providers.allTargetModels.length} model(s), ${shellState.extensions.size} extension(s)\n`);
    } catch (e) {
      errorReporter.write(e, { operation: 'loading providers and extensions' });
      if (throwOnFailure) throw e;
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
    if (!fs.existsSync(providersPath)) {
      throw new ConfigError(`providers.json missing at ${providersPath}. Run 'ccb --x-init' to seed it.`, { context: { providersPath } });
    }
    const data = fs.readFileSync(providersPath, 'utf8');
    const loadPromise = loadAndApplyProviders(data, { throwOnFailure: true });

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

  // URLs that require BOTH loopback + auth (admin surface). The GUI is a
  // separate, loopback-only-but-not-auth-gated bootstrap path so the browser
  // can receive its Set-Cookie before issuing /api/* fetches.
  function urlClassification(rawUrl) {
    const urlPath = rawUrl.split('?')[0].split('#')[0];
    if (urlPath.startsWith('/gui')) return 'gui';
    if (urlPath.startsWith('/api/')) return 'admin_authed';
    if (urlPath === '/__ccb_internal__/status') return 'admin_authed';
    if (urlPath === '/__ccb_internal__/session') return 'admin_authed';
    // Keepalive uses its own x-ccb-keepalive-secret header (kept for backwards
    // compatibility with the existing CLI client) but is still loopback-only.
    if (urlPath === '/__ccb_internal__/keepalive') return 'admin_loopback';
    return 'public';
  }

  function rejectNonLoopback(res) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'auth_error', code: 'non_loopback_admin', message: 'Admin endpoints accept loopback connections only. The proxy service (model routing) is on the LAN per bindHost; admin remains workstation-only.' } }));
  }

  function rejectUnauthorized(res, authError) {
    res.writeHead(authError.httpStatus, { 'content-type': 'application/json' });
    res.end(authError.toResponsePayload());
  }

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

      // ── Admin gate ── (runs before all admin handlers; service endpoints pass through)
      const classification = urlClassification(req.url);
      if (classification === 'gui' || classification === 'admin_authed' || classification === 'admin_loopback') {
        if (!isLoopbackAddress(req.socket?.remoteAddress)) {
          rejectNonLoopback(res);
          return;
        }
      }
      if (classification === 'admin_authed') {
        const authResult = isAuthorizedRequest(req, authSecret);
        if (!authResult.isSuccess) {
          rejectUnauthorized(res, authResult.error);
          return;
        }
      }

      // ── GUI Static Files ──
      if (req.method === 'GET' && req.url.startsWith('/gui')) {
        const filePath = resolveGuiPath(GUI_DIR, req.url);
        if (filePath === null) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          const ext = path.extname(filePath);
          const contentType = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : 'text/plain';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Set-Cookie': buildSetCookieHeader(authSecret)
          });
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
            payload = JSON.stringify(redactProviderApiKeys(normalized));
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

      if (req.method === 'GET' && req.url === '/api/daemon-config-schema') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(DAEMON_CONFIG_SCHEMA));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/config') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400);
            res.end('Invalid JSON');
            return;
          }
          if (hasLiteralApiKey(parsed)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'literal_api_key_refused', message: 'Refusing to persist a literal apiKey. Use "ENV:<VAR_NAME>" to reference an env var, or set the key via `ccb --x-key set <provider>` and omit apiKey from the config.' } }));
            return;
          }
          fs.writeFileSync(providersPath, body, 'utf8');
          res.writeHead(200);
          res.end('OK');
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
        if (!process.send || process.connected === false) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('Restart is only available when running under the watchdog.');
          return;
        }
        // Guard the IPC send. If the control channel is closing — e.g. a restart
        // arrives while a previous restart is still draining this worker — an
        // unguarded process.send throws ERR_IPC_CHANNEL_CLOSED that surfaces as
        // an unhandled 'error' event and crashes the worker, after which the
        // watchdog cannot rebind its control socket (EADDRINUSE) and the daemon
        // stays down. Passing a callback makes Node report the async failure to
        // the callback instead of emitting 'error'; the try/catch absorbs a
        // synchronous throw when the channel is already closed.
        try {
          process.send({ type: 'restart-request' }, () => {});
        } catch {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('Restart could not be dispatched: the worker is shutting down.');
          return;
        }
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
        keepaliveState = keepaliveState.withConnect();

        const cleanup = () => {
          keepaliveState = keepaliveState.withDisconnect();
          if (keepaliveState.shouldShutDown) {
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
          keepalives: keepaliveState.activeKeepalives
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
          claude_session_id: sessionMetrics.lastClaudeSessionId,
          total_requests: sessionMetrics.totalRequests,
          total_input_tokens: sessionMetrics.totalInputTokens,
          total_output_tokens: sessionMetrics.totalOutputTokens,
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
              keepalives: keepaliveState.activeKeepalives
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

async function bindWorkerServer(server, basePort, bindHost) {
  const candidates = [];
  for (let i = 0; i < WORKER_PORT_FALLBACK_RANGE; i++) candidates.push(basePort + i);
  candidates.push(0);

  let useReusePort = true;
  let reusePortDisabledNote = false;

  for (const port of candidates) {
    try {
      const opts = useReusePort
        ? { port, host: bindHost, reusePort: true }
        : { port, host: bindHost };
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
          await listenOnce(server, { port, host: bindHost });
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

  // Last-resort fault isolation. Per-request faults are caught at the request
  // boundary (proxy-upstream: finalizeUpstreamFailure + the upstream-handler
  // guard), so this backstop should never fire in normal operation. It exists
  // for an UNKNOWN escape only. Per industry + manifesto consensus we do NOT
  // swallow-and-continue (a process past an uncaught fault is in undefined
  // state and leaks sockets/FDs): log the fault clearly for diagnosis, then
  // exit so the watchdog respawns a clean worker. Re-entrancy-guarded so the
  // exit path cannot loop. (Node already crashes on uncaught faults by default;
  // this wraps that in a single, diagnosable, controlled exit — which is also
  // why it has no behaviour test: the boundary makes it unreachable through the
  // real request interface.)
  let crashingDown = false;
  const exitForRespawn = (kind, error) => {
    if (crashingDown) return;
    crashingDown = true;
    const detail = error?.stack ?? error?.message ?? String(error);
    process.stderr.write(`[worker] FATAL ${kind} — exiting for watchdog respawn:\n${detail}\n`);
    process.exit(1);
  };
  process.on('uncaughtException', (error) => exitForRespawn('uncaughtException', error));
  process.on('unhandledRejection', (reason) => exitForRespawn('unhandledRejection', reason));

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
      bindResult = await bindWorkerServer(server, basePort, config.bindHost);
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
