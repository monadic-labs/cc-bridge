import { detectFormat, convertV1ToV2 } from './config-adapter.js';

export const DEFAULT_RAW_CONFIG = {
  port: 9099,
  anthropicBaseUrl: 'https://api.anthropic.com',
  daemon: {
    healthCheckTimeoutMs: 500,
    pollIntervalMs: 300,
    pollMaxAttempts: 10,
    // 600 000 ms — matches the Claude CLI's own API_TIMEOUT_MS default
    // (xorespesp-leak/src/services/api/client.ts:144).
    // proxyReq.setTimeout is an *inactivity* timer: it resets on every received
    // chunk, so it only fires when the upstream goes completely silent — not
    // during active streaming. This complements the CLI's hard wall-clock
    // deadline rather than replacing it. Set to 0 to disable.
    upstreamTimeoutMs: 600000,
    workerInitTimeoutMs: 20000,
    drainTimeoutMs: 600000,
    workerKeepaliveS: -1,
    ipcTimeoutMs: 5000,
    // Interface the HTTP listener binds to. Loopback by default; setting to
    // '0.0.0.0' is an explicit opt-in to LAN exposure of the proxy and its
    // management endpoints — combine with the auth gate on /api/* before doing so.
    bindHost: '127.0.0.1',
    // Hard ceiling the CLI waits for the worker to start, reach the bound
    // port, finish initProviders, and report 'ready'. Real-world cold starts
    // include filesystem walks + dynamic imports of every extension; 60s
    // leaves room for slow disks, recently-cleared module caches, and
    // long-running per-extension init.
    daemonStartTimeoutMs: 60000,
    // Phase-aware "stuck" detector: if daemon.log goes silent for this long
    // AND the daemon isn't responding, the CLI gives up early instead of
    // waiting out the full ceiling. Each new chunk of log resets the timer.
    daemonStartProgressGraceMs: 15000,
    retry: {
      maxAttempts: 2,
      baseDelayMs: 500,
      maxDelayMs: 5000,
      retryOnStatusCodes: [502, 503, 504],
      retryOnTcpErrors: ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'],
      retryOnBodyPatterns: []
    },
  },
  logging: {
    enabled: true,
    requests: true,
    responses: true,
    history: 5,
    maxBodyLog: 10000,
    level: 'info'
  },
  compression: {
    recompressRequests: true
  }
};

// Every per-provider entry MUST carry `models` and `toolTransforms` so the
// strict ProviderConfig validator (src/core/providers.js) doesn't reject
// the migrator's own seed shape. ensureCompleteProviders also fills these
// per provider so user-written providers.json files with sparse entries
// load without error.
export const DEFAULT_RAW_PROVIDERS = {
  providers: {
    "custom-gateway": {
      url: "https://api.example-gateway.internal/v1",
      anthropicCompliant: false,
      models: {},
      toolTransforms: {}
    }
  },
  routes: {
    models: {},
    properties: {},
    payloadSize: {}
  }
};


function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] instanceof Object && !Array.isArray(source[key])) {
      if (!target[key]) Object.assign(target, { [key]: {} });
      deepMerge(target[key], source[key]);
      continue;
    }
    if (target[key] === undefined) {
      Object.assign(target, { [key]: source[key] });
    }
  }
}

export function ensureCompleteConfig(existingRaw) {
  const merged = JSON.parse(JSON.stringify(existingRaw || {}));

  // Migrate legacy daemon properties
  if (merged.daemon) {
    if (merged.daemon.healthCheckTimeout !== undefined) {
      merged.daemon.healthCheckTimeoutMs = merged.daemon.healthCheckTimeout;
      delete merged.daemon.healthCheckTimeout;
    }
    if (merged.daemon.pollInterval !== undefined) {
      merged.daemon.pollIntervalMs = merged.daemon.pollInterval;
      delete merged.daemon.pollInterval;
    }
  }

  deepMerge(merged, DEFAULT_RAW_CONFIG);
  return merged;
}

export function ensureCompleteProviders(existingRaw) {
  const merged = JSON.parse(JSON.stringify(existingRaw || {}));

  // Detect format and convert v1 → v2 if needed
  const format = detectFormat(merged);
  if (format === 'v1') {
    return convertV1ToV2(merged);
  }

  // v2 format: merge defaults into providers object
  if (!merged.providers || typeof merged.providers !== 'object' || Array.isArray(merged.providers)) {
    merged.providers = JSON.parse(JSON.stringify(DEFAULT_RAW_PROVIDERS.providers));
  }

  // Per-provider: fill mandatory fields the ProviderConfig validator demands.
  // Users frequently write a sparse entry (just url + anthropicCompliant);
  // without these defaults the loader would reject their config at startup.
  for (const id of Object.keys(merged.providers)) {
    const entry = merged.providers[id];
    if (!entry || typeof entry !== 'object') continue;
    if (!entry.models || typeof entry.models !== 'object') entry.models = {};
    if (!entry.toolTransforms || typeof entry.toolTransforms !== 'object') entry.toolTransforms = {};
  }

  // Ensure routes section exists with all sub-sections
  if (!merged.routes) merged.routes = {};
  if (!merged.routes.models) merged.routes.models = {};
  if (!merged.routes.properties) merged.routes.properties = {};
  if (!merged.routes.payloadSize) merged.routes.payloadSize = {};

  return merged;
}
