/**
 * Sanitization extension for multi-provider routing.
 *
 * Converts Anthropic-specific block types (thinking, redacted_thinking,
 * connector_text) to text blocks when switching between providers.
 * Compliant providers (Anthropic) preserve signed thinking blocks;
 * non-compliant providers strip all thinking blocks regardless.
 *
 * Also sanitizes tool_result content arrays (non-compliant only) and
 * strips cache_control from generic blocks (non-compliant only).
 */

import { BLOCK_TYPES } from '../../core/types.js';
import {
  getSystemBlockText as _getSystemBlockText,
  getBlockType, getBlockText, getBlockThinking, getBlockRedactedData, getBlockToolContent,
  hasValidSignature, omitCacheControl,
  getSystem, getMessages,
} from '../../core/api-adapter.js';

export const EXTENSION_META = {
  activation: 'always',
  title: 'Sanitization',
  description: 'Adapts Anthropic-specific block types for cross-provider routing. Compliant providers keep signed thinking/redacted_thinking blocks; non-compliant providers get those converted to text plus cache_control stripped from generic and tool_result blocks.',
  configuredBy: 'providers[*].anthropicCompliant',
};

export function createSanitizationExtension() {
  return {
    name: 'sanitization',

    hooks: {
      requestTransform: {
        order: 5,
        transform: ({ body, provider }) => transformSanitize(body, provider?.anthropicCompliant ?? false),
      },
    },
  };
}

function transformSanitize(body, isCompliant) {
  const system = getSystem(body);
  const messages = getMessages(body);
  if (!messages && !system) return body;

  let report = { convertedCount: 0, convertedTypes: [] };

  let safeSystem = system;
  if (system !== undefined && system !== null) {
    const result = sanitizeContent(system, isCompliant);
    safeSystem = result.content;
    report.convertedCount += result.conversions.length;
    report.convertedTypes = [...new Set([...report.convertedTypes, ...result.conversions])];
  }

  let safeMessages = messages;
  if (Array.isArray(messages)) {
    const result = sanitizeMessages(messages, isCompliant);
    safeMessages = result.messages;
    report = mergeReports(report, result.report);
  }

  return { ...body, system: safeSystem, messages: safeMessages, _ccbSanitizationReport: report };
}

function mergeReports(a, b) {
  return {
    convertedCount: a.convertedCount + b.convertedCount,
    convertedTypes: [...new Set([...a.convertedTypes, ...b.convertedTypes])],
  };
}

function sanitizeMessages(messages, isCompliant) {
  const allConversions = [];
  const sanitized = messages.map(m => {
    const { message, conversions } = sanitizeMessage(m, isCompliant);
    allConversions.push(...conversions);
    return message;
  });
  return { messages: sanitized, report: { convertedCount: allConversions.length, convertedTypes: [...new Set(allConversions)] } };
}

function sanitizeMessage(m, isCompliant) {
  if (!m || typeof m !== 'object') return { message: m, conversions: [] };
  const { content, conversions } = sanitizeContent(m.content, isCompliant);
  return { message: { ...m, content }, conversions };
}

function sanitizeContent(content, isCompliant) {
  if (typeof content === 'string') return { content, conversions: [] };
  if (Array.isArray(content)) {
    const conversions = [];
    const safeBlocks = content.map(b => {
      const { block, converted, originalType } = sanitizeBlock(b, isCompliant);
      if (converted) conversions.push(originalType);
      return block;
    });
    // Only merge when sanitization actually converted something — that's the
    // only case where adjacent text blocks can appear as a side-effect of
    // this pass. Otherwise pass blocks through verbatim and respect the
    // caller's block structure (especially per-block cache_control markers).
    const finalBlocks = conversions.length > 0
      ? mergeAdjacentTextBlocks(safeBlocks)
      : safeBlocks;
    return { content: finalBlocks, conversions };
  }
  if (typeof content === 'object' && content !== null) {
    const { block, converted, originalType } = sanitizeBlock(content, isCompliant);
    return { content: block, conversions: converted ? [originalType] : [] };
  }
  return { content, conversions: [] };
}

function sanitizeBlock(block, isCompliant) {
  if (typeof block !== 'object' || block === null) return { block, converted: false };

  const originalType = getBlockType(block);
  let result;

  const blockHandlers = {
    [BLOCK_TYPES.THINKING]: () => sanitizeThinkingBlock(block, isCompliant),
    [BLOCK_TYPES.REDACTED_THINKING]: () => sanitizeRedactedThinking(block, isCompliant),
    [BLOCK_TYPES.CONNECTOR_TEXT]: () => sanitizeConnectorText(block, isCompliant),
    [BLOCK_TYPES.TOOL_RESULT]: () => !isCompliant ? sanitizeToolResult(block) : null,
  };

  const handler = blockHandlers[originalType];
  result = handler ? handler() : null;
  if (result === null) result = sanitizeGenericBlock(block, isCompliant);

  const converted = result.type !== originalType;
  return { block: result, converted, originalType: converted ? originalType : undefined };
}

function sanitizeThinkingBlock(block, isCompliant) {
  if (isCompliant && hasValidSignature(block)) return block;
  return { type: BLOCK_TYPES.TEXT, text: `\`\`\`thinking\n${getBlockThinking(block)}\n\`\`\`\n` };
}

function sanitizeRedactedThinking(block, isCompliant) {
  if (isCompliant && hasValidSignature(block)) return block;
  const data = getBlockRedactedData(block) || '[Redacted Thinking]';
  return { type: BLOCK_TYPES.TEXT, text: `\`\`\`thinking\n${data}\n\`\`\`\n` };
}

function sanitizeConnectorText(block, isCompliant) {
  if (isCompliant && hasValidSignature(block)) return block;
  return { type: BLOCK_TYPES.TEXT, text: `[Connector Text]\n${getBlockText(block)}` };
}

function sanitizeToolResult(block) {
  const rest = omitCacheControl(block);
  const toolContent = getBlockToolContent(rest);
  if (!Array.isArray(toolContent)) return rest;
  const joinedContent = toolContent.map(extractToolResultText).join('\n');
  return { ...rest, content: joinedContent };
}

function sanitizeGenericBlock(block, isCompliant) {
  if (isCompliant) return block;
  return omitCacheControl(block);
}

function extractToolResultText(block) {
  if (typeof block === 'string') return block;
  const text = getBlockText(block);
  if (text) return text;
  return JSON.stringify(block);
}

/**
 * Merge adjacent text blocks ONLY when they are structurally equivalent:
 * same `cache_control` (deep-equal, including undefined-vs-absent) and no
 * other distinguishing fields. The purpose of this pass is to coalesce
 * back-to-back text blocks produced when sanitization converts thinking →
 * text — NOT to collapse a system array that the caller deliberately split
 * with per-block cache_control markers.
 *
 * Bug history: a blind merge dropped cache_control from later blocks and
 * concatenated everything into a single text block, which tripped a
 * non-UTF-8-safe parser on z.ai's Anthropic adapter for any non-ASCII
 * content. Direct claude→z.ai sends the unmerged 3-block system and works;
 * the merge was the divergence.
 */
/**
 * Structural equality on cache_control objects. Enumerates every key on
 * both sides so a future Anthropic field (priority, region, etc.) cannot
 * silently treat differing values as equal and trigger a wrong merge.
 * Fail-closed: any key mismatch in either direction prevents the merge.
 * Exported for direct unit testing — private to the merge logic otherwise.
 */
export function isSameCacheControl(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

function mergeAdjacentTextBlocks(blocks) {
  const merged = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    const canMerge = last
      && last.type === 'text'
      && block.type === 'text'
      && isSameCacheControl(last.cache_control, block.cache_control)
      && Object.keys(last).every(k => k === 'type' || k === 'text' || k === 'cache_control')
      && Object.keys(block).every(k => k === 'type' || k === 'text' || k === 'cache_control');
    if (canMerge) {
      last.text = (last.text || '') + '\n' + (block.text || '');
      continue;
    }
    merged.push({ ...block });
  }
  return merged;
}
