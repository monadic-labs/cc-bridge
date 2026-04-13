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

export const DEFAULT_RAW_PROVIDERS = {
  providers: {
    "custom-gateway": {
      url: "https://api.example-gateway.internal/v1",
      anthropicCompliant: false
    }
  },
  routes: {
    models: {},
    properties: {},
    payloadSize: {}
  }
};

const DEFAULT_PROVIDER_ENTRY = {
  url: "",
  anthropicCompliant: false
};

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] instanceof Object && !Array.isArray(source[key])) {
      if (!target[key]) Object.assign(target, { [key]: {} });
      deepMerge(target[key], source[key]);
    } else {
      if (target[key] === undefined) {
        Object.assign(target, { [key]: source[key] });
      }
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
  } else {
    for (const [id, cfg] of Object.entries(merged.providers)) {
      deepMerge(cfg, DEFAULT_PROVIDER_ENTRY);
    }
  }

  // Ensure routes section exists with all sub-sections
  if (!merged.routes) merged.routes = {};
  if (!merged.routes.models) merged.routes.models = {};
  if (!merged.routes.properties) merged.routes.properties = {};
  if (!merged.routes.payloadSize) merged.routes.payloadSize = {};

  return merged;
}
