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
 *
 * Format conversion hooks (for multi-protocol support):
 *  - **requestFormatConvert** — converts request body to target API format
 *  - **responseFormatConvert** — converts response from source API format
 *
 * Load balancing hooks:
 *  - **resolveProvider** — selects a provider from a pool
 *  - **onRequestStart** / **onRequestEnd** — lifecycle tracking
 */
export class ExtensionRegistry {
  #extensions = new Map();
  #requestTransformers = [];
  #fullResponseTransformers = [];
  #sseChunkTransformers = [];
  #fallbackCheckers = [];
  #fallbackTcpCheckers = [];
  #fallbackBuilders = [];
  #requestFormatConverters = [];
  #responseFormatConverters = [];
  #providerResolvers = [];
  #unmatchedResolvers = [];
  #requestStartHandlers = [];
  #requestEndHandlers = [];
  #upstreamHandlers = [];

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
    if (extension.hooks?.requestFormatConvert) {
      this.#requestFormatConverters = this.#upsert(this.#requestFormatConverters, extension.name, extension.hooks.requestFormatConvert);
    }
    if (extension.hooks?.responseFormatConvert) {
      this.#responseFormatConverters = this.#upsert(this.#responseFormatConverters, extension.name, extension.hooks.responseFormatConvert);
    }
    if (extension.hooks?.resolveProvider) {
      this.#providerResolvers = this.#upsert(this.#providerResolvers, extension.name, extension.hooks.resolveProvider);
    }
    if (extension.hooks?.resolveUnmatched) {
      this.#unmatchedResolvers = this.#upsert(this.#unmatchedResolvers, extension.name, extension.hooks.resolveUnmatched);
    }
    if (extension.hooks?.onRequestStart) {
      this.#requestStartHandlers = this.#upsert(this.#requestStartHandlers, extension.name, extension.hooks.onRequestStart);
    }
    if (extension.hooks?.onRequestEnd) {
      this.#requestEndHandlers = this.#upsert(this.#requestEndHandlers, extension.name, extension.hooks.onRequestEnd);
    }
    if (extension.hooks?.handleUpstream) {
      this.#upstreamHandlers = this.#upsert(this.#upstreamHandlers, extension.name, extension.hooks.handleUpstream);
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
  get hasProviderResolver() { return this.#providerResolvers.length > 0; }
  get hasUnmatchedResolver() { return this.#unmatchedResolvers.length > 0; }

  /**
   * Convert request body to the target API format.
   * Finds the first converter matching the declared format and returns its output.
   * Returns null if no converter matches (no conversion needed).
   */
  convertRequestFormat(ctx) {
    for (const c of this.#requestFormatConverters) {
      if (c.format === ctx.format) {
        return c.convert(ctx);
      }
    }
    return null;
  }

  /**
   * Check if a response format converter exists for the given format.
   */
  hasResponseFormatConverter(format) {
    return this.#responseFormatConverters.some(c => c.format === format);
  }

  /**
   * Convert a full (buffered) response from the source API format to Anthropic.
   * Returns the converted response string, or null if no converter matches.
   */
  convertFullResponseFormat(ctx) {
    for (const c of this.#responseFormatConverters) {
      if (c.format === ctx.format && c.convertFullResponse) {
        return c.convertFullResponse(ctx);
      }
    }
    return null;
  }

  /**
   * Create per-stream state objects for response format converters that
   * have a `createState()` method.
   */
  createResponseFormatStates(format) {
    return this.#responseFormatConverters
      .filter(c => c.format === format)
      .map(t => (typeof t.createState === 'function' ? t.createState() : undefined));
  }

  /**
   * Convert a single SSE chunk from the source API format to Anthropic SSE.
   * Runs all matching converters in order, passing state objects.
   */
  convertSseChunkFormat(ctx, states) {
    let { chunk } = ctx;
    const matching = this.#responseFormatConverters.filter(c => c.format === ctx.format);
    let i = 0;
    for (const c of matching) {
      const state = states ? states[i] : undefined;
      if (c.convertSseChunk) {
        chunk = state !== undefined ? c.convertSseChunk({ ...ctx, chunk }, state) : c.convertSseChunk({ ...ctx, chunk });
      }
      i++;
    }
    return chunk;
  }

  /**
   * Resolve a provider from a pool using the first extension that returns non-null.
   */
  resolveProvider(ctx) {
    for (const r of this.#providerResolvers) {
      const result = r.resolve(ctx);
      if (result) return result;
    }
    return null;
  }

  /**
   * Resolve an unmatched model using the first extension that returns non-null.
   * Called when no routing rule matches the requested model.
   */
  async resolveUnmatched(ctx) {
    for (const r of this.#unmatchedResolvers) {
      const result = await r.resolve(ctx);
      if (result) return result;
    }
    return null;
  }

  /**
   * Check if any extension handles upstream directly for the given provider.
   * Used for CLI-based providers (e.g. agy) that bypass HTTP forwarding.
   */
  hasUpstreamHandler(providerId) {
    for (const h of this.#upstreamHandlers) {
      if (h.handles(providerId)) return true;
    }
    return false;
  }

  /**
   * Delegate upstream handling to the first extension that accepts the provider.
   * The extension receives the parsed body and writes directly to the client response.
   */
  async invokeUpstream({ providerId, body, req, res, ctx }) {
    for (const h of this.#upstreamHandlers) {
      if (h.handles(providerId)) {
        return h.handle({ body, req, res, ctx });
      }
    }
  }

  /**
   * Get configuration schemas for all registered extensions.
   */
  getSchemas() {
    const schemas = {};
    for (const [name, ext] of this.#extensions.entries()) {
      if (ext.schema) {
        schemas[name] = ext.schema;
      }
    }
    return schemas;
  }

  /**
   * Get a description of every registered extension, including those without
   * a user-tunable schema. Used by /api/extensions to power the GUI's
   * Extensions tab — the tab needs to list everything that's loaded so the
   * user can see what's actually doing work, not just what they can edit.
   */
  getAll() {
    const out = [];
    for (const [name, ext] of this.#extensions.entries()) {
      out.push({
        name,
        title: ext.title ?? name,
        description: ext.description ?? '',
        activation: ext.activation ?? 'always',
        configuredBy: ext.configuredBy ?? null,
        providerTrigger: ext.providerTrigger ?? null,
        schema: ext.schema ?? null,
      });
    }
    return out;
  }

  /**
   * Notify all onRequestStart handlers.
   */
  emitRequestStart(ctx) {
    for (const h of this.#requestStartHandlers) {
      h.handler(ctx);
    }
  }

  /**
   * Notify all onRequestEnd handlers.
   */
  emitRequestEnd(ctx) {
    for (const h of this.#requestEndHandlers) {
      h.handler(ctx);
    }
  }

  #upsert(list, name, hook) {
    const filtered = list.filter(t => t.name !== name);
    const entry = { name, order: hook.order ?? 100 };
    if (hook.transform) entry.transform = hook.transform;
    if (hook.createState) entry.createState = hook.createState;
    if (hook.check) entry.check = hook.check;
    if (hook.build) entry.build = hook.build;
    if (hook.convert) entry.convert = hook.convert;
    if (hook.resolve) entry.resolve = hook.resolve;
    if (hook.handler) entry.handler = hook.handler;
    if (hook.format) entry.format = hook.format;
    if (hook.convertSseChunk) entry.convertSseChunk = hook.convertSseChunk;
    if (hook.convertFullResponse) entry.convertFullResponse = hook.convertFullResponse;
    if (hook.handles) entry.handles = hook.handles;
    if (hook.handle) entry.handle = hook.handle;
    filtered.push(entry);
    filtered.sort((a, b) => a.order - b.order);
    return filtered;
  }
}
