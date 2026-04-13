/**
 * Adapter for the Anthropic API message schema.
 *
 * All field-level access to external Anthropic JSON structures goes through
 * this module. When Anthropic renames a field, update api-schema.json and
 * the one accessor here — nothing else in cc-bridge changes.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const schema = require('./api-schema.json');

// ─── Request body ─────────────────────────────────────────────────────────────

export const getModel    = body => body?.[schema.requestBody.model] ?? 'unknown';
export const getMessages = body => body?.[schema.requestBody.messages];
export const getSystem   = body => body?.[schema.requestBody.system];
export const getBetas    = body => body?.[schema.requestBody.betas];

// ─── System block (element of a system array) ─────────────────────────────────

export const getSystemBlockText = s => s?.[schema.systemBlock.text] ?? '';

// ─── Content block ────────────────────────────────────────────────────────────

export const getBlockType           = block => block?.[schema.contentBlock.type];
export const getBlockSignature      = block => block?.[schema.contentBlock.signature];
export const getBlockName           = block => block?.[schema.contentBlock.name];
export const getBlockText           = block => block?.[schema.contentBlock.text] ?? '';
export const getBlockThinking       = block => block?.[schema.contentBlock.thinkingContent] ?? '';
export const getBlockRedactedData   = block => block?.[schema.contentBlock.redactedData] ?? '';
export const getBlockToolContent    = block => block?.[schema.contentBlock.toolResultContent];

// ─── SSE event ────────────────────────────────────────────────────────────────

export const getSseEventType    = evt => evt?.[schema.sseEvent.type];
export const getSseIndex        = evt => evt?.[schema.sseEvent.index];
export const getSseContentBlock = evt => evt?.[schema.sseEvent.contentBlock];
export const getSseDelta        = evt => evt?.[schema.sseEvent.delta];
export const getSseError        = evt => evt?.[schema.sseEvent.errorPayload] ?? evt;

// ─── SSE delta ────────────────────────────────────────────────────────────────

export const getDeltaType         = delta => delta?.[schema.sseDelta.type];
export const getDeltaThinking     = delta => delta?.[schema.sseDelta.thinkingContent] ?? '';
export const getDeltaRedactedData = delta => delta?.[schema.sseDelta.redactedData] ?? '';
export const getDeltaStopReason   = delta => delta?.[schema.sseDelta.stopReason] ?? '';

// ─── message_start event ─────────────────────────────────────────────────────

export const getMessageStartModel       = evt => evt?.message?.[schema.messageStartEvent.model] ?? '';
export const getMessageStartInputTokens = evt => evt?.message?.usage?.[schema.messageStartEvent.inputTokens] ?? 0;

// ─── message_delta event ─────────────────────────────────────────────────────

export const getMessageDeltaOutputTokens = evt => evt?.usage?.[schema.messageDeltaEvent.outputTokens] ?? 0;

// ─── Signature heuristic ─────────────────────────────────────────────────────
//
// Only Anthropic produces non-empty signatures (cryptographic, API-key-bound).
// Custom providers either omit `signature` or set it to "".
// If Anthropic changes the signature representation, update only this function.

export function hasValidSignature(block) {
  const sig = getBlockSignature(block);
  return typeof sig === 'string' && sig.length > 0;
}

// ─── Block helpers ────────────────────────────────────────────────────────────

/**
 * Return a shallow copy of block with cache_control omitted.
 * Used by sanitizers that must strip the field before forwarding to
 * non-compliant providers. Centralised here so a field rename only
 * touches api-schema.json and this one line.
 */
export function omitCacheControl(block) {
  const { [schema.contentBlock.cacheControl]: _, ...rest } = block;
  return rest;
}
