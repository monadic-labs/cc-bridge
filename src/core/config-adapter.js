import { ArgumentError } from './exceptions.js';

/**
 * Config format adapter — boundary layer between raw JSON and internal objects.
 *
 * Detects config version, parses the new compact format, and converts to the
 * internal shape that ProviderConfig / RoutingPolicy / rule classes consume.
 * Also handles v1 → v2 migration.
 */

/**
 * Split a "provider.model" dot-notation target into provider ID and model name.
 *
 * Splits at the first dot — provider IDs are restricted to [a-z0-9-_]+ (no dots),
 * so this is unambiguous. Model names may contain dots (e.g. "claude-sonnet-4-6").
 *
 * @param {string} dotNotation
 * @returns {{ providerId: string, model: string }}
 */
export function parseTarget(dotNotation) {
  if (typeof dotNotation !== 'string' || !dotNotation) {
    throw new ArgumentError('Target must be a non-empty "provider.model" string', { context: { target: dotNotation } });
  }
  const dotIndex = dotNotation.indexOf('.');
  if (dotIndex === -1) {
    throw new ArgumentError('Target must be in "provider.model" format (missing dot)', { context: { target: dotNotation } });
  }
  return {
    providerId: dotNotation.slice(0, dotIndex),
    model: dotNotation.slice(dotIndex + 1)
  };
}

/**
 * Detect whether raw config is v1 (array providers) or v2 (object providers).
 *
 * @param {object} rawJson
 * @returns {'v1' | 'v2'}
 */
export function detectFormat(rawJson) {
  if (!rawJson || typeof rawJson !== 'object') return 'v1';
  const providers = rawJson.providers;
  if (Array.isArray(providers)) return 'v1';
  if (typeof providers === 'object' && providers !== null) return 'v2';
  return 'v1';
}

/**
 * Parse a routes.models key into match type and value.
 *
 * Plain strings → exact match. Strings containing `*` → wildcard (compiled to regex).
 *
 * @param {string} key
 * @returns {{ type: 'exact', match: string } | { type: 'regex', pattern: string }}
 */
export function parseRouteKey(key) {
  if (typeof key !== 'string' || !key) {
    throw new ArgumentError('Route key must be a non-empty string', { context: { key } });
  }
  if (key.includes('*')) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '.*' : '\\' + ch));
    return { type: 'regex', pattern: escaped };
  }
  return { type: 'exact', match: key };
}

/**
 * Parse a payloadSize key with operator prefix.
 *
 * Supports: ">N", "<N", ">=N", "<=N". Default operator is "gt" for bare numbers.
 *
 * @param {string} key
 * @returns {{ operator: string, thresholdBytes: number }}
 */
export function parsePayloadSizeKey(key) {
  if (typeof key !== 'string' || !key) {
    throw new ArgumentError('payloadSize key must be a non-empty string', { context: { key } });
  }

  const m = key.match(/^([<>]=?)\s*(\d+)$/);
  if (m) return { operator: m[1], thresholdBytes: parseInt(m[2], 10) };

  const bareNum = key.match(/^(\d+)$/);
  if (bareNum) return { operator: 'gt', thresholdBytes: parseInt(bareNum[1], 10) };

  throw new ArgumentError('payloadSize key must be ">N", "<N", ">=N", "<=N", or "N"', { context: { key } });
}

/**
 * Normalize a route value — bare string becomes { target }, object passes through.
 *
 * @param {string|object} value
 * @returns {{ target: string, fallback?: string[] }}
 */
export function normalizeRouteValue(value) {
  if (typeof value === 'string') return { target: value };
  if (value && typeof value === 'object') return value;
  throw new ArgumentError('Route value must be a string or object', { context: { value } });
}

/**
 * Convert a v2 config to the internal shape consumed by ProviderConfig / RoutingPolicy.
 *
 * Returns `{ providers: Array<provider-shape>, routingPolicy: Array<rule-shape> }`
 * which is the same structure tryParseProviders() currently produces.
 *
 * @param {object} v2Json
 * @returns {{ providers: object[], routingPolicy: object[] }}
 */
export function convertV2ToInternal(v2Json) {
  const providersObj = v2Json.providers ?? {};
  const routes = v2Json.routes ?? {};

  // Build provider array from object entries
  const providers = [];
  for (const [id, cfg] of Object.entries(providersObj)) {
    providers.push({
      id,
      url: cfg.url ?? '',
      models: {},
      anthropicCompliant: cfg.anthropicCompliant ?? false,
      apiKey: cfg.apiKey
    });
  }

  const routingPolicy = [];

  // routes.models → exact and regex rules
  const models = routes.models ?? {};
  for (const [key, rawValue] of Object.entries(models)) {
    const value = normalizeRouteValue(rawValue);
    const target = parseTarget(value.target);
    const keyParsed = parseRouteKey(key);

    const rule = {
      type: keyParsed.type,
      targetProvider: target.providerId,
      targetModel: target.model
    };

    if (keyParsed.type === 'exact') {
      rule.match = keyParsed.match;
    } else {
      rule.pattern = keyParsed.pattern;
    }

    if (value.fallback && value.fallback.length > 0) {
      const fb = parseTarget(value.fallback[0]);
      rule.fallback = { providerId: fb.providerId, model: fb.model };
    }

    routingPolicy.push(rule);
  }

  // routes.properties → property rules
  const properties = routes.properties ?? {};
  for (const [prop, rawValue] of Object.entries(properties)) {
    const value = normalizeRouteValue(rawValue);
    const target = parseTarget(value.target);

    const rule = {
      type: 'property',
      property: prop,
      targetProvider: target.providerId,
      targetModel: target.model
    };

    if (value.fallback && value.fallback.length > 0) {
      const fb = parseTarget(value.fallback[0]);
      rule.fallback = { providerId: fb.providerId, model: fb.model };
    }

    routingPolicy.push(rule);
  }

  // routes.payloadSize → payloadSize rules
  const payloadSizes = routes.payloadSize ?? {};
  for (const [key, rawValue] of Object.entries(payloadSizes)) {
    const value = normalizeRouteValue(rawValue);
    const target = parseTarget(value.target);
    const sizeParsed = parsePayloadSizeKey(key);

    const rule = {
      type: 'payloadSize',
      thresholdBytes: sizeParsed.thresholdBytes,
      operator: sizeParsed.operator,
      targetProvider: target.providerId,
      targetModel: target.model
    };

    if (value.fallback && value.fallback.length > 0) {
      const fb = parseTarget(value.fallback[0]);
      rule.fallback = { providerId: fb.providerId, model: fb.model };
    }

    routingPolicy.push(rule);
  }

  return { providers, routingPolicy };
}

/**
 * Convert a v1 config to v2 format.
 *
 * Merges provider-local models maps into routes.models as exact rules,
 * converts routingPolicy rules into the appropriate routes.* sections.
 *
 * @param {object} v1Json
 * @returns {object} v2 config
 */
export function convertV1ToV2(v1Json) {
  const v1Providers = Array.isArray(v1Json.providers) ? v1Json.providers : [];
  const v1Policy = Array.isArray(v1Json.routingPolicy) ? v1Json.routingPolicy : [];

  // Build providers object (strip models, id becomes the key)
  const providers = {};
  for (const p of v1Providers) {
    providers[p.id] = {
      url: p.url,
      anthropicCompliant: p.anthropicCompliant
    };
    if (p.apiKey) providers[p.id].apiKey = p.apiKey;
  }

  const models = {};
  const properties = {};
  const payloadSize = {};

  // Convert models maps from providers into routes.models (exact matches)
  for (const p of v1Providers) {
    if (!p.models || typeof p.models !== 'object') continue;
    for (const [alias, realModel] of Object.entries(p.models)) {
      if (models[alias] !== undefined) continue; // first provider wins
      models[alias] = `${p.id}.${realModel}`;
    }
  }

  // Convert routingPolicy rules
  for (const rule of v1Policy) {
    const targetDot = `${rule.targetProvider}.${rule.targetModel}`;
    const fallback = rule.fallback ? [`${rule.fallback.providerId}.${rule.fallback.model}`] : undefined;
    const value = fallback ? { target: targetDot, fallback } : targetDot;

    if (rule.type === 'exact') {
      models[rule.match] = value;
    } else if (rule.type === 'regex') {
      // Convert regex to wildcard if it's a simple .*pattern.* pattern
      const wildcardKey = regexToWildcard(rule.pattern);
      models[wildcardKey] = value;
    } else if (rule.type === 'property') {
      properties[rule.property] = value;
    } else if (rule.type === 'payloadSize') {
      const op = rule.operator === 'gt' || !rule.operator ? '>' : rule.operator === 'lt' ? '<' : rule.operator;
      const key = `${op}${rule.thresholdBytes}`;
      payloadSize[key] = value;
    }
  }

  return { providers, routes: { models, properties, payloadSize } };
}

/**
 * Convert a simple regex pattern back to wildcard notation.
 *
 * `.*haiku.*` → `*haiku*`, `.*sonnet.*` → `*sonnet*`.
 * Falls back to `*pattern*` wrapping for anything more complex.
 */
function regexToWildcard(pattern) {
  const m = pattern.match(/^\.\*([^*]+)\.\*$/);
  if (m) return `*${m[1]}*`;
  // Complex regex — wrap in stars as best-effort
  return `*${pattern.replace(/\.\*/g, '*')}*`;
}
