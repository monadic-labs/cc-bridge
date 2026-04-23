import { ArgumentError } from './exceptions.js';

/**
 * Ordered extension registry for proxy request/response transforms.
 *
 * Extensions register hooks that run in ascending `order` during the
 * request-transform and response-transform phases. The core pipeline
 * calls `transformRequest()` / `transformResponse()` — extensions
 * never touch HTTP directly.
 *
 * Response transforms come in two flavours:
 *  - **full-response** — receives the complete (buffered) body as a
 *    string. Used for non-SSE or when the response was already buffered
 *    by retry/fallback logic.
 *  - **sse-chunk** — receives one SSE chunk (string), returns the
 *    (possibly modified) chunk string. Runs for every chunk in the
 *    streaming path, keeping latency low.
 *
 * Both flavours share the same `order` namespace so their relative
 * priority is unambiguous.
 *
 * SSE chunk hooks may be **stateful**: if the hook provides a
 * `createState()` function, the pipeline calls it once per stream and
 * passes the returned object to each `transform(ctx, state)` call.
 * Stateless hooks (no `createState`) receive only `ctx`.
 *
 * Fallback hooks:
 *  - **shouldAttemptFallback** — decides if an HTTP error triggers fallback
 *  - **shouldAttemptFallbackForTcpError** — decides if a TCP error triggers fallback
 *  - **buildFallbackRequest** — builds the fallback request body/headers
 */
export class ExtensionRegistry {
  #extensions = new Map();
  #requestTransformers = [];
  #fullResponseTransformers = [];
  #sseChunkTransformers = [];
  #fallbackCheckers = [];
  #fallbackTcpCheckers = [];
  #fallbackBuilders = [];

  /** Register an extension. Idempotent — re-registering replaces the previous entry. */
  register(extension) {
    if (!extension || typeof extension !== 'object') {
      throw new ArgumentError('Extension must be an object', { context: { extension } });
    }
    if (typeof extension.name !== 'string' || !extension.name) {
      throw new ArgumentError('Extension.name must be a non-empty string');
    }

    this.#extensions.set(extension.name, extension);

    if (extension.hooks?.requestTransform) {
      this.#requestTransformers = this.#upsert(this.#requestTransformers, extension.name, extension.hooks.requestTransform);
    }
    if (extension.hooks?.responseTransform) {
      this.#fullResponseTransformers = this.#upsert(this.#fullResponseTransformers, extension.name, extension.hooks.responseTransform);
    }
    if (extension.hooks?.sseChunkTransform) {
      this.#sseChunkTransformers = this.#upsert(this.#sseChunkTransformers, extension.name, extension.hooks.sseChunkTransform);
    }
    if (extension.hooks?.shouldAttemptFallback) {
      this.#fallbackCheckers = this.#upsert(this.#fallbackCheckers, extension.name, extension.hooks.shouldAttemptFallback);
    }
    if (extension.hooks?.shouldAttemptFallbackForTcpError) {
      this.#fallbackTcpCheckers = this.#upsert(this.#fallbackTcpCheckers, extension.name, extension.hooks.shouldAttemptFallbackForTcpError);
    }
    if (extension.hooks?.buildFallbackRequest) {
      this.#fallbackBuilders = this.#upsert(this.#fallbackBuilders, extension.name, extension.hooks.buildFallbackRequest);
    }
  }

  /** Run all request transformers in order. Returns the final body. */
  transformRequest(ctx) {
    let { body } = ctx;
    for (const t of this.#requestTransformers) {
      body = t.transform({ ...ctx, body });
    }
    return body;
  }

  /** Run all full-response transformers in order. Returns the final body string. */
  transformResponse(ctx) {
    let { response } = ctx;
    for (const t of this.#fullResponseTransformers) {
      response = t.transform({ ...ctx, response });
    }
    return response;
  }

  /**
   * Run all SSE chunk transformers in order on a single chunk string.
   * Returns the (possibly modified) chunk string.
   */
  transformSseChunk(ctx, states) {
    let { chunk } = ctx;
    let i = 0;
    for (const t of this.#sseChunkTransformers) {
      const state = states ? states[i] : undefined;
      chunk = state !== undefined ? t.transform({ ...ctx, chunk }, state) : t.transform({ ...ctx, chunk });
      i++;
    }
    return chunk;
  }

  /**
   * Create per-stream state objects for all SSE chunk transformers that
   * have a `createState()` method.
   */
  createSseStates() {
    return this.#sseChunkTransformers.map(t => (typeof t.createState === 'function' ? t.createState() : undefined));
  }

  /** Check if any fallback extension wants to attempt fallback for an HTTP error. */
  shouldAttemptFallback(ctx) {
    for (const t of this.#fallbackCheckers) {
      if (t.check(ctx)) return true;
    }
    return false;
  }

  /** Check if any fallback extension wants to attempt fallback for a TCP error. */
  shouldAttemptFallbackForTcpError(ctx) {
    for (const t of this.#fallbackTcpCheckers) {
      if (t.check(ctx)) return true;
    }
    return false;
  }

  /** Build a fallback request using the first extension that returns non-null. */
  buildFallbackRequest(ctx) {
    for (const t of this.#fallbackBuilders) {
      const result = t.build({ ...ctx, extensions: this });
      if (result) return result;
    }
    return null;
  }

  get size() { return this.#extensions.size; }
  get requestTransformerCount() { return this.#requestTransformers.length; }
  get responseTransformerCount() { return this.#fullResponseTransformers.length; }
  get sseChunkTransformerCount() { return this.#sseChunkTransformers.length; }
  get hasFallback() { return this.#fallbackCheckers.length > 0; }

  #upsert(list, name, hook) {
    const filtered = list.filter(t => t.name !== name);
    const entry = { name, order: hook.order ?? 100 };
    if (hook.transform) entry.transform = hook.transform;
    if (hook.createState) entry.createState = hook.createState;
    if (hook.check) entry.check = hook.check;
    if (hook.build) entry.build = hook.build;
    filtered.push(entry);
    filtered.sort((a, b) => a.order - b.order);
    return filtered;
  }
}
