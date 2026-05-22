import { Result } from './types.js';
import { ArgumentError } from './exceptions.js';

// Holds a single immutable ProxyConfig snapshot. Constructed eagerly (fail
// loud if the initial load throws — bad config at startup is fatal).
// tryRefresh() is best-effort: a failed refresh leaves the previous good
// snapshot in place and returns Result.fail, so a hot-reload of a malformed
// config can't kill a running daemon. Used to eliminate per-request sync
// FS reads in the hot path; the file watcher calls tryRefresh on change.
export class ConfigCache {
  #loader;
  #cached;

  constructor(loader) {
    if (typeof loader !== 'function') {
      throw new ArgumentError('ConfigCache: loader must be a function');
    }
    this.#loader = loader;
    this.#cached = loader();
  }

  get() { return this.#cached; }

  tryRefresh() {
    try {
      this.#cached = this.#loader();
      return Result.ok(undefined);
    } catch (e) {
      return Result.fail(e);
    }
  }
}
