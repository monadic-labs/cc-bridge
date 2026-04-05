import { ArgumentError } from './exceptions.js';

export function normalizeModelsToObject(models) {
  if (Array.isArray(models)) {
    return Object.freeze(Object.fromEntries(models.map((m) => [m, m])));
  }
  return Object.freeze({ ...models });
}

export class ProviderConfig {
  #id;
  #url;
  #models;
  #anthropicCompliant;

  constructor({ id, url, models, anthropicCompliant }) {
    if (id !== undefined && typeof id !== 'string') {
      throw new ArgumentError('ProviderConfig.id must be a string', { context: { id: typeof id } });
    }
    if (!url || typeof url !== 'string') {
      throw new ArgumentError('ProviderConfig.url is required', { context: { url } });
    }
    if (anthropicCompliant === undefined) {
      throw new ArgumentError('ProviderConfig.anthropicCompliant must be explicitly true or false', { context: { url } });
    }
    this.#id = id ?? '';
    this.#url = url;
    this.#models = normalizeModelsToObject(models);
    this.#anthropicCompliant = anthropicCompliant;
    Object.freeze(this);
  }

  get id() { return this.#id; }
  get url() { return this.#url; }
  get models() { return this.#models; }
  get anthropicCompliant() { return this.#anthropicCompliant; }
}

export class ProviderMatch {
  #provider;
  #alias;
  #realModel;

  constructor(provider, alias, realModel) {
    this.#provider = provider;
    this.#alias = alias;
    this.#realModel = realModel;
    Object.freeze(this);
  }

  get provider() { return this.#provider; }
  get alias() { return this.#alias; }
  get realModel() { return this.#realModel; }
  get isAliased() { return this.#alias !== this.#realModel; }
  get label() { return this.isAliased ? `${this.#alias}→${this.#realModel}` : this.#realModel; }
}

export class ProvidersMap {
  #map;
  #providerIds;

  constructor(providerConfigs) {
    this.#map = new Map();
    this.#providerIds = new Set();
    for (const provider of providerConfigs) {
      if (provider.id) {
        if (this.#providerIds.has(provider.id)) {
          throw new ArgumentError(`Duplicate provider ID: "${provider.id}"`);
        }
        this.#providerIds.add(provider.id);
      }
      for (const [alias, realModel] of Object.entries(provider.models)) {
        this.#map.set(alias, new ProviderMatch(provider, alias, realModel));
      }
    }
    Object.freeze(this);
  }

  resolve(modelName) {
    if (typeof modelName !== 'string') return null;
    return this.#map.get(modelName) ?? null;
  }

  get size() { return this.#map.size; }
  get allAliases() { return [...this.#map.keys()]; }
}
