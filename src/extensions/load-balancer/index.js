/**
 * Load balancer extension for multi-provider pool routing.
 *
 * Reads pool configuration from `extensions.load-balancer` in providers.json.
 * Fully autonomous — uses the resolveProvider hook to select a provider from
 * a pool based on strategy (round-robin, least-conn, random, weighted).
 */

"use strict";

import { selectRoundRobin } from './strategies/round-robin.js';
import { selectLeastConn, entryKey } from './strategies/least-conn.js';
import { selectRandom, selectWeighted } from './strategies/random.js';

export function createLoadBalancerExtension(config = {}) {
  const pools = config.pools ?? {};
  const aliases = config.aliases ?? {};

  // Local state for strategies
  const rrState = { counter: 0 };
  const activeCounts = new Map();

  // Pre-parse alias regexes
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

  function normalizeEntry(entry) {
    if (typeof entry === 'string') {
      const parts = entry.split('.');
      if (parts.length < 2) return null;
      return { providerId: parts[0], model: parts.slice(1).join('.'), weight: 1 };
    }
    if (entry.ref) {
      const parts = entry.ref.split('.');
      if (parts.length < 2) return null;
      return { providerId: parts[0], model: parts.slice(1).join('.'), weight: entry.weight ?? 1 };
    }
    if (entry.providerId || entry.provider) {
      return { 
        providerId: entry.providerId || entry.provider, 
        model: entry.model, 
        weight: entry.weight ?? 1 
      };
    }
    return null;
  }

  function resolveFromPool(modelName, matchedRule, _policy) {
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
        strategy = pools[poolName].strategy ?? 'round-robin';
        entries = (pools[poolName].entries ?? [])
          .map(normalizeEntry)
          .filter(Boolean);
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

    return entry;
  }

  return {
    name: 'load-balancer',

    hooks: {
      resolveProvider: {
        order: 50,
        resolve: ({ body, matchedRule, _policy }) => {
          const modelName = body?.model;
          if (!modelName) return null;

          const entry = resolveFromPool(modelName, matchedRule, _policy);
          if (!entry) return null;

          return { providerId: entry.providerId, model: entry.model };
        },
      },

      resolveUnmatched: {
        order: 50,
        resolve: ({ modelName, policy }) => {
          const entry = resolveFromPool(modelName, null, policy);
          if (!entry) return null;

          const provider = policy.getProvider(entry.providerId);
          if (provider.isNone) return null;

          return {
            providerId: entry.providerId,
            model: entry.model,
            provider: provider.value
          };
        }
      },

      onRequestStart: {
        order: 10,
        handler: ({ providerId, model }) => {
          const key = entryKey({ providerId, model });
          const current = activeCounts.get(key) ?? 0;
          activeCounts.set(key, current + 1);
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
