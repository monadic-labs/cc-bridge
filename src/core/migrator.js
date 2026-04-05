export const DEFAULT_RAW_CONFIG = {
  port: 9099,
  daemon: {
    healthCheckTimeoutMs: 500,
    pollIntervalMs: 300,
    pollMaxAttempts: 10,
  },
  logging: {
    enabled: true,
    requests: true,
    responses: true,
    history: 5,
    maxBodyLog: 10000
  }
};

export const DEFAULT_RAW_PROVIDERS = {
  providers: [
    {
      id: "custom-gateway",
      url: "https://api.example-gateway.internal/v1",
      models: {
        "custom-model": "actual-model-name"
      },
      anthropicCompliant: false
    }
  ]
};

export const DEFAULT_SINGLE_PROVIDER = {
  id: "",
  url: "",
  models: {},
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
  if (!Array.isArray(merged.providers)) {
    merged.providers = JSON.parse(JSON.stringify(DEFAULT_RAW_PROVIDERS.providers));
  }
  
  merged.providers = merged.providers.map(p => {
    const pMerged = JSON.parse(JSON.stringify(p));
    deepMerge(pMerged, DEFAULT_SINGLE_PROVIDER);
    
    // If id is missing or empty, try to derive it from the URL
    if (!pMerged.id && pMerged.url) {
      try {
        const u = new URL(pMerged.url);
        const hostParts = u.hostname.split('.');
        pMerged.id = hostParts[hostParts.length - 2] || hostParts[0] || 'provider';
      } catch {
        pMerged.id = 'provider-' + Math.floor(Math.random() * 1000);
      }
    }
    
    return pMerged;
  });

  return merged;
}
