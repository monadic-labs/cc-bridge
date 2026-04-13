import { BLOCK_TYPES, SSE_EVENT_TYPES, DELTA_TYPES } from './types.js';
import {
  getSseEventType, getSseIndex, getSseContentBlock, getSseDelta,
  getBlockType, getDeltaType, getDeltaThinking, getDeltaRedactedData,
} from './api-adapter.js';

export class SseResponseTransformer {
  #buffer = '';
  #thinkingIndexes = new Set();

  transformChunk(chunkStr) {
    this.#buffer += chunkStr;
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop(); // keep last partial line

    let output = '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) {
        output += line + '\n';
        continue;
      }
      try {
        const evt = JSON.parse(line.slice(6));
        const evtType = getSseEventType(evt);
        const idx = getSseIndex(evt);
        let modified = false;

        if (evtType === SSE_EVENT_TYPES.CONTENT_BLOCK_START) {
          const contentBlock = getSseContentBlock(evt);
          if (contentBlock) {
            const blockType = getBlockType(contentBlock);
            if (blockType === BLOCK_TYPES.THINKING || blockType === BLOCK_TYPES.REDACTED_THINKING) {
              this.#thinkingIndexes.add(idx);
              evt.content_block = { type: BLOCK_TYPES.TEXT, text: '```thinking\n' };
              modified = true;
            }
          }
        } else if (evtType === SSE_EVENT_TYPES.CONTENT_BLOCK_DELTA && this.#thinkingIndexes.has(idx)) {
          const delta = getSseDelta(evt);
          if (delta) {
            const deltaType = getDeltaType(delta);
            if (deltaType === DELTA_TYPES.THINKING_DELTA) {
              evt.delta = { type: DELTA_TYPES.TEXT_DELTA, text: getDeltaThinking(delta) };
              modified = true;
            } else if (deltaType === DELTA_TYPES.REDACTED_THINKING_DELTA) {
              evt.delta = { type: DELTA_TYPES.TEXT_DELTA, text: getDeltaRedactedData(delta) };
              modified = true;
            }
          }
        } else if (evtType === SSE_EVENT_TYPES.CONTENT_BLOCK_STOP && this.#thinkingIndexes.has(idx)) {
          const extraDelta = { type: SSE_EVENT_TYPES.CONTENT_BLOCK_DELTA, index: idx, delta: { type: DELTA_TYPES.TEXT_DELTA, text: '\n```\n' } };
          output += 'data: ' + JSON.stringify(extraDelta) + '\n\n';
          this.#thinkingIndexes.delete(idx);
        }

        output += modified ? `data: ${JSON.stringify(evt)}\n` : `${line}\n`;
      } catch {
        output += line + '\n';
      }
    }
    return output;
  }

  flush() {
    const out = this.#buffer;
    this.#buffer = '';
    return out;
  }
}
