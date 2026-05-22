import { ArgumentError } from './exceptions.js';

const ENV_REFERENCE_PREFIX = 'ENV:';

// Returns a deep-cloned v2 providers config with every provider's apiKey field
// removed. Input is not mutated. Use on the GET /api/config response path so
// the network surface never echoes a literal API key — even if the auth gate
// is disabled, even if providers.json on disk holds raw secrets.
export function redactProviderApiKeys(v2Config) {
  if (!v2Config || typeof v2Config !== 'object' || Array.isArray(v2Config)) {
    throw new ArgumentError('redactProviderApiKeys: v2Config must be a non-null object');
  }
  if (!v2Config.providers || typeof v2Config.providers !== 'object') {
    throw new ArgumentError('redactProviderApiKeys: v2Config.providers must be an object');
  }
  const clonedProviders = {};
  for (const id of Object.keys(v2Config.providers)) {
    const original = v2Config.providers[id];
    if (!original || typeof original !== 'object') {
      clonedProviders[id] = original;
      continue;
    }
    const { apiKey: _ignored, ...rest } = original;
    clonedProviders[id] = rest;
  }
  return { ...v2Config, providers: clonedProviders };
}

// Returns true iff any provider in the v2 config has a non-empty apiKey field
// whose value is NOT an ENV: reference. Empty strings, missing fields, and
// "ENV:VAR_NAME" references all return false. Use on the POST /api/config
// validation path to refuse persisting raw secrets.
export function hasLiteralApiKey(v2Config) {
  if (!v2Config || typeof v2Config !== 'object') return false;
  if (!v2Config.providers || typeof v2Config.providers !== 'object') return false;
  for (const id of Object.keys(v2Config.providers)) {
    const provider = v2Config.providers[id];
    if (!provider || typeof provider !== 'object') continue;
    if (typeof provider.apiKey !== 'string') continue;
    if (provider.apiKey.length === 0) continue;
    if (provider.apiKey.startsWith(ENV_REFERENCE_PREFIX)) continue;
    return true;
  }
  return false;
}
