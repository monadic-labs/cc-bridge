import { ContentBlockInfo, SseMetadata } from './types.js';

function parseSseLine(line) {
  if (!line.startsWith('data: ')) return null;
  try { return JSON.parse(line.slice(6)); } catch { return null; }
}

function extractBlockInfo(contentBlock) {
  if (!contentBlock) return new ContentBlockInfo({ type: 'unknown' });
  return new ContentBlockInfo({
    type: contentBlock.type,
    name: contentBlock.name,
    signature: contentBlock.signature,
  });
}

const SSE_HANDLERS = Object.freeze({
  message_start(evt, acc) {
    acc.model = evt.message?.model ?? '';
    acc.inputTokens = evt.message?.usage?.input_tokens ?? 0;
  },
  content_block_start(evt, acc) {
    acc.blocks.push(extractBlockInfo(evt.content_block));
  },
  message_delta(evt, acc) {
    acc.stopReason = evt.delta?.stop_reason ?? '';
    acc.outputTokens = evt.usage?.output_tokens ?? 0;
  },
  error(evt, acc) {
    acc.error = evt.error ?? evt;
  },
});

export function parseSseMetadata(raw) {
  const acc = { model: '', inputTokens: 0, outputTokens: 0, stopReason: '', blocks: [], error: null };
  for (const line of raw.split('\n')) {
    const evt = parseSseLine(line);
    if (!evt) continue;
    const handler = SSE_HANDLERS[evt.type];
    if (!handler) continue;
    handler(evt, acc);
  }
  return new SseMetadata(acc);
}
