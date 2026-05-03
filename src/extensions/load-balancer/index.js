/**
 * Load balancer extension for multi-provider pool routing.
 *
 * Reads pool configuration from `extensions.load-balancer` in providers.json.
 * Fully autonomous — uses the resolveProvider hook to select a provider from
 * a pool when the requested model matches a pool alias.
 *
 * Pool entries use UIDs in `"providerId.model"` format — the same format used
 * in routes. No need to re-declare provider+model pairs.
 *
 * Config example:
 *   "extensions": {
 *     "load-balancer": {
 *       "pools": {
 *         "coder": {
 *           "strategy": "round-robin",
 *           "entries": [
 *             { "ref": "z.glm-5", "weight": 5 },
 *             "synthetic.zai-org/GLM-5"
 *           ]
 *         }
 *       },
 *       "aliases": {
 *         "*sonnet*": "coder",
 *         "*haiku*": "explorer"
 *       }
 *     }
 *   }
 *
 * Entry formats (backward compatible):
 *   String:  "providerId.model"         → weight 1
 *   Object:  { "ref": "p.model", "weight": N }
 *   Legacy:  { "provider": "p", "model": "m", "weight": N }
 *
 * Uses extension hooks:
 *  - resolveProvider: selects a provider from the matching pool
 *  - onRequestStart / onRequestEnd: tracks active requests for least-conn
 */

import { selectRoundRobin } from './strategies/round-robin.js';
import { selectLeastConn, entryKey } from './strategies/least-conn.js';
import { selectRandom, selectWeighted } from './strategies/random.js';

function parseRef(ref) {
  const dot = ref.indexOf('.');
  if (dot < 1) return null;
  return { providerId: ref.substring(0, dot), model: ref.substring(dot + 1) };
}

function normalizeEntry(raw) {
  if (typeof raw === 'string') {
    const parsed = parseRef(raw);
    return parsed ? { ...parsed, weight: 1 } : null;
  }
  if (raw.ref) {
    const parsed = parseRef(raw.ref);
    return parsed ? { ...parsed, weight: raw.weight ?? 1 } : null;
  }
  if (raw.provider && raw.model) {
    return { providerId: raw.provider, model: raw.model, weight: raw.weight ?? 1 };
  }
  return null;
}

export const EXTENSION_META = {
  activation: 'always',
  schema: {
    type: 'object',
    title: 'Load Balancer',
    description: 'Multi-provider pool routing and model aliasing.',
    properties: {
      pools: {
        type: 'object',
        title: 'Model Pools',
        description: 'Define groups of models to balance requests across.',
        additionalProperties: {
          type: 'object',
          properties: {
            strategy: {
              type: 'string',
              title: 'Strategy',
              enum: ['round-robin', 'least-conn', 'random', 'weighted'],
              default: 'round-robin'
            },
            entries: {
              type: 'array',
              title: 'Pool Entries',
              items: {
                type: 'string',
                description: 'Format: providerId.modelName'
              }
            }
          }
        }
      },
      aliases: {
        type: 'object',
        title: 'Wildcard Aliases',
        description: 'Map model name patterns (e.g. *sonnet*) to pool names.',
        additionalProperties: {
          type: 'string',
          title: 'Pool Name'
        }
      }
    }
  }
};

export function createLoadBalancerExtension(config = {}) {
  const rawPools = config.pools ?? {};
  const aliases = config.aliases ?? {};

  // Normalize all pool entries upfront
  const pools = {};
  for (const [name, pool] of Object.entries(rawPools)) {
    const entries = (pool.entries ?? [])
      .map(normalizeEntry)
      .filter(Boolean);
    if (entries.length > 0) {
      pools[name] = { strategy: pool.strategy ?? 'round-robin', entries };
    }
  }

  const rrState = { counter: 0 };
  const activeCounts = new Map();

  // Pre-compile alias regexes
  const aliasRegexes = [];
  for (const [pattern, poolName] of Object.entries(aliases)) {
    if (pattern.includes('*')) {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '.*' : '\\' + ch));
      aliasRegexes.push({ re: new RegExp(escaped), poolName });
    }
  }

  function resolvePoolName(modelName) {
    if (pools[modelName]) return modelName;
    for (const { re, poolName } of aliasRegexes) {
      if (re.test(modelName)) return poolName;
    }
    return null;
  }

  return {
    name: 'load-balancer',

    hooks: {
      resolveProvider: {
        order: 50,
        resolve: ({ body, matchedRule }) => {
          const modelName = body?.model;
          if (!modelName) return null;

          let pool = null;
          let strategy = 'round-robin';
          let entries = [];

          // 1. Try pool from the core routing rule (v3 style)
          if (matchedRule?.type === 'pool' && matchedRule.pool) {
            strategy = matchedRule.pool.strategy ?? 'round-robin';
            entries = (matchedRule.pool.entries ?? [])
              .map(normalizeEntry)
              .filter(Boolean);
          }

          // 2. Fallback to extension's own pool config (v2 style)
          if (entries.length === 0) {
            const poolName = resolvePoolName(modelName);
            if (poolName && pools[poolName]) {
              strategy = pools[poolName].strategy;
              entries = pools[poolName].entries;
            }
          }

          if (entries.length === 0) return null;

          const entry = strategy === 'least-conn'
            ? selectLeastConn(entries, activeCounts)
            : strategy === 'weighted'
              ? selectWeighted(entries)
              : strategy === 'random'
                ? selectRandom(entries)
                : selectRoundRobin(entries, rrState);

          return { providerId: entry.providerId, model: entry.model };
        },
      },

      onRequestStart: {
        order: 10,
        handler: ({ providerId, model }) => {
          const key = entryKey({ providerId, model });
          activeCounts.set(key, (activeCounts.get(key) ?? 0) + 1);
        },
      },

      onRequestEnd: {
        order: 10,
        handler: ({ providerId, model }) => {
          const key = entryKey({ providerId, model });
          const current = activeCounts.get(key) ?? 0;
          activeCounts.set(key, Math.max(0, current - 1));
        },
      },
    },
  };
}
