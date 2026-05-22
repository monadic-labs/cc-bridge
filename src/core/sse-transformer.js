import {
  getSseEventType,
  getMessageStartModel, getMessageStartInputTokens,
  getMessageDeltaOutputTokens,
} from './api-adapter.js';

/**
 * SSE response transformer — buffers partial lines, delegates per-chunk
 * transformation to the extension registry, and accumulates response
 * metadata (model, input/output tokens) inline as events flow through.
 *
 * The metadata accumulator replaces an end-of-stream re-parse of the full
 * SSE body that was previously done purely to read two integers. Callers
 * read `transformer.inputTokens` / `.outputTokens` / `.model` after the
 * stream ends instead of feeding the buffered body back through a parser.
 */
export class SseResponseTransformer {
  #buffer = '';
  #extensions;
  #sseStates;
  #provider;
  #inputTokens = 0;
  #outputTokens = 0;
  #model = '';

  constructor(extensions, provider) {
    this.#extensions = extensions;
    this.#provider = provider ?? null;
    this.#sseStates = extensions ? extensions.createSseStates() : null;
  }

  get inputTokens() { return this.#inputTokens; }
  get outputTokens() { return this.#outputTokens; }
  get model() { return this.#model; }

  transformChunk(chunkStr) {
    this.#buffer += chunkStr;
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop();

    if (lines.length === 0) return '';

    this.#scanLinesForMetadata(lines);

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

  #scanLinesForMetadata(lines) {
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let evt;
      try { evt = JSON.parse(line.slice(6)); } catch { continue; }
      const evtType = getSseEventType(evt);
      if (evtType === 'message_start') {
        const m = getMessageStartModel(evt);
        if (m) this.#model = m;
        const inTok = getMessageStartInputTokens(evt);
        if (typeof inTok === 'number' && Number.isFinite(inTok)) this.#inputTokens = inTok;
        continue;
      }
      if (evtType === 'message_delta') {
        const outTok = getMessageDeltaOutputTokens(evt);
        if (typeof outTok === 'number' && Number.isFinite(outTok)) this.#outputTokens = outTok;
      }
    }
  }
}
