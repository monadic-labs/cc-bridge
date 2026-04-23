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

import { BLOCK_TYPES } from '../core/types.js';
import {
  getSystemBlockText,
  getBlockType, getBlockText, getBlockThinking, getBlockRedactedData, getBlockToolContent,
  hasValidSignature, omitCacheControl,
  getSystem, getMessages,
} from '../core/api-adapter.js';

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
    return { content: mergeAdjacentTextBlocks(safeBlocks), conversions };
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

function mergeAdjacentTextBlocks(blocks) {
  const merged = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    if (last && last.type === 'text' && block.type === 'text') {
      last.text = (last.text || '') + '\n' + (block.text || '');
      continue;
    }
    merged.push({ ...block });
  }
  return merged;
}
