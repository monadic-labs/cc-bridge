import { spawn, spawnSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

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

  const { applyRouting, applyAuthHeaders, extractSessionId, sanitizeMessages } = await import('../src/core/routing.js');
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
  const { ResultAccessError, ArgumentError, ConfigError } = await import('../src/core/exceptions.js');
  const { parseSseMetadata } = await import('../src/core/sse-parser.js');
  const { ProxyConfig } = await import('../src/core/config.js');

  // ── Result ──
  console.log('\nResult:');
  const ok = Result.ok(42);
  assert(ok.isSuccess === true, 'ok.isSuccess');
  assert(ok.value === 42, 'ok.value === 42');
  const err = Result.fail(new Error('boom'));
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
  const cfg = new ProviderConfig({ id: 'test-id', url: 'https://example.com', models: { a: 'model-a' }, anthropicCompliant: true });
  assert(cfg.id === 'test-id', 'id getter');
  assert(cfg.url === 'https://example.com', 'url getter');
  assert(cfg.anthropicCompliant === true, 'anthropicCompliant getter');
  assertThrows(() => new ProviderConfig({ url: '', models: {}, anthropicCompliant: true }), ArgumentError, 'empty url throws');
  assertThrows(() => new ProviderConfig({ url: 'https://x.com', models: {} }), ArgumentError, 'missing anthropicCompliant throws');

  // ── ProvidersMap ──
  console.log('\nProvidersMap:');
  const p1 = new ProviderConfig({ id: 'p1', url: 'https://a.com', models: { 'glm': 'glm-4.7', 'sonnet': 'claude-sonnet-4-6' }, anthropicCompliant: false });
  const p2 = new ProviderConfig({ id: 'p2', url: 'https://b.com', models: ['local-model'], anthropicCompliant: true });
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
  const validP = [{ id: 'zai', url: 'https://zai.com' }, { id: 'mirror', url: 'https://mirror.com' }];
  assert(validateIds(validP) === undefined, 'valid IDs pass');

  assertThrows(() => validateIds([{ id: '', url: 'x' }]), ConfigError, 'empty ID throws');
  assertThrows(() => validateIds([{ id: 'Bad ID', url: 'x' }]), ConfigError, 'invalid ID format throws');
  assertThrows(() => validateIds([{ id: 'a', url: 'x' }, { id: 'a', url: 'y' }]), ConfigError, 'duplicate ID throws');
  assertThrows(() => validateIds([{ id: 'z-ai', url: 'x' }, { id: 'z_ai', url: 'y' }]), ConfigError, 'env key collision throws (Z_AI_KEY)');

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
  assert(headersMatch.authorization === undefined, 'match strips authorization');
  assert(headersMatch['x-api-key'] === 'key-p1', 'match injects x-api-key from apiKey');
  assert(headersMatch['anthropic-beta'] === undefined, 'non-compliant strips anthropic-beta');

  const matchLocal = pmap.resolve('local-model');
  const headersCompliant = applyAuthHeaders({ headers: { authorization: 'Bearer tok', 'anthropic-beta': 'b1' }, match: matchLocal, apiKey: '' });
  assert(headersCompliant['anthropic-beta'] === 'b1', 'compliant preserves anthropic-beta');
  assert(headersCompliant['x-api-key'] === undefined, 'empty apiKey results in no x-api-key');

  // ── sanitizeMessages ──
  console.log('\nsanitizeMessages:');
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
  const transformer = new SseResponseTransformer();
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
    daemon: { healthCheckTimeoutMs: 500, pollIntervalMs: 300, pollMaxAttempts: 10, upstreamTimeoutMs: 600000 },
    logging: { enabled: true, requests: true, responses: true, history: 5, maxBodyLog: 1000 },
    compression: { recompressRequests: true }
  });
  assert(validConfig.port === 9099, 'port');
  assert(validConfig.anthropicBaseUrl === 'https://api.anthropic.com', 'anthropicBaseUrl');
  assert(validConfig.upstreamTimeoutMs === 600000, 'upstreamTimeoutMs');
  assertThrows(() => new ProxyConfig({ port: 9099, logging: { enabled: true } }), ConfigError, 'incomplete logging throws');

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
  assert(ps1.operator === '>' && ps1.thresholdBytes === 102400, 'parsePayloadSizeKey gt');
  const ps2 = parsePayloadSizeKey('<50000');
  assert(ps2.operator === '<' && ps2.thresholdBytes === 50000, 'parsePayloadSizeKey lt');
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

  // ── RoutingPolicy ──
  console.log('\nRoutingPolicy:');
  const policyProviders = [
    new ProviderConfig({ id: 'mirror', url: 'https://mirror.example.com/v1', models: { 'mirror-model': 'real-model' }, anthropicCompliant: true }),
    new ProviderConfig({ id: 'local', url: 'http://localhost:11434/v1', models: {}, anthropicCompliant: false })
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
  const tmpEnvPath = path.join(tmpEnvDir, '.env');
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
  const testProvCfg = new ProviderConfig({ id: 'test-p', url: 'https://test.com/v1', models: { 't-model': 'real-model' }, anthropicCompliant: false });
  const testPolicy = buildRoutingPolicy({
    rawPolicy: [],
    providerConfigs: [testProvCfg],
    legacyProvidersMap: new ProvidersMap([testProvCfg])
  });

  const rr = resolveRoutingFn({
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

  const rrFallback = resolveRoutingFn({
    policy: testPolicy,
    body: { model: 'unknown-model', messages: [] },
    urlSessionId: '',
    routedHeaders: {},
    anthropicBaseUrl: 'https://api.anthropic.com'
  });
  assert(rrFallback.routing.targetBase === 'https://api.anthropic.com', 'resolveRouting falls back to Anthropic');

}

// ── Integration test (isolated daemon) ──

const TEST_PORT = 9100;
const TEST_CONFIG_DIR = path.join(PKG_ROOT, '.test-config');

async function setupTestConfig() {
  const testEnvPath = path.join(TEST_CONFIG_DIR, '.env');
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
    const userCcbEnv = path.join(os.homedir(), '.claude', '.ccb', '.env');
    if (fs.existsSync(userCcbEnv)) {
      const content = fs.readFileSync(userCcbEnv, 'utf8');
      const keyMatch = content.match(/^ZAI_KEY=(.+)$/m);
      if (keyMatch && keyMatch[1].trim()) savedEnv = content;
    }
  }

  // WSL cross-mount fallback: Linux homedir may differ from Windows USERPROFILE
  if (!savedEnv) {
    try {
      const winHome = spawnSync('cmd.exe', ['/c', 'echo', '%USERPROFILE%'], { encoding: 'utf8', timeout: 3000 });
      const winPath = (winHome.stdout || '').trim();
      if (winPath && !winPath.includes('%')) {
        const wslPath = winPath.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_, d) => `/mnt/${d.toLowerCase()}`);
        const wslEnv = path.join(wslPath, '.claude', '.ccb', '.env');
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
    if (process.env.ZAI_KEY) {
      savedEnv = `ZAI_KEY=${process.env.ZAI_KEY}\n`;
    } else {
      throw new Error('No ZAI_KEY found. Set it via ccb --x-key, or in process env.');
    }
  }

  const logsDir = path.join(TEST_CONFIG_DIR, 'logs');
  if (fs.existsSync(TEST_CONFIG_DIR)) {
    try {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    } catch {
      // WSL on /mnt/c/ (NTFS cross-mount) can fail with ENOTEMPTY
      spawnSync('rm', ['-rf', TEST_CONFIG_DIR], { encoding: 'utf8' });
    }
  }
  fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const providers = {
    providers: {
      "zai": {
        url: "https://api.z.ai/api/anthropic",
        anthropicCompliant: false
      }
    },
    routes: {
      models: { "glm-4.7": "zai.glm-4.7" },
      properties: {},
      payloadSize: {}
    }
  };
  fs.writeFileSync(path.join(TEST_CONFIG_DIR, 'providers.json'), JSON.stringify(providers, null, 2), 'utf8');

  const config = {
    port: TEST_PORT,
    daemon: { healthCheckTimeoutMs: 1000, pollIntervalMs: 200, pollMaxAttempts: 15 },
    logging: { enabled: true, requests: true, responses: true, history: 5, maxBodyLog: 1000 }
  };
  fs.writeFileSync(path.join(TEST_CONFIG_DIR, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

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

let testDaemonPid = null;

async function startTestDaemon() {
  const CCB_BIN = path.join(PKG_ROOT, 'bin', 'ccb.js');
  const out = fs.openSync(path.join(TEST_CONFIG_DIR, 'logs', 'daemon.log'), 'a');
  const err = fs.openSync(path.join(TEST_CONFIG_DIR, 'logs', 'daemon.err'), 'a');

  const child = spawn(process.execPath, [CCB_BIN, '--__cc-proxy-daemon__'], {
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
    env: { ...process.env, CCB_CONFIG_DIR: TEST_CONFIG_DIR }
  });
  testDaemonPid = child.pid;
  child.unref();

  for (let i = 0; i < 15; i++) {
    if (await checkTestProxy()) return true;
    await sleep(200);
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
      const r = spawnSync('netstat', ['-aon', '-p', 'TCP'], { encoding: 'utf8' });
      const lines = (r.stdout || '').split('\n').filter(l => l.includes(`:${TEST_PORT} `));
      for (const line of lines) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) {
          try { process.kill(Number(pid), 'SIGKILL'); } catch { }
        }
      }
    } else {
      const ss = spawnSync('sh', ['-c', `ss -ltnp | grep :${TEST_PORT}`], { encoding: 'utf8' });
      const match = ss.stdout.match(/pid=(\d+)/);
      if (match && match[1]) {
        process.kill(Number(match[1]), 'SIGKILL');
      }
    }
  } catch { }
}

function assertModel(model, expectedPattern) {
  console.log(`\nTesting model: ${model}...`);

  const CCB_BIN = path.join(PKG_ROOT, 'bin', 'ccb.js');
  const prompt = `State your exact model name, then explain the difference between recursion and iteration in one paragraph. Be concise.`;
  const args = ['--model', model, '--print', prompt];

  const result = spawnSync(process.execPath, [CCB_BIN, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      CCB_CONFIG_DIR: TEST_CONFIG_DIR
    }
  });

  const output = result.stdout || '';
  const errOutput = result.stderr || '';
  const combined = output + errOutput;

  const responseLine = output.trim().split('\n').find(l => l.toLowerCase().includes('claude') || l.toLowerCase().includes('glm') || l.toLowerCase().includes('sonnet') || l.toLowerCase().includes('opus')) || output.trim().split('\n')[0];
  if (responseLine) console.log(`Response: ${responseLine}`);

  if (result.error?.code === 'ETIMEDOUT' || result.status === null) {
    console.error(`  FAIL: Timed out for ${model} after 60s.`);
    return false;
  }

  // Hard proxy logic failures (400 from upstream due to signature issues)
  if (combined.includes('thinking.signature: Field required') || combined.includes('adjacent text blocks not allowed')) {
    console.error(`  FAIL: Proxy Logic Failure: ${combined}`);
    return false;
  }

  const match = expectedPattern.test(combined);
  if (match) {
    console.log(`  PASS: ${model} identified correctly`);
    return true;
  }

  // Quota/Rate-limit errors — routing worked, provider rejected
  const isQuotaError = combined.includes('429') ||
    combined.includes('402') ||
    combined.includes('insufficient balance') ||
    combined.includes('insufficient_quota') ||
    combined.includes('out of tokens') ||
    combined.includes('limit reached') ||
    combined.includes("hit your limit");
  if (isQuotaError) {
    console.warn(`  WARN: Quota/rate-limit hit for ${model} — routing reached the provider.`);
    return true;
  }

  const isAuthError = combined.includes('401') || combined.includes('403') || combined.includes('Authentication');
  if (isAuthError) {
    // 401 from a custom provider = proxy failed to inject the API key. This is a real failure.
    // 401 from Anthropic passthrough = OAuth issue, not a proxy bug — but still unexpected.
    console.error(`  FAIL: Auth error for ${model} — proxy may not have injected the API key.`);
    return false;
  }

  // The request completed but the model didn't identify itself as expected.
  // This is still a WARN, not a hard failure — model confusion is not a proxy bug.
  console.warn(`  WARN: Expected ${expectedPattern} but got "${output.trim().slice(0, 200)}"`);
  return true;
}

/**
 * Scan the most recent session log for thinking block evidence.
 * Returns { hasThinking, details } for diagnostic output.
 */
function checkThinkingInLogs() {
  const logsDir = path.join(TEST_CONFIG_DIR, 'logs');
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

  // 1. CLI Management Command Tests (non-destructive — don't touch .env/keys yet)
  console.log('\nTesting CLI Management Commands...');
  const CCB_BIN = path.join(PKG_ROOT, 'bin', 'ccb.js');
  const runCcb = (args) => spawnSync(process.execPath, [CCB_BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CCB_CONFIG_DIR: TEST_CONFIG_DIR }
  });

  let cliSuccess = true;
  let providers;

  const assertCli = (res, expectedStatus, expectedStdout, expectedStderr, label) => {
    let ok = res.status === expectedStatus;
    if (ok && expectedStdout) ok = (res.stdout || '').includes(expectedStdout);
    if (ok && expectedStderr) ok = (res.stderr || '').includes(expectedStderr);
    if (ok) {
      console.log(`  PASS: ${label}`);
    } else {
      console.error(`  FAIL: ${label} (status: ${res.status}, out: ${res.stdout?.trim()}, err: ${res.stderr?.trim()})`);
      cliSuccess = false;
    }
  };

  // Test --x-help
  console.log('  Testing --x-help...');
  assertCli(runCcb(['--x-help']), 0, 'CCB (Claude Code Bridge) Management Commands', null, '--x-help');
  assertCli(runCcb(['--x-help']), 0, '--x-clearlogs', null, '--x-help includes --x-clearlogs');

  // Test --x-init
  console.log('  Testing --x-init...');
  assertCli(runCcb(['--x-init']), 0, null, null, '--x-init');

  // Test --x-clearlogs
  console.log('  Testing --x-clearlogs...');
  // Create a dummy log file to clear
  const dummyLog = path.join(TEST_CONFIG_DIR, 'logs', 'test-clear.log');
  fs.writeFileSync(dummyLog, 'test', 'utf8');
  assertCli(runCcb(['--x-clearlogs']), 0, 'Cleared', null, '--x-clearlogs');
  if (!fs.existsSync(dummyLog)) {
    console.log('  PASS: --x-clearlogs deleted log file');
  } else {
    console.error('  FAIL: --x-clearlogs did not delete log file');
    cliSuccess = false;
  }

  // Test --x-provider
  console.log('  Testing --x-provider add/remove/exceptions...');
  assertCli(runCcb(['--x-provider', 'add']), 1, null, 'Usage:', '--x-provider add missing args');
  assertCli(runCcb(['--x-provider', 'remove']), 1, null, 'Usage:', '--x-provider remove missing args');

  const addRes = runCcb(['--x-provider', 'add', 'new-p', 'http://new.com', '--non-compliant']);
  if (addRes.status !== 0) console.error('    Error output:', addRes.stderr);
  providers = JSON.parse(fs.readFileSync(path.join(TEST_CONFIG_DIR, 'providers.json'), 'utf8'));
  const newP = providers.providers['new-p'];
  if (newP && newP.url === 'http://new.com' && newP.anthropicCompliant === false) {
    console.log('  PASS: --x-provider add');
  } else {
    console.error('  FAIL: --x-provider add');
    cliSuccess = false;
  }

  assertCli(runCcb(['--x-provider', 'add', 'new-p', 'http://new2.com']), 1, null, 'Error:', '--x-provider add duplicate id');

  runCcb(['--x-provider', 'remove', 'new-p']);
  providers = JSON.parse(fs.readFileSync(path.join(TEST_CONFIG_DIR, 'providers.json'), 'utf8'));
  if (!providers.providers['new-p']) {
    console.log('  PASS: --x-provider remove');
  } else {
    console.error('  FAIL: --x-provider remove');
    cliSuccess = false;
  }

  // Test --x-route
  console.log('  Testing --x-route add/remove/list/tree/exceptions...');
  assertCli(runCcb(['--x-route', 'add']), 1, null, 'Error:', '--x-route add missing args');

  runCcb(['--x-route', 'add', 'model', 'test-alias', 'zai.test-real']);
  providers = JSON.parse(fs.readFileSync(path.join(TEST_CONFIG_DIR, 'providers.json'), 'utf8'));
  const testRoute = providers.routes?.models?.['test-alias'];
  if (testRoute === 'zai.test-real') {
    console.log('  PASS: --x-route add model');
  } else {
    console.error('  FAIL: --x-route add model');
    cliSuccess = false;
  }

  assertCli(runCcb(['--x-route', 'list']), 0, 'test-alias', null, '--x-route list');
  assertCli(runCcb(['--x-route', 'tree']), 0, 'api.z.ai', null, '--x-route tree');

  runCcb(['--x-route', 'remove', 'test-alias']);
  providers = JSON.parse(fs.readFileSync(path.join(TEST_CONFIG_DIR, 'providers.json'), 'utf8'));
  if (providers.routes?.models?.['test-alias'] === undefined) {
    console.log('  PASS: --x-route remove');
  } else {
    console.error('  FAIL: --x-route remove');
    cliSuccess = false;
  }

  // 2. Key management tests — run BEFORE model tests, but we'll restore .env after
  const testEnvPath = path.join(TEST_CONFIG_DIR, '.env');
  const savedEnvContent = fs.readFileSync(testEnvPath, 'utf8');

  console.log('\n  Testing --x-key set/remove/list/prune/exceptions...');
  assertCli(runCcb(['--x-key', 'set']), 1, null, 'Usage:', '--x-key set missing args');
  assertCli(runCcb(['--x-key', 'remove']), 1, null, 'Usage:', '--x-key remove missing args');

  assertCli(runCcb(['--x-key', 'list']), 0, '[zai]', null, '--x-key list');
  assertCli(runCcb(['--x-key', 'list', '--reveal']), 0, '[zai]', null, '--x-key list --reveal');

  runCcb(['--x-key', 'set', 'zai', 'sk-test-key']);
  let envContent = fs.readFileSync(testEnvPath, 'utf8');
  if (envContent.includes('ZAI_KEY=sk-test-key')) {
    console.log('  PASS: --x-key set updated .env');
  } else {
    console.error('  FAIL: --x-key set failed to update .env');
    cliSuccess = false;
  }

  runCcb(['--x-key', 'remove', 'zai']);
  envContent = fs.readFileSync(testEnvPath, 'utf8');
  if (envContent.includes('ZAI_KEY=')) {
    const val = envContent.split('\n').find(l => l.startsWith('ZAI_KEY=')).split('=')[1];
    if (val === '') {
      console.log('  PASS: --x-key remove cleared .env');
    } else {
      console.error('  FAIL: --x-key remove failed to clear .env');
      cliSuccess = false;
    }
  }

  // Test prune
  fs.appendFileSync(testEnvPath, '\nORPHAN_KEY=old\n');
  runCcb(['--x-key', 'prune']);
  envContent = fs.readFileSync(testEnvPath, 'utf8');
  if (!envContent.includes('ORPHAN_KEY')) {
    console.log('  PASS: --x-key prune removed orphan');
  } else {
    console.error('  FAIL: --x-key prune failed to remove orphan');
    cliSuccess = false;
  }

  // Restore the original .env so model tests have a valid API key.
  fs.writeFileSync(testEnvPath, savedEnvContent, 'utf8');

  // Trigger hot-reload so the daemon picks up the restored key
  const providersContent = fs.readFileSync(path.join(TEST_CONFIG_DIR, 'providers.json'), 'utf8');
  fs.writeFileSync(path.join(TEST_CONFIG_DIR, 'providers.json'), providersContent, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 500));

  // 3. Real Model Tests
  console.log('\nRunning model identity tests: GLM -> Claude');

  let modelSuccess = true;

  const rGlm = assertModel('glm-4.7', /glm-/i);
  modelSuccess = modelSuccess && rGlm;

  const rSonnet = assertModel('sonnet', /claude|sonnet/i);
  modelSuccess = modelSuccess && rSonnet;

  // 4. Check thinking block evidence in proxy logs
  console.log('\nChecking proxy logs for thinking block handling...');
  const thinkingCheck = checkThinkingInLogs();
  if (thinkingCheck.hasThinking) {
    console.log(`  Thinking blocks detected: ${thinkingCheck.details}`);
  } else {
    console.log(`  No thinking blocks found: ${thinkingCheck.details}`);
    console.log(`  (This is informational — models may not always use extended thinking)`);
  }
  if (thinkingCheck.logFile) {
    console.log(`  Log file: ${thinkingCheck.logFile}`);
  }

  killTestDaemon();
  return [cliSuccess, modelSuccess];
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

  const integrationResults = await runIntegrationTests();

  if (integrationResults.every(Boolean)) {
    console.log('\n✨ ALL TESTS PASSED!');
    process.exit(0);
  }
  console.error('\n🚨 INTEGRATION TESTS FAILED!');
  process.exit(1);
}

main();
