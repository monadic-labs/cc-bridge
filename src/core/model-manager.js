import { Result } from './types.js';
import { ArgumentError } from './exceptions.js';

export function findProviderIndex(providers, identifier) {
  if (typeof identifier !== 'string' || !identifier) return -1;
  const byId = providers.findIndex((p) => p.id === identifier);
  if (byId !== -1) return byId;
  return providers.findIndex((p) => p.url.includes(identifier));
}

function modelsToObject(models) {
  if (Array.isArray(models)) {
    return Object.fromEntries(models.map((m) => [m, m]));
  }
  return { ...models };
}

export function addModel(rawProviders, providerId, alias, realModel) {
  const providers = rawProviders.map((p) => ({ ...p }));
  const idx = findProviderIndex(providers, providerId);
  if (idx === -1) return Result.fail(new ArgumentError(`No provider matching "${providerId}"`));

  const models = modelsToObject(providers[idx].models);
  if (models[alias] !== undefined) {
    return Result.fail(new ArgumentError(`Model "${alias}" already exists on "${providers[idx].url}"`));
  }

  models[alias] = realModel;
  providers[idx].models = models;
  return Result.ok(providers);
}

export function removeModel(rawProviders, providerId, alias) {
  const providers = rawProviders.map((p) => ({ ...p }));
  const idx = findProviderIndex(providers, providerId);
  if (idx === -1) return Result.fail(new ArgumentError(`No provider matching "${providerId}"`));

  const models = modelsToObject(providers[idx].models);
  if (models[alias] === undefined) {
    return Result.fail(new ArgumentError(`Model "${alias}" not found on "${providers[idx].url}"`));
  }

  delete models[alias];
  providers[idx].models = models;
  return Result.ok(providers);
}

export function addProvider(rawProviders, id, url, compliant = true) {
  const providers = rawProviders.map((p) => ({ ...p }));
  if (providers.some((p) => p.id === id)) {
    return Result.fail(new ArgumentError(`Provider ID "${id}" already exists`));
  }
  if (providers.some((p) => p.url === url)) {
    return Result.fail(new ArgumentError(`Provider URL "${url}" already exists`));
  }
  providers.push({ id, url, models: {}, anthropicCompliant: compliant });
  return Result.ok(providers);
}

export function removeProvider(rawProviders, id) {
  const idx = findProviderIndex(rawProviders, id);
  if (idx === -1) {
    return Result.fail(new ArgumentError(`No provider matching "${id}"`));
  }
  const providers = rawProviders.filter((_, i) => i !== idx);
  return Result.ok(providers);
}

export function listModels(rawProviders, providerId) {
  const idx = findProviderIndex(rawProviders, providerId);
  if (idx === -1) return Result.fail(new ArgumentError(`No provider matching "${providerId}"`));

  const provider = rawProviders[idx];
  const entries = Array.isArray(provider.models)
    ? provider.models.map((m) => [m, m])
    : Object.entries(provider.models);

  return Result.ok({ url: provider.url, compliant: provider.anthropicCompliant, models: entries });
}

export function listProviders(rawProviders) {
  return rawProviders.map((p) => {
    const count = Array.isArray(p.models) ? p.models.length : Object.keys(p.models).length;
    return { url: p.url, compliant: p.anthropicCompliant, modelCount: count };
  });
}

export function formatTree(rawProviders) {
  const lines = [];
  for (let i = 0; i < rawProviders.length; i++) {
    const p = rawProviders[i];
    const tag = p.anthropicCompliant ? 'compliant' : 'non-compliant';
    lines.push(`${p.url} (${tag})`);

    const entries = Array.isArray(p.models)
      ? p.models.map((m) => [m, m])
      : Object.entries(p.models);

    for (let j = 0; j < entries.length; j++) {
      const [alias, real] = entries[j];
      const branch = j === entries.length - 1 ? '└──' : '├──';
      const label = alias === real ? alias : `${alias} → ${real}`;
      lines.push(`${branch} ${label}`);
    }

    if (i < rawProviders.length - 1) lines.push('');
  }
  return lines.join('\n');
}
