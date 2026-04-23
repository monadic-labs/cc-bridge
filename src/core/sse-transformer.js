/**
 * SSE response transformer — buffers partial lines and delegates
 * per-chunk transformation to the extension registry.
 *
 * Previously contained hardcoded thinking-block conversion logic.
 * Now serves as a thin SSE line-buffering layer: accumulated partial
 * lines are joined, split on '\n', and each complete line is handed
 * to extensions via `transformSseChunk()`.
 */
export class SseResponseTransformer {
  #buffer = '';
  #extensions;
  #sseStates;
  #provider;

  constructor(extensions, provider) {
    this.#extensions = extensions;
    this.#provider = provider ?? null;
    this.#sseStates = extensions ? extensions.createSseStates() : null;
  }

  transformChunk(chunkStr) {
    this.#buffer += chunkStr;
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop();

    if (lines.length === 0) return '';

    if (!this.#extensions || this.#extensions.sseChunkTransformerCount === 0) {
      return lines.join('\n') + '\n';
    }

    const chunk = lines.join('\n') + '\n';
    return this.#extensions.transformSseChunk({ chunk, provider: this.#provider }, this.#sseStates);
  }

  flush() {
    const out = this.#buffer;
    this.#buffer = '';
    return out;
  }
}
