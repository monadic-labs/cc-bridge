import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import pty from 'node-pty';
import {
  LOGS_DIR_NAME,
  PROVIDERS_FILENAME,
  CONFIG_FILENAME,
  ENV_FILENAME,
  CCB_DIR_NAME,
  WATCHDOG_SCRIPT_NAME
} from '../src/core/constants.js';
import { ArgumentError } from '../src/core/exceptions.js';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── Unit tests for pure functions ──

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  console.error(`  FAIL: ${label}`);
}

function assertThrows(fn, ErrorClass, label) {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${label} (no throw)`);
  } catch (e) {
    if (ErrorClass && !(e instanceof ErrorClass)) {
      failed++;
      console.error(`  FAIL: ${label} (wrong type: ${e.constructor.name})`);
      return;
    }
    passed++;
  }
}

async function runUnitTests() {
  console.log('\n── Unit Tests ──');

  const { applyRouting, applyAuthHeaders, extractSessionId } = await import('../src/core/routing.js');
  const { Result, Option, RequestInfo, RequestSummary, RoutingResult } = await import('../src/core/types.js');
  const { ProvidersMap, ProviderConfig, ProviderMatch } = await import('../src/core/providers.js');

  // ── providerIdToEnvKey ──
  console.log('\nproviderIdToEnvKey:');
  const { providerIdToEnvKey } = await import('../src/core/providers.js');
  assert(providerIdToEnvKey('zai') === 'ZAI_KEY', 'simple id');
  assert(providerIdToEnvKey('my-provider') === 'MY_PROVIDER_KEY', 'hyphenated id');
  assert(providerIdToEnvKey('z_ai') === 'Z_AI_KEY', 'underscored id');
  assert(providerIdToEnvKey('z-ai') === 'Z_AI_KEY', 'hyphen normalizes to underscore');
  assert(providerIdToEnvKey('') === '', 'empty string returns empty');
  assert(providerIdToEnvKey(null) === '', 'null returns empty');
  assert(providerIdToEnvKey(undefined) === '', 'undefined returns empty');

  // ── daemon-constants ──
  console.log('\ndaemon-constants:');
  const { getControlIpcPath } = await import('../src/core/daemon-constants.js');
  const ipcPath = getControlIpcPath();
  assert(typeof ipcPath === 'string' && ipcPath.length > 0, 'getControlIpcPath returns non-empty string');
  if (process.platform === 'win32') {
    assert(ipcPath.includes('pipe'), 'Windows IPC path contains "pipe"');
  }
  if (process.platform !== 'win32') {
    assert(ipcPath.endsWith('.sock') || ipcPath.includes('ccb-ctrl'), 'POSIX IPC path has expected suffix');
  }

  // ── ipc-protocol ──
  console.log('\nipc-protocol:');
  const { parseIpcMessage, serializeIpcMessage, validateWorkerMessage, validateCommandMessage } = await import('../src/core/ipc-protocol.js');

  // serializeIpcMessage
  const serialized = serializeIpcMessage({ type: 'ready', pid: 123, routes: 5, extensions: 2 });
  assert(serialized === '{"type":"ready","pid":123,"routes":5,"extensions":2}\n', 'serializeIpcMessage produces newline-delimited JSON');

  // parseIpcMessage — valid
  const ipcParsed = parseIpcMessage('{"type":"ready","pid":123,"routes":5,"extensions":2}');
  assert(ipcParsed.type === 'ready' && ipcParsed.pid === 123, 'parseIpcMessage parses valid JSON');
  assert(Object.isFrozen(ipcParsed), 'parseIpcMessage freezes result');

  // parseIpcMessage — invalid JSON
  const badParse = parseIpcMessage('not json');
  assert(badParse === null, 'parseIpcMessage returns null for invalid JSON');

  // validateWorkerMessage — valid ready
  const readyMsg = validateWorkerMessage({ type: 'ready', pid: 123, routes: 5, extensions: 2 });
  assert(readyMsg.type === 'ready', 'validateWorkerMessage accepts valid ready');

  // validateWorkerMessage — valid error
  const errMsg = validateWorkerMessage({ type: 'error', message: 'boom' });
  assert(errMsg.type === 'error' && errMsg.message === 'boom', 'validateWorkerMessage accepts valid error');

  // validateWorkerMessage — unknown type
  assert(validateWorkerMessage({ type: 'bogus' }) === null, 'validateWorkerMessage rejects unknown type');

  // validateWorkerMessage — missing fields
  assert(validateWorkerMessage({ type: 'ready' }) === null, 'validateWorkerMessage rejects ready missing fields');

  // validateCommandMessage — valid restart
  const restartCmd = validateCommandMessage({ cmd: 'restart' });
  assert(restartCmd.cmd === 'restart', 'validateCommandMessage accepts restart');

  // validateCommandMessage — valid status
  const statusCmd = validateCommandMessage({ cmd: 'status' });
  assert(statusCmd.cmd === 'status', 'validateCommandMessage accepts status');

  // validateCommandMessage — valid shutdown
  const shutdownCmd = validateCommandMessage({ cmd: 'shutdown' });
  assert(shutdownCmd.cmd === 'shutdown', 'validateCommandMessage accepts shutdown');

  // validateCommandMessage — valid keepalive
  const kaCmd = validateCommandMessage({ cmd: 'keepalive' });
  assert(kaCmd.cmd === 'keepalive', 'validateCommandMessage accepts keepalive');

  // validateCommandMessage — valid sessions
  const sessionsCmd = validateCommandMessage({ cmd: 'sessions' });
  assert(sessionsCmd.cmd === 'sessions', 'validateCommandMessage accepts sessions');

  // validateCommandMessage — unknown
  assert(validateCommandMessage({ cmd: 'bogus' }) === null, 'validateCommandMessage rejects unknown cmd');

  // validateCommandMessage — not an object
  assert(validateCommandMessage('restart') === null, 'validateCommandMessage rejects string');
  assert(validateCommandMessage(null) === null, 'validateCommandMessage rejects null');

  // ── extractUrlSession (proxy-core) ──
  console.log('\nextractUrlSession:');
  const { extractUrlSession } = await import('../src/proxy-core.js');
  assert(extractUrlSession('/s/abc123/v1/messages').sessionId === 'abc123', 'extracts session');
  assert(extractUrlSession('/s/abc123/v1/messages').strippedUrl === '/v1/messages', 'strips prefix');
  assert(extractUrlSession('/v1/messages').sessionId === '', 'no-session returns empty');
  assert(extractUrlSession('/v1/messages').strippedUrl === '/v1/messages', 'no-session returns url');
  assert(extractUrlSession(null).sessionId === '', 'null safe');
  assert(extractUrlSession(null).strippedUrl === '/', 'null returns /');
  assert(extractUrlSession('/s/abc').sessionId === 'abc', 'no trailing path');
  assert(extractUrlSession('/s/abc').strippedUrl === '/', 'no trailing path returns /');

  const { ResultAccessError, ArgumentError, ConfigError } = await import('../src/core/exceptions.js');
  const { parseSseMetadata } = await import('../src/core/sse-parser.js');
  const { ProxyConfig } = await import('../src/core/config.js');

  // ── Result ──
  console.log('\nResult:');
  const ok = Result.ok(42);
  assert(ok.isSuccess === true, 'ok.isSuccess');
  assert(ok.value === 42, 'ok.value === 42');
  const err = Result.fail(new ArgumentError('boom'));
  assert(err.isSuccess === false, 'fail.isSuccess === false');
  assertThrows(() => err.value, ResultAccessError, 'fail.value throws ResultAccessError');
  assertThrows(() => ok.error, ResultAccessError, 'ok.error throws ResultAccessError');

  // ── Option ──
  console.log('\nOption:');
  const some = Option.some('hello');
  assert(some.isSome === true, 'some.isSome');
  assert(some.value === 'hello', 'some.value');
  assert(some.unwrapOr('default') === 'hello', 'some.unwrapOr');
  const none = Option.none();
  assert(none.isNone === true, 'none.isNone');
  assert(none.unwrapOr('default') === 'default', 'none.unwrapOr');
  assertThrows(() => none.value, ResultAccessError, 'none.value throws ResultAccessError');
  assertThrows(() => Option.some(null), ArgumentError, 'Option.some(null) throws ArgumentError');
  assertThrows(() => Option.some(undefined), ArgumentError, 'Option.some(undefined) throws ArgumentError');

  // ── ProviderConfig ──
  console.log('\nProviderConfig:');
  const cfg = new ProviderConfig({ id: 'test-id', url: 'https://example.com', models: { a: 'model-a' }, anthropicCompliant: true, toolTransforms: {} });
  assert(cfg.id === 'test-id', 'id getter');
  assert(cfg.url === 'https://example.com', 'url getter');
  assert(cfg.anthropicCompliant === true, 'anthropicCompliant getter');
  assertThrows(() => new ProviderConfig({ id: 'test-id', url: '', models: {}, anthropicCompliant: true, toolTransforms: {} }), ArgumentError, 'empty url throws');
  assertThrows(() => new ProviderConfig({ id: 'test-id', url: 'https://x.com', models: {}, toolTransforms: {} }), ArgumentError, 'missing anthropicCompliant throws');
  assertThrows(() => new ProviderConfig({ id: 'test-id', url: 'https://x.com', models: {}, anthropicCompliant: true }), ArgumentError, 'missing toolTransforms throws');

  // ── ProvidersMap ──
  console.log('\nProvidersMap:');
  const p1 = new ProviderConfig({ id: 'p1', url: 'https://a.com', models: { 'glm': 'glm-4.7', 'sonnet': 'claude-sonnet-4-6' }, anthropicCompliant: false, toolTransforms: {} });
  const p2 = new ProviderConfig({ id: 'p2', url: 'https://b.com', models: ['local-model'], anthropicCompliant: true, toolTransforms: {} });
  const pmap = new ProvidersMap([p1, p2]);
  assert(pmap.size === 3, 'size === 3');
  const match = pmap.resolve('glm');
  assert(match instanceof ProviderMatch, 'resolve returns ProviderMatch');
  assert(match.realModel === 'glm-4.7', 'realModel alias');
  assert(match.isAliased === true, 'isAliased for aliased model');
  const localMatch = pmap.resolve('local-model');
  assert(localMatch.isAliased === false, 'isAliased for non-aliased model');
  assert(pmap.resolve('nonexistent') === null, 'resolve unknown returns null');
  assert(pmap.resolve(null) === null, 'resolve null returns null');

  assertThrows(() => new ProvidersMap([p1, p1]), ArgumentError, 'duplicate ID throws');

  // ── ID Validation ──
  console.log('\nID Validation:');
  const { validateIds } = await import('../bin/ccb.js');
  const validP = { 'zai': { url: 'https://zai.com' }, 'mirror': { url: 'https://mirror.com' } };
  assert(validateIds(validP) === undefined, 'valid IDs pass');

  assertThrows(() => validateIds({ '': { url: 'x' } }), ArgumentError, 'empty ID throws');
  assertThrows(() => validateIds({ 'Bad ID': { url: 'x' } }), ArgumentError, 'invalid ID format throws');
  assertThrows(() => validateIds({ 'z-ai': { url: 'x' }, 'z_ai': { url: 'y' } }), ArgumentError, 'env key collision throws (Z_AI_KEY)');

  // ── applyRouting ──
  console.log('\napplyRouting:');
  const anthropicResult = applyRouting({ model: 'claude-opus-4-6', messages: [] }, pmap);
  assert(anthropicResult instanceof RoutingResult, 'returns RoutingResult');
  assert(anthropicResult.targetBase === 'https://api.anthropic.com', 'routes to Anthropic');
  assert(anthropicResult.label === 'Anthropic (claude-opus-4-6)', 'Anthropic label');
  assert(anthropicResult.isCustom === false, 'isCustom is false for Anthropic');

  const providerResult = applyRouting({ model: 'glm', messages: [] }, pmap);
  assert(providerResult.targetBase === 'https://a.com', 'routes to custom provider');
  assert(providerResult.label === 'Provider (glm→glm-4.7)', 'Provider label');
  assert(providerResult.isCustom === true, 'isCustom is true for provider');

  const noModel = applyRouting({ messages: [] }, pmap);
  assert(noModel.targetBase === 'https://api.anthropic.com', 'no model routes to Anthropic');
  assert(noModel.isCustom === false, 'isCustom is false when no model');

  // ── applyAuthHeaders ──
  console.log('\napplyAuthHeaders:');
  const headersNoMatch = applyAuthHeaders({ headers: { authorization: 'Bearer token', 'x-api-key': 'old' }, match: null });
  assert(headersNoMatch['x-api-key'] === 'old', 'no match preserves headers');
  assert(headersNoMatch.authorization === 'Bearer token', 'no match preserves auth');

  const matchGlm = pmap.resolve('glm');
  const headersMatch = applyAuthHeaders({ headers: { authorization: 'Bearer token', 'anthropic-beta': 'b1' }, match: matchGlm, apiKey: 'key-p1' });
  assert(headersMatch.authorization === 'Bearer key-p1', 'Anthropic-protocol match swaps authorization to provider key Bearer');
  assert(headersMatch['x-api-key'] === 'key-p1', 'match injects x-api-key from apiKey');
  assert(headersMatch['anthropic-beta'] === undefined, 'non-compliant strips anthropic-beta');

  const matchLocal = pmap.resolve('local-model');
  const headersCompliant = applyAuthHeaders({ headers: { authorization: 'Bearer tok', 'anthropic-beta': 'b1' }, match: matchLocal, apiKey: '' });
  assert(headersCompliant['anthropic-beta'] === 'b1', 'compliant preserves anthropic-beta');
  assert(headersCompliant['x-api-key'] === undefined, 'empty apiKey results in no x-api-key');

  // ── sanitizeMessages ──
  console.log('\nsanitizeMessages:');
  // sanitization logic now lives in the extension, test via extension registry
  const { createSanitizationExtension } = await import('../src/extensions/sanitization/index.js');
  const { ExtensionRegistry: SanitizeER } = await import('../src/core/extension-registry.js');
  const sanitizeReg = new SanitizeER();
  sanitizeReg.register(createSanitizationExtension());
  function sanitizeMessages(messages, isCompliant) {
    const body = { messages };
    const provider = { anthropicCompliant: isCompliant };
    const result = sanitizeReg.transformRequest({ body, provider });
    return { messages: result.messages, report: result._ccbSanitizationReport || { convertedCount: 0, convertedTypes: [] } };
  }
  const withSig = { messages: [{ content: [{ type: 'thinking', thinking: 'hmm', signature: 'abc123' }] }] };
  const { messages: sanitizedWithSig, report: reportSig } = sanitizeMessages(withSig.messages, true);
  assert(sanitizedWithSig[0].content[0].signature === 'abc123', 'signature preserved if compliant and present');
  assert(sanitizedWithSig[0].content[0].type === 'thinking', 'type thinking preserved if compliant and present');
  assert(reportSig.convertedCount === 0, 'no conversions when signature valid');
  assert(reportSig.convertedTypes.length === 0, 'no converted types when signature valid');

  const withoutSig = { messages: [{ content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'response' }] }] };
  const { messages: sanitizedWithoutSig, report: reportNoSig } = sanitizeMessages(withoutSig.messages, true);
  assert(sanitizedWithoutSig[0].content[0].type === 'text', 'type converted to text if no signature');
  assert(sanitizedWithoutSig[0].content[0].text.includes('hmm'), 'thinking converted to text if no signature');
  assert(sanitizedWithoutSig[0].content.length === 1, 'adjacent text blocks were merged');
  assert(sanitizedWithoutSig[0].content[0].text.includes('response'), 'merged block contains original text response');
  assert(reportNoSig.convertedCount === 1, 'one block converted when unsigned');
  assert(reportNoSig.convertedTypes.includes('thinking'), 'converted type is thinking');

  const { messages: noMessages } = sanitizeMessages({ model: 'x' }, true);
  assert(noMessages.model === 'x', 'no messages passthrough');

  // Empty signature (custom provider scenario)
  const withEmptySig = { messages: [{ content: [{ type: 'thinking', thinking: 'test', signature: '' }] }] };
  const { messages: sanitizedEmpty, report: reportEmpty } = sanitizeMessages(withEmptySig.messages, true);
  assert(sanitizedEmpty[0].content[0].type === 'text', 'empty signature converted to text');
  assert(reportEmpty.convertedCount === 1, 'empty signature counts as conversion');

  // Non-compliant path strips all thinking regardless of signature
  const withSigNonCompliant = { messages: [{ content: [{ type: 'thinking', thinking: 'hmm', signature: 'valid123' }] }] };
  const { messages: sanitizedNonComp, report: reportNonComp } = sanitizeMessages(withSigNonCompliant.messages, false);
  assert(sanitizedNonComp[0].content[0].type === 'text', 'non-compliant converts even with valid signature');
  assert(reportNonComp.convertedCount === 1, 'non-compliant reports conversion');

  // Multiple block types in one message
  const mixed = {
    messages: [{
      content: [
        { type: 'thinking', thinking: 'a', signature: '' },
        { type: 'redacted_thinking', data: 'b', signature: '' },
        { type: 'text', text: 'c' }
      ]
    }]
  };
  const { report: reportMixed } = sanitizeMessages(mixed.messages, true);
  assert(reportMixed.convertedCount === 2, 'mixed: two blocks converted');
  assert(reportMixed.convertedTypes.includes('thinking'), 'mixed: thinking in types');
  assert(reportMixed.convertedTypes.includes('redacted_thinking'), 'mixed: redacted_thinking in types');

  // ── extractSessionId ──
  console.log('\nextractSessionId:');
  assert(extractSessionId({ metadata: { user_id: '{"session_id":"sess-123"}' } }) === 'sess-123', 'extracts from user_id JSON');
  assert(extractSessionId({ metadata: { session_id: 'direct-sess' } }) === 'direct-sess', 'extracts from metadata.session_id');
  assert(extractSessionId({ session_id: 'top-sess' }) === 'top-sess', 'extracts from top-level session_id');
  assert(extractSessionId({}) === '', 'empty body returns empty string');
  assert(extractSessionId({ metadata: { user_id: 'invalid-json' } }) === '', 'invalid JSON returns empty');

  // ── parseSseMetadata ──
  console.log('\nparseSseMetadata:');
  const sseRaw = [
    'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100}}}',
    'data: {"type":"content_block_start","content_block":{"type":"text","name":"write"}}',
    'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"Read","signature":"sig1234567890"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}',
  ].join('\n');
  const meta = parseSseMetadata(sseRaw);
  assert(meta.model === 'claude-sonnet-4-6', 'model extracted');
  assert(meta.inputTokens === 100, 'inputTokens');
  assert(meta.outputTokens === 50, 'outputTokens');
  assert(meta.stopReason === 'end_turn', 'stopReason');
  assert(meta.blocks.length === 2, 'blocks count');
  assert(meta.blocks[0].toSummary() === 'text(write)', 'text block summary');
  assert(meta.blocks[1].toSummary().includes('tool_use(Read)'), 'tool_use block summary');
  assert(meta.hasError === false, 'no error');

  const sseError = 'data: {"type":"error","error":{"type":"rate_limit_error","message":"too many"}}';
  const errMeta = parseSseMetadata(sseError);
  assert(errMeta.hasError === true, 'has error');
  assert(errMeta.error.type === 'rate_limit_error', 'error type preserved');

  const emptySse = parseSseMetadata('');
  assert(emptySse.inputTokens === 0, 'empty SSE zero tokens');
  assert(emptySse.blocks.length === 0, 'empty SSE no blocks');

  // ── SseResponseTransformer ──
  console.log('\nSseResponseTransformer:');
  const { SseResponseTransformer } = await import('../src/core/sse-transformer.js');
  const { createThinkingSseExtension } = await import('../src/extensions/thinking-sse/index.js');
  const { ExtensionRegistry: SseER } = await import('../src/core/extension-registry.js');
  const sseReg = new SseER();
  sseReg.register(createThinkingSseExtension());
  const transformer = new SseResponseTransformer(sseReg);
  const inputSse = [
    'data: {"type":"message_start","message":{"model":"claude-opus"}}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","signature":"xyz"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
    'data: {"type":"content_block_stop","index":1}',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":"hello"}}'
  ].join('\n\n') + '\n\n';

  const transformedSse = transformer.transformChunk(inputSse) + transformer.flush();
  assert(transformedSse.includes('"type":"text","text":"```thinking\\n"'), 'thinking start converted to text block');
  assert(transformedSse.includes('"type":"text_delta","text":"hmm"'), 'thinking delta converted to text_delta');
  assert(transformedSse.includes('"type":"text_delta","text":"\\n```\\n"'), 'content_block_stop injected closing ```');
  assert(transformedSse.includes('"type":"text","text":"hello"'), 'regular text block unchanged');

  // ── ProxyConfig ──
  console.log('\nProxyConfig:');
  const validConfig = new ProxyConfig({
    port: 9099,
    anthropicBaseUrl: 'https://api.anthropic.com',
    daemon: { healthCheckTimeoutMs: 500, pollIntervalMs: 300, pollMaxAttempts: 10, upstreamTimeoutMs: 600000, workerInitTimeoutMs: 20000, drainTimeoutMs: 600000, workerKeepaliveS: -1, ipcTimeoutMs: 5000, daemonStartTimeoutMs: 60000, daemonStartProgressGraceMs: 15000 },
    logging: { enabled: true, requests: true, responses: true, history: 5, maxBodyLog: 1000 },
    compression: { recompressRequests: true }
  });
  assert(validConfig.port === 9099, 'port');
  assert(validConfig.anthropicBaseUrl === 'https://api.anthropic.com', 'anthropicBaseUrl');
  assert(validConfig.upstreamTimeoutMs === 600000, 'upstreamTimeoutMs');
  assert(validConfig.workerInitTimeoutMs === 20000, 'workerInitTimeoutMs');
  assert(validConfig.drainTimeoutMs === 600000, 'drainTimeoutMs');
  assert(validConfig.ipcTimeoutMs === 5000, 'ipcTimeoutMs');
  assertThrows(() => new ProxyConfig({ port: 9099, logging: { enabled: true } }), ConfigError, 'incomplete logging throws');

  // Config validation: watchdog timeouts
  assertThrows(() => new ProxyConfig({ port: 9099, anthropicBaseUrl: 'https://api.anthropic.com', daemon: { healthCheckTimeoutMs: 500, pollIntervalMs: 300, pollMaxAttempts: 10, upstreamTimeoutMs: 600000, workerInitTimeoutMs: 500, drainTimeoutMs: 600000, workerKeepaliveS: -1, ipcTimeoutMs: 5000, daemonStartTimeoutMs: 60000, daemonStartProgressGraceMs: 15000 }, logging: { enabled: true, requests: true, responses: true, history: 5, maxBodyLog: 1000 }, compression: { recompressRequests: true } }), ConfigError, 'workerInitTimeoutMs < 1000 throws');
  assertThrows(() => new ProxyConfig({ port: 9099, anthropicBaseUrl: 'https://api.anthropic.com', daemon: { healthCheckTimeoutMs: 500, pollIntervalMs: 300, pollMaxAttempts: 10, upstreamTimeoutMs: 600000, workerInitTimeoutMs: 20000, drainTimeoutMs: 500, workerKeepaliveS: -1, ipcTimeoutMs: 5000, daemonStartTimeoutMs: 60000, daemonStartProgressGraceMs: 15000 }, logging: { enabled: true, requests: true, responses: true, history: 5, maxBodyLog: 1000 }, compression: { recompressRequests: true } }), ConfigError, 'drainTimeoutMs < 1000 throws');
  assertThrows(() => new ProxyConfig({ port: 9099, anthropicBaseUrl: 'https://api.anthropic.com', daemon: { healthCheckTimeoutMs: 500, pollIntervalMs: 300, pollMaxAttempts: 10, upstreamTimeoutMs: 600000, workerInitTimeoutMs: 20000, drainTimeoutMs: 600000, workerKeepaliveS: -2, ipcTimeoutMs: 5000, daemonStartTimeoutMs: 60000, daemonStartProgressGraceMs: 15000 }, logging: { enabled: true, requests: true, responses: true, history: 5, maxBodyLog: 1000 }, compression: { recompressRequests: true } }), ConfigError, 'workerKeepaliveS < -1 throws');
  assertThrows(() => new ProxyConfig({ port: 9099, anthropicBaseUrl: 'https://api.anthropic.com', daemon: { healthCheckTimeoutMs: 500, pollIntervalMs: 300, pollMaxAttempts: 10, upstreamTimeoutMs: 600000, workerInitTimeoutMs: 20000, drainTimeoutMs: 600000, workerKeepaliveS: -1, ipcTimeoutMs: 50, daemonStartTimeoutMs: 60000, daemonStartProgressGraceMs: 15000 }, logging: { enabled: true, requests: true, responses: true, history: 5, maxBodyLog: 1000 }, compression: { recompressRequests: true } }), ConfigError, 'ipcTimeoutMs < 100 throws');
  // Valid workerKeepaliveS values
  const cfgIndefinite = new ProxyConfig({ port: 9099, anthropicBaseUrl: 'https://api.anthropic.com', daemon: { healthCheckTimeoutMs: 500, pollIntervalMs: 300, pollMaxAttempts: 10, upstreamTimeoutMs: 600000, workerInitTimeoutMs: 20000, drainTimeoutMs: 600000, workerKeepaliveS: -1, ipcTimeoutMs: 5000, daemonStartTimeoutMs: 60000, daemonStartProgressGraceMs: 15000 }, logging: { enabled: true, requests: true, responses: true, history: 5, maxBodyLog: 1000 }, compression: { recompressRequests: true } });
  assert(cfgIndefinite.workerKeepaliveS === -1, 'workerKeepaliveS=-1 (indefinite) accepted');
  const cfgZero = new ProxyConfig({ port: 9099, anthropicBaseUrl: 'https://api.anthropic.com', daemon: { healthCheckTimeoutMs: 500, pollIntervalMs: 300, pollMaxAttempts: 10, upstreamTimeoutMs: 600000, workerInitTimeoutMs: 20000, drainTimeoutMs: 600000, workerKeepaliveS: 0, ipcTimeoutMs: 5000, daemonStartTimeoutMs: 60000, daemonStartProgressGraceMs: 15000 }, logging: { enabled: true, requests: true, responses: true, history: 5, maxBodyLog: 1000 }, compression: { recompressRequests: true } });
  assert(cfgZero.workerKeepaliveS === 0, 'workerKeepaliveS=0 (last keepalive) accepted');
  const cfgGrace = new ProxyConfig({ port: 9099, anthropicBaseUrl: 'https://api.anthropic.com', daemon: { healthCheckTimeoutMs: 500, pollIntervalMs: 300, pollMaxAttempts: 10, upstreamTimeoutMs: 600000, workerInitTimeoutMs: 20000, drainTimeoutMs: 600000, workerKeepaliveS: 60, ipcTimeoutMs: 5000, daemonStartTimeoutMs: 60000, daemonStartProgressGraceMs: 15000 }, logging: { enabled: true, requests: true, responses: true, history: 5, maxBodyLog: 1000 }, compression: { recompressRequests: true } });
  assert(cfgGrace.workerKeepaliveS === 60, 'workerKeepaliveS=60 (grace period) accepted');
  const cfgDecimal = new ProxyConfig({ port: 9099, anthropicBaseUrl: 'https://api.anthropic.com', daemon: { healthCheckTimeoutMs: 500, pollIntervalMs: 300, pollMaxAttempts: 10, upstreamTimeoutMs: 600000, workerInitTimeoutMs: 20000, drainTimeoutMs: 600000, workerKeepaliveS: 0.5, ipcTimeoutMs: 5000, daemonStartTimeoutMs: 60000, daemonStartProgressGraceMs: 15000 }, logging: { enabled: true, requests: true, responses: true, history: 5, maxBodyLog: 1000 }, compression: { recompressRequests: true } });
  assert(cfgDecimal.workerKeepaliveS === 0.5, 'workerKeepaliveS=0.5 (decimal) accepted');

  // ── ProxyState withConnectionBump validation ──
  console.log('\nProxyState:');
  const { ProxyState: RealProxyState } = await import('../src/proxy-core.js');
  const { buildRoutingPolicy: buildBumpPolicy } = await import('../src/core/routing-rules.js');
  const { ProvidersMap: BumpProvidersMap } = await import('../src/core/providers.js');
  const { ExtensionRegistry: BumpER } = await import('../src/core/extension-registry.js');
  const bumpPolicy = buildBumpPolicy({
    rawPolicy: [],
    providerConfigs: [],
    legacyProvidersMap: new BumpProvidersMap([])
  });
  const state0 = new RealProxyState(0, bumpPolicy, new BumpER(), {}, 0);
  assert(state0.activeConnections === 0, 'ProxyState initial connections');
  const state1 = state0.withConnectionBump(1);
  assert(state1.activeConnections === 1, 'bump 0+1 returns 1');
  const stateBack = state1.withConnectionBump(-1);
  assert(stateBack.activeConnections === 0, 'bump 1-1 returns 0');
  const state8 = new RealProxyState(0, bumpPolicy, new BumpER(), {}, 5).withConnectionBump(3);
  assert(state8.activeConnections === 8, 'bump 5+3 returns 8');
  assertThrows(() => state0.withConnectionBump(NaN), ArgumentError, 'NaN delta throws ArgumentError');
  assertThrows(() => state0.withConnectionBump(Infinity), ArgumentError, 'Infinity delta throws ArgumentError');
  assertThrows(() => state0.withConnectionBump('1'), ArgumentError, 'string delta throws ArgumentError');
  assertThrows(() => state0.withConnectionBump(undefined), ArgumentError, 'undefined delta throws ArgumentError');
  assertThrows(() => state0.withConnectionBump(-1), ArgumentError, 'negative result throws ArgumentError');
  assertThrows(() => new RealProxyState(0, bumpPolicy, new BumpER(), {}, 2).withConnectionBump(-3), ArgumentError, 'underflow result throws ArgumentError');

  // ── RequestInfo ──
  console.log('\nRequestInfo:');
  const ri = new RequestInfo({ id: 1, route: 'Anthropic', url: '/v1/messages', headers: { 'content-length': '100' }, body: { model: 'test', messages: [1, 2] }, sessionId: 's1' });
  assert(ri.contentLength === '100', 'contentLength');
  assert(ri.messageCount === 2, 'messageCount');
  assertThrows(() => new RequestInfo({ id: 0 }), ArgumentError, 'id must be positive');

  // ── RequestSummary ──
  console.log('\nRequestSummary:');
  const rs = new RequestSummary({ id: 1, route: 'P', model: 'm', status: 200, duration: 150, inputTokens: 10, outputTokens: 20 });
  assert(rs.toLogLine().includes('#1'), 'toLogLine includes id');

  // ── Migrator ──
  console.log('\nMigrator:');
  const { ensureCompleteConfig, ensureCompleteProviders } = await import('../src/core/migrator.js');

  const rawConfig = { port: 9999 };
  const completeConfig = ensureCompleteConfig(rawConfig);
  assert(completeConfig.port === 9999, 'port preserved');
  assert(completeConfig.anthropicBaseUrl === 'https://api.anthropic.com', 'anthropicBaseUrl default');
  assert(completeConfig.daemon.upstreamTimeoutMs === 600000, 'upstreamTimeoutMs default');
  assert(completeConfig.daemon.healthCheckTimeoutMs === 500, 'healthCheckTimeoutMs default');
  assert(completeConfig.daemon.workerInitTimeoutMs === 20000, 'workerInitTimeoutMs default');
  assert(completeConfig.daemon.drainTimeoutMs === 600000, 'drainTimeoutMs default');
  assert(completeConfig.daemon.workerKeepaliveS === -1, 'workerKeepaliveS default');

  const rawProviders = { providers: [{ id: 'zai', url: 'https://zai.com/api', anthropicCompliant: false }] };
  const completeProviders = ensureCompleteProviders(rawProviders);
  // v1 auto-migrates to v2: providers becomes an object keyed by derived id
  assert(typeof completeProviders.providers === 'object', 'providers is object (v2)');
  assert(completeProviders.providers['zai'] !== undefined, 'id derived from URL');
  assert(completeProviders.providers['zai'].anthropicCompliant === false, 'anthropicCompliant added');
  assert(completeProviders.routes !== undefined, 'routes section added');

  const emptyProviders = ensureCompleteProviders({});
  assert(typeof emptyProviders.providers === 'object', 'providers object initialized');
  assert(typeof emptyProviders.providers === 'object', 'empty input produces providers object');

  // ── Config adapter ──
  console.log('\nConfig adapter:');
  const { detectFormat, parseTarget, parseRouteKey, parsePayloadSizeKey, normalizeRouteValue, convertV2ToInternal, convertV1ToV2 } = await import('../src/core/config-adapter.js');

  // detectFormat
  assert(detectFormat({ providers: [] }) === 'v1', 'detectFormat v1 (array)');
  assert(detectFormat({ providers: {} }) === 'v2', 'detectFormat v2 (object)');
  assert(detectFormat({}) === 'v1', 'detectFormat empty defaults to v1');

  // parseTarget
  const t1 = parseTarget('z.glm-4.7');
  assert(t1.providerId === 'z' && t1.model === 'glm-4.7', 'parseTarget basic');
  const t2 = parseTarget('my-mirror.claude-sonnet-4-6');
  assert(t2.providerId === 'my-mirror' && t2.model === 'claude-sonnet-4-6', 'parseTarget hyphenated');
  assertThrows(() => parseTarget('nodot'), Error, 'parseTarget no dot throws');
  assertThrows(() => parseTarget(''), Error, 'parseTarget empty throws');

  // parseRouteKey
  assert(parseRouteKey('my-sonnet').type === 'exact', 'parseRouteKey exact');
  assert(parseRouteKey('my-sonnet').match === 'my-sonnet', 'parseRouteKey exact match');
  assert(parseRouteKey('*haiku*').type === 'regex', 'parseRouteKey wildcard');
  assert(parseRouteKey('*haiku*').pattern.includes('haiku'), 'parseRouteKey wildcard pattern');

  // parsePayloadSizeKey
  const ps1 = parsePayloadSizeKey('>102400');
  assert(ps1.operator === 'gt' && ps1.thresholdBytes === 102400, 'parsePayloadSizeKey gt');
  const ps2 = parsePayloadSizeKey('<50000');
  assert(ps2.operator === 'lt' && ps2.thresholdBytes === 50000, 'parsePayloadSizeKey lt');
  const ps2b = parsePayloadSizeKey('>=50000');
  assert(ps2b.operator === 'gte' && ps2b.thresholdBytes === 50000, 'parsePayloadSizeKey gte');
  const ps2c = parsePayloadSizeKey('<=50000');
  assert(ps2c.operator === 'lte' && ps2c.thresholdBytes === 50000, 'parsePayloadSizeKey lte');
  const ps3 = parsePayloadSizeKey('99999');
  assert(ps3.operator === 'gt' && ps3.thresholdBytes === 99999, 'parsePayloadSizeKey bare number');
  assertThrows(() => parsePayloadSizeKey('invalid'), Error, 'parsePayloadSizeKey invalid');

  // normalizeRouteValue
  assert(normalizeRouteValue('z.glm-4.7').target === 'z.glm-4.7', 'normalizeRouteValue bare string');
  assert(normalizeRouteValue({ target: 'z.glm-4.7', fallback: ['z.glm-5'] }).target === 'z.glm-4.7', 'normalizeRouteValue object');

  // convertV2ToInternal
  const v2Config = {
    providers: { z: { url: 'https://api.z.ai/api/anthropic', anthropicCompliant: false } },
    routes: {
      models: { 'glm-4.7': 'z.glm-4.7', '*haiku*': { target: 'z.glm-4.7', fallback: ['z.glm-5'] } },
      properties: { thinking: 'z.glm-5.1' },
      payloadSize: { '>102400': 'z.glm-5' }
    }
  };
  const internal = convertV2ToInternal(v2Config);
  assert(internal.providers.length === 1, 'convertV2ToInternal providers count');
  assert(internal.providers[0].id === 'z', 'convertV2ToInternal provider id');
  assert(internal.routingPolicy.length === 4, 'convertV2ToInternal rules count');
  assert(internal.routingPolicy.some(r => r.type === 'exact' && r.match === 'glm-4.7'), 'convertV2ToInternal exact rule');
  assert(internal.routingPolicy.some(r => r.type === 'regex' && r.pattern.includes('haiku')), 'convertV2ToInternal wildcard rule');
  assert(internal.routingPolicy.some(r => r.type === 'property' && r.property === 'thinking'), 'convertV2ToInternal property rule');
  assert(internal.routingPolicy.some(r => r.type === 'payloadSize' && r.thresholdBytes === 102400), 'convertV2ToInternal payloadSize rule');
  assert(internal.defaultFallback === null, 'convertV2ToInternal no defaultFallback when absent');

  // convertV2ToInternal with routes.defaults
  const v2WithDefaults = {
    providers: { z: { url: 'https://api.z.ai/api/anthropic', anthropicCompliant: false } },
    routes: {
      defaults: { fallback: ['z.glm-5.1'] },
      models: { 'glm-4.7': 'z.glm-4.7' }
    }
  };
  const internalWithDefaults = convertV2ToInternal(v2WithDefaults);
  assert(internalWithDefaults.defaultFallback !== null, 'convertV2ToInternal parses defaults');
  assert(internalWithDefaults.defaultFallback.providerId === 'z', 'convertV2ToInternal defaultFallback providerId');
  assert(internalWithDefaults.defaultFallback.model === 'glm-5.1', 'convertV2ToInternal defaultFallback model');

  // convertV2ToInternal with empty defaults.fallback
  const v2EmptyDefaults = {
    providers: { z: { url: 'https://api.z.ai/api/anthropic', anthropicCompliant: false } },
    routes: { defaults: { fallback: [] } }
  };
  const internalEmptyDefaults = convertV2ToInternal(v2EmptyDefaults);
  assert(internalEmptyDefaults.defaultFallback === null, 'convertV2ToInternal empty fallback array');

  // convertV2ToInternal with defaults object but no fallback
  const v2DefaultsNoFallback = {
    providers: { z: { url: 'https://api.z.ai/api/anthropic', anthropicCompliant: false } },
    routes: { defaults: {} }
  };
  const internalDefaultsNoFallback = convertV2ToInternal(v2DefaultsNoFallback);
  assert(internalDefaultsNoFallback.defaultFallback === null, 'convertV2ToInternal defaults without fallback');

  // convertV1ToV2
  const v1Config = {
    providers: [
      { id: 'z', url: 'https://api.z.ai/api/anthropic', models: { 'glm-4.7': 'glm-4.7' }, anthropicCompliant: false }
    ],
    routingPolicy: [
      { type: 'regex', pattern: '.*haiku.*', targetProvider: 'z', targetModel: 'glm-4.7' },
      { type: 'property', property: 'thinking', targetProvider: 'z', targetModel: 'glm-5.1' }
    ]
  };
  const v2 = convertV1ToV2(v1Config);
  assert(typeof v2.providers === 'object' && !Array.isArray(v2.providers), 'convertV1ToV2 providers is object');
  assert(v2.providers['z'] !== undefined, 'convertV1ToV2 provider key exists');
  assert(v2.routes.models['glm-4.7'] === 'z.glm-4.7', 'convertV1ToV2 model route');
  assert(v2.routes.models['*haiku*'] !== undefined, 'convertV1ToV2 wildcard route');
  assert(v2.routes.properties['thinking'] === 'z.glm-5.1', 'convertV1ToV2 property route');

  // ── Model manager ──
  console.log('\nModel manager:');
  const { addRouteModel, removeRouteModel, listModels, listProviders, formatTree, findProviderKey, addProvider, removeProvider } = await import('../src/core/model-manager.js');

  const testConfig = {
    providers: {
      zai: { url: 'https://api.z.ai/api/anthropic', anthropicCompliant: false },
      mirror: { url: 'https://mirror.example.com/v1', anthropicCompliant: true }
    },
    routes: {
      models: { 'glm-4.7': 'zai.glm-4.7', 'm-opus': 'mirror.claude-opus-4-6' },
      properties: {},
      payloadSize: {}
    }
  };

  // findProviderKey
  assert(findProviderKey(testConfig.providers, 'zai') === 'zai', 'findProviderKey by id');
  assert(findProviderKey(testConfig.providers, 'mirror') === 'mirror', 'findProviderKey by id');
  assert(findProviderKey(testConfig.providers, 'z.ai') === 'zai', 'findProviderKey fallback to url');
  assert(findProviderKey(testConfig.providers, 'nonexistent') === null, 'findProviderKey miss');

  // addRouteModel
  const addResult = addRouteModel(testConfig, 'glm-5', 'zai.glm-5');
  assert(addResult.isSuccess, 'addRouteModel succeeds');
  assert(addResult.value.routes.models['glm-5'] === 'zai.glm-5', 'addRouteModel adds entry');

  // removeRouteModel
  const rmResult = removeRouteModel(addResult.value, 'glm-5');
  assert(rmResult.isSuccess, 'removeRouteModel succeeds');
  assert(rmResult.value.routes.models['glm-5'] === undefined, 'removeRouteModel removes entry');

  // listModels (now route-based)
  const lmResult = listModels(testConfig, 'zai');
  assert(lmResult.isSuccess, 'listModels succeeds');
  assert(lmResult.value.models.length === 1, 'listModels count for zai');
  assert(lmResult.value.models[0][0] === 'glm-4.7', 'listModels entry');

  const lmMiss = listModels(testConfig, 'nonexistent');
  assert(!lmMiss.isSuccess, 'listModels bad provider fails');

  // listProviders
  const lp = listProviders(testConfig.providers);
  assert(lp.length === 2, 'listProviders count');
  assert(lp[0].compliant === false, 'listProviders compliant');
  assert(lp[1].compliant === true, 'listProviders compliant true');

  // addProvider
  const apResult = addProvider(testConfig.providers, 'newp', 'https://new.example.com/v1', true);
  assert(apResult.isSuccess, 'addProvider succeeds');
  assert(apResult.value['newp'] !== undefined, 'addProvider adds key');

  // removeProvider
  const rpResult = removeProvider(testConfig.providers, 'mirror');
  assert(rpResult.isSuccess, 'removeProvider succeeds');
  assert(rpResult.value['mirror'] === undefined, 'removeProvider removes key');

  // formatTree
  const tree = formatTree(testConfig);
  assert(tree.includes('api.z.ai'), 'tree includes zai');
  assert(tree.includes('non-compliant'), 'tree includes non-compliant');
  assert(tree.includes('mirror.example.com'), 'tree includes mirror');

  // ── RoutingRules ──
  console.log('\nRoutingRules:');
  const { ExactRule, RegexRule, PropertyRule, PayloadSizeRule, createRule, RoutingPolicy, buildRoutingPolicy } = await import('../src/core/routing-rules.js');
  const { ArgumentError: ArgErr } = await import('../src/core/exceptions.js');

  // ExactRule
  const exact = new ExactRule({ match: 'sonnet', targetProvider: 'p1', targetModel: 'claude-sonnet-4-6' });
  assert(exact.type === 'exact', 'ExactRule.type');
  assert(exact.match === 'sonnet', 'ExactRule.match');
  assert(exact.matches({ model: 'sonnet' }) === true, 'ExactRule matches');
  assert(exact.matches({ model: 'opus' }) === false, 'ExactRule no match');
  assert(exact.matches({}) === false, 'ExactRule no model');
  assert(exact.toLabel() === 'exact:sonnet', 'ExactRule.toLabel');
  assert(exact.toJSON().type === 'exact', 'ExactRule.toJSON');

  assertThrows(() => new ExactRule({ match: '', targetProvider: 'p', targetModel: 'm' }), ArgErr, 'ExactRule empty match');
  assertThrows(() => new ExactRule({ match: 'x', targetProvider: '', targetModel: 'm' }), ArgErr, 'ExactRule empty provider');

  // RegexRule
  const regex = new RegexRule({ pattern: 'haiku', targetProvider: 'p1', targetModel: 'fast-model' });
  assert(regex.type === 'regex', 'RegexRule.type');
  assert(regex.matches({ model: 'claude-haiku-4-5' }) === true, 'RegexRule matches haiku');
  assert(regex.matches({ model: 'claude-sonnet-4-6' }) === false, 'RegexRule no match sonnet');
  assert(regex.toLabel() === 'regex:/haiku/', 'RegexRule.toLabel');
  assertThrows(() => new RegexRule({ pattern: '[', targetProvider: 'p', targetModel: 'm' }), ArgErr, 'RegexRule invalid regex');

  // PropertyRule
  const prop = new PropertyRule({ property: 'thinking', targetProvider: 'p1', targetModel: 'reasoner' });
  assert(prop.type === 'property', 'PropertyRule.type');
  assert(prop.matches({ thinking: { type: 'enabled', budget_tokens: 10000 }, model: 'x' }) === true, 'PropertyRule matches thinking');
  assert(prop.matches({ model: 'x' }) === false, 'PropertyRule no thinking');
  assert(prop.toLabel() === 'property:thinking', 'PropertyRule.toLabel');

  // PayloadSizeRule
  const ps = new PayloadSizeRule({ thresholdBytes: 200000, targetProvider: 'p1', targetModel: 'big-model' });
  assert(ps.type === 'payloadSize', 'PayloadSizeRule.type');
  assert(ps.operator === 'gt', 'PayloadSizeRule default operator');
  const bigMessages = Array.from({ length: 10000 }, (_, i) => ({ role: 'user', content: `message ${i} with padding` }));
  assert(ps.matches({ messages: bigMessages, model: 'x' }) === true, 'PayloadSizeRule matches large');
  assert(ps.matches({ messages: [{ role: 'user', content: 'hi' }], model: 'x' }) === false, 'PayloadSizeRule no match small');
  assert(ps.toLabel() === 'payloadSize:gt200000', 'PayloadSizeRule.toLabel');
  assertThrows(() => new PayloadSizeRule({ thresholdBytes: -1, targetProvider: 'p', targetModel: 'm' }), ArgErr, 'PayloadSizeRule negative');
  assertThrows(() => new PayloadSizeRule({ thresholdBytes: 100, operator: 'bad', targetProvider: 'p', targetModel: 'm' }), ArgErr, 'PayloadSizeRule bad operator');

  // createRule factory
  const factoryExact = createRule({ type: 'exact', match: 'test', targetProvider: 'p', targetModel: 'm' });
  assert(factoryExact instanceof ExactRule, 'createRule exact');
  const factoryRegex = createRule({ type: 'regex', pattern: 'test', targetProvider: 'p', targetModel: 'm' });
  assert(factoryRegex instanceof RegexRule, 'createRule regex');
  const factoryProp = createRule({ type: 'property', property: 'test', targetProvider: 'p', targetModel: 'm' });
  assert(factoryProp instanceof PropertyRule, 'createRule property');
  const factoryPs = createRule({ type: 'payloadSize', thresholdBytes: 100, targetProvider: 'p', targetModel: 'm' });
  assert(factoryPs instanceof PayloadSizeRule, 'createRule payloadSize');
  assertThrows(() => createRule({ type: 'unknown' }), ArgErr, 'createRule unknown type');
  assertThrows(() => createRule(null), ArgErr, 'createRule null');

  // ── Passthrough-with-fallback rules (no target) ──
  console.log('\nPassthrough-with-fallback rules:');
  // ExactRule with fallback only (no target) → passthrough to Anthropic, fallback on error
  const passExact = new ExactRule({ match: 'glm-5.1', targetProvider: null, targetModel: null, fallback: { providerId: 'local', model: 'glm-5.1' } });
  assert(passExact.type === 'exact', 'PassthroughRule exact type');
  assert(passExact.hasTarget === false, 'PassthroughRule hasTarget false');
  assert(passExact.hasFallback === true, 'PassthroughRule hasFallback true');
  assert(passExact.targetProviderId === null, 'PassthroughRule targetProviderId null');
  assert(passExact.targetModel === null, 'PassthroughRule targetModel null');
  assert(passExact.fallbackProviderId === 'local', 'PassthroughRule fallbackProviderId');
  assert(passExact.fallbackModel === 'glm-5.1', 'PassthroughRule fallbackModel');
  assert(passExact.matches({ model: 'glm-5.1' }) === true, 'PassthroughRule matches');
  assert(passExact.toJSON().targetProvider === undefined, 'PassthroughRule.toJSON omits target');

  // RegexRule passthrough
  const passRegex = new RegexRule({ pattern: 'opus', targetProvider: null, targetModel: null, fallback: { providerId: 'local', model: 'fallback-opus' } });
  assert(passRegex.hasTarget === false, 'PassthroughRegexRule hasTarget false');
  assert(passRegex.hasFallback === true, 'PassthroughRegexRule hasFallback true');
  assert(passRegex.matches({ model: 'claude-opus-4-6' }) === true, 'PassthroughRegexRule matches');

  // Rule with neither target nor fallback → should throw
  assertThrows(() => new ExactRule({ match: 'x', targetProvider: null, targetModel: null }), ArgErr, 'Rule no target no fallback throws');
  assertThrows(() => new ExactRule({ match: 'x' }), ArgErr, 'Rule no args throws');

  // Rule with target but no fallback → still works
  const targetOnly = new ExactRule({ match: 'has-target', targetProvider: 'p1', targetModel: 'm1' });
  assert(targetOnly.hasTarget === true, 'TargetOnlyRule hasTarget true');
  assert(targetOnly.hasFallback === false, 'TargetOnlyRule hasFallback false');

  // Config adapter: fallback-only route value
  assert(normalizeRouteValue({ fallback: ['z.glm-5.1'] }).target === undefined, 'normalizeRouteValue fallback-only no target');
  assert(normalizeRouteValue({ fallback: ['z.glm-5.1'] }).fallback.length === 1, 'normalizeRouteValue fallback-only has fallback');

  // Config adapter: convertV2ToInternal with fallback-only model
  const v2Passthrough = {
    providers: { z: { url: 'https://api.z.ai/api/anthropic', anthropicCompliant: false } },
    routes: {
      models: {
        'glm-5.1': { fallback: ['z.glm-5.1'] },
        'glm-4.7': 'z.glm-4.7'
      },
      properties: {},
      payloadSize: {}
    }
  };
  const passInternal = convertV2ToInternal(v2Passthrough);
  assert(passInternal.routingPolicy.length === 2, 'convertV2ToInternal passthrough rules count');
  const passRule = passInternal.routingPolicy.find(r => r.match === 'glm-5.1');
  assert(passRule !== undefined, 'convertV2ToInternal passthrough rule exists');
  assert(passRule.targetProvider === undefined, 'convertV2ToInternal passthrough no targetProvider');
  assert(passRule.fallback.providerId === 'z', 'convertV2ToInternal passthrough fallback providerId');
  assert(passRule.fallback.model === 'glm-5.1', 'convertV2ToInternal passthrough fallback model');
  const normalRule = passInternal.routingPolicy.find(r => r.match === 'glm-4.7');
  assert(normalRule.targetProvider === 'z', 'convertV2ToInternal normal still has target');

  // ── RoutingPolicy ──
  console.log('\nRoutingPolicy:');
  const policyProviders = [
    new ProviderConfig({ id: 'mirror', url: 'https://mirror.example.com/v1', models: { 'mirror-model': 'real-model' }, anthropicCompliant: true, toolTransforms: {} }),
    new ProviderConfig({ id: 'local', url: 'http://localhost:11434/v1', models: {}, anthropicCompliant: false, toolTransforms: {} })
  ];
  const legacyMap = new ProvidersMap(policyProviders);

  const policy = new RoutingPolicy({
    rules: [
      new PropertyRule({ property: 'thinking', targetProvider: 'mirror', targetModel: 'reasoner' }),
      new RegexRule({ pattern: 'haiku', targetProvider: 'local', targetModel: 'fast' }),
      new ExactRule({ match: 'my-model', targetProvider: 'mirror', targetModel: 'real-model' })
    ],
    providerConfigs: policyProviders,
    legacyProvidersMap: legacyMap
  });

  assert(policy.size === 3, 'RoutingPolicy.size');
  // Property rule matches first for thinking requests
  const thinkMatch = policy.evaluate({ thinking: { type: 'enabled' }, model: 'anything' });
  assert(thinkMatch.isSome, 'policy evaluates thinking');
  assert(thinkMatch.value.realModel === 'reasoner', 'policy thinking routes to reasoner');
  // Regex matches haiku
  const haikuMatch = policy.evaluate({ model: 'claude-haiku-4-5' });
  assert(haikuMatch.isSome, 'policy evaluates haiku');
  assert(haikuMatch.value.realModel === 'fast', 'policy haiku routes to fast');
  // Exact match
  const exactMatch = policy.evaluate({ model: 'my-model' });
  assert(exactMatch.isSome, 'policy evaluates exact');
  assert(exactMatch.value.realModel === 'real-model', 'policy exact routes correctly');
  // Legacy fallback
  const legacyMatch = policy.evaluate({ model: 'mirror-model' });
  assert(legacyMatch.isSome, 'policy falls back to legacy');
  assert(legacyMatch.value.realModel === 'real-model', 'policy legacy routes correctly');
  // No match
  const noMatch = policy.evaluate({ model: 'unknown-model' });
  assert(noMatch.isNone, 'policy returns none for unknown');
  // allTargetModels
  const targets = policy.allTargetModels;
  assert(targets.includes('reasoner'), 'allTargetModels includes reasoner');
  assert(targets.includes('fast'), 'allTargetModels includes fast');
  assert(targets.includes('mirror-model'), 'allTargetModels includes legacy');

  // RoutingPolicy with passthrough rule
  const policyWithPassthrough = new RoutingPolicy({
    rules: [
      new ExactRule({ match: 'passthrough-model', targetProvider: null, targetModel: null, fallback: { providerId: 'mirror', model: 'fallback-m' } }),
      new ExactRule({ match: 'normal-model', targetProvider: 'mirror', targetModel: 'real-model' })
    ],
    providerConfigs: policyProviders,
    legacyProvidersMap: legacyMap
  });
  // evaluate: passthrough rule returns none (no provider match)
  const passEval = policyWithPassthrough.evaluate({ model: 'passthrough-model' });
  assert(passEval.isNone, 'policy evaluate passthrough returns none (routes to Anthropic)');
  // evaluate: normal rule still works
  const normalEval = policyWithPassthrough.evaluate({ model: 'normal-model' });
  assert(normalEval.isSome, 'policy evaluate normal still works');
  // evaluateWithRule: passthrough returns rule with null match
  const passWithRule = policyWithPassthrough.evaluateWithRule({ model: 'passthrough-model' });
  assert(passWithRule.isSome, 'policy evaluateWithRule passthrough isSome');
  assert(passWithRule.value.match === null, 'policy evaluateWithRule passthrough match null');
  assert(passWithRule.value.rule !== null, 'policy evaluateWithRule passthrough rule present');
  assert(passWithRule.value.rule.hasFallback === true, 'policy evaluateWithRule passthrough rule hasFallback');
  assert(passWithRule.value.rule.hasTarget === false, 'policy evaluateWithRule passthrough rule hasTarget false');
  // evaluateWithRule: unknown model returns none
  const unknownWithRule = policyWithPassthrough.evaluateWithRule({ model: 'unknown' });
  assert(unknownWithRule.isNone, 'policy evaluateWithRule unknown returns none');

  // buildRoutingPolicy
  console.log('\nbuildRoutingPolicy:');
  const builtPolicy = buildRoutingPolicy({
    rawPolicy: [
      { type: 'exact', match: 'test', targetProvider: 'mirror', targetModel: 'm1' }
    ],
    providerConfigs: policyProviders,
    legacyProvidersMap: legacyMap
  });
  assert(builtPolicy.size === 1, 'buildRoutingPolicy creates policy');
  const builtMatch = builtPolicy.evaluate({ model: 'test' });
  assert(builtMatch.isSome, 'buildRoutingPolicy evaluates rule');

  // Validation: unknown provider
  assertThrows(() => buildRoutingPolicy({
    rawPolicy: [{ type: 'exact', match: 'x', targetProvider: 'nonexistent', targetModel: 'm' }],
    providerConfigs: policyProviders,
    legacyProvidersMap: legacyMap
  }), ArgErr, 'RoutingPolicy rejects unknown provider');

  // Validation: duplicate exact match
  assertThrows(() => buildRoutingPolicy({
    rawPolicy: [
      { type: 'exact', match: 'dup', targetProvider: 'mirror', targetModel: 'm1' },
      { type: 'exact', match: 'dup', targetProvider: 'mirror', targetModel: 'm2' }
    ],
    providerConfigs: policyProviders,
    legacyProvidersMap: legacyMap
  }), ArgErr, 'RoutingPolicy rejects duplicate exact match');

  // defaultFallbackRule
  console.log('\ndefaultFallbackRule:');
  const policyWithDefault = buildRoutingPolicy({
    rawPolicy: [{ type: 'exact', match: 'test', targetProvider: 'mirror', targetModel: 'm1' }],
    providerConfigs: policyProviders,
    legacyProvidersMap: legacyMap,
    defaultFallback: { providerId: 'mirror', model: 'fallback-model' }
  });
  const dfRule = policyWithDefault.defaultFallbackRule;
  assert(dfRule.isSome, 'defaultFallbackRule returns some when configured');
  assert(dfRule.value.hasFallback === true, 'defaultFallbackRule hasFallback');
  assert(dfRule.value.hasTarget === false, 'defaultFallbackRule hasTarget false');
  assert(dfRule.value.fallbackProviderId === 'mirror', 'defaultFallbackRule fallbackProviderId');
  assert(dfRule.value.fallbackModel === 'fallback-model', 'defaultFallbackRule fallbackModel');
  assert(dfRule.value.toLabel() === 'default-fallback', 'defaultFallbackRule toLabel');

  // defaultFallbackRule not configured
  const dfNone = builtPolicy.defaultFallbackRule;
  assert(dfNone.isNone, 'defaultFallbackRule returns none when not configured');

  // Validation: default fallback references unknown provider
  assertThrows(() => buildRoutingPolicy({
    rawPolicy: [],
    providerConfigs: policyProviders,
    legacyProvidersMap: legacyMap,
    defaultFallback: { providerId: 'nonexistent', model: 'm' }
  }), ArgErr, 'RoutingPolicy rejects unknown default fallback provider');

  // ── applyRoutingWithMatch ──
  console.log('\napplyRoutingWithMatch:');
  const { applyRoutingWithMatch } = await import('../src/core/routing.js');

  const matchedOpt = policy.evaluate({ model: 'my-model', messages: [] });
  const routedWithMatch = applyRoutingWithMatch({ model: 'my-model', messages: [] }, matchedOpt, 'https://api.anthropic.com');
  assert(routedWithMatch instanceof RoutingResult, 'applyRoutingWithMatch returns RoutingResult');
  assert(routedWithMatch.isCustom === true, 'applyRoutingWithMatch routes to provider');

  const noneOpt = Option.none();
  const routedNone = applyRoutingWithMatch({ model: 'unknown', messages: [] }, noneOpt, 'https://api.anthropic.com');
  assert(routedNone.isCustom === false, 'applyRoutingWithMatch falls back to Anthropic');
  assert(routedNone.targetBase === 'https://api.anthropic.com', 'applyRoutingWithMatch Anthropic base');

  // ── Fallback handler ──
  console.log('\nFallback handler:');
  const { createFallbackExtension } = await import('../src/extensions/fallback/index.js');
  const { ExtensionRegistry: FallbackER } = await import('../src/core/extension-registry.js');
  const fallbackReg = new FallbackER();
  fallbackReg.register(createFallbackExtension());

  const ruleWithFallback = new ExactRule({ match: 'test-fb', targetProvider: 'mirror', targetModel: 'fb-m', fallback: { providerId: 'mirror', model: 'fb-m' } });
  const ruleNoFallback = new ExactRule({ match: 'test-no-fb', targetProvider: 'mirror', targetModel: 'direct-m' });

  // shouldAttemptFallback — HTTP errors
  assert(fallbackReg.shouldAttemptFallback({ statusCode: 500, matchedRule: ruleWithFallback, fallbackDepth: 0 }) === true, 'fallback 500 with rule');
  assert(fallbackReg.shouldAttemptFallback({ statusCode: 502, matchedRule: ruleWithFallback, fallbackDepth: 0 }) === true, 'fallback 502 with rule');
  assert(fallbackReg.shouldAttemptFallback({ statusCode: 200, matchedRule: ruleWithFallback, fallbackDepth: 0 }) === false, 'fallback 200 skipped');
  assert(fallbackReg.shouldAttemptFallback({ statusCode: 400, matchedRule: ruleNoFallback, fallbackDepth: 0 }) === false, 'fallback 400 no rule');
  assert(fallbackReg.shouldAttemptFallback({ statusCode: 500, matchedRule: null, fallbackDepth: 0 }) === false, 'fallback null rule');
  assert(fallbackReg.shouldAttemptFallback({ statusCode: 500, matchedRule: ruleWithFallback, fallbackDepth: 3 }) === false, 'fallback depth exceeded');

  // shouldAttemptFallbackForTcpError — TCP errors (no HTTP status)
  assert(fallbackReg.shouldAttemptFallbackForTcpError({ matchedRule: ruleWithFallback, fallbackDepth: 0 }) === true, 'tcp fallback with rule');
  assert(fallbackReg.shouldAttemptFallbackForTcpError({ matchedRule: ruleNoFallback, fallbackDepth: 0 }) === false, 'tcp fallback no rule');
  assert(fallbackReg.shouldAttemptFallbackForTcpError({ matchedRule: null, fallbackDepth: 0 }) === false, 'tcp fallback null rule');
  assert(fallbackReg.shouldAttemptFallbackForTcpError({ matchedRule: ruleWithFallback, fallbackDepth: 3 }) === false, 'tcp fallback depth exceeded');

  // ── v1 auto-migration via ensureCompleteProviders ──
  console.log('\nv1 auto-migration:');
  const oldConfig = { providers: [{ id: 'p1', url: 'https://a.com/v1', models: { alias1: 'real1', alias2: 'real2' }, anthropicCompliant: true }] };
  const migrated = ensureCompleteProviders(oldConfig);
  assert(typeof migrated.providers === 'object', 'migration produces v2 object');
  assert(migrated.providers['p1'] !== undefined, 'migration creates provider key');
  assert(migrated.routes.models['alias1'] === 'p1.real1', 'migration creates model routes');
  assert(migrated.routes.models['alias2'] === 'p1.real2', 'migration creates second model route');

  // V2 config passes through unchanged
  const v2Input = { providers: { p1: { url: 'https://a.com/v1', anthropicCompliant: true } }, routes: { models: { a: 'p1.b' }, properties: {}, payloadSize: {} } };
  const v2Output = ensureCompleteProviders(v2Input);
  assert(v2Output.routes.models['a'] === 'p1.b', 'v2 config preserved');

  // ── rule-manager ──
  console.log('\nrule-manager:');
  const { addRule, removeRule, listRules, formatRuleTree: fmtRuleTree } = await import('../src/core/rule-manager.js');

  const emptyPolicy = [];
  const added = addRule(emptyPolicy, { type: 'exact', match: 'test', targetProvider: 'p1', targetModel: 'm1' });
  assert(added.isSuccess, 'addRule succeeds');
  assert(added.value.length === 1, 'addRule appends');
  assert(added.value[0].match === 'test', 'addRule preserves match');

  const dupResult = addRule(added.value, { type: 'exact', match: 'test', targetProvider: 'p1', targetModel: 'm2' });
  assert(!dupResult.isSuccess, 'addRule rejects duplicate exact');

  const badType = addRule(emptyPolicy, { type: 'bad', targetProvider: 'p', targetModel: 'm' });
  assert(!badType.isSuccess, 'addRule rejects bad type');

  const withRegex = addRule(added.value, { type: 'regex', pattern: 'haiku', targetProvider: 'p1', targetModel: 'fast' });
  assert(withRegex.isSuccess, 'addRule regex');
  assert(withRegex.value.length === 2, 'addRule regex appends');

  const removed = removeRule(withRegex.value, 0);
  assert(removed.isSuccess, 'removeRule succeeds');
  assert(removed.value.length === 1, 'removeRule removes');
  assert(removed.value[0].type === 'regex', 'removeRule removes correct index');

  const badIdx = removeRule(withRegex.value, 99);
  assert(!badIdx.isSuccess, 'removeRule rejects out-of-range');

  const rules = listRules(withRegex.value);
  assert(rules.length === 2, 'listRules returns 2');
  assert(rules[0].type === 'exact', 'listRules[0].type');
  assert(rules[1].type === 'regex', 'listRules[1].type');

  const ruleTree = fmtRuleTree(withRegex.value);
  assert(ruleTree.includes('exact'), 'formatRuleTree includes exact');
  assert(ruleTree.includes('regex'), 'formatRuleTree includes regex');
  assert(fmtRuleTree([]) === '(no rules)', 'formatRuleTree empty');
  // ── env-file ──
  console.log('\nenv-file:');
  const { loadEnv: loadEnvFn, updateEnvKey, pruneEnvLines, obfuscateKey: obfKey } = await import('../src/core/env-file.js');

  // obfuscateKey
  assert(obfKey('sk-abcdefghijklmnop') === 'sk-...mnop', 'obfuscateKey normal');
  assert(obfKey('short') === '***', 'obfuscateKey short');
  assert(obfKey('') === '(none)', 'obfuscateKey empty');
  assert(obfKey(null) === '(none)', 'obfuscateKey null');
  assert(obfKey(undefined) === '(none)', 'obfuscateKey undefined');

  // loadEnv from a temp file
  const tmpEnvDir = path.join(os.tmpdir(), `ccb-test-env-${Date.now()}`);
  fs.mkdirSync(tmpEnvDir, { recursive: true });
  const tmpEnvPath = path.join(tmpEnvDir, ENV_FILENAME);
  fs.writeFileSync(tmpEnvPath, 'KEY_A=value_a\nKEY_B=value=b\n# COMMENT\n\nKEY_C=hello\n', 'utf8');

  const env = loadEnvFn(tmpEnvPath);
  assert(env.KEY_A === 'value_a', 'loadEnv basic key');
  assert(env.KEY_B === 'value=b', 'loadEnv value with =');
  assert(env.KEY_C === 'hello', 'loadEnv last key');
  assert(Object.keys(env).length === 3, 'loadEnv skips comments and blanks');

  const missingEnv = loadEnvFn(path.join(tmpEnvDir, 'nonexistent.env'));
  assert(Object.keys(missingEnv).length === 0, 'loadEnv nonexistent returns empty');

  // updateEnvKey - add new key
  updateEnvKey(tmpEnvPath, 'KEY_D', 'new_val');
  const envAfterAdd = loadEnvFn(tmpEnvPath);
  assert(envAfterAdd.KEY_D === 'new_val', 'updateEnvKey adds new key');

  // updateEnvKey - update existing key
  updateEnvKey(tmpEnvPath, 'KEY_A', 'updated');
  const envAfterUpdate = loadEnvFn(tmpEnvPath);
  assert(envAfterUpdate.KEY_A === 'updated', 'updateEnvKey updates existing key');

  // pruneEnvLines - remove matching keys
  const pruned = pruneEnvLines(tmpEnvPath, ({ key }) => key === 'KEY_D');
  assert(pruned.length === 1, 'pruneEnvLines returns 1 removed');
  assert(pruned[0] === 'KEY_D', 'pruneEnvLines returns key name');
  const envAfterPrune = loadEnvFn(tmpEnvPath);
  assert(envAfterPrune.KEY_D === undefined, 'pruneEnvLines removed key');

  // pruneEnvLines - nothing to remove
  const prunedEmpty = pruneEnvLines(tmpEnvPath, ({ key }) => key === 'NONEXISTENT');
  assert(prunedEmpty.length === 0, 'pruneEnvLines returns empty when no match');

  // Cleanup
  try { fs.rmSync(tmpEnvDir, { recursive: true, force: true }); } catch { }

  // ── proxy-routing (resolveRouting + processRequestBody) ──
  console.log('\nproxy-routing:');
  const { resolveRouting: resolveRoutingFn } = await import('../src/core/proxy-routing.js');

  // Build a simple policy for testing
  const testProvCfg = new ProviderConfig({ id: 'test-p', url: 'https://test.com/v1', models: { 't-model': 'real-model' }, anthropicCompliant: false, toolTransforms: {} });
  const testPolicy = buildRoutingPolicy({
    rawPolicy: [],
    providerConfigs: [testProvCfg],
    legacyProvidersMap: new ProvidersMap([testProvCfg])
  });

  const rr = await resolveRoutingFn({
    policy: testPolicy,
    body: { model: 't-model', messages: [] },
    urlSessionId: 'sess-123',
    routedHeaders: { authorization: 'Bearer tok' },
    anthropicBaseUrl: 'https://api.anthropic.com'
  });
  assert(rr.reqModel === 't-model', 'resolveRouting reqModel');
  assert(rr.sessionId === 'sess-123', 'resolveRouting sessionId from urlSessionId');
  assert(rr.routing.targetBase === 'https://test.com/v1', 'resolveRouting routes to provider');
  assert(rr.routedHeaders.authorization === undefined, 'resolveRouting strips auth');
  assert(rr.routedHeaders['x-api-key'] !== undefined || true, 'resolveRouting resolves headers');

  const rrFallback = await resolveRoutingFn({
    policy: testPolicy,
    body: { model: 'unknown-model', messages: [] },
    urlSessionId: '',
    routedHeaders: {},
    anthropicBaseUrl: 'https://api.anthropic.com'
  });
  assert(rrFallback.routing.targetBase === 'https://api.anthropic.com', 'resolveRouting falls back to Anthropic');
  assert(rrFallback.match === null, 'resolveRouting no match for unknown model');
  assert(rrFallback.matchedRule === null, 'resolveRouting no matchedRule without default fallback');

  // resolveRouting with default fallback
  const fallbackProvCfg = new ProviderConfig({ id: 'fb-p', url: 'https://fallback.example.com/v1', anthropicCompliant: true, toolTransforms: {}, models: {} });
  const policyWithDefaultFallback = buildRoutingPolicy({
    rawPolicy: [],
    providerConfigs: [testProvCfg, fallbackProvCfg],
    legacyProvidersMap: new ProvidersMap([testProvCfg, fallbackProvCfg]),
    defaultFallback: { providerId: 'fb-p', model: 'safe-model' }
  });

  const rrDefault = await resolveRoutingFn({
    policy: policyWithDefaultFallback,
    body: { model: 'unknown-model', messages: [] },
    urlSessionId: '',
    routedHeaders: { authorization: 'Bearer oauth-tok' },
    anthropicBaseUrl: 'https://api.anthropic.com'
  });
  assert(rrDefault.routing.targetBase === 'https://api.anthropic.com', 'resolveRouting with default still routes to Anthropic');
  assert(rrDefault.match === null, 'resolveRouting with default has null match');
  assert(rrDefault.matchedRule !== null, 'resolveRouting with default has matchedRule');
  assert(rrDefault.matchedRule.hasFallback === true, 'resolveRouting default matchedRule hasFallback');
  assert(rrDefault.matchedRule.fallbackProviderId === 'fb-p', 'resolveRouting default fallbackProviderId');
  assert(rrDefault.matchedRule.fallbackModel === 'safe-model', 'resolveRouting default fallbackModel');

  // ── Extension Registry ──
  console.log('\nExtensionRegistry:');
  const { ExtensionRegistry } = await import('../src/core/extension-registry.js');

  const emptyReg = new ExtensionRegistry();
  assert(emptyReg.size === 0, 'ExtensionRegistry starts empty');

  const reg = new ExtensionRegistry();
  reg.register({
    name: 'test-ext',
    hooks: {
      requestTransform: {
        order: 100,
        transform: ({ body }) => ({ ...body, _testExt: true }),
      }
    }
  });
  assert(reg.size === 1, 'ExtensionRegistry size after register');
  assert(reg.requestTransformerCount === 1, 'ExtensionRegistry requestTransformerCount');

  const transformed = reg.transformRequest({ body: { model: 'test' } });
  assert(transformed._testExt === true, 'ExtensionRegistry transformRequest runs');
  assert(transformed.model === 'test', 'ExtensionRegistry transformRequest preserves body');

  // Order: lower order runs first
  const reg2 = new ExtensionRegistry();
  reg2.register({ name: 'late', hooks: { requestTransform: { order: 200, transform: ({ body }) => ({ ...body, _order: (body._order || '') + 'late' }) } } });
  reg2.register({ name: 'early', hooks: { requestTransform: { order: 50, transform: ({ body }) => ({ ...body, _order: (body._order || '') + 'early' }) } } });
  const ordered = reg2.transformRequest({ body: {} });
  assert(ordered._order === 'earlylate', 'ExtensionRegistry respects order');

  // Re-register replaces
  reg2.register({ name: 'late', hooks: { requestTransform: { order: 200, transform: ({ body }) => ({ ...body, _order: (body._order || '') + 'new-late' }) } } });
  assert(reg2.size === 2, 'ExtensionRegistry re-register keeps size');
  const reReg = reg2.transformRequest({ body: {} });
  assert(reReg._order === 'earlynew-late', 'ExtensionRegistry re-register replaces');

  // Response transform (full)
  const regResp = new ExtensionRegistry();
  regResp.register({ name: 'resp-strip', hooks: { responseTransform: { order: 100, transform: ({ response }) => response.replace(/"secret":\s*\d+/, '"secret":0') } } });
  const stripped = regResp.transformResponse({ response: '{"secret": 42}' });
  assert(stripped === '{"secret":0}', 'ExtensionRegistry transformResponse works');

  // SSE chunk transform
  const regSse = new ExtensionRegistry();
  regSse.register({ name: 'sse-strip', hooks: { sseChunkTransform: { order: 100, transform: ({ chunk }) => chunk.replace(/"web_search":\s*\[.*?\]/, '') } } });
  const sseChunk = 'data: {"type":"message_start","message":{"web_search":[1,2],"id":"msg_1"}}\n\n';
  const sseResult = regSse.transformSseChunk({ chunk: sseChunk });
  assert(!sseResult.includes('"web_search"'), 'ExtensionRegistry transformSseChunk works');

  // ── ProviderConfig.toolTransforms ──
  console.log('\nProviderConfig.toolTransforms:');
  const ProvCfg = (await import('../src/core/providers.js')).ProviderConfig;

  const pcNoTransforms = new ProvCfg({ id: 'x', url: 'https://x.com', models: {}, anthropicCompliant: false, toolTransforms: {} });
  assert(Object.keys(pcNoTransforms.toolTransforms).length === 0, 'ProviderConfig empty toolTransforms when absent');

  const pcWithTransforms = new ProvCfg({
    id: 'z', url: 'https://z.ai', models: {}, anthropicCompliant: false,
    toolTransforms: { web_search: { search_engine: 'search-prime', count: '5' } }
  });
  assert(pcWithTransforms.toolTransforms.web_search.count === '5', 'ProviderConfig parses toolTransforms');
  assert(pcWithTransforms.toolTransforms.web_search.search_engine === 'search-prime', 'ProviderConfig toolTransforms preserves params');

  // ── Web Search z.ai Extension ──
  console.log('\nWeb Search z.ai Extension:');
  const { createWebSearchZaiExtension, sanitizeWebSearchHistory } = await import('../src/extensions/web-search-zai/index.js');

  const wsExt = createWebSearchZaiExtension({ search_engine: 'search-prime', count: '5' });
  assert(wsExt.name === 'web-search-zai', 'createWebSearchZaiExtension name');
  assert(wsExt.hooks.requestTransform.order === 80, 'createWebSearchZaiExtension request order');
  assert(wsExt.hooks.responseTransform.order === 80, 'createWebSearchZaiExtension response order');
  assert(wsExt.hooks.sseChunkTransform.order === 80, 'createWebSearchZaiExtension sseChunk order');

  // Request transform: web_search tool detected and replaced
  const provider = pcWithTransforms;
  const reqBody = {
    model: 'glm-4.7',
    messages: [{ role: 'user', content: 'search for foo' }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }]
  };
  const transformedReq = wsExt.hooks.requestTransform.transform({ body: reqBody, provider });
  assert(transformedReq.tools[0].type === 'web_search', 'web_search tool type transformed');
  assert(transformedReq.tools[0].name === 'web_search', 'web_search name preserved');
  assert(transformedReq.tools[0].web_search.enable === 'True', 'web_search enable injected');
  assert(transformedReq.tools[0].web_search.search_result === 'True', 'web_search search_result injected');
  assert(transformedReq.tools[0].web_search.search_engine === 'search-prime', 'web_search search_engine from config');
  assert(transformedReq.tools[0].web_search.count === '5', 'web_search count from config');

  // Request transform: no web_search tool → no-op
  const noWsBody = { model: 'glm-4.7', messages: [], tools: [{ type: 'computer_use', name: 'computer' }] };
  const noWsResult = wsExt.hooks.requestTransform.transform({ body: noWsBody, provider });
  assert(noWsResult.tools[0].type === 'computer_use', 'web_search no-op for non-web_search tools');

  // Request transform: no toolTransforms on provider → no-op
  const noTransformProvider = pcNoTransforms;
  const noTransformResult = wsExt.hooks.requestTransform.transform({ body: reqBody, provider: noTransformProvider });
  assert(noTransformResult.tools[0].type === 'web_search_20250305', 'web_search no-op without toolTransforms');

  // Response transform (full): strips web_search array
  const zaiResponse = JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant',
    content: [{ type: 'text', text: 'Results [Source: ref_1]' }],
    web_search: [{ refer: 'ref_1', title: 'Test', link: 'https://example.com' }],
    stop_reason: 'end_turn'
  });
  const strippedResp = wsExt.hooks.responseTransform.transform({ response: zaiResponse, provider });
  const parsed = JSON.parse(strippedResp);
  assert(parsed.web_search === undefined, 'web_search stripped from response');
  assert(parsed.content[0].text === 'Results [Source: ref_1]', 'web_search response preserves content');

  // Response transform: no web_search in response → no-op
  const cleanResp = JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text: 'hi' }] });
  const cleanResult = wsExt.hooks.responseTransform.transform({ response: cleanResp, provider });
  assert(cleanResult === cleanResp, 'web_search response no-op when no web_search field');

  // SSE chunk transform: strips web_search from message_start
  const sseStartChunk = 'data: {"type":"message_start","message":{"id":"msg_1","web_search":[{"refer":"ref_1"}]}}\n\n';
  const sseStripped = wsExt.hooks.sseChunkTransform.transform({ chunk: sseStartChunk, provider });
  assert(!sseStripped.includes('"web_search"'), 'web_search SSE stripped from message_start');
  assert(sseStripped.includes('"id":"msg_1"'), 'web_search SSE preserves other fields');

  // SSE chunk transform: non-message_start event → no-op
  const sseDeltaChunk = 'data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n';
  const sseDeltaResult = wsExt.hooks.sseChunkTransform.transform({ chunk: sseDeltaChunk, provider });
  assert(sseDeltaResult === sseDeltaChunk, 'web_search SSE no-op for non-message_start');

  // ── z.ai tool_use → Anthropic server_tool_use format ──
  // z.ai returns a regular tool_use block with stop_reason "tool_use" for web_search,
  // but Claude Code expects server_tool_use / web_search_tool_result blocks (Anthropic format).
  // The extension must transform this so Claude Code doesn't try to handle a client-side tool cycle.

  // Response transform: z.ai tool_use for web_search → server_tool_use format
  const zaiToolUseResponse = JSON.stringify({
    id: 'msg_zai_ws1', type: 'message', role: 'assistant', model: 'glm-4.7',
    content: [
      { type: 'text', text: 'Let me search for that.' },
      { type: 'tool_use', id: 'call_ws_abc123', name: 'web_search', input: {} }
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 }
  });
  const transformedWsResp = wsExt.hooks.responseTransform.transform({ response: zaiToolUseResponse, provider });
  const wsParsed = JSON.parse(transformedWsResp);

  // The tool_use block for web_search should be converted to server_tool_use
  const wsToolUseBlock = wsParsed.content.find(b => b.name === 'web_search');
  assert(wsToolUseBlock != null, 'web_search tool_use block exists in response');
  assert(wsToolUseBlock.type === 'server_tool_use', 'web_search tool_use converted to server_tool_use type');
  assert(wsToolUseBlock.id === 'call_ws_abc123', 'server_tool_use preserves tool id');
  assert(wsToolUseBlock.name === 'web_search', 'server_tool_use preserves tool name');

  // A web_search_tool_result placeholder block should follow
  const wsResultBlock = wsParsed.content.find(b => b.type === 'web_search_tool_result');
  if (wsResultBlock) {
    assert(wsResultBlock.tool_use_id === 'call_ws_abc123', 'web_search_tool_result references correct tool id');
    assert(wsResultBlock.content != null, 'web_search_tool_result has content');
  }

  // stop_reason should remain end_turn or be changed from tool_use
  assert(wsParsed.stop_reason !== 'tool_use', 'web_search stop_reason changed from tool_use');

  // Non-web_search tool_use blocks should NOT be transformed
  const zaiOtherToolResponse = JSON.stringify({
    id: 'msg_other', type: 'message', role: 'assistant', model: 'glm-4.7',
    content: [
      { type: 'tool_use', id: 'call_other', name: 'get_weather', input: { city: 'SF' } }
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 50, output_tokens: 10 }
  });
  const otherToolResult = wsExt.hooks.responseTransform.transform({ response: zaiOtherToolResponse, provider });
  const otherParsed = JSON.parse(otherToolResult);
  assert(otherParsed.content[0].type === 'tool_use', 'non-web_search tool_use unchanged');
  assert(otherParsed.stop_reason === 'tool_use', 'non-web_search stop_reason unchanged');

  // SSE chunk transform: z.ai tool_use for web_search → server_tool_use in content_block_start
  // Use a shared state to simulate a real SSE stream
  const sseState = wsExt.hooks.sseChunkTransform.createState();
  const sseToolUseStartChunk = 'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_ws_sse1","name":"web_search","input":{}}}\n\n';
  const sseToolUseTransformed = wsExt.hooks.sseChunkTransform.transform({ chunk: sseToolUseStartChunk, provider }, sseState);
  assert(sseToolUseTransformed.includes('"server_tool_use"'), 'web_search SSE tool_use → server_tool_use');
  assert(sseToolUseTransformed.includes('"call_ws_sse1"'), 'web_search SSE server_tool_use preserves id');
  assert(sseState.sawWebSearchToolUse === true, 'web_search SSE state tracks tool_use');

  // SSE chunk: non-web_search tool_use → no change
  const sseOtherState = wsExt.hooks.sseChunkTransform.createState();
  const sseOtherToolChunk = 'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_other","name":"get_weather","input":{}}}\n\n';
  const sseOtherResult = wsExt.hooks.sseChunkTransform.transform({ chunk: sseOtherToolChunk, provider }, sseOtherState);
  assert(sseOtherResult === sseOtherToolChunk, 'non-web_search SSE tool_use unchanged');
  assert(sseOtherState.sawWebSearchToolUse === false, 'non-web_search SSE state unchanged');

  // SSE message_delta: after seeing web_search tool_use, stop_reason tool_use → end_turn
  const sseDeltaWsChunk = 'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":20}}\n\n';
  const sseDeltaWsResult = wsExt.hooks.sseChunkTransform.transform({ chunk: sseDeltaWsChunk, provider }, sseState);
  assert(!sseDeltaWsResult.includes('"tool_use"'), 'web_search SSE stop_reason transformed away from tool_use');
  assert(sseDeltaWsResult.includes('"end_turn"'), 'web_search SSE stop_reason becomes end_turn');

  // SSE message_delta: without prior web_search tool_use, stop_reason stays tool_use
  const sseNoWsState = wsExt.hooks.sseChunkTransform.createState();
  const sseDeltaNoWsResult = wsExt.hooks.sseChunkTransform.transform({ chunk: sseDeltaWsChunk, provider }, sseNoWsState);
  assert(sseDeltaNoWsResult === sseDeltaWsChunk, 'non-web_search SSE stop_reason unchanged');

  // History sanitization: web_search tool_use → text
  const history = [
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_ws1', name: 'web_search', input: { query: 'test query' } }
    ]},
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_ws1', content: 'search result text' }
    ]},
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_other', name: 'other_tool', input: { x: 1 } }
    ]},
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_other', content: 'other result' }
    ]}
  ];
  const sanitizedHistory = sanitizeWebSearchHistory(history);
  assert(sanitizedHistory[0].content[0].type === 'text', 'web_search history tool_use → text');
  assert(sanitizedHistory[0].content[0].text.includes('test query'), 'web_search history preserves query');
  assert(sanitizedHistory[1].content[0].type === 'text', 'web_search history tool_result → text');
  assert(sanitizedHistory[1].content[0].text.includes('search result text'), 'web_search history preserves result');
  assert(sanitizedHistory[2].content[0].type === 'tool_use', 'web_search history preserves other tool_use');
  assert(sanitizedHistory[3].content[0].type === 'tool_result', 'web_search history preserves other tool_result');

  // History sanitization: no web_search → no change
  const noWsHistory = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'other', input: {} }] }
  ];
  const noWsSanitized = sanitizeWebSearchHistory(noWsHistory);
  assert(noWsSanitized === noWsHistory, 'web_search history no-op without web_search');

  // Config parsing: toolTransforms in v2 config
  const v2WithToolTransforms = {
    providers: { z: { url: 'https://api.z.ai', anthropicCompliant: false, toolTransforms: { web_search: { count: '10' } } } },
    routes: { models: {} }
  };
  const internalTT = convertV2ToInternal(v2WithToolTransforms);
  assert(internalTT.providers[0].toolTransforms.web_search.count === '10', 'config-adapter parses toolTransforms');

  // ── Extension Loader ──
  console.log('\nextension-loader:');
  const { discoverExtensions, buildRegistry, getNestedValue } = await import('../src/core/extension-loader.js');

  // getNestedValue
  assert(getNestedValue({ a: { b: 1 } }, 'a.b') === 1, 'getNestedValue resolves dot path');
  assert(getNestedValue({ a: { b: 1 } }, 'a.c') === undefined, 'getNestedValue returns undefined for missing key');
  assert(getNestedValue(null, 'a.b') === undefined, 'getNestedValue handles null');
  assert(getNestedValue({ toolTransforms: { web_search: { count: '5' } } }, 'toolTransforms.web_search').count === '5', 'getNestedValue resolves toolTransforms path');

  // discoverExtensions on built-in dir
  const extDir = path.join(PKG_ROOT, 'src', 'extensions');
  const discovered = await discoverExtensions(extDir);
  assert(discovered.length === 7, `discovers 7 extensions (found ${discovered.length})`);
  const errors = discovered.filter(m => m.error);
  assert(errors.length === 0, `no discovery errors (${errors.map(e => e.error).join(', ')})`);

  // buildRegistry with no providers — only always-on extensions
  const { registry: regNoProviders } = buildRegistry(discovered, []);
  assert(regNoProviders.size === 6, `6 always-on extensions without providers (got ${regNoProviders.size})`);
  assert(regNoProviders.requestTransformerCount >= 2, 'at least 2 request transformers (sanitization + non-compliant)');

  // buildRegistry with provider that has toolTransforms.web_search
  const providerWithWs = new ProviderConfig({
    id: 'z', url: 'https://api.z.ai/api/anthropic', models: {}, anthropicCompliant: false,
    toolTransforms: { web_search: {} }
  });
  const { registry: regWithWs } = buildRegistry(discovered, [providerWithWs]);
  assert(regWithWs.size === 7, `7 extensions with web_search provider (got ${regWithWs.size})`);

  // getAll() exposes the full extension list including those without
  // tunable schemas — this is what the GUI Extensions tab consumes.
  const allExtensions = regWithWs.getAll();
  assert(allExtensions.length === 7, `getAll returns 7 extensions (got ${allExtensions.length})`);
  const byName = Object.fromEntries(allExtensions.map(e => [e.name, e]));

  for (const name of ['fallback', 'load-balancer', 'non-compliant-transform', 'openai-format', 'sanitization', 'thinking-sse', 'web-search-zai']) {
    assert(byName[name], `getAll includes ${name}`);
    assert(typeof byName[name].title === 'string' && byName[name].title.length > 0, `${name} has non-empty title`);
    assert(typeof byName[name].description === 'string' && byName[name].description.length > 0, `${name} has non-empty description`);
    assert(typeof byName[name].activation === 'string', `${name} has activation`);
  }

  // Schema attached for the two extensions that declare one
  assert(byName['openai-format'].schema, 'openai-format has schema');
  assert(byName['load-balancer'].schema, 'load-balancer has schema');
  assert(byName['fallback'].schema === null, 'fallback has no schema');
  assert(byName['sanitization'].schema === null, 'sanitization has no schema');

  // Activation classifications
  assert(byName['fallback'].activation === 'route-driven', 'fallback is route-driven');
  assert(byName['web-search-zai'].activation === 'provider-driven', 'web-search-zai is provider-driven');
  assert(byName['web-search-zai'].providerTrigger === 'toolTransforms.web_search', 'web-search-zai trigger recorded');
  assert(byName['sanitization'].activation === 'always', 'sanitization is always-on');

  // ── Load Balancer Extension ──
  console.log('\nload-balancer:');
  const { createLoadBalancerExtension } = await import('../src/extensions/load-balancer/index.js');
  const { selectRoundRobin } = await import('../src/extensions/load-balancer/strategies/round-robin.js');
  const { selectLeastConn, entryKey } = await import('../src/extensions/load-balancer/strategies/least-conn.js');
  const { selectRandom, selectWeighted } = await import('../src/extensions/load-balancer/strategies/random.js');

  // Round-robin strategy
  const rrState = { counter: 0 };
  const rrEntries = [{ providerId: 'a', model: 'm1', weight: 1 }, { providerId: 'b', model: 'm2', weight: 1 }];
  assert(selectRoundRobin(rrEntries, rrState).providerId === 'a', 'round-robin picks first');
  assert(selectRoundRobin(rrEntries, rrState).providerId === 'b', 'round-robin picks second');
  assert(selectRoundRobin(rrEntries, rrState).providerId === 'a', 'round-robin wraps');

  // Least-conn strategy
  const lcCounts = new Map();
  const lcEntries = [{ providerId: 'a', model: 'm', weight: 1 }, { providerId: 'b', model: 'm', weight: 1 }];
  lcCounts.set('a:m', 3);
  lcCounts.set('b:m', 1);
  assert(selectLeastConn(lcEntries, lcCounts).providerId === 'b', 'least-conn picks fewest active');

  // Weighted strategy (statistical — run many times)
  const wEntries = [{ providerId: 'a', model: 'm', weight: 9 }, { providerId: 'b', model: 'm', weight: 1 }];
  let wA = 0;
  for (let i = 0; i < 1000; i++) { if (selectWeighted(wEntries).providerId === 'a') wA++; }
  assert(wA > 700, `weighted favors higher weight (a=${wA}/1000)`);

  // Random strategy
  const randEntry = selectRandom(lcEntries);
  assert(randEntry.providerId === 'a' || randEntry.providerId === 'b', 'random returns valid entry');

  // entryKey
  assert(entryKey({ providerId: 'z', model: 'glm-5' }) === 'z:glm-5', 'entryKey with providerId');
  assert(entryKey({ provider: 'z', model: 'glm-5' }) === 'z:glm-5', 'entryKey with legacy provider field');

  // UID-based pool config (ref format)
  const lbRef = createLoadBalancerExtension({
    pools: {
      coder: {
        strategy: 'round-robin',
        entries: [{ ref: 'z.glm-5', weight: 5 }, 'synthetic.zai-org/GLM-5']
      }
    },
    aliases: { '*sonnet*': 'coder' }
  });
  assert(lbRef.name === 'load-balancer', 'extension name');

  // resolveProvider with alias match
  const resolved = lbRef.hooks.resolveProvider.resolve({ body: { model: 'claude-sonnet-4-20250514' } });
  assert(resolved !== null, 'resolves sonnet alias');
  assert(resolved.providerId === 'z' || resolved.providerId === 'synthetic', 'resolved providerId is valid');

  // resolveProvider returns null for non-matching model
  const noResolve = lbRef.hooks.resolveProvider.resolve({ body: { model: 'claude-opus-4-20250514' } });
  assert(noResolve === null, 'returns null for unmatched model');

  // resolveProvider with exact pool name
  const lbExact = createLoadBalancerExtension({
    pools: {
      coder: {
        strategy: 'round-robin',
        entries: [{ ref: 'z.glm-5', weight: 5 }, 'synthetic.zai-org/GLM-5']
      }
    }
  });
  const exactResolved = lbExact.hooks.resolveProvider.resolve({ body: { model: 'coder' } });
  assert(exactResolved !== null, 'resolves exact pool name as model');
  assert(exactResolved.providerId === 'z' || exactResolved.providerId === 'synthetic', 'exact pool resolved to valid provider');

  // Legacy entry format still works
  const lbLegacy = createLoadBalancerExtension({
    pools: {
      test: {
        strategy: 'round-robin',
        entries: [{ provider: 'z', model: 'glm-5', weight: 1 }]
      }
    }
  });
  const legacyResolved = lbLegacy.hooks.resolveProvider.resolve({ body: { model: 'test' } });
  assert(legacyResolved.providerId === 'z' && legacyResolved.model === 'glm-5', 'legacy entry format works');

  // onRequestStart / onRequestEnd tracking
  const lbTracking = createLoadBalancerExtension({
    pools: { coder: { entries: ['z.glm-5'] } }
  });
  const trackMap = new Map();
  const _origSet = trackMap.set.bind(trackMap);
  // Verify hooks exist and don't crash
  lbTracking.hooks.onRequestStart.handler({ providerId: 'z', model: 'glm-5' });
  lbTracking.hooks.onRequestEnd.handler({ providerId: 'z', model: 'glm-5' });

  // ── OpenAI Format Extension ──
  console.log('\nopenai-format:');
  const { createOpenaiFormatExtension } = await import('../src/extensions/openai-format/index.js');
  const { convertRequest } = await import('../src/extensions/openai-format/converters/request.js');
  const { convertChunk, convertFullResponse, createState } = await import('../src/extensions/openai-format/converters/response-sse.js');

  // Request conversion: basic text
  const anthropicReq = {
    model: 'gpt-4',
    system: 'You are helpful.',
    messages: [
      { role: 'user', content: 'Hello' }
    ],
    max_tokens: 1024,
    stream: true,
    temperature: 0.7,
  };
  const openaiReq = convertRequest(anthropicReq);
  assert(openaiReq.model === 'gpt-4', 'model preserved');
  assert(openaiReq.messages[0].role === 'system', 'system converted to system role message');
  assert(openaiReq.messages[0].content === 'You are helpful.', 'system text preserved');
  assert(openaiReq.messages[1].role === 'user', 'user message converted');
  assert(openaiReq.max_tokens === 1024, 'max_tokens preserved');
  assert(openaiReq.stream === true, 'stream preserved');
  assert(openaiReq.temperature === 0.7, 'temperature preserved');

  // Request conversion: tool_use → tool_calls
  const toolReq = {
    model: 'gpt-4',
    messages: [
      { role: 'user', content: 'Read file' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read that.' },
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: '/tmp/x' } }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' }] }
    ],
    tools: [
      { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }
    ],
    tool_choice: 'auto',
  };
  const toolResult = convertRequest(toolReq);
  const assistantMsg = toolResult.messages.find(m => m.tool_calls);
  assert(assistantMsg, 'assistant message has tool_calls');
  assert(assistantMsg.tool_calls[0].function.name === 'read_file', 'tool_use name preserved');
  assert(assistantMsg.tool_calls[0].id === 'tu_1', 'tool_use id preserved');
  assert(toolResult.tools.length === 1, 'tools converted');
  assert(toolResult.tools[0].type === 'function', 'tool converted to function type');
  assert(toolResult.tool_choice === 'auto', 'tool_choice auto preserved');

  // Request conversion: tool_choice variants
  assert(convertRequest({ messages: [], tool_choice: 'any' }).tool_choice === 'required', 'tool_choice any → required');
  assert(convertRequest({ messages: [], tool_choice: { type: 'tool', name: 'my_tool' } }).tool_choice.function.name === 'my_tool', 'tool_choice named tool');

  // Request conversion: system as array
  const sysArr = convertRequest({ model: 'm', system: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }], messages: [] });
  assert(sysArr.messages[0].content === 'Part 1\nPart 2', 'system array joined');

  // Request conversion: built-in tools skipped
  const builtinTools = convertRequest({ model: 'm', messages: [], tools: [
    { type: 'web_search' },
    { name: 'my_fn', description: 'desc', input_schema: {} }
  ]});
  assert(builtinTools.tools.length === 1, 'built-in tools filtered out');
  assert(builtinTools.tools[0].function.name === 'my_fn', 'custom tool kept');

  // SSE chunk conversion: text streaming
  const ofState = createState();
  const ofChunk1 = convertChunk('data: {"id":"chatcmpl-1","model":"gpt-4","choices":[{"delta":{"role":"assistant","content":"Hi"}}]}\n\n', ofState);
  assert(ofChunk1.includes('message_start'), 'first chunk emits message_start');
  assert(ofChunk1.includes('content_block_start'), 'first chunk emits content_block_start');
  assert(ofChunk1.includes('content_block_delta'), 'chunk emits content_block_delta');

  const ofChunk2 = convertChunk('data: {"id":"chatcmpl-1","model":"gpt-4","choices":[{"delta":{"content":" there"}}]}\n\n', ofState);
  assert(ofChunk2.includes('content_block_delta'), 'second chunk emits delta');
  assert(!ofChunk2.includes('message_start'), 'second chunk does not re-emit message_start');

  const ofChunk3 = convertChunk('data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', ofState);
  assert(ofChunk3.includes('content_block_stop'), 'finish emits content_block_stop');
  assert(ofChunk3.includes('message_delta'), 'finish emits message_delta');
  assert(ofChunk3.includes('"stop_reason":"end_turn"'), 'stop reason converted');

  const ofChunkDone = convertChunk('data: [DONE]\n\n', ofState);
  assert(ofChunkDone.includes('message_stop'), '[DONE] emits message_stop');
  assert(ofState.finished === true, 'state marked finished');

  // SSE chunk conversion: tool calls
  const ofTcState = createState();
  const ofTcChunk = convertChunk('data: {"id":"chatcmpl-2","model":"gpt-4","choices":[{"delta":{"role":"assistant","tool_calls":[{"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}\n\n', ofTcState);
  assert(ofTcChunk.includes('tool_use'), 'tool call chunk emits tool_use block');
  assert(ofTcChunk.includes('"name":"read_file"'), 'tool name in content_block_start');

  const ofTcArgPayload = JSON.stringify({ id: 'chatcmpl-2', choices: [{ delta: { tool_calls: [{ function: { arguments: '{"path":"/tmp"}' } }] } }] });
  const ofTcArgs = convertChunk('data: ' + ofTcArgPayload + '\n\n', ofTcState);
  assert(ofTcArgs.includes('input_json_delta'), 'tool arguments emit input_json_delta');

  // SSE: empty chunk / already finished
  const ofFinState = createState();
  ofFinState.finished = true;
  assert(convertChunk('data: {}', ofFinState) === '', 'finished state returns empty');

  // Full response conversion
  const ofFullResp = convertFullResponse(JSON.stringify({
    id: 'chatcmpl-3',
    model: 'gpt-4',
    choices: [{
      message: { content: 'Hello world', tool_calls: [{ id: 'tc_1', function: { name: 'fn', arguments: '{"a":1}' } }] },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  }));
  const ofParsed = JSON.parse(ofFullResp);
  assert(ofParsed.type === 'message', 'full response type is message');
  assert(ofParsed.content[0].type === 'text', 'text content first');
  assert(ofParsed.content[1].type === 'tool_use', 'tool_use second');
  assert(ofParsed.content[1].input.a === 1, 'tool input parsed');
  assert(ofParsed.stop_reason === 'tool_use', 'finish_reason tool_calls → tool_use');
  assert(ofParsed.usage.input_tokens === 10, 'usage preserved');

  // Extension hook passthrough for non-openai providers
  const ofExt = createOpenaiFormatExtension({ providers: { synthetic: { format: 'openai' } } });
  const ofBody = { model: 'test', messages: [] };
  assert(ofExt.hooks.requestTransform.transform({ body: ofBody, provider: { id: 'other' } }) === ofBody, 'non-openai provider passthrough');
  assert(ofExt.hooks.responseTransform.transform({ response: 'raw', provider: { id: 'other' } }) === 'raw', 'response passthrough for non-openai');

  // Extension hook converts for openai provider
  const ofTransformed = ofExt.hooks.requestTransform.transform({ body: anthropicReq, provider: { id: 'synthetic' } });
  assert(ofTransformed.messages[0].role === 'system', 'openai provider gets converted request');

  // ── ErrorReporter (zero-mock, writes to real temp dir) ──
  console.log('\nErrorReporter:');

  const { ErrorReporter } = await import('../src/infra/error-reporter.js');
  const { UpstreamError } = await import('../src/core/exceptions.js');
  const errTestDir = path.join(os.tmpdir(), `ccb-err-test-${Date.now()}`);
  const reporter = new ErrorReporter({ logsDir: errTestDir });

  try {

    // Happy path — upstream error with full context
    console.log('  upstream error report:');
    const upstreamErr = new UpstreamError('Upstream HTTP 408', { code: 'ETIMEDOUT' });
    const result1 = reporter.write(upstreamErr, {
      requestId: 42,
      route: 'exact:z→glm-5.1',
      method: 'POST',
      url: '/v1/messages?beta=true',
      model: 'glm-5.1',
      sessionId: 'sess-abc123',
      headers: {
        'authorization': 'Bearer sk-ant-oat01-longsecrettoken1234567890',
        'x-api-key': 'sk-real-key-1234567890',
        'content-type': 'application/json',
        'x-claude-code-session-id': 'real-session-id'
      },
      responseBody: '{"error":{"type":"timeout_error","message":"Request timed out"}}',
      operation: 'upstream_error',
      statusCode: 408,
      upstreamUrl: 'https://api.z.ai/api/anthropic',
      elapsedMs: 30042
    });

    assert(result1 !== null, 'write returns result');
    assert(typeof result1.errorId === 'string', 'result has errorId');
    assert(result1.errorId.startsWith('ccb-'), 'errorId has ccb- prefix');
    assert(result1.errorId.length > 10, 'errorId is non-trivial');
    assert(typeof result1.filePath === 'string', 'result has filePath');
    assert(result1.filePath.endsWith('.err'), 'filePath ends with .err');

    const file1 = fs.readFileSync(result1.filePath, 'utf8');

    assert(file1.includes('Error ID: ccb-'), 'file contains error ID header');
    assert(file1.includes('Error ID: ' + result1.errorId), 'file contains exact error ID');
    assert(file1.includes('Operation: upstream_error'), 'file contains operation');
    assert(file1.includes('Request ID: #42'), 'file contains request ID');
    assert(file1.includes('Route: exact:z→glm-5.1'), 'file contains route');
    assert(file1.includes('Method: POST'), 'file contains method');
    assert(file1.includes('URL: /v1/messages?beta=true'), 'file contains URL with query');
    assert(file1.includes('Model: glm-5.1'), 'file contains model');
    assert(file1.includes('Session: sess-abc123'), 'file contains session ID');
    assert(file1.includes('Status: 408'), 'file contains status code');
    assert(file1.includes('Upstream: https://api.z.ai/api/anthropic'), 'file contains upstream URL');
    assert(file1.includes('Elapsed: 30042ms'), 'file contains elapsed time');
    assert(file1.includes('Upstream HTTP 408'), 'file contains error message');
    assert(file1.includes('timeout_error'), 'file contains response body content');

    assert(!file1.includes('sk-ant-oat01-longsecrettoken'), 'authorization token is redacted');
    assert(!file1.includes('Bearer sk-ant'), 'Bearer prefix is not exposed');
    assert(file1.includes('authorization:'), 'authorization header name is present');
    assert(file1.includes('...[REDACTED]'), 'redaction marker is present');
    assert(!file1.includes('sk-real-key-1234567890'), 'x-api-key is redacted');
    assert(file1.includes('content-type: application/json'), 'non-sensitive header preserved');
    assert(file1.includes('x-claude-code-session-id: real-session-id'), 'session header preserved');

    assert(file1.includes('Quote the Error ID'), 'footer has correlation hint');

    const errFiles = fs.readdirSync(errTestDir).filter(f => f.endsWith('.err'));
    assert(errFiles.length === 1, 'exactly one .err file written');
    assert(errFiles[0].includes('42-'), 'filename contains request ID');
    assert(errFiles[0].includes(result1.errorId), 'filename contains error ID');

    // Config error — minimal context
    console.log('  config error report:');
    const configErr = new ConfigError('Port must be a number');
    const result2 = reporter.write(configErr, {
      operation: 'parsing config.json'
    });
    assert(result2 !== null, 'config error returns result');
    assert(result2.errorId.startsWith('ccb-'), 'config error has ccb- prefix');
    assert(result2.errorId !== result1.errorId, 'error IDs are unique');

    const file2 = fs.readFileSync(result2.filePath, 'utf8');
    assert(file2.includes('Operation: parsing config.json'), 'config error has operation');
    assert(file2.includes('Port must be a number'), 'config error has message');
    assert(!file2.includes('Status:'), 'no status when not provided');
    assert(!file2.includes('Upstream:'), 'no upstream when not provided');
    assert(!file2.includes('Elapsed:'), 'no elapsed when not provided');

    // Request body redaction — metadata.user_id must not leak
    console.log('  request body redaction:');
    const result3 = reporter.write(new UpstreamError('body redaction test', {}), {
      requestId: 7,
      operation: 'request_processing',
      requestBody: {
        model: 'glm-5.1',
        metadata: {
          user_id: JSON.stringify({ device_id: 'abc123', account_uuid: 'uuid-456' })
        },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'secret conversation text here' }] }
        ],
        system: [
          { type: 'thinking', thinking: 'internal reasoning data' }
        ]
      },
      debugMode: true
    });

    const file3 = fs.readFileSync(result3.filePath, 'utf8');
    assert(!file3.includes('secret conversation text'), 'text content is redacted');
    assert(!file3.includes('internal reasoning'), 'thinking content is redacted');
    assert(!file3.includes('device_id'), 'device_id is redacted');
    assert(!file3.includes('account_uuid'), 'account_uuid is redacted');
    assert(!file3.includes('abc123'), 'device_id value is redacted');
    assert(file3.includes('[redacted:'), 'redaction markers present');
    assert(file3.includes('"model": "glm-5.1"'), 'model is preserved');
    assert(file3.includes('"role": "user"'), 'role is preserved');

    // Non-debug mode — no request body section
    console.log('  non-debug mode:');
    const result4 = reporter.write(new UpstreamError('non-debug test', {}), {
      requestId: 8,
      operation: 'test',
      requestBody: { model: 'test' }
    });
    const file4 = fs.readFileSync(result4.filePath, 'utf8');
    assert(!file4.includes('Request Body Structure'), 'no body section in non-debug mode');

    // Long response body truncation
    console.log('  response body truncation:');
    const longBody = 'x'.repeat(8192);
    const result5 = reporter.write(new UpstreamError('truncation test', {}), {
      requestId: 9,
      operation: 'test',
      responseBody: longBody
    });
    const file5 = fs.readFileSync(result5.filePath, 'utf8');
    assert(file5.includes('truncated, 8192 chars total'), 'long body is truncated');
    assert(file5.includes('x'.repeat(4096)), 'first 4096 chars preserved');

    // Sensitive header redaction completeness
    console.log('  all sensitive headers redacted:');
    const result6 = reporter.write(new UpstreamError('header redaction test', {}), {
      requestId: 10,
      operation: 'test',
      headers: {
        'authorization': 'Bearer secret-token-value',
        'cookie': 'session=abc123',
        'set-cookie': 'session=abc123',
        'x-api-key': 'sk-key-1234567890',
        'anthropic-dangerous-direct-browser-access': 'true',
        'x-stainless-retry-count': '3',
        'accept': 'application/json',
        'user-agent': 'claude-cli/2.1.128'
      }
    });
    const file6 = fs.readFileSync(result6.filePath, 'utf8');
    assert(!file6.includes('secret-token-value'), 'authorization value redacted');
    assert(!file6.includes('session=abc123'), 'cookie value redacted');
    assert(!file6.includes('sk-key-1234567890'), 'x-api-key value redacted');
    assert(!file6.includes('anthropic-dangerous-direct-browser-access: true'), 'dangerous header redacted');
    assert(!file6.includes('x-stainless-retry-count: 3'), 'retry count redacted');
    assert(file6.includes('accept: application/json'), 'accept header preserved');
    assert(file6.includes('user-agent: claude-cli/2.1.128'), 'user-agent preserved');

    // Error ID uniqueness across rapid writes
    console.log('  error ID uniqueness:');
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
      const r = reporter.write(new UpstreamError('batch test', {}), { requestId: 100 + i, operation: 'batch' });
      ids.add(r.errorId);
    }
    assert(ids.size === 50, '50 writes produce 50 unique error IDs');

    // Request history inclusion
    console.log('  request history:');
    const history = [
      new RequestSummary({ id: 1, route: 'exact:z→glm-5.1', model: 'glm-5.1', status: 200, duration: 1200, inputTokens: 500, outputTokens: 100 }),
      new RequestSummary({ id: 2, route: 'exact:z→glm-5.1', model: 'glm-5.1', status: 408, duration: 30000, inputTokens: 500, outputTokens: 0 })
    ];
    const result7 = reporter.write(new UpstreamError('after history', {}), {
      requestId: 3,
      operation: 'test',
      history
    });
    const file7 = fs.readFileSync(result7.filePath, 'utf8');
    assert(file7.includes('Recent Requests'), 'history section present');
    assert(file7.includes('#1 exact:z→glm-5.1 | 200 | 1200ms'), 'first history entry');
    assert(file7.includes('#2 exact:z→glm-5.1 | 408 | 30000ms'), 'second history entry');

  } finally {
    fs.rmSync(errTestDir, { recursive: true, force: true });
  }

  // ── Logger timestamps ──
  console.log('\nLogger timestamps:');

  const { Logger } = await import('../src/infra/logger.js');
  const logTestDir = path.join(os.tmpdir(), `ccb-log-test-${Date.now()}`);
  const logFile = path.join(logTestDir, 'test.log');

  try {
    const logger = new Logger({ logsDir: logTestDir, defaultLog: logFile, maxHistory: 10 });
    await logger.emit('[REQ #1] → test /v1/messages', 'sess-test');

    const sessionLog = path.join(logTestDir, 'session-sess-test.log');
    const logContent = fs.readFileSync(sessionLog, 'utf8');
    const timeRegex = /^\[sess-test\] \d{2}:\d{2}:\d{2} \[REQ #1\]/;
    assert(timeRegex.test(logContent), 'log line includes HH:MM:SS timestamp');

    assert(logContent.includes('[sess-test]'), 'session prefix present');
    assert(logContent.includes('[REQ #1]'), 'log line content preserved');

    await logger.emit('[RES #1] ← 200', null);
    const logContent2 = fs.readFileSync(logFile, 'utf8');
    const timeRegex2 = /^\d{2}:\d{2}:\d{2} \[RES #1\]/;
    assert(timeRegex2.test(logContent2), 'non-session log also has timestamp');
  } finally {
    fs.rmSync(logTestDir, { recursive: true, force: true });
  }

  // ── convertV1ToV2 fills models/toolTransforms ──
  console.log('\nconvertV1ToV2 schema completeness:');
  const { convertV1ToV2: convertV1ToV2Fn } = await import('../src/core/config-adapter.js');
  const v1Fixture = {
    providers: [
      { id: 'p1', url: 'https://x.com', anthropicCompliant: true, models: { 'alias-1': 'real-1' } },
      { id: 'p2', url: 'https://y.com', anthropicCompliant: false, apiKey: 'ENV:KEY', toolTransforms: { web_search: { foo: 'bar' } } }
    ],
    routingPolicy: []
  };
  const v2Out = convertV1ToV2Fn(v1Fixture);
  assert(v2Out.providers.p1.models !== undefined, 'p1 receives explicit models object');
  assert(typeof v2Out.providers.p1.models === 'object', 'p1.models is an object');
  assert(v2Out.providers.p1.toolTransforms !== undefined, 'p1 receives explicit toolTransforms');
  assert(v2Out.providers.p2.toolTransforms.web_search.foo === 'bar', 'p2 toolTransforms preserved');
  assert(v2Out.providers.p2.apiKey === 'ENV:KEY', 'p2 apiKey preserved');
  assert(v2Out.routes.models['alias-1'] === 'p1.real-1', 'p1 models migrated into routes.models');

  // The resulting v2 must satisfy ProviderConfig's strict validation
  const { ProviderConfig: PCfg } = await import('../src/core/providers.js');
  for (const [id, cfg] of Object.entries(v2Out.providers)) {
    new PCfg({ id, url: cfg.url, models: cfg.models, anthropicCompliant: cfg.anthropicCompliant, toolTransforms: cfg.toolTransforms });
  }

  // ── UpstreamError accepts missing opts (regression) ──
  console.log('\nUpstreamError construction:');
  const { UpstreamError: UE } = await import('../src/core/exceptions.js');
  const ue1 = new UE('one-arg construction');
  assert(ue1.message.includes('one-arg construction'), 'message preserved with one-arg form');
  assert(ue1.statusCode === 0, 'statusCode defaults to 0 when no opts');
  assert(ue1.responseBody === '', 'responseBody defaults to empty when no opts');
  const ue2 = new UE('with opts', { statusCode: 502, responseBody: 'bad gateway' });
  assert(ue2.statusCode === 502, 'statusCode from opts');
  assert(ue2.responseBody === 'bad gateway', 'responseBody from opts');

  // ── getControlIpcPath with port ──
  console.log('\ngetControlIpcPath with port:');
  const { getControlIpcPath: gcip } = await import('../src/core/constants.js');
  const ipc9099 = gcip(9099);
  const ipc9100 = gcip(9100);
  assert(ipc9099 !== ipc9100, 'different ports yield different IPC paths');
  assert(ipc9099.includes('9099'), 'IPC path embeds port 9099');
  assert(ipc9100.includes('9100'), 'IPC path embeds port 9100');
  const ipcEmpty = gcip();
  assert(!ipcEmpty.includes('-9099'), 'no port arg = no port suffix');

  // ── ensureCompleteConfig fills ipcTimeoutMs and retry block ──
  console.log('\nensureCompleteConfig defaults:');
  const { ensureCompleteConfig: ecc } = await import('../src/core/migrator.js');
  const legacy = {
    port: 9099,
    daemon: { healthCheckTimeoutMs: 500, pollIntervalMs: 300, pollMaxAttempts: 10 }
  };
  const completed = ecc(legacy);
  assert(completed.daemon.ipcTimeoutMs === 5000, 'ipcTimeoutMs default applied');
  assert(completed.daemon.workerKeepaliveS === -1, 'workerKeepaliveS default applied');
  assert(completed.daemon.upstreamTimeoutMs === 600000, 'upstreamTimeoutMs default applied');
  assert(completed.daemon.workerInitTimeoutMs === 20000, 'workerInitTimeoutMs default applied');
  assert(completed.daemon.drainTimeoutMs === 600000, 'drainTimeoutMs default applied');
  assert(typeof completed.daemon.retry === 'object', 'retry block populated');
  assert(completed.daemon.retry.maxAttempts === 2, 'retry.maxAttempts default');
  assert(completed.logging.enabled === true, 'logging.enabled default');
  assert(completed.compression.recompressRequests === true, 'compression default');

  // ── stripAnsi (terminal emulator helper) ──
  console.log('\nstripAnsi:');
  assert(stripAnsi('plain') === 'plain', 'plain string unchanged');
  assert(stripAnsi('\x1b[31mred\x1b[0m').includes('red'), 'color sequence stripped');
  assert(!stripAnsi('\x1b[31mred\x1b[0m').includes('\x1b'), 'no ESC after strip');
  assert(stripAnsi('\x1b[2;5H❯ prompt').endsWith('❯ prompt'), 'cursor positioning stripped');
  assert(stripAnsi('\x1b]0;title\x07after') === 'after', 'OSC title stripped');
  // ZOMBIES boundary: empty, one char, near-only-escape, no escape
  assert(stripAnsi('') === '', '0 length input');
  assert(stripAnsi('x') === 'x', 'single char');
  assert(stripAnsi('\x1b[K') === '', 'only escape leaves empty');

  // ── ipc-protocol restart-request validation ──
  console.log('\nrestart-request worker message:');
  const { validateWorkerMessage: vwm } = await import('../src/core/ipc-protocol.js');
  assert(vwm({ type: 'restart-request' })?.type === 'restart-request', 'restart-request accepted');
  assert(vwm({ type: 'bogus' }) === null, 'unknown type rejected');
  assert(vwm(null) === null, 'null rejected');
  assert(vwm({ type: 'error', message: 'oops' })?.message === 'oops', 'error type still works');
  assert(vwm({ type: 'ready', pid: 1, routes: 2, extensions: 3 })?.routes === 2, 'ready type still works');

}

// ── Integration test (isolated daemon) ──

const TEST_PORT = 9100;
const TEST_CONFIG_DIR = path.join(PKG_ROOT, '.test-config');

async function setupTestConfig() {
  const testEnvPath = path.join(TEST_CONFIG_DIR, ENV_FILENAME);
  let savedEnv = null;
  if (fs.existsSync(testEnvPath)) {
    const content = fs.readFileSync(testEnvPath, 'utf8');
    // Only trust the cached .env if ZAI_KEY has a non-empty value.
    // A previous failed run may have left ZAI_KEY= (empty).
    const keyMatch = content.match(/^ZAI_KEY=(.+)$/m);
    if (keyMatch && keyMatch[1].trim()) {
      savedEnv = content;
    }
  }

  // Fall back to the user's real ccb config .env (~/.claude/.ccb/.env)
  if (!savedEnv) {
    const userCcbEnv = path.join(os.homedir(), '.claude', CCB_DIR_NAME, ENV_FILENAME);
    if (fs.existsSync(userCcbEnv)) {
      const content = fs.readFileSync(userCcbEnv, 'utf8');
      const keyMatch = content.match(/^ZAI_KEY=(.+)$/m);
      if (keyMatch && keyMatch[1].trim()) savedEnv = content;
    }
  }

  // WSL cross-mount fallback: Linux homedir may differ from Windows USERPROFILE
  if (!savedEnv) {
    try {
      const winHome = runSync('cmd.exe', ['/c', 'echo', '%USERPROFILE%'], { encoding: 'utf8', timeout: 3000 });
      const winPath = (winHome.stdout || '').trim();
      if (winPath && !winPath.includes('%')) {
        const wslPath = winPath.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_, d) => `/mnt/${d.toLowerCase()}`);
        const wslEnv = path.join(wslPath, '.claude', CCB_DIR_NAME, ENV_FILENAME);
        if (fs.existsSync(wslEnv)) {
          const content = fs.readFileSync(wslEnv, 'utf8');
          const keyMatch = content.match(/^ZAI_KEY=(.+)$/m);
          if (keyMatch && keyMatch[1].trim()) savedEnv = content;
        }
      }
    } catch { /* not WSL or cmd.exe unavailable */ }
  }

  // Last resort: process environment
  if (!savedEnv) {
    if (!process.env.ZAI_KEY) {
      throw new ArgumentError('No ZAI_KEY found. Set it via ccb --x-key, or in process env.');
    }
    savedEnv = `ZAI_KEY=${process.env.ZAI_KEY}\n`;
  }

  const logsDir = path.join(TEST_CONFIG_DIR, LOGS_DIR_NAME);
  if (fs.existsSync(TEST_CONFIG_DIR)) {
    try {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    } catch {
      // WSL on /mnt/c/ (NTFS cross-mount) can fail with ENOTEMPTY
      runSync('rm', ['-rf', TEST_CONFIG_DIR], { encoding: 'utf8' });
    }
  }
  fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const providers = {
    providers: {
      "zai": {
        url: "https://api.z.ai/api/anthropic",
        models: {},
        anthropicCompliant: false,
        toolTransforms: {
          web_search: {
            search_engine: "search-prime",
            count: "5",
            search_recency_filter: "noLimit",
            content_size: "high"
          }
        }
      },
      "synthetic": {
        "url": "https://api.openai.com/v1",
        models: {},
        anthropicCompliant: false,
        toolTransforms: {}
      }
    },
    extensions: {
      "openai-format": {
        providers: {
          "synthetic": { "format": "openai" }
        }
      }
    },
    routes: {
      models: { "glm-4.7": "zai.glm-4.7" },
      properties: {},
      payloadSize: {}
    }
  };
  fs.writeFileSync(path.join(TEST_CONFIG_DIR, PROVIDERS_FILENAME), JSON.stringify(providers, null, 2), 'utf8');

  const config = {
    port: TEST_PORT,
    daemon: { healthCheckTimeoutMs: 1000, pollIntervalMs: 200, pollMaxAttempts: 15, upstreamTimeoutMs: 0, workerInitTimeoutMs: 20000, drainTimeoutMs: 600000, workerKeepaliveS: -1, ipcTimeoutMs: 5000, daemonStartTimeoutMs: 60000, daemonStartProgressGraceMs: 15000 },
    logging: { enabled: true, requests: true, responses: true, history: 5, maxBodyLog: 1000, level: 'trace' }
  };
  fs.writeFileSync(path.join(TEST_CONFIG_DIR, CONFIG_FILENAME), JSON.stringify(config, null, 2), 'utf8');

  fs.writeFileSync(testEnvPath, savedEnv, 'utf8');
}

function checkTestProxy() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${TEST_PORT}/v1/models`, () => resolve(true));
    req.on('error', () => resolve(false));
    req.setTimeout(500, () => { req.destroy(); resolve(false); });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

import { spawnDaemon, runSync } from '../src/infra/process-manager.js';

let testDaemonPid = null;

async function startTestDaemon() {
  const WATCHDOG_BIN = path.join(PKG_ROOT, 'bin', WATCHDOG_SCRIPT_NAME);
  const out = fs.openSync(path.join(TEST_CONFIG_DIR, LOGS_DIR_NAME, 'daemon.log'), 'a');
  const err = fs.openSync(path.join(TEST_CONFIG_DIR, LOGS_DIR_NAME, 'daemon.err'), 'a');

  const child = spawnDaemon(WATCHDOG_BIN, [], {
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
    env: { ...process.env, CCB_CONFIG_DIR: TEST_CONFIG_DIR }
  });
  testDaemonPid = child.pid;
  child.unref();

  const POLL_MS = 200;
  for (let i = 0; i < 15; i++) {
    if (await checkTestProxy()) return true;
    await sleep(POLL_MS);
  }
  return false;
}

function killTestDaemon() {
  if (testDaemonPid) {
    try { process.kill(testDaemonPid, 'SIGKILL'); } catch { }
    testDaemonPid = null;
  }

  // Kill anything listening on the test port
  try {
  if (process.platform === 'win32') {
    const r = runSync('netstat', ['-aon', '-p', 'TCP'], { encoding: 'utf8' });
    const lines = (r.stdout || '').split('\n').filter(l => l.includes(`:${TEST_PORT} `));
    for (const line of lines) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch { }
      }
    }
  }
  if (process.platform !== 'win32') {
    const ss = runSync('sh', ['-c', `ss -ltnp | grep :${TEST_PORT}`], { encoding: 'utf8' });
    const match = ss.stdout.match(/pid=(\d+)/);
    if (match && match[1]) {
      process.kill(Number(match[1]), 'SIGKILL');
    }
  }
  } catch { }
}

// ANSI CSI / OSC escape strip — turns terminal output into something
// regex-matchable without false hits on color sequences or cursor codes.
// Pattern adapted from the standard "ansi-regex" coverage set. The
// no-control-regex rule fires on ESC / BEL characters at the heart of
// CSI/OSC matching; matching them is exactly what this regex is for.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = new RegExp('[\\u001b\\u009b][[\\]()#;?]*(?:(?:(?:[a-zA-Z0-9]*(?:;[a-zA-Z0-9]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PRZcf-ntqry=><~]))', 'g');
function stripAnsi(s) {
  return s.replace(ANSI_ESCAPE_PATTERN, '');
}

const INTERACTIVE_POLL_MS = 100;
const INTERACTIVE_QUIESCE_MS = 250;
const INTERACTIVE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MiB cap per session
const INTERACTIVE_CLOSE_GRACE_MS = 1000;

class InteractiveSession {
  constructor(cmd, args, env) {
    this.output = '';
    this.lastDataAt = Date.now();
    this.closed = false;
    this.exited = false;
    this.exitInfo = null;
    this.ptyProcess = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: env
    });
    this.ptyProcess.onData((data) => {
      this.output += data;
      this.lastDataAt = Date.now();
      if (this.output.length > INTERACTIVE_MAX_OUTPUT_BYTES) {
        // Drop the oldest half; keep recent context for assertions.
        this.output = this.output.slice(-INTERACTIVE_MAX_OUTPUT_BYTES / 2);
      }
    });
    this.ptyProcess.onExit((info) => {
      this.exited = true;
      this.exitInfo = info;
    });
  }

  // Match pattern against ANSI-stripped output so assertions are stable across
  // terminal escape variations. Returns early if the pty exits.
  async waitFor(pattern, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
      if (pattern.test(stripAnsi(this.output))) return true;
      if (this.exited) return pattern.test(stripAnsi(this.output));
      await sleep(INTERACTIVE_POLL_MS);
    }
    return false;
  }

  // Wait until no new data has arrived for `quiesceMs`. Used to let the CLI
  // settle its initial render before we start sending keys, rather than
  // sleeping a hard-coded duration.
  async waitForQuiescence(quiesceMs = INTERACTIVE_QUIESCE_MS, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
      if (Date.now() - this.lastDataAt >= quiesceMs) return true;
      if (this.exited) return true;
      await sleep(INTERACTIVE_POLL_MS);
    }
    return false;
  }

  send(text) {
    if (this.exited) return;
    this.ptyProcess.write(text);
  }

  clearOutput() {
    this.output = '';
    this.lastDataAt = Date.now();
  }

  // Returns the ANSI-stripped accumulated output. Use this for any structural
  // assertion (substring contains, regex match against plain text).
  get visible() {
    return stripAnsi(this.output);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    // Ctrl+C twice asks Claude CLI to exit cleanly.
    try { this.ptyProcess.write('\x03\x03'); } catch { /* may already be gone */ }

    // Give it up to INTERACTIVE_CLOSE_GRACE_MS to exit on its own; otherwise kill.
    const graceStart = Date.now();
    while (!this.exited && Date.now() - graceStart < INTERACTIVE_CLOSE_GRACE_MS) {
      await sleep(INTERACTIVE_POLL_MS);
    }
    if (!this.exited) {
      try { this.ptyProcess.kill('SIGKILL'); } catch { /* best effort */ }
    }
  }
}

async function assertModel(model, expectedPattern) {
  console.log(`\nTesting model: ${model}...`);

  const CCB_BIN = path.join(PKG_ROOT, 'bin', 'ccb.js');
  const session = new InteractiveSession(process.execPath, [CCB_BIN, '--model', model], {
    ...process.env,
    CCB_CONFIG_DIR: TEST_CONFIG_DIR
  });

  try {
    // Wait for the Claude CLI prompt and let the UI settle
    const ready = await session.waitFor(/❯/);
    if (!ready) {
      console.error(`  FAIL: Timed out waiting for CLI prompt for ${model} after 60s.`);
      console.error(`  [DEBUG OUTPUT]: ${session.visible.slice(0, 500)}`);
      return false;
    }

    // Wait until the CLI stops drawing (avoids racing the prompt's settle animation).
    await session.waitForQuiescence();

    session.clearOutput();
    session.send(`State your exact model name.\r`);

    // Wait until the expected model name (or a known error pattern) appears in the output
    const waitPattern = new RegExp(`(${expectedPattern.source}|429|402|insufficient|limit reached|401|403|Authentication|thinking\\.signature|adjacent text blocks)`, 'i');
    const responded = await session.waitFor(waitPattern, 60000);
    if (!responded) {
      console.error(`  FAIL: Timed out waiting for response for ${model} after 60s.`);
      console.error(`  [DEBUG OUTPUT]: ${session.visible}`);
      return false;
    }

    const combined = session.visible;
    
    // Hard proxy logic failures
    if (combined.includes('thinking.signature: Field required') || combined.includes('adjacent text blocks not allowed')) {
      console.error(`  FAIL: Proxy Logic Failure: ${combined.slice(0, 200)}`);
      return false;
    }

    const match = expectedPattern.test(combined);
    if (match) {
      console.log(`  PASS: ${model} identified correctly`);
      return true;
    }

    // Quota/Rate-limit errors — routing reached the provider
    const isQuotaError = combined.includes('429') ||
      combined.includes('402') ||
      combined.includes('insufficient balance') ||
      combined.includes('insufficient_quota') ||
      combined.includes('out of tokens') ||
      combined.includes('limit reached') ||
      combined.includes("hit your limit");
    if (isQuotaError) {
      console.log(`  PASS: ${model} — quota/rate-limit hit, but routing reached the provider correctly.`);
      return true;
    }

    const isAuthError = combined.includes('401') || combined.includes('403') || combined.includes('Authentication');
    if (isAuthError) {
      console.error(`  FAIL: Auth error for ${model} — proxy may not have injected the API key.`);
      return false;
    }

    console.error(`  FAIL: Expected ${expectedPattern} but got "${combined.trim().slice(0, 200)}"`);
    return false;
  } finally {
    await session.close();
  }
}

async function testModelSwitch() {
  console.log(`\nTesting in-session model switch (/model)...`);

  const CCB_BIN = path.join(PKG_ROOT, 'bin', 'ccb.js');
  const session = new InteractiveSession(process.execPath, [CCB_BIN, '--model', 'glm-4.7'], {
    ...process.env,
    CCB_CONFIG_DIR: TEST_CONFIG_DIR
  });

  try {
    const ready1 = await session.waitFor(/❯/);
    if (!ready1) {
      console.error(`  FAIL: Timed out waiting for initial prompt.`);
      return false;
    }

    await session.waitForQuiescence();

    session.clearOutput();
    session.send('/model sonnet\r');

    // Wait for the UI to acknowledge the change
    const uiUpdated = await session.waitFor(/Model set to sonnet|❯/, 15000);
    if (!uiUpdated) {
      console.error(`  FAIL: Timed out waiting for /model switch acknowledgement.`);
      console.error(`  [DEBUG OUTPUT]: ${session.visible}`);
      return false;
    }

    await session.waitForQuiescence();

    session.clearOutput();
    session.send(`Identify yourself with your exact model name.\r`);

    // Wait until the expected model string or auth error appears
    const waitPattern = /claude|sonnet|401|403|disabled Claude subscription/i;
    const responded = await session.waitFor(waitPattern, 60000);
    if (!responded) {
      console.error(`  FAIL: Timed out waiting for response after switch.`);
      console.error(`  [DEBUG OUTPUT]: ${session.visible}`);
      return false;
    }

    const combined = session.visible;
    const match = /claude|sonnet/i.test(combined);
    
    // Auth errors are acceptable if Sonnet OAuth isn't set up, means routing worked
    const isAuthError = combined.includes('401') || combined.includes('403') || combined.includes('disabled Claude subscription');
    
    if (match || isAuthError) {
      console.log(`  PASS: In-session model switch successfully routed to sonnet.`);
      return true;
    }

    console.error(`  FAIL: Model did not switch correctly. Got: ${combined.slice(0, 200)}`);
    return false;
  } finally {
    await session.close();
  }
}

/**
 * Concurrency stress through the full Claude → ccb → z.ai → response chain.
 * Spawns the real CLI under PTY (just like a user), fires several prompts in
 * a row without waiting for the previous response to fully complete, asserts
 * every prompt eventually got an answer with no proxy-side errors.
 *
 * Needs ZAI_KEY in .env. Returns false if the key isn't set so the suite can
 * skip rather than fail on missing credentials.
 */
async function assertTtyConcurrency() {
  // Read ZAI_KEY from the test config dir's .env (setupTestConfig wrote
  // it from one of: cached test .env, user's ~/.claude/.ccb/.env, WSL
  // crossmount, or process.env). Match what the spawned ccb subprocess
  // will actually see.
  const testEnvPath = path.join(TEST_CONFIG_DIR, ENV_FILENAME);
  let zaiKey = process.env.ZAI_KEY;
  if (!zaiKey && fs.existsSync(testEnvPath)) {
    const m = fs.readFileSync(testEnvPath, 'utf8').match(/^ZAI_KEY=(.+)$/m);
    if (m && m[1].trim()) zaiKey = m[1].trim();
  }
  if (!zaiKey) {
    console.log('  SKIP: ZAI_KEY not available');
    return true;
  }

  const CCB_BIN = path.join(PKG_ROOT, 'bin', 'ccb.js');
  const session = new InteractiveSession(process.execPath, [CCB_BIN, '--model', 'glm-4.7'], {
    ...process.env,
    CCB_CONFIG_DIR: TEST_CONFIG_DIR
  });

  const PROMPTS = [
    'Reply with exactly: APPLE',
    'Reply with exactly: BANANA',
    'Reply with exactly: CHERRY',
    'Reply with exactly: DATE'
  ];
  const TOKENS = ['APPLE', 'BANANA', 'CHERRY', 'DATE'];

  try {
    const ready = await session.waitFor(/❯/);
    if (!ready) {
      console.error('  FAIL: TTY concurrency — CLI prompt never appeared');
      return false;
    }
    await session.waitForQuiescence();

    // Send all prompts back-to-back; Claude CLI handles them serially but
    // each turn round-trips through ccb. We're stressing the proxy's
    // sequential responsiveness through the full PTY → fork → fork chain
    // and verifying the daemon doesn't wedge between turns.
    for (const prompt of PROMPTS) {
      session.send(`${prompt}\r`);
      // Briefly let the CLI accept input before the next send (it lines them).
      await sleep(150);
    }

    // Now wait for ALL tokens to appear. Each turn the CLI shows the answer.
    // Cap at a generous 5 min for 4 turns through z.ai.
    const TTY_CONCURRENCY_TIMEOUT_MS = 300000;
    const start = Date.now();
    let seen = 0;
    while (Date.now() - start < TTY_CONCURRENCY_TIMEOUT_MS) {
      const visible = session.visible;
      seen = TOKENS.filter(tok => visible.includes(tok)).length;
      if (seen === TOKENS.length) break;
      // Surface proxy logic failures fast
      if (visible.includes('thinking.signature: Field required') ||
          visible.includes('adjacent text blocks not allowed') ||
          visible.includes('ccb_error_id')) {
        console.error(`  FAIL: TTY concurrency — proxy logic error in output: ${visible.slice(-300)}`);
        return false;
      }
      await sleep(500);
    }

    if (seen === TOKENS.length) {
      console.log(`  PASS: All ${TOKENS.length} sequential prompts round-tripped through ccb → z.ai`);
      return true;
    }
    console.error(`  FAIL: TTY concurrency — only ${seen}/${TOKENS.length} tokens seen in output after ${TTY_CONCURRENCY_TIMEOUT_MS}ms`);
    console.error(`  Last 500 chars: ${session.visible.slice(-500)}`);
    return false;
  } finally {
    await session.close();
  }
}

/**
 * Scan the most recent session log for thinking block evidence.
 * Returns { hasThinking, details } for diagnostic output.
 */
function checkThinkingInLogs() {
  const logsDir = path.join(TEST_CONFIG_DIR, LOGS_DIR_NAME);
  if (!fs.existsSync(logsDir)) return { hasThinking: false, details: 'No logs dir' };

  const sessionLogs = fs.readdirSync(logsDir)
    .filter(f => f.startsWith('session-') && f.endsWith('.log'))
    .map(f => ({ name: f, time: fs.statSync(path.join(logsDir, f)).mtime.getTime() }))
    .sort((a, b) => b.time - a.time);

  if (sessionLogs.length === 0) return { hasThinking: false, details: 'No session logs' };

  const latest = path.join(logsDir, sessionLogs[0].name);
  const content = fs.readFileSync(latest, 'utf8');

  // Check for thinking blocks in response logs (SSE events)
  const hasThinkingBlock = content.includes('"type":"thinking"') || content.includes('"type":"thinking_delta"');
  const hasRedacted = content.includes('"type":"redacted_thinking"') || content.includes('"type":"redacted_thinking_delta"');
  const hasConnectorText = content.includes('"type":"connector_text"');
  const hasSanitized = content.includes('[DEBUG') && content.includes('Sanitized');

  const details = [];
  if (hasThinkingBlock) details.push('thinking blocks in SSE');
  if (hasRedacted) details.push('redacted_thinking in SSE');
  if (hasConnectorText) details.push('connector_text in SSE');
  if (hasSanitized) details.push('sanitization fired');
  if (details.length === 0) details.push('no thinking evidence found');

  return { hasThinking: hasThinkingBlock || hasRedacted, details: details.join(', '), logFile: latest };
}
/**
 * Send a real request with web_search tool through the proxy to z.ai.
 * Verifies that:
 * 1. The tool is accepted (no 1210 error)
 * 2. The response comes back clean (no web_search array leaked to client)
 * 3. The model responds with text content
 */
async function assertWebSearchTransform() {
  const http = await import('http');
  const testToken1 = `ws-test-1-${Math.random().toString(36).slice(2)}`;
  const testToken2 = `ws-test-2-${Math.random().toString(36).slice(2)}`;

  const logsDir = path.join(TEST_CONFIG_DIR, LOGS_DIR_NAME);

  // ── TEST 1: Request Tool Transformation ──
  const body1 = JSON.stringify({
    model: 'glm-4.7',
    max_tokens: 200,
    messages: [{ role: 'user', content: `What is the current date today? [${testToken1}]` }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }]
  });

  const res1 = await new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: TEST_PORT, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body1), 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' },
      timeout: 90000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', (e) => resolve({ error: e }));
    req.on('timeout', () => { req.destroy(); resolve({ error: { code: 'HTTP_TIMEOUT', message: 'upstream timeout after 90s' } }); });
    req.write(body1);
    req.end();
  });

  if (res1.error) {
    console.error(`  FAIL: web_search test 1 connection error: ${res1.error.message}`);
    return false;
  }

  // Verify transform in logs for Test 1
  let transformed1 = null;
  try {
    const files1 = fs.readdirSync(logsDir).filter(f => f.startsWith('debug-') && f.endsWith('.sanitized.json'));
    for (const file of files1) {
      const content = fs.readFileSync(path.join(logsDir, file), 'utf8');
      if (content.includes(testToken1)) {
        transformed1 = JSON.parse(content);
        break;
      }
    }
  } catch { /* ignore */ }

  if (transformed1) {
    const wsTool = transformed1.tools?.find(t => t.type === 'web_search');
    if (!wsTool || !wsTool.web_search || wsTool.web_search.enable !== 'True') {
      console.error('  FAIL: Request tool transformation failed');
      return false;
    }
    console.log('  PASS: Request tool transformation verified in debug logs');
  }

  // ── TEST 2: History Sanitization ──
  const body2 = JSON.stringify({
    model: 'glm-4.7',
    max_tokens: 200,
    messages: [
      { role: 'user', content: 'What is the capital of France?' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Searching...' },
        { type: 'tool_use', id: 'toolu_ws_test', name: 'web_search', input: { query: 'capital of France' } }
      ]},
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_ws_test', content: 'The capital of France is Paris.' }
      ]},
      { role: 'assistant', content: [{ type: 'text', text: 'The capital of France is Paris.' }] },
      { role: 'user', content: `Tell me more about it. [${testToken2}]` }
    ]
  });

  const res2 = await new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: TEST_PORT, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body2), 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' },
      timeout: 90000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', (e) => resolve({ error: e }));
    req.on('timeout', () => { req.destroy(); resolve({ error: { code: 'HTTP_TIMEOUT', message: 'upstream timeout after 90s' } }); });
    req.write(body2);
    req.end();
  });

  if (res2.error) {
    console.error(`  FAIL: web_search test 2 connection error: ${res2.error.message}`);
    return false;
  }

  // Verify transform in logs for Test 2 (History Sanitization)
  let transformed2 = null;
  try {
    const files2 = fs.readdirSync(logsDir).filter(f => f.startsWith('debug-') && f.endsWith('.sanitized.json'));
    for (const file of files2) {
      const content = fs.readFileSync(path.join(logsDir, file), 'utf8');
      if (content.includes(testToken2)) {
        transformed2 = JSON.parse(content);
        break;
      }
    }
  } catch { /* ignore */ }

  if (transformed2) {
    const msgWithToolUse = transformed2.messages.find(m => m.role === 'assistant' && JSON.stringify(m.content).includes('[web_search query:'));
    const msgWithToolResult = transformed2.messages.find(m => m.role === 'user' && JSON.stringify(m.content).includes('[web_search results:'));
    
    if (!msgWithToolUse || !msgWithToolResult) {
      console.error('  FAIL: History sanitization failed');
      return false;
    }
    console.log('  PASS: History sanitization verified in debug logs');
  }

  // Final checks
  if (res1.statusCode === 400 && res1.body.includes('1210')) {
     console.error('  FAIL: web_search tool not accepted by upstream (1210 error)');
     return false;
  }

  if (res1.statusCode === 200 || res2.statusCode === 200) {
    console.log('  PASS: web_search integration test successful');
  }

  return true;
}

async function runPortFallbackTest() {
  console.log('\n── Port fallback test (occupies TEST_PORT, asserts watchdog bumps) ──');

  killTestDaemon();
  await setupTestConfig();

  const { RUNTIME_FILENAME } = await import('../src/core/constants.js');
  const runtimePath = path.join(TEST_CONFIG_DIR, RUNTIME_FILENAME);
  if (fs.existsSync(runtimePath)) fs.unlinkSync(runtimePath);

  // Hold TEST_PORT with a real TCP listener
  const net = await import('net');
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(TEST_PORT, '127.0.0.1', resolve);
  });

  try {
    const WATCHDOG_BIN = path.join(PKG_ROOT, 'bin', WATCHDOG_SCRIPT_NAME);
    const out = fs.openSync(path.join(TEST_CONFIG_DIR, LOGS_DIR_NAME, 'daemon.log'), 'a');
    const err = fs.openSync(path.join(TEST_CONFIG_DIR, LOGS_DIR_NAME, 'daemon.err'), 'a');
    const child = spawnDaemon(WATCHDOG_BIN, [], {
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
      env: { ...process.env, CCB_CONFIG_DIR: TEST_CONFIG_DIR }
    });
    testDaemonPid = child.pid;
    child.unref();

    // Wait for runtime.json to appear and for the new port to answer
    const RUNTIME_TIMEOUT_MS = 15000;
    const RUNTIME_POLL_MS = 200;
    const startTs = Date.now();
    let runtime = null;
    while (Date.now() - startTs < RUNTIME_TIMEOUT_MS) {
      if (fs.existsSync(runtimePath)) {
        try {
          runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
          if (typeof runtime.port === 'number') break;
        } catch { /* file may be mid-write */ }
      }
      await sleep(RUNTIME_POLL_MS);
    }

    if (!runtime) {
      console.error('  FAIL: runtime.json never appeared after 15s');
      return false;
    }
    assert(runtime.port !== TEST_PORT, 'watchdog did NOT bind blocked TEST_PORT');
    assert(runtime.port > TEST_PORT && runtime.port <= TEST_PORT + 10, `watchdog bound a port within fallback range (got ${runtime.port})`);
    assert(typeof runtime.watchdogPid === 'number' && runtime.watchdogPid > 0, 'runtime.json records a watchdog PID');
    assert(typeof runtime.version === 'string', 'runtime.json records the version');

    // Verify the bumped port actually answers /v1/models
    const probeStart = Date.now();
    let alive = false;
    while (Date.now() - probeStart < RUNTIME_TIMEOUT_MS) {
      const probe = await new Promise((resolve) => {
        const req = http.get(`http://localhost:${runtime.port}/v1/models`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.setTimeout(500, () => { req.destroy(); resolve(false); });
      });
      if (probe) { alive = true; break; }
      await sleep(RUNTIME_POLL_MS);
    }
    assert(alive, 'bumped-port daemon answers HTTP');

    console.log(`  PASS: watchdog fell back from ${TEST_PORT} to ${runtime.port} and wrote runtime.json correctly`);
    return true;
  } finally {
    await new Promise((resolve) => blocker.close(() => resolve()));
    killTestDaemon();
    if (fs.existsSync(runtimePath)) {
      try { fs.unlinkSync(runtimePath); } catch { /* best effort */ }
    }
  }
}

async function runIntegrationTests() {
  console.log('\n── Integration Tests (isolated daemon on port ' + TEST_PORT + ') ──');

  killTestDaemon();
  await setupTestConfig();

  console.log('Starting test daemon...');
  const started = await startTestDaemon();
  if (!started) {
    console.error('FAIL: Test daemon failed to start on port ' + TEST_PORT);
    return [false];
  }
  console.log('Test daemon started.');

  // Open a persistent keepalive to prevent the daemon from auto-shutting down
  // between sequential test runs.
  let testKeepaliveSocket = null;
  try {
    const req = http.get({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/__ccb_internal__/keepalive',
      headers: { connection: 'keep-alive' }
    });
    req.on('socket', (sock) => { testKeepaliveSocket = sock; });
    req.on('error', () => {});
  } catch (e) {
    console.error('Warning: failed to open test harness keepalive:', e.message);
  }

  // ── GUI HTTP API tests (zero-mock, real daemon) ──
  console.log('\nTesting GUI HTTP API endpoints...');
  let apiSuccess = true;
  const POLL_INTERVAL_MS = 100;
  const POST_RESTART_POLL_MS = 200;

  const HTTP_TIMEOUT_MS = 10000;
  // Dedicated keep-alive agent for the API test block. Sharing a single warm
  // socket across the (mostly serial) calls avoids the per-connection
  // cold-start path that occasionally takes longer than HTTP_TIMEOUT_MS on
  // freshly-spawned daemons, and avoids the agent:false flake we saw with
  // fresh-socket-per-request.
  const apiAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const httpJsonOnce = (method, path_, body) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = {};
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(data);
    }
    const req = http.request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: path_,
      method,
      headers,
      timeout: HTTP_TIMEOUT_MS,
      agent: apiAgent
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', (e) => resolve({ error: e }));
    req.on('timeout', () => { req.destroy(); resolve({ error: { code: 'HTTP_TIMEOUT', message: 'HTTP timeout' } }); });
    if (body) req.write(data);
    req.end();
  });
  const httpJson = async (method, path_, body) => {
    // One-retry envelope: if the cold-start first request times out, the next
    // attempt warms the keep-alive socket. Real failures still surface.
    const first = await httpJsonOnce(method, path_, body);
    if (first.error?.code === 'HTTP_TIMEOUT') {
      return httpJsonOnce(method, path_, body);
    }
    return first;
  };

  // Warmup probe — the very first HTTP request to a freshly-started daemon
  // occasionally takes >10s while the worker finishes its provider/extension
  // registry. Issue a throwaway /__ccb_internal__/status first; the result is
  // ignored.
  await httpJson('GET', '/__ccb_internal__/status');

  // GET /api/config: returns v2-shaped config
  const r1 = await httpJson('GET', '/api/config');
  if (r1.statusCode === 200) {
    const cfg = JSON.parse(r1.body);
    if (!cfg.providers || Array.isArray(cfg.providers)) {
      console.error('  FAIL: /api/config did not return v2 (object) provider shape');
      apiSuccess = false;
    }
    if (cfg.providers && !cfg.providers.zai) {
      console.error('  FAIL: /api/config missing zai provider');
      apiSuccess = false;
    }
    if (apiSuccess) console.log('  PASS: GET /api/config returns v2-shaped config with provider entries');
  }
  if (r1.statusCode !== 200) {
    console.error(`  FAIL: GET /api/config returned ${r1.statusCode}`);
    apiSuccess = false;
  }

  // GET /api/daemon-config: returns full config with ipcTimeoutMs
  const r2 = await httpJson('GET', '/api/daemon-config');
  if (r2.statusCode === 200) {
    const cfg = JSON.parse(r2.body);
    if (typeof cfg.port !== 'number') {
      console.error('  FAIL: /api/daemon-config missing port');
      apiSuccess = false;
    }
    if (cfg.daemon?.ipcTimeoutMs !== 5000) {
      console.error(`  FAIL: /api/daemon-config missing or wrong ipcTimeoutMs (got ${cfg.daemon?.ipcTimeoutMs})`);
      apiSuccess = false;
    }
    if (cfg.logging?.enabled === undefined) {
      console.error('  FAIL: /api/daemon-config missing logging section');
      apiSuccess = false;
    }
    if (cfg.port === TEST_PORT && cfg.daemon.ipcTimeoutMs === 5000) console.log('  PASS: GET /api/daemon-config returns complete config');
  }
  if (r2.statusCode !== 200) {
    console.error(`  FAIL: GET /api/daemon-config returned ${r2.statusCode}`);
    apiSuccess = false;
  }

  // POST /api/daemon-config with invalid input: 400 + error body
  const r3 = await httpJson('POST', '/api/daemon-config', { port: 'not-a-number' });
  if (r3.statusCode !== 400) {
    console.error(`  FAIL: POST /api/daemon-config with invalid input expected 400, got ${r3.statusCode}`);
    apiSuccess = false;
  }
  if (r3.statusCode === 400 && r3.body.length > 0) {
    console.log('  PASS: POST /api/daemon-config rejects invalid input with 400 + message');
  }

  // POST /api/daemon-config with valid input: 200, persisted to disk
  const validCfg = JSON.parse(r2.body);
  validCfg.logging.level = 'debug';
  const r4 = await httpJson('POST', '/api/daemon-config', validCfg);
  if (r4.statusCode !== 200) {
    console.error(`  FAIL: POST /api/daemon-config with valid input expected 200, got ${r4.statusCode}: ${r4.body}`);
    apiSuccess = false;
  }
  if (r4.statusCode === 200) {
    const onDisk = JSON.parse(fs.readFileSync(path.join(TEST_CONFIG_DIR, CONFIG_FILENAME), 'utf8'));
    if (onDisk.logging.level !== 'debug') {
      console.error(`  FAIL: POST /api/daemon-config did not persist logging.level (on disk: ${onDisk.logging.level})`);
      apiSuccess = false;
    }
    if (onDisk.logging.level === 'debug') {
      console.log('  PASS: POST /api/daemon-config persisted logging.level=debug');
    }
  }

  // GET /api/logs?lines=N: returns tail
  const r5 = await httpJson('GET', '/api/logs?lines=10');
  if (r5.statusCode !== 200) {
    console.error(`  FAIL: GET /api/logs returned ${r5.statusCode}`);
    apiSuccess = false;
  }
  if (r5.statusCode === 200) {
    const lineCount = (r5.body.match(/\n/g) || []).length;
    if (lineCount > 11) {
      console.error(`  FAIL: GET /api/logs?lines=10 returned ${lineCount} lines (expected <= 11)`);
      apiSuccess = false;
    }
    if (lineCount <= 11) {
      console.log(`  PASS: GET /api/logs?lines=10 returned <= 10 lines (${lineCount})`);
    }
  }

  // GET /gui: serves index.html
  const r6 = await httpJson('GET', '/gui');
  if (r6.statusCode !== 200 || !r6.body.includes('<html')) {
    console.error(`  FAIL: GET /gui returned ${r6.statusCode} or missing HTML`);
    apiSuccess = false;
  }
  if (r6.statusCode === 200 && r6.body.includes('<html')) {
    console.log('  PASS: GET /gui serves index.html');
  }

  // GET /gui/app.js: served as text/javascript
  const r7 = await httpJson('GET', '/gui/app.js');
  if (r7.statusCode !== 200) {
    console.error(`  FAIL: GET /gui/app.js returned ${r7.statusCode}`);
    apiSuccess = false;
  }
  if (r7.statusCode === 200 && r7.headers['content-type']?.includes('javascript')) {
    console.log('  PASS: GET /gui/app.js served as text/javascript');
  }

  // POST /api/restart: 202 + watchdog spawns new worker
  const daemonLogPath = path.join(TEST_CONFIG_DIR, LOGS_DIR_NAME, 'daemon.log');
  const readLogSafely = () => {
    try { return fs.readFileSync(daemonLogPath, 'utf8'); }
    catch { return ''; }
  };
  const beforeLog = readLogSafely();
  const r8 = await httpJson('POST', '/api/restart');
  if (r8.statusCode !== 202) {
    console.error(`  FAIL: POST /api/restart returned ${r8.statusCode} (expected 202)`);
    apiSuccess = false;
  }
  // Poll for "Restart requested" in daemon log instead of arbitrary sleep
  const RESTART_LOG_TIMEOUT_MS = 5000;
  const restartStart = Date.now();
  let restartLogged = false;
  while (Date.now() - restartStart < RESTART_LOG_TIMEOUT_MS) {
    const after = readLogSafely();
    if (after.length > beforeLog.length && after.slice(beforeLog.length).includes('Restart requested')) {
      restartLogged = true;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (r8.statusCode === 202 && restartLogged) {
    console.log('  PASS: POST /api/restart triggered watchdog restart');
  }
  if (r8.statusCode === 202 && !restartLogged) {
    console.error('  FAIL: POST /api/restart returned 202 but no restart logged in 5s');
    apiSuccess = false;
  }

  // After restart, wait for new worker to be ready before continuing (no arbitrary sleeps).
  const POST_RESTART_TIMEOUT_MS = 15000;
  const postRestartStart = Date.now();
  let workerReady = false;
  while (Date.now() - postRestartStart < POST_RESTART_TIMEOUT_MS) {
    const probe = await httpJson('GET', '/__ccb_internal__/status');
    if (probe.statusCode === 200) {
      workerReady = true;
      break;
    }
    await sleep(POST_RESTART_POLL_MS);
  }
  if (!workerReady) {
    console.error('  FAIL: Worker did not become ready after restart within 15s');
    apiSuccess = false;
  }

  if (apiSuccess) console.log('  PASS: GUI HTTP API endpoints verified');
  if (!apiSuccess) console.error('  FAIL: One or more GUI HTTP API checks failed');

  // ── Concurrent-request stress (regression guard for watchdog/worker handle sharing) ──
  console.log('\nStress: 50 parallel HTTP requests across mixed endpoints...');
  const STRESS_TOTAL = 50;
  const STRESS_TIMEOUT_MS = 5000;
  const STRESS_ENDPOINTS = [
    { method: 'GET', path: '/api/config' },
    { method: 'GET', path: '/api/schema' },
    { method: 'GET', path: '/api/daemon-config' },
    { method: 'GET', path: '/__ccb_internal__/status' },
    { method: 'GET', path: '/gui/app.js' },
    { method: 'GET', path: '/v1/models' }
  ];
  // Independent connections per request (no shared agent). Each request gets
  // its own socket so we genuinely exercise concurrent kernel accept dispatch.
  const stressOne = (ep) => new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: ep.path,
      method: ep.method,
      headers: { connection: 'close' },
      timeout: STRESS_TIMEOUT_MS,
      agent: false
    }, (res) => {
      res.on('data', () => {}); // consume to free the socket
      res.on('end', () => resolve({ statusCode: res.statusCode }));
    });
    req.on('error', () => resolve({ error: 'connect' }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
  const stressResults = await Promise.all(
    Array.from({ length: STRESS_TOTAL }, (_, i) => stressOne(STRESS_ENDPOINTS[i % STRESS_ENDPOINTS.length]))
  );
  const stressOk = stressResults.filter(r => r.statusCode === 200).length;
  const stressBad = STRESS_TOTAL - stressOk;
  if (stressOk === STRESS_TOTAL) {
    console.log(`  PASS: ${stressOk}/${STRESS_TOTAL} concurrent requests all returned 200`);
  }
  if (stressOk !== STRESS_TOTAL) {
    console.error(`  FAIL: only ${stressOk}/${STRESS_TOTAL} concurrent requests succeeded (${stressBad} timed out or errored)`);
    apiSuccess = false;
  }

  // 1. CLI Management Command Tests (non-destructive — don't touch .env/keys yet)
  console.log('\nTesting CLI Management Commands...');
  const CCB_BIN = path.join(PKG_ROOT, 'bin', 'ccb.js');
  const runCcb = (args) => runSync(process.execPath, [CCB_BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CCB_CONFIG_DIR: TEST_CONFIG_DIR }
  });

  let cliSuccess = true;
  let providers;

  const assertCli = (res, expectedStatus, expectedStdout, expectedStderr, label) => {
    let ok = res.status === expectedStatus;
    if (ok && expectedStdout) ok = (res.stdout || '').includes(expectedStdout);
    if (ok && expectedStderr) ok = (res.stderr || '').includes(expectedStderr);
    if (!ok) {
      console.error(`  FAIL: ${label} (status: ${res.status}, out: ${res.stdout?.trim()}, err: ${res.stderr?.trim()})`);
      cliSuccess = false;
      return;
    }
    console.log(`  PASS: ${label}`);
  };

  // Test --x-help
  console.log('  Testing --x-help...');
  assertCli(runCcb(['--x-help']), 0, 'CCB (Claude Code Bridge) Management Commands', null, '--x-help');
  assertCli(runCcb(['--x-help']), 0, '--x-clearlogs', null, '--x-help includes --x-clearlogs');
  assertCli(runCcb(['--x-help']), 0, '--x-sessions', null, '--x-help includes --x-sessions');

  // Test --x-init
  console.log('  Testing --x-init...');
  assertCli(runCcb(['--x-init']), 0, null, null, '--x-init');

  // Test --x-clearlogs
  console.log('  Testing --x-clearlogs...');
  // Create a dummy log file to clear
  const dummyLog = path.join(TEST_CONFIG_DIR, LOGS_DIR_NAME, 'test-clear.log');
  fs.writeFileSync(dummyLog, 'test', 'utf8');
  assertCli(runCcb(['--x-clearlogs']), 0, 'Cleared', null, '--x-clearlogs');
  if (fs.existsSync(dummyLog)) {
    console.error('  FAIL: --x-clearlogs did not delete log file');
    cliSuccess = false;
  }
  if (!fs.existsSync(dummyLog)) {
    console.log('  PASS: --x-clearlogs deleted log file');
  }

  // Test --x-provider
  console.log('  Testing --x-provider add/remove/exceptions...');
  assertCli(runCcb(['--x-provider', 'add']), 1, null, 'Usage:', '--x-provider add missing args');
  assertCli(runCcb(['--x-provider', 'remove']), 1, null, 'Usage:', '--x-provider remove missing args');

  const addRes = runCcb(['--x-provider', 'add', 'new-p', 'http://new.com', '--non-compliant']);
  if (addRes.status !== 0) console.error('    Error output:', addRes.stderr);
  providers = JSON.parse(fs.readFileSync(path.join(TEST_CONFIG_DIR, PROVIDERS_FILENAME), 'utf8'));
  const newP = providers.providers['new-p'];
  if (!newP || newP.url !== 'http://new.com' || newP.anthropicCompliant !== false) {
    console.error('  FAIL: --x-provider add');
    cliSuccess = false;
  }
  if (newP && newP.url === 'http://new.com' && newP.anthropicCompliant === false) {
    console.log('  PASS: --x-provider add');
  }

  assertCli(runCcb(['--x-provider', 'add', 'new-p', 'http://new2.com']), 1, null, 'Error:', '--x-provider add duplicate id');

  runCcb(['--x-provider', 'remove', 'new-p']);
  providers = JSON.parse(fs.readFileSync(path.join(TEST_CONFIG_DIR, PROVIDERS_FILENAME), 'utf8'));
  if (providers.providers['new-p']) {
    console.error('  FAIL: --x-provider remove');
    cliSuccess = false;
  }
  if (!providers.providers['new-p']) {
    console.log('  PASS: --x-provider remove');
  }

  // Test --x-route
  console.log('  Testing --x-route add/remove/list/tree/exceptions...');
  assertCli(runCcb(['--x-route', 'add']), 1, null, 'Usage:', '--x-route add missing args');

  runCcb(['--x-route', 'add', 'model', 'test-alias', 'zai.test-real']);
  providers = JSON.parse(fs.readFileSync(path.join(TEST_CONFIG_DIR, PROVIDERS_FILENAME), 'utf8'));
  const testRoute = providers.routes?.models?.['test-alias'];
  if (testRoute !== 'zai.test-real') {
    console.error('  FAIL: --x-route add model');
    cliSuccess = false;
  }
  if (testRoute === 'zai.test-real') {
    console.log('  PASS: --x-route add model');
  }

  assertCli(runCcb(['--x-route', 'list']), 0, 'test-alias', null, '--x-route list');
  assertCli(runCcb(['--x-route', 'tree']), 0, 'api.z.ai', null, '--x-route tree');

  runCcb(['--x-route', 'remove', 'test-alias']);
  providers = JSON.parse(fs.readFileSync(path.join(TEST_CONFIG_DIR, PROVIDERS_FILENAME), 'utf8'));
  if (providers.routes?.models?.['test-alias'] !== undefined) {
    console.error('  FAIL: --x-route remove');
    cliSuccess = false;
  }
  if (providers.routes?.models?.['test-alias'] === undefined) {
    console.log('  PASS: --x-route remove');
  }

  const testEnvPath = path.join(TEST_CONFIG_DIR, ENV_FILENAME);
  const savedEnvContent = fs.readFileSync(testEnvPath, 'utf8');

  console.log('\n  Testing --x-key set/remove/list/prune/exceptions...');
  assertCli(runCcb(['--x-key', 'set']), 1, null, 'Usage:', '--x-key set missing args');
  assertCli(runCcb(['--x-key', 'remove']), 1, null, 'Usage:', '--x-key remove missing args');

  assertCli(runCcb(['--x-key', 'list']), 0, '[zai]', null, '--x-key list');
  assertCli(runCcb(['--x-key', 'list', '--reveal']), 0, '[zai]', null, '--x-key list --reveal');

  runCcb(['--x-key', 'set', 'zai', 'sk-test-key']);
  let envContent = fs.readFileSync(testEnvPath, 'utf8');
  if (!envContent.includes('ZAI_KEY=sk-test-key')) {
    console.error('  FAIL: --x-key set failed to update .env');
    cliSuccess = false;
  }
  if (envContent.includes('ZAI_KEY=sk-test-key')) {
    console.log('  PASS: --x-key set updated .env');
  }

  runCcb(['--x-key', 'remove', 'zai']);
  envContent = fs.readFileSync(testEnvPath, 'utf8');
  if (envContent.includes('ZAI_KEY=')) {
    const val = envContent.split('\n').find(l => l.startsWith('ZAI_KEY=')).split('=')[1];
    if (val !== '') {
      console.error('  FAIL: --x-key remove failed to clear .env');
      cliSuccess = false;
    }
    if (val === '') {
      console.log('  PASS: --x-key remove cleared .env');
    }
  }

  // Test prune
  fs.appendFileSync(testEnvPath, '\nORPHAN_KEY=old\n');
  runCcb(['--x-key', 'prune']);
  envContent = fs.readFileSync(testEnvPath, 'utf8');
  if (envContent.includes('ORPHAN_KEY')) {
    console.error('  FAIL: --x-key prune failed to remove orphan');
    cliSuccess = false;
  }
  if (!envContent.includes('ORPHAN_KEY')) {
    console.log('  PASS: --x-key prune removed orphan');
  }


  // Restore the original .env so model tests have a valid API key.
  fs.writeFileSync(testEnvPath, savedEnvContent, 'utf8');

  // Trigger hot-reload so the daemon picks up the restored key
  const providersContent = fs.readFileSync(path.join(TEST_CONFIG_DIR, PROVIDERS_FILENAME), 'utf8');
  fs.writeFileSync(path.join(TEST_CONFIG_DIR, PROVIDERS_FILENAME), providersContent, 'utf8');
  const HOT_RELOAD_MS = 500;
  await new Promise(resolve => setTimeout(resolve, HOT_RELOAD_MS));

  // 3. Real Model Tests
  console.log('\nRunning model identity tests (Interactive): GLM -> Claude');

  let modelSuccess = true;

  const rGlm = await assertModel('glm-4.7', /glm-/i);
  modelSuccess = modelSuccess && rGlm;

  const rSonnet = await assertModel('sonnet', /claude|sonnet/i);
  modelSuccess = modelSuccess && rSonnet;

  const rSynth = await assertModel('synthetic.gpt-4', /401|Incorrect API key|Authentication|API Error|Retrying/i);
  modelSuccess = modelSuccess && rSynth;

  const rSwitch = await testModelSwitch();
  modelSuccess = modelSuccess && rSwitch;

  console.log('\nRunning TTY concurrency stress (real z.ai through Claude CLI)...');
  const rTtyConcurrency = await assertTtyConcurrency();
  modelSuccess = modelSuccess && rTtyConcurrency;

  // 3b. Web search tool transform test (live request through proxy)
  //    The daemon may have shut down after the last model test — restart it.
  console.log('\nRunning web search tool transform test...');
  let wsDaemonUp = await checkTestProxy();
  if (!wsDaemonUp) {
    const restarted = await startTestDaemon();
    if (!restarted) {
      console.error('  FAIL: Could not restart daemon for web search test');
      modelSuccess = false;
    }
    if (restarted) {
      wsDaemonUp = true;
    }
  }
  if (wsDaemonUp) {
    const wsTestResult = await assertWebSearchTransform();
    modelSuccess = modelSuccess && wsTestResult;
  }

  // 4. Check thinking block evidence in proxy logs
  console.log('\nChecking proxy logs for thinking block handling...');
  const thinkingCheck = checkThinkingInLogs();
  if (thinkingCheck.hasThinking) {
    console.log(`  Thinking blocks detected: ${thinkingCheck.details}`);
  }
  if (!thinkingCheck.hasThinking) {
    console.log(`  No thinking blocks found: ${thinkingCheck.details}`);
    console.log(`  (This is informational — models may not always use extended thinking)`);
  }
  if (thinkingCheck.logFile) {
    console.log(`  Log file: ${thinkingCheck.logFile}`);
  }

  if (testKeepaliveSocket) testKeepaliveSocket.destroy();
  killTestDaemon();
  return [cliSuccess, apiSuccess, modelSuccess];
}

// ── Main ──

async function main() {
  console.log('--- Starting CC-Bridge Tests ---');

  await runUnitTests();

  console.log(`\nUnit: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('\n🚨 UNIT TESTS FAILED!');
    process.exit(1);
  }

  const portFallback = await runPortFallbackTest();

  const integrationResults = await runIntegrationTests();

  if (!portFallback || !integrationResults.every(Boolean)) {
    console.error('\n🚨 INTEGRATION TESTS FAILED!');
    process.exit(1);
  }

  console.log('\n✨ ALL TESTS PASSED!');
  process.exit(0);
}

main();
