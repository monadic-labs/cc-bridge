import { Result } from './types.js';
import { ArgumentError } from './exceptions.js';
import { parseTarget } from './config-adapter.js';

/**
 * Find a provider key in an object-keyed providers map.
 *
 * Searches by key name first, then by URL substring match.
 *
 * @param {object} providers - Object-keyed providers map
 * @param {string} identifier - Provider ID or URL substring
 * @returns {string|null} Provider key or null
 */
export function findProviderKey(providers, identifier) {
  if (typeof identifier !== 'string' || !identifier) return null;
  if (typeof providers !== 'object' || !providers) return null;

  // Direct key match
  if (providers[identifier]) return identifier;

  // URL substring match
  for (const [key, cfg] of Object.entries(providers)) {
    if (cfg.url && typeof cfg.url === 'string' && cfg.url.includes(identifier)) {
      return key;
    }
  }
  return null;
}

/**
 * Add a route entry to routes.models.
 *
 * @param {object} config - Full v2 config object
 * @param {string} name - Route key (model name or wildcard pattern)
 * @param {string} targetDot - Target in "provider.model" notation
 * @param {string[]} [fallback] - Optional fallback targets
 * @returns {Result<object>} Updated config
 */
export function addRouteModel(config, name, targetDot, fallback) {
  const updated = JSON.parse(JSON.stringify(config));
  if (!updated.routes) updated.routes = { models: {}, properties: {}, payloadSize: {} };
  if (!updated.routes.models) updated.routes.models = {};

  if (updated.routes.models[name] !== undefined) {
    return Result.fail(new ArgumentError(`Route "${name}" already exists`));
  }

  parseTarget(targetDot); // validate format

  if (fallback && fallback.length > 0) {
    for (const fb of fallback) parseTarget(fb);
    updated.routes.models[name] = { target: targetDot, fallback };
  } else {
    updated.routes.models[name] = targetDot;
  }

  return Result.ok(updated);
}

/**
 * Remove a route entry from routes.models.
 *
 * @param {object} config - Full v2 config object
 * @param {string} name - Route key to remove
 * @returns {Result<object>} Updated config
 */
export function removeRouteModel(config, name) {
  const updated = JSON.parse(JSON.stringify(config));
  if (!updated.routes?.models || updated.routes.models[name] === undefined) {
    return Result.fail(new ArgumentError(`Route "${name}" not found`));
  }

  delete updated.routes.models[name];
  return Result.ok(updated);
}

/**
 * Add a provider to the object-keyed providers map.
 *
 * @param {object} providers - Object-keyed providers map
 * @param {string} id - Provider ID
 * @param {string} url - Provider URL
 * @param {boolean} [compliant=true] - Whether provider is Anthropic-compliant
 * @returns {Result<object>} Updated providers map
 */
export function addProvider(providers, id, url, compliant = true) {
  const updated = { ...providers };
  if (updated[id]) {
    return Result.fail(new ArgumentError(`Provider ID "${id}" already exists`));
  }
  for (const [key, cfg] of Object.entries(updated)) {
    if (cfg.url === url) {
      return Result.fail(new ArgumentError(`Provider URL "${url}" already exists (provider "${key}")`));
    }
  }

  updated[id] = { url, anthropicCompliant: compliant };
  return Result.ok(updated);
}

/**
 * Remove a provider from the object-keyed providers map.
 *
 * @param {object} providers - Object-keyed providers map
 * @param {string} id - Provider ID to remove
 * @returns {Result<object>} Updated providers map
 */
export function removeProvider(providers, id) {
  const key = findProviderKey(providers, id);
  if (key === null) {
    return Result.fail(new ArgumentError(`No provider matching "${id}"`));
  }

  const updated = { ...providers };
  delete updated[key];
  return Result.ok(updated);
}

/**
 * List models for a specific provider (derived from routes).
 *
 * @param {object} config - Full v2 config object
 * @param {string} providerId - Provider identifier
 * @returns {Result<{url: string, compliant: boolean, models: [string, string][]}>}
 */
export function listModels(config, providerId) {
  const key = findProviderKey(config.providers, providerId);
  if (key === null) return Result.fail(new ArgumentError(`No provider matching "${providerId}"`));

  const provider = config.providers[key];
  const models = [];

  // Find all routes targeting this provider
  if (config.routes?.models) {
    for (const [routeName, rawValue] of Object.entries(config.routes.models)) {
      const value = typeof rawValue === 'string' ? { target: rawValue } : rawValue;
      try {
        const target = parseTarget(value.target);
        if (target.providerId === key) {
          models.push([routeName, target.model]);
        }
      } catch { /* skip malformed routes */ }
    }
  }

  return Result.ok({ url: provider.url, compliant: provider.anthropicCompliant, models });
}

/**
 * List all providers with summary info.
 *
 * @param {object} providers - Object-keyed providers map
 * @returns {Array<{id: string, url: string, compliant: boolean}>}
 */
export function listProviders(providers) {
  return Object.entries(providers).map(([id, cfg]) => ({
    id,
    url: cfg.url,
    compliant: cfg.anthropicCompliant
  }));
}

/**
 * Format a tree view of providers and their routes.
 *
 * @param {object} config - Full v2 config object
 * @returns {string}
 */
export function formatTree(config) {
  const lines = [];
  const providers = config.providers ?? {};

  // Build reverse map: provider → routes targeting it
  const providerRoutes = {};
  for (const key of Object.keys(providers)) providerRoutes[key] = [];

  if (config.routes?.models) {
    for (const [routeName, rawValue] of Object.entries(config.routes.models)) {
      const value = typeof rawValue === 'string' ? { target: rawValue } : rawValue;
      try {
        const target = parseTarget(value.target);
        if (providerRoutes[target.providerId]) {
          const fb = value.fallback ? ` [fallback: ${value.fallback.join(', ')}]` : '';
          const label = routeName === target.model ? routeName : `${routeName} → ${target.model}${fb}`;
          providerRoutes[target.providerId].push(label);
        }
      } catch { /* skip */ }
    }
  }

  const entries = Object.entries(providers);
  for (let i = 0; i < entries.length; i++) {
    const [id, cfg] = entries[i];
    const tag = cfg.anthropicCompliant ? 'compliant' : 'non-compliant';
    lines.push(`${id}: ${cfg.url} (${tag})`);

    const routes = providerRoutes[id] ?? [];
    for (let j = 0; j < routes.length; j++) {
      const branch = j === routes.length - 1 ? '└──' : '├──';
      lines.push(`${branch} ${routes[j]}`);
    }

    if (i < entries.length - 1) lines.push('');
  }

  return lines.join('\n');
}
