/**
 * Model resolver for the agy CLI extension.
 *
 * Discovers available models by calling `agy models` locally (default) or
 * via SSH when an explicit sshHost is configured.
 * Parses the display names, normalizes them for routing, and caches with TTL.
 */

import { execCommand } from '../../infra/process-manager.js';
import { buildAgyInvocation } from './invocation-builder.js';
import { agyDir } from './binary-resolver.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Strip ANSI escape codes from a string.
 * Builds regex from char codes to avoid no-control-regex lint violations.
 */
function stripAnsi(str) {
  const e = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  const csi = new RegExp(e + '\\[[0-9;]*[a-zA-Z]', 'g');
  const osc = new RegExp(e + '\\][\\s\\S]*?(?:' + bel + '|' + e + '\\\\)', 'g');
  return str.replace(csi, '').replace(osc, '');
}

/**
 * Normalize a display name into a routing-friendly slug.
 * "Gemini 3.1 Pro (Low)" -> "gemini-3.1-pro-low"
 */
function normalizeDisplayName(name) {
  return name
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '');
}

export class ModelResolver {
  #sshHost;
  #agyPath;
  #cacheTtlMs;
  #models;
  #cacheTime;
  #discovering;

  /**
   * @param {object} opts
   * @param {string|undefined} opts.sshHost     - Optional SSH host (absent = local).
   * @param {string}           opts.agyPath     - Resolved path to the agy binary.
   * @param {number|undefined} opts.cacheTtlMs  - Cache TTL in ms.
   */
  constructor({ sshHost, agyPath, cacheTtlMs }) {
    this.#sshHost = sshHost ?? undefined;
    this.#agyPath = agyPath;
    this.#cacheTtlMs = cacheTtlMs ?? DEFAULT_TTL_MS;
    this.#models = new Map();
    this.#cacheTime = 0;
    this.#discovering = null;
  }

  /**
   * Discover available models from `agy models`.
   * Returns the model map. Uses TTL cache — repeated calls within the TTL
   * return the cached result. Only one discovery runs at a time.
   */
  discover() {
    if (this.#discovering) return this.#discovering;

    this.#discovering = this._doDiscover();
    const promise = this.#discovering;
    promise.finally(() => { this.#discovering = null; });
    return promise;
  }

  async _doDiscover() {
    if (this.#models.size > 0 && Date.now() - this.#cacheTime < this.#cacheTtlMs) {
      return this.#models;
    }

    const resolvedAgyDir = agyDir(this.#agyPath);
    const shellCommand = `export PATH=${resolvedAgyDir}:$PATH; script -qec "agy models" /dev/null`;
    const { cmd, args } = buildAgyInvocation(shellCommand, this.#sshHost);

    try {
      const raw = await execCommand(cmd, args, { timeout: 15000 });
      const clean = stripAnsi(raw);

      const models = new Map();
      for (const line of clean.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const normalized = normalizeDisplayName(trimmed);
        if (!normalized) continue;

        models.set(normalized, trimmed);
      }

      if (models.size > 0) {
        this.#models = models;
        this.#cacheTime = Date.now();
      }
    } catch {
      // Discovery failed — return stale cache if available, else empty
    }

    return this.#models;
  }

  /**
   * Resolve a model name to a discovered model.
   * Returns an object with displayName and normalizedName, or null.
   */
  resolve(modelName) {
    if (typeof modelName !== 'string' || !modelName) return null;

    const normalized = normalizeDisplayName(modelName);

    // Exact match on normalized name
    if (this.#models.has(normalized)) {
      return { displayName: this.#models.get(normalized), normalizedName: normalized };
    }

    // Exact match on display name (user typed the full display name)
    for (const [norm, display] of this.#models) {
      if (display === modelName) {
        return { displayName: display, normalizedName: norm };
      }
    }

    // Prefix match (e.g. "gemini-3.1" matches "gemini-3.1-pro")
    for (const [norm, display] of this.#models) {
      if (norm.startsWith(normalized)) {
        return { displayName: display, normalizedName: norm };
      }
    }

    return null;
  }

  get models() { return this.#models; }
}
