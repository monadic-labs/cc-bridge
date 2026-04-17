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
 */
export class ExtensionRegistry {
  #extensions = new Map();
  #requestTransformers = [];
  #fullResponseTransformers = [];
  #sseChunkTransformers = [];

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
  transformSseChunk(ctx) {
    let { chunk } = ctx;
    for (const t of this.#sseChunkTransformers) {
      chunk = t.transform({ ...ctx, chunk });
    }
    return chunk;
  }

  get size() { return this.#extensions.size; }
  get requestTransformerCount() { return this.#requestTransformers.length; }
  get responseTransformerCount() { return this.#fullResponseTransformers.length; }
  get sseChunkTransformerCount() { return this.#sseChunkTransformers.length; }

  #upsert(list, name, hook) {
    const filtered = list.filter(t => t.name !== name);
    filtered.push({ name, order: hook.order ?? 100, transform: hook.transform });
    filtered.sort((a, b) => a.order - b.order);
    return filtered;
  }
}
