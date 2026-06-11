import { ContentBlockInfo, SseMetadata } from './types.js';
import {
  getSseEventType,
  getMessageStartModel, getMessageStartInputTokens,
  getSseContentBlock, getSseDelta, getSseError,
  getBlockType, getBlockName, getBlockSignature,
  getDeltaStopReason, getMessageDeltaOutputTokens, getMessageDeltaInputTokens,
} from './api-adapter.js';

function parseSseLine(line) {
  if (!line.startsWith('data: ')) return null;
  try { return JSON.parse(line.slice(6)); } catch { return null; }
}

/**
 * Extract block metadata from a content_block_start event.
 *
 * Note: `signature` is captured at content_block_start time. For Anthropic's
 * streaming responses, the real cryptographic signature is attached later in
 * the stream (typically at content_block_stop). An empty signature here does
 * NOT mean the block is unsigned — it may simply not have been delivered yet.
 * See vault/evidence/Daemon Log Analysis.md for details on this artifact.
 */
function extractBlockInfo(contentBlock) {
  if (!contentBlock) return new ContentBlockInfo({ type: 'unknown' });
  return new ContentBlockInfo({
    type: getBlockType(contentBlock),
    name: getBlockName(contentBlock),
    signature: getBlockSignature(contentBlock),
  });
}

const SSE_HANDLERS = Object.freeze({
  message_start(evt, acc) {
    acc.model = getMessageStartModel(evt);
    acc.inputTokens = getMessageStartInputTokens(evt);
  },
  content_block_start(evt, acc) {
    acc.blocks.push(extractBlockInfo(getSseContentBlock(evt)));
  },
  message_delta(evt, acc) {
    acc.stopReason = getDeltaStopReason(getSseDelta(evt));
    acc.outputTokens = getMessageDeltaOutputTokens(evt);
    // Some providers (e.g. z.ai) report the real input_tokens in message_delta
    // rather than message_start (where they send 0). Only adopt the delta value
    // when it is finite and > 0 so a correct message_start count is never
    // clobbered by a missing or zero delta field.
    const deltaIn = getMessageDeltaInputTokens(evt);
    if (Number.isFinite(deltaIn) && deltaIn > 0) acc.inputTokens = deltaIn;
  },
  error(evt, acc) {
    acc.error = getSseError(evt);
  },
});

export function parseSseMetadata(raw) {
  const acc = { model: '', inputTokens: 0, outputTokens: 0, stopReason: '', blocks: [], error: null };
  for (const line of raw.split('\n')) {
    const evt = parseSseLine(line);
    if (!evt) continue;
    const handler = SSE_HANDLERS[getSseEventType(evt)];
    if (!handler) {
      continue;
    }
    handler(evt, acc);
  }
  return new SseMetadata(acc);
}
