/**
 * SSE thinking-block transformation extension.
 *
 * Converts thinking/redacted_thinking blocks in SSE streams from non-compliant
 * providers to text blocks with markdown code fences, so Claude Code CLI
 * doesn't choke on unsupported block types.
 */

import { BLOCK_TYPES, SSE_EVENT_TYPES, DELTA_TYPES } from '../core/types.js';
import {
  getSseEventType, getSseIndex, getSseContentBlock, getSseDelta,
  getBlockType, getDeltaType, getDeltaThinking, getDeltaRedactedData,
} from '../core/api-adapter.js';

export function createThinkingSseExtension() {
  return {
    name: 'thinking-sse',

    hooks: {
      sseChunkTransform: {
        order: 10,
        createState: () => ({ thinkingIndexes: new Set() }),
        transform: (ctx, state) => transformThinkingChunk(ctx, state),
      },
    },
  };
}

function transformThinkingChunk({ chunk }, state) {
  // If chunk was produced by SseResponseTransformer, it likely ends with \n.
  // split('\n') will have an empty string at the end which we should handle.
  const lines = chunk.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const result = [];
  let modified = false;

  for (const line of lines) {
    if (!line.startsWith('data: ')) {
      result.push(line);
      continue;
    }
    try {
      const evt = JSON.parse(line.slice(6));
      const evtType = getSseEventType(evt);
      const idx = getSseIndex(evt);
      let evtModified = false;

      if (evtType === SSE_EVENT_TYPES.CONTENT_BLOCK_START) {
        const contentBlock = getSseContentBlock(evt);
        if (contentBlock) {
          const blockType = getBlockType(contentBlock);
          if (blockType === BLOCK_TYPES.THINKING || blockType === BLOCK_TYPES.REDACTED_THINKING) {
            state.thinkingIndexes.add(idx);
            evt.content_block = { type: BLOCK_TYPES.TEXT, text: '```thinking\n' };
            evtModified = true;
          }
        }
      }

      if (evtType === SSE_EVENT_TYPES.CONTENT_BLOCK_DELTA && state.thinkingIndexes.has(idx)) {
        const delta = getSseDelta(evt);
        if (delta) {
          const deltaType = getDeltaType(delta);
          if (deltaType === DELTA_TYPES.THINKING_DELTA) {
            evt.delta = { type: DELTA_TYPES.TEXT_DELTA, text: getDeltaThinking(delta) };
            evtModified = true;
          }
          if (deltaType === DELTA_TYPES.REDACTED_THINKING_DELTA) {
            evt.delta = { type: DELTA_TYPES.TEXT_DELTA, text: getDeltaRedactedData(delta) };
            evtModified = true;
          }
        }
      }

      if (evtType === SSE_EVENT_TYPES.CONTENT_BLOCK_STOP && state.thinkingIndexes.has(idx)) {
        const extraDelta = { type: SSE_EVENT_TYPES.CONTENT_BLOCK_DELTA, index: idx, delta: { type: DELTA_TYPES.TEXT_DELTA, text: '\n```\n' } };
        result.push('data: ' + JSON.stringify(extraDelta));
        result.push(''); // Force end of event for extraDelta
        state.thinkingIndexes.delete(idx);
        modified = true;
      }

      if (evtModified) {
        result.push('data: ' + JSON.stringify(evt));
        modified = true;
        continue;
      }
      result.push(line);
    } catch {
      result.push(line);
    }
  }

  return modified ? result.join('\n') + '\n' : chunk;
}
