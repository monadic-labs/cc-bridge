import { Result } from './types.js';
import { ArgumentError } from './exceptions.js';
import { providerIdToEnvKey } from './providers.js';

export function findProviderIndex(providers, identifier) {
  if (typeof identifier !== 'string' || !identifier) return -1;
  const byId = providers.findIndex((p) => p.id === identifier);
  if (byId !== -1) return byId;
  return providers.findIndex((p) => p.url.includes(identifier));
}

export function obfuscateKey(key) {
  if (key === null || key === undefined || key === '') return '(none)';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

export function listApiKeys(rawProviders, reveal = false) {
  return rawProviders.map((p) => {
    const envVar = providerIdToEnvKey(p.id);
    const val = process.env[envVar] || '';
    return {
      id: p.id,
      url: p.url,
      key: reveal ? (val || '(none)') : obfuscateKey(val),
    };
  });
}
