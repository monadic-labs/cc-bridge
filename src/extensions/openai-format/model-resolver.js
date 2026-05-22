/**
 * Model resolver for OpenAI-format providers.
 *
 * Resolves direct dot-notation model references (e.g. "synthetic.zai-org/GLM-5.1")
 * when no explicit route rule exists. Validates models via /v1/models API with
 * TTL-based caching, falling back to known models from config.
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';
import { UpstreamError } from '../../core/exceptions.js';
import { tryProviderApiKey } from '../../core/api-key-resolver.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 5000;

const modelCache = new Map();

/**
 * Parse a dot-notation model reference into provider ID and model name.
 * Splits at the first dot — provider IDs don't contain dots.
 */
export function parseDotNotation(modelName) {
  const dotIndex = modelName.indexOf('.');
  if (dotIndex === -1) return null;
  return {
    providerId: modelName.slice(0, dotIndex),
    model: modelName.slice(dotIndex + 1),
  };
}

/**
 * Fetch models from an OpenAI-compatible /v1/models endpoint.
 * Returns a Set of model IDs, or null on failure.
 */
async function fetchModels(url, apiKey) {
  const cacheKey = `${url}:${apiKey?.slice(0, 8)}`;
  const cached = modelCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.models;
  }

  try {
    const modelsUrl = new URL(url.replace(/\/+$/, '') + '/models');
    const transport = modelsUrl.protocol === 'https:' ? https : http;
    const headers = {};
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

    const data = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new UpstreamError('timeout')), FETCH_TIMEOUT_MS);
      transport.get(
        { hostname: modelsUrl.hostname, port: modelsUrl.port, path: modelsUrl.pathname, headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            clearTimeout(timeout);
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
          res.on('error', (e) => { clearTimeout(timeout); reject(e); });
        }
      ).on('error', (e) => { clearTimeout(timeout); reject(e); });
    });

    const parsed = JSON.parse(data);
    if (!parsed.data || parsed.error) {
      throw new UpstreamError(parsed.error?.message || 'Invalid response from models endpoint');
    }
    const models = new Set(parsed.data.map((m) => m.id));
    modelCache.set(cacheKey, { models, ts: Date.now() });
    return models;
  } catch {
    return null;
  }
}

/**
 * Resolve an unmatched model for a known OpenAI-format provider.
 *
 * @param {string} modelName - The requested model (e.g. "synthetic.zai-org/GLM-5.1")
 * @param {object} providerFormats - openai-format provider config map
 * @param {Map} providerConfigs - Map of providerId → ProviderConfig
 * @returns {Promise<{ providerId: string, model: string } | null>}
 */
export async function resolveOpenaiModel(modelName, providerFormats, providerConfigs) {
  const parsed = parseDotNotation(modelName);
  if (!parsed) return null;

  const { providerId, model } = parsed;
  const fmt = providerFormats[providerId]?.format;
  if (!fmt || fmt === 'anthropic') return null;

  const provider = providerConfigs.get(providerId);
  if (!provider) return null;

  // Side-channel probe to /v1/models — missing env var is non-fatal here:
  // the probe just runs unauthenticated (open gateways still respond) and
  // the unmatched-route forwarding path (proxy-routing.js) is where a
  // missing key surfaces as a structured ProviderApiKeyError.
  const keyOpt = tryProviderApiKey(providerId);
  const apiKey = keyOpt.isSome ? keyOpt.value : '';
  const knownModels = await fetchModels(provider.url, apiKey);
  if (knownModels) {
    if (knownModels.has(model)) {
      return { providerId, model };
    }
    return null;
  }

  // API check failed — allow through, trust the user
  return { providerId, model };
}
