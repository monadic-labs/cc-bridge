import { ArgumentError } from './exceptions.js';
import { ProviderConfig, ProviderMatch } from './providers.js';
import { Option } from './types.js';

const VALID_OPERATORS = Object.freeze(['gt', 'lt', 'gte', 'lte']);
const VALID_RULE_TYPES = Object.freeze(['exact', 'regex', 'property', 'payloadSize']);

function requireString(value, fieldName) {
  if (typeof value !== 'string' || !value) {
    throw new ArgumentError(`${fieldName} must be a non-empty string`, { context: { [fieldName]: value } });
  }
}

function requirePositiveInt(value, fieldName) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ArgumentError(`${fieldName} must be a positive integer`, { context: { [fieldName]: value } });
  }
}

function validateFallback(fallback) {
  if (fallback === undefined || fallback === null) return { providerId: null, model: null };
  if (typeof fallback !== 'object') {
    throw new ArgumentError('fallback must be an object with providerId and model', { context: { fallback } });
  }
  if (typeof fallback.providerId !== 'string' || !fallback.providerId) {
    throw new ArgumentError('fallback.providerId must be a non-empty string', { context: { providerId: fallback.providerId } });
  }
  if (typeof fallback.model !== 'string' || !fallback.model) {
    throw new ArgumentError('fallback.model must be a non-empty string', { context: { model: fallback.model } });
  }
  return { providerId: fallback.providerId, model: fallback.model };
}

export const MAX_FALLBACK_DEPTH = 3;

export class ExactRule {
  #match;
  #targetProviderId;
  #targetModel;
  #fallbackProviderId;
  #fallbackModel;

  constructor({ match, targetProvider, targetModel, fallback }) {
    requireString(match, 'ExactRule.match');
    requireString(targetProvider, 'ExactRule.targetProvider');
    requireString(targetModel, 'ExactRule.targetModel');
    this.#match = match;
    this.#targetProviderId = targetProvider;
    this.#targetModel = targetModel;
    const fb = validateFallback(fallback);
    this.#fallbackProviderId = fb.providerId;
    this.#fallbackModel = fb.model;
    Object.freeze(this);
  }

  get type() { return 'exact'; }
  get match() { return this.#match; }
  get targetProviderId() { return this.#targetProviderId; }
  get targetModel() { return this.#targetModel; }
  get fallbackProviderId() { return this.#fallbackProviderId; }
  get fallbackModel() { return this.#fallbackModel; }
  get hasFallback() { return this.#fallbackProviderId !== null; }

  matches(body) {
    return typeof body.model === 'string' && body.model === this.#match;
  }

  toLabel() { return `exact:${this.#match}`; }

  toJSON() {
    const json = { type: 'exact', match: this.#match, targetProvider: this.#targetProviderId, targetModel: this.#targetModel };
    if (this.#fallbackProviderId) json.fallback = { providerId: this.#fallbackProviderId, model: this.#fallbackModel };
    return json;
  }
}

export class RegexRule {
  #pattern;
  #compiled;
  #targetProviderId;
  #targetModel;
  #fallbackProviderId;
  #fallbackModel;

  constructor({ pattern, targetProvider, targetModel, fallback }) {
    requireString(pattern, 'RegexRule.pattern');
    requireString(targetProvider, 'RegexRule.targetProvider');
    requireString(targetModel, 'RegexRule.targetModel');
    try {
      this.#compiled = new RegExp(pattern);
    } catch (e) {
      throw new ArgumentError(`RegexRule.pattern is not a valid regex: ${e.message}`, { context: { pattern } });
    }
    this.#pattern = pattern;
    this.#targetProviderId = targetProvider;
    this.#targetModel = targetModel;
    const fb = validateFallback(fallback);
    this.#fallbackProviderId = fb.providerId;
    this.#fallbackModel = fb.model;
    Object.freeze(this);
  }

  get type() { return 'regex'; }
  get pattern() { return this.#pattern; }
  get targetProviderId() { return this.#targetProviderId; }
  get targetModel() { return this.#targetModel; }
  get fallbackProviderId() { return this.#fallbackProviderId; }
  get fallbackModel() { return this.#fallbackModel; }
  get hasFallback() { return this.#fallbackProviderId !== null; }

  matches(body) {
    return typeof body.model === 'string' && this.#compiled.test(body.model);
  }

  toLabel() { return `regex:/${this.#pattern}/`; }

  toJSON() {
    const json = { type: 'regex', pattern: this.#pattern, targetProvider: this.#targetProviderId, targetModel: this.#targetModel };
    if (this.#fallbackProviderId) json.fallback = { providerId: this.#fallbackProviderId, model: this.#fallbackModel };
    return json;
  }
}

export class PropertyRule {
  #property;
  #targetProviderId;
  #targetModel;
  #fallbackProviderId;
  #fallbackModel;

  constructor({ property, targetProvider, targetModel, fallback }) {
    requireString(property, 'PropertyRule.property');
    requireString(targetProvider, 'PropertyRule.targetProvider');
    requireString(targetModel, 'PropertyRule.targetModel');
    this.#property = property;
    this.#targetProviderId = targetProvider;
    this.#targetModel = targetModel;
    const fb = validateFallback(fallback);
    this.#fallbackProviderId = fb.providerId;
    this.#fallbackModel = fb.model;
    Object.freeze(this);
  }

  get type() { return 'property'; }
  get property() { return this.#property; }
  get targetProviderId() { return this.#targetProviderId; }
  get targetModel() { return this.#targetModel; }
  get fallbackProviderId() { return this.#fallbackProviderId; }
  get fallbackModel() { return this.#fallbackModel; }
  get hasFallback() { return this.#fallbackProviderId !== null; }

  matches(body) {
    return body[this.#property] !== undefined;
  }

  toLabel() { return `property:${this.#property}`; }

  toJSON() {
    const json = { type: 'property', property: this.#property, targetProvider: this.#targetProviderId, targetModel: this.#targetModel };
    if (this.#fallbackProviderId) json.fallback = { providerId: this.#fallbackProviderId, model: this.#fallbackModel };
    return json;
  }
}

export class PayloadSizeRule {
  #thresholdBytes;
  #operator;
  #targetProviderId;
  #targetModel;
  #fallbackProviderId;
  #fallbackModel;

  constructor({ thresholdBytes, operator, targetProvider, targetModel, fallback }) {
    requirePositiveInt(thresholdBytes, 'PayloadSizeRule.thresholdBytes');
    requireString(targetProvider, 'PayloadSizeRule.targetProvider');
    requireString(targetModel, 'PayloadSizeRule.targetModel');
    const op = operator || 'gt';
    if (!VALID_OPERATORS.includes(op)) {
      throw new ArgumentError(`PayloadSizeRule.operator must be one of ${VALID_OPERATORS.join(', ')}`, { context: { operator: op } });
    }
    this.#thresholdBytes = thresholdBytes;
    this.#operator = op;
    this.#targetProviderId = targetProvider;
    this.#targetModel = targetModel;
    const fb = validateFallback(fallback);
    this.#fallbackProviderId = fb.providerId;
    this.#fallbackModel = fb.model;
    Object.freeze(this);
  }

  get type() { return 'payloadSize'; }
  get thresholdBytes() { return this.#thresholdBytes; }
  get operator() { return this.#operator; }
  get targetProviderId() { return this.#targetProviderId; }
  get targetModel() { return this.#targetModel; }
  get fallbackProviderId() { return this.#fallbackProviderId; }
  get fallbackModel() { return this.#fallbackModel; }
  get hasFallback() { return this.#fallbackProviderId !== null; }

  matches(body) {
    const messages = body.messages;
    const size = Array.isArray(messages) ? JSON.stringify(messages).length : 0;
    if (this.#operator === 'gt') return size > this.#thresholdBytes;
    if (this.#operator === 'lt') return size < this.#thresholdBytes;
    if (this.#operator === 'gte') return size >= this.#thresholdBytes;
    return size <= this.#thresholdBytes; // lte
  }

  toLabel() { return `payloadSize:${this.#operator}${this.#thresholdBytes}`; }

  toJSON() {
    const json = { type: 'payloadSize', thresholdBytes: this.#thresholdBytes, targetProvider: this.#targetProviderId, targetModel: this.#targetModel };
    if (this.#operator !== 'gt') json.operator = this.#operator;
    if (this.#fallbackProviderId) json.fallback = { providerId: this.#fallbackProviderId, model: this.#fallbackModel };
    return json;
  }
}

export function createRule(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ArgumentError('Rule definition must be an object', { context: { raw } });
  }
  const { type, targetProvider, targetModel } = raw;

  if (!VALID_RULE_TYPES.includes(type)) {
    throw new ArgumentError(`Rule type must be one of ${VALID_RULE_TYPES.join(', ')}`, { context: { type } });
  }

  if (type === 'exact') return new ExactRule({ match: raw.match, targetProvider, targetModel, fallback: raw.fallback });
  if (type === 'regex') return new RegexRule({ pattern: raw.pattern, targetProvider, targetModel, fallback: raw.fallback });
  if (type === 'property') return new PropertyRule({ property: raw.property, targetProvider, targetModel, fallback: raw.fallback });
  return new PayloadSizeRule({ thresholdBytes: raw.thresholdBytes, operator: raw.operator, targetProvider, targetModel, fallback: raw.fallback });
}

export class RoutingPolicy {
  #rules;
  #providerMap;
  #legacyMap;

  constructor({ rules, providerConfigs, legacyProvidersMap }) {
    if (!Array.isArray(rules)) {
      throw new ArgumentError('RoutingPolicy.rules must be an array', { context: { rules } });
    }

    const providerMap = new Map();
    for (const config of providerConfigs) {
      if (!(config instanceof ProviderConfig)) {
        throw new ArgumentError('RoutingPolicy.providerConfigs must contain ProviderConfig instances', { context: { config } });
      }
      if (config.id) providerMap.set(config.id, config);
    }

    // Validate every rule's targetProviderId references an existing provider
    const exactMatches = new Set();
    for (const rule of rules) {
      const pid = rule.targetProviderId;
      if (pid && !providerMap.has(pid)) {
        throw new ArgumentError(`Rule ${rule.toLabel()} references unknown provider "${pid}"`, { context: { rule: rule.toJSON() } });
      }
      if (rule.hasFallback && !providerMap.has(rule.fallbackProviderId)) {
        throw new ArgumentError(`Rule ${rule.toLabel()} fallback references unknown provider "${rule.fallbackProviderId}"`, { context: { rule: rule.toJSON() } });
      }
      if (rule.type === 'exact') {
        if (exactMatches.has(rule.match)) {
          throw new ArgumentError(`Duplicate exact match: "${rule.match}"`, { context: { match: rule.match } });
        }
        exactMatches.add(rule.match);
      }
    }

    this.#rules = Object.freeze([...rules]);
    this.#providerMap = Object.freeze(providerMap);
    this.#legacyMap = legacyProvidersMap ?? null;
    Object.freeze(this);
  }

  evaluate(body) {
    for (const rule of this.#rules) {
      if (rule.matches(body)) {
        const provider = this.#providerMap.get(rule.targetProviderId);
        if (provider) return Option.some(new ProviderMatch(provider, rule.toLabel(), rule.targetModel));
      }
    }

    if (this.#legacyMap) {
      const legacyMatch = this.#legacyMap.resolve(body.model);
      if (legacyMatch) return Option.some(legacyMatch);
    }

    return Option.none();
  }

  /**
   * Evaluate the policy and return both the match and the matched rule.
   *
   * Needed by the fallback handler to know which rule's fallback to use.
   * Legacy matches (from the models map) return a null rule (no fallback possible).
   *
   * @param {object} body - Request body to evaluate
   * @returns {Option<{ match: ProviderMatch, rule: object|null }>}
   */
  evaluateWithRule(body) {
    for (const rule of this.#rules) {
      if (rule.matches(body)) {
        const provider = this.#providerMap.get(rule.targetProviderId);
        if (provider) return Option.some({ match: new ProviderMatch(provider, rule.toLabel(), rule.targetModel), rule });
      }
    }

    if (this.#legacyMap) {
      const legacyMatch = this.#legacyMap.resolve(body.model);
      if (legacyMatch) return Option.some({ match: legacyMatch, rule: null });
    }

    return Option.none();
  }

  /**
   * Look up a provider by ID.
   *
   * Returns Option.some(ProviderConfig) if found, Option.none() otherwise.
   * Used by the fallback handler to resolve fallback provider references.
   */
  getProvider(providerId) {
    const provider = this.#providerMap.get(providerId);
    return provider ? Option.some(provider) : Option.none();
  }

  get rules() { return [...this.#rules]; }
  get size() { return this.#rules.length; }

  get allTargetModels() {
    const models = new Set();
    for (const rule of this.#rules) {
      models.add(rule.targetModel);
    }
    if (this.#legacyMap) {
      for (const alias of this.#legacyMap.allAliases) {
        models.add(alias);
      }
    }
    return [...models];
  }
}

export function buildRoutingPolicy({ rawPolicy, providerConfigs, legacyProvidersMap }) {
  const rules = (rawPolicy ?? []).map((raw) => createRule(raw));
  return new RoutingPolicy({ rules, providerConfigs, legacyProvidersMap });
}
