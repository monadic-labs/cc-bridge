import { providerIdToEnvKey } from './providers.js';
import { obfuscateKey as _obfuscateKey } from './env-file.js';

export const obfuscateKey = _obfuscateKey;

export function listApiKeys(rawProviders, reveal = false) {
  // Support both v2 (object) and v1 (array) for robustness
  const entries = Array.isArray(rawProviders)
    ? rawProviders.map(p => [p.id, p])
    : Object.entries(rawProviders);

  return entries.map(([id, cfg]) => {
    const envVar = providerIdToEnvKey(id);
    const val = process.env[envVar] || '';
    return {
      id,
      url: cfg.url,
      key: reveal ? (val || '(none)') : obfuscateKey(val),
    };
  });
}
