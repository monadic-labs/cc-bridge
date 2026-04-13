import { Result } from './types.js';
import { ArgumentError } from './exceptions.js';
import { parseTarget } from './config-adapter.js';

const VALID_RULE_TYPES = Object.freeze(['exact', 'regex', 'property', 'payloadSize']);
const VALID_OPERATORS = Object.freeze(['gt', 'lt', 'gte', 'lte']);

function validateRuleDef(ruleDef) {
  if (!ruleDef || typeof ruleDef !== 'object') {
    return Result.fail(new ArgumentError('Rule definition must be an object'));
  }

  const { type } = ruleDef;

  if (!VALID_RULE_TYPES.includes(type)) {
    return Result.fail(new ArgumentError(`Rule type must be one of ${VALID_RULE_TYPES.join(', ')}`, { context: { type } }));
  }

  // Resolve target: accept dot notation "target" or separate targetProvider/targetModel
  let targetProvider = ruleDef.targetProvider;
  let targetModel = ruleDef.targetModel;

  if (ruleDef.target && typeof ruleDef.target === 'string') {
    try {
      const parsed = parseTarget(ruleDef.target);
      targetProvider = parsed.providerId;
      targetModel = parsed.model;
    } catch (e) {
      return Result.fail(e);
    }
  }

  if (typeof targetProvider !== 'string' || !targetProvider) {
    return Result.fail(new ArgumentError('targetProvider is required (use targetProvider+targetModel or target in "provider.model" format)'));
  }

  if (typeof targetModel !== 'string' || !targetModel) {
    return Result.fail(new ArgumentError('targetModel is required'));
  }

  if (ruleDef.fallback !== undefined && ruleDef.fallback !== null) {
    if (typeof ruleDef.fallback !== 'object') {
      return Result.fail(new ArgumentError('fallback must be an object with providerId and model'));
    }
    if (typeof ruleDef.fallback.providerId !== 'string' || !ruleDef.fallback.providerId) {
      return Result.fail(new ArgumentError('fallback.providerId must be a non-empty string'));
    }
    if (typeof ruleDef.fallback.model !== 'string' || !ruleDef.fallback.model) {
      return Result.fail(new ArgumentError('fallback.model must be a non-empty string'));
    }
  }

  if (type === 'exact') {
    if (typeof ruleDef.match !== 'string' || !ruleDef.match) {
      return Result.fail(new ArgumentError('exact rule requires a non-empty "match" field'));
    }
  }

  if (type === 'regex') {
    if (typeof ruleDef.pattern !== 'string' || !ruleDef.pattern) {
      return Result.fail(new ArgumentError('regex rule requires a non-empty "pattern" field'));
    }
    try {
      new RegExp(ruleDef.pattern);
    } catch (e) {
      return Result.fail(new ArgumentError(`Invalid regex pattern: ${e.message}`, { context: { pattern: ruleDef.pattern } }));
    }
  }

  if (type === 'property') {
    if (typeof ruleDef.property !== 'string' || !ruleDef.property) {
      return Result.fail(new ArgumentError('property rule requires a non-empty "property" field'));
    }
  }

  if (type === 'payloadSize') {
    if (typeof ruleDef.thresholdBytes !== 'number' || !Number.isInteger(ruleDef.thresholdBytes) || ruleDef.thresholdBytes <= 0) {
      return Result.fail(new ArgumentError('payloadSize rule requires a positive integer "thresholdBytes"'));
    }
    if (ruleDef.operator !== undefined && !VALID_OPERATORS.includes(ruleDef.operator)) {
      return Result.fail(new ArgumentError(`operator must be one of ${VALID_OPERATORS.join(', ')}`, { context: { operator: ruleDef.operator } }));
    }
  }

  return Result.ok(null);
}

function buildRuleEntry(ruleDef) {
  // Resolve target from dot notation if needed
  let targetProvider = ruleDef.targetProvider;
  let targetModel = ruleDef.targetModel;
  if (ruleDef.target && typeof ruleDef.target === 'string') {
    const parsed = parseTarget(ruleDef.target);
    targetProvider = parsed.providerId;
    targetModel = parsed.model;
  }

  const entry = { type: ruleDef.type, targetProvider, targetModel };

  if (ruleDef.type === 'exact') entry.match = ruleDef.match;
  if (ruleDef.type === 'regex') entry.pattern = ruleDef.pattern;
  if (ruleDef.type === 'property') entry.property = ruleDef.property;
  if (ruleDef.type === 'payloadSize') {
    entry.thresholdBytes = ruleDef.thresholdBytes;
    if (ruleDef.operator && ruleDef.operator !== 'gt') entry.operator = ruleDef.operator;
  }
  if (ruleDef.fallback) entry.fallback = { providerId: ruleDef.fallback.providerId, model: ruleDef.fallback.model };

  return entry;
}

export function addRule(rawPolicy, ruleDef) {
  const validation = validateRuleDef(ruleDef);
  if (validation.isFail ?? !validation.isSuccess) return validation;

  const policy = Array.isArray(rawPolicy) ? rawPolicy.map(r => ({ ...r })) : [];

  // Check for duplicate exact matches
  if (ruleDef.type === 'exact') {
    const existing = policy.find(r => r.type === 'exact' && r.match === ruleDef.match);
    if (existing) {
      return Result.fail(new ArgumentError(`Duplicate exact match: "${ruleDef.match}"`, { context: { match: ruleDef.match } }));
    }
  }

  policy.push(buildRuleEntry(ruleDef));
  return Result.ok(policy);
}

export function removeRule(rawPolicy, ruleIndex) {
  const policy = Array.isArray(rawPolicy) ? rawPolicy.map(r => ({ ...r })) : [];

  if (typeof ruleIndex !== 'number' || !Number.isInteger(ruleIndex) || ruleIndex < 0 || ruleIndex >= policy.length) {
    return Result.fail(new ArgumentError(`Rule index ${ruleIndex} is out of range (0-${policy.length - 1})`, { context: { ruleIndex, policySize: policy.length } }));
  }

  return Result.ok(policy.filter((_, i) => i !== ruleIndex));
}

export function listRules(rawPolicy) {
  if (!Array.isArray(rawPolicy)) return [];
  return rawPolicy.map((rule, index) => {
    const summary = { index, type: rule.type, targetProvider: rule.targetProvider, targetModel: rule.targetModel };

    if (rule.type === 'exact') summary.match = rule.match;
    if (rule.type === 'regex') summary.pattern = rule.pattern;
    if (rule.type === 'property') summary.property = rule.property;
    if (rule.type === 'payloadSize') {
      summary.thresholdBytes = rule.thresholdBytes;
      summary.operator = rule.operator || 'gt';
    }
    if (rule.fallback) summary.fallback = rule.fallback;

    return summary;
  });
}

export function formatRuleTree(rawPolicy) {
  if (!Array.isArray(rawPolicy) || rawPolicy.length === 0) return '(no rules)';

  const lines = [];
  for (let i = 0; i < rawPolicy.length; i++) {
    const rule = rawPolicy[i];
    const branch = i === rawPolicy.length - 1 ? '\u2514\u2500\u2500' : '\u251C\u2500\u2500';

    let desc;
    if (rule.type === 'exact') desc = `match="${rule.match}"`;
    else if (rule.type === 'regex') desc = `pattern=/${rule.pattern}/`;
    else if (rule.type === 'property') desc = `property="${rule.property}"`;
    else if (rule.type === 'payloadSize') desc = `size ${rule.operator || '>'} ${rule.thresholdBytes} bytes`;
    else desc = '(unknown)';

    let line = `${branch} [${i}] ${rule.type}: ${desc} \u2192 ${rule.targetProvider}/${rule.targetModel}`;
    if (rule.fallback) line += ` [fallback: ${rule.fallback.providerId}/${rule.fallback.model}]`;
    lines.push(line);
  }

  return lines.join('\n');
}
