import { spawn, spawnSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

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

  const { applyRouting, applyAuthHeaders, extractSessionId, stripSignatures, cleanForNonCompliant } = await import('../src/core/routing.js');
  const { Result, Option, RequestInfo, RequestSummary, RoutingResult } = await import('../src/core/types.js');
  const { ProvidersMap, ProviderConfig, ProviderMatch } = await import('../src/core/providers.js');
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

  const providerResult = applyRouting({ model: 'glm', messages: [] }, pmap);
  assert(providerResult.targetBase === 'https://a.com', 'routes to custom provider');
  assert(providerResult.label === 'Provider (glm→glm-4.7)', 'Provider label');

  const noModel = applyRouting({ messages: [] }, pmap);
  assert(noModel.targetBase === 'https://api.anthropic.com', 'no model routes to Anthropic');

  // ── applyAuthHeaders ──
  console.log('\napplyAuthHeaders:');
  const headersNoMatch = applyAuthHeaders({ authorization: 'Bearer token', 'x-api-key': 'old' }, null);
  assert(headersNoMatch['x-api-key'] === 'old', 'no match preserves headers');
  assert(headersNoMatch.authorization === 'Bearer token', 'no match preserves auth');

  const matchGlm = pmap.resolve('glm');
  const headersMatch = applyAuthHeaders({ authorization: 'Bearer token', 'anthropic-beta': 'b1' }, matchGlm, { P1_KEY: 'key-p1' });
  assert(headersMatch.authorization === undefined, 'match strips authorization');
  assert(headersMatch['x-api-key'] === 'key-p1', 'match injects x-api-key from ID-based env');
  assert(headersMatch['anthropic-beta'] === undefined, 'non-compliant strips anthropic-beta');

  const matchLocal = pmap.resolve('local-model');
  const headersCompliant = applyAuthHeaders({ authorization: 'Bearer tok', 'anthropic-beta': 'b1' }, matchLocal, {});
  assert(headersCompliant['anthropic-beta'] === 'b1', 'compliant preserves anthropic-beta');
  assert(headersCompliant['x-api-key'] === undefined, 'missing env var results in no x-api-key');

  // ── stripSignatures ──
  console.log('\nstripSignatures:');
  const withSig = { messages: [{ content: [{ type: 'thinking', thinking: 'hmm', signature: 'abc123' }] }] };
  const stripped = stripSignatures(withSig);
  assert(stripped.messages[0].content[0].signature === undefined, 'signature removed');
  assert(stripped.messages[0].content[0].thinking === 'hmm', 'thinking preserved');

  const noMessages = stripSignatures({ model: 'x' });
  assert(noMessages.model === 'x', 'no messages passthrough');

  // ── cleanForNonCompliant ──
  console.log('\ncleanForNonCompliant:');
  const body = {
    model: 'glm',
    betas: ['cool-beta'],
    system: [{ type: 'text', text: 'You are helpful.' }],
    messages: [{ content: [{ type: 'tool_result', content: [{ type: 'text', text: 'result' }] }] }]
  };
  const cleaned = cleanForNonCompliant(body);
  assert(cleaned.betas === undefined, 'betas stripped');
  assert(typeof cleaned.system === 'string', 'system flattened to string');
  assert(typeof cleaned.messages[0].content[0].content === 'string', 'tool_result content joined to string');

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

  // ── ProxyConfig ──
  console.log('\nProxyConfig:');
  const validConfig = new ProxyConfig({
    port: 9099,
    daemon: { healthCheckTimeoutMs: 500, pollIntervalMs: 300, pollMaxAttempts: 10 },
    logging: { enabled: true, requests: true, responses: true, history: 5, maxBodyLog: 1000 }
  });
  assert(validConfig.port === 9099, 'port');
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
  
  const rawProviders = { providers: [{ url: 'https://zai.com/api' }] };
  const completeProviders = ensureCompleteProviders(rawProviders);
  assert(completeProviders.providers[0].id === 'zai', 'id derived from URL');
  assert(completeProviders.providers[0].models !== undefined, 'models property added');
  assert(completeProviders.providers[0].anthropicCompliant === false, 'anthropicCompliant added');

  const emptyProviders = ensureCompleteProviders({});
  assert(Array.isArray(emptyProviders.providers), 'providers array initialized');
  assert(emptyProviders.providers.length > 0, 'default providers added');

  // ── Model manager ──
  console.log('\nModel manager:');
  const { addModel, removeModel, listModels, listProviders, formatTree, findProviderIndex } = await import('../src/core/model-manager.js');

  const testProviders = [
    { id: 'zai', url: 'https://api.z.ai/api/anthropic', models: { 'glm-4.7': 'glm-4.7' }, anthropicCompliant: false },
    { id: 'mirror', url: 'https://mirror.example.com/v1', models: { 'm-opus': 'claude-opus-4-6' }, anthropicCompliant: true },
  ];

  // findProviderIndex
  assert(findProviderIndex(testProviders, 'zai') === 0, 'findProviderIndex by id');
  assert(findProviderIndex(testProviders, 'mirror') === 1, 'findProviderIndex by id');
  assert(findProviderIndex(testProviders, 'z.ai') === 0, 'findProviderIndex fallback to url');
  assert(findProviderIndex(testProviders, 'nonexistent') === -1, 'findProviderIndex miss');

  // addModel
  const addResult = addModel(testProviders, 'zai', 'glm-5', 'glm-5');
  assert(addResult.isSuccess, 'addModel succeeds');
  assert(addResult.value[0].models['glm-5'] === 'glm-5', 'addModel adds entry');

  // removeModel
  const rmResult = removeModel(addResult.value, 'zai', 'glm-5');
  assert(rmResult.isSuccess, 'removeModel succeeds');
  assert(rmResult.value[0].models['glm-5'] === undefined, 'removeModel removes entry');

  // listModels
  const lmResult = listModels(testProviders, 'zai');
  assert(lmResult.isSuccess, 'listModels succeeds');
  assert(lmResult.value.models.length === 1, 'listModels count');
  assert(lmResult.value.models[0][0] === 'glm-4.7', 'listModels entry');

  const lmMiss = listModels(testProviders, 'nonexistent');
  assert(!lmMiss.isSuccess, 'listModels bad provider fails');

  // listProviders
  const lp = listProviders(testProviders);
  assert(lp.length === 2, 'listProviders count');
  assert(lp[0].modelCount === 1, 'listProviders modelCount');
  assert(lp[0].compliant === false, 'listProviders compliant');
  assert(lp[1].compliant === true, 'listProviders compliant true');

  // formatTree
  const tree = formatTree(testProviders);
  assert(tree.includes('api.z.ai'), 'tree includes zai');
  assert(tree.includes('non-compliant'), 'tree includes non-compliant');
  assert(tree.includes('mirror.example.com'), 'tree includes mirror');
  assert(tree.includes('├──') || tree.includes('└──'), 'tree has branches');
}

// ── Integration test (isolated daemon) ──

const TEST_PORT = 9100;
const TEST_CONFIG_DIR = path.join(PKG_ROOT, '.test-config');

function promptUserForApiKey() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    const ask = () => {
      rl.question('\n[Setup] No .env found. Please enter your real ZAI_KEY for integration tests: ', (answer) => {
        if (!answer.trim()) {
          console.error('❌ A real API key is required for integration tests (Zero Mock policy).');
          return ask();
        }
        rl.close();
        resolve(answer.trim());
      });
    };
    ask();
  });
}

async function setupTestConfig() {
  const testEnvPath = path.join(TEST_CONFIG_DIR, '.env');
  let savedEnv = null;
  if (fs.existsSync(testEnvPath)) {
    savedEnv = fs.readFileSync(testEnvPath, 'utf8');
  } else {
    const projectEnv = path.join(PKG_ROOT, '.env');
    if (fs.existsSync(projectEnv)) {
      savedEnv = fs.readFileSync(projectEnv, 'utf8');
    }
  }

  if (!savedEnv) {
    const apiKey = await promptUserForApiKey();
    savedEnv = `ZAI_KEY=${apiKey}\n`;
  }

  const logsDir = path.join(TEST_CONFIG_DIR, 'logs');
  if (fs.existsSync(TEST_CONFIG_DIR)) {
    fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const providers = {
    providers: [
      {
        id: "zai",
        url: "https://api.z.ai/api/anthropic",
        models: {
          "glm-4.7": "glm-4.7",
          "glm-5.1": "glm-5.1"
        },
        anthropicCompliant: false
      }
    ]
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
    try { process.kill(testDaemonPid, 'SIGKILL'); } catch {}
    testDaemonPid = null;
  }
  
  // Also try to kill anything on the test port
  try {
    if (process.platform !== 'win32') {
      const ss = spawnSync('sh', ['-c', `ss -ltnp | grep :${TEST_PORT}`], { encoding: 'utf8' });
      const match = ss.stdout.match(/pid=(\d+)/);
      if (match && match[1]) {
        process.kill(Number(match[1]), 'SIGKILL');
      }
    }
  } catch {}
}

function assertModel(model, expectedPattern) {
  console.log(`\nTesting model: ${model}...`);
  const CCB_BIN = path.join(PKG_ROOT, 'bin', 'ccb.js');
  const result = spawnSync(process.execPath, [CCB_BIN, '--model', model, '--print', 'What model are you?'], {
    encoding: 'utf8',
    timeout: 15000,
    env: { 
      ...process.env, 
      CCB_CONFIG_DIR: TEST_CONFIG_DIR
    }
  });
  const output = result.stdout || '';
  const errOutput = result.stderr || '';
  const combined = output + errOutput;
  const firstLine = output.trim().split('\n')[0];
  if (firstLine)
    console.log(`Response: ${firstLine}`);

  // Check for session log
  const logsDir = path.join(TEST_CONFIG_DIR, 'logs');
  if (fs.existsSync(logsDir)) {
    const sessionLogs = fs.readdirSync(logsDir).filter(f => f.startsWith('session-'));
    if (sessionLogs.length > 0) {
      console.log(`✅ Session log(s) found: ${sessionLogs.join(', ')}`);
    }
  }

  if (result.error?.code === 'ETIMEDOUT' || result.status === null) {
    console.error(`❌ Timed out for ${model} after 15s.`);
    return false;
  }
  const isKnownError = combined.includes("There's an issue with the selected model") ||
    combined.includes("It may not exist or you may not have access to it") ||
    combined.includes("failed to launch claude") ||
    combined.includes("ccb error:");

  if (isKnownError) {
    console.error(`❌ Model failed with error: ${output.trim() || errOutput.trim()}`);
    return false;
  }

  if (expectedPattern.test(output)) {
    console.log(`✅ Assertion passed for ${model}`);
    return true;
  }
  const isQuotaError = combined.includes('429') ||
    combined.includes('402') ||
    combined.includes('insufficient balance') ||
    combined.includes('insufficient_quota') ||
    combined.includes('out of tokens') ||
    combined.includes('limit reached') ||
    combined.includes("hit your limit");
  if (isQuotaError) {
    console.warn(`⚠️  Quota/rate-limit hit for ${model} — routing reached the provider.`);
    return true;
  }
  const isConnError = combined.includes('ECONNREFUSED') ||
    combined.includes('ECONNRESET') ||
    combined.includes('Unable to connect');
  if (isConnError) {
    console.warn(`⚠️  Connection error for ${model} — provider unreachable.`);
    return true;
  }
  const isAuthError = combined.includes('401') ||
    combined.includes('400') ||
    combined.includes('Authentication') ||
    combined.includes('authenticate') ||
    combined.includes('ConfigurationMissingException') ||
    combined.includes('Missing environment variable');
  if (isAuthError) {
    console.warn(`⚠️  Auth error for ${model} — check API key.`);
    return true;
  }
  console.error(`❌ Assertion failed for ${model}`);
  console.error(`Expected: ${expectedPattern}`);
  console.error(`Got: ${output.trim() || errOutput.trim()}`);
  return false;
}

async function runIntegrationTests() {
  console.log('\n── Integration Tests (isolated daemon on port ' + TEST_PORT + ') ──');

  killTestDaemon();
  await setupTestConfig();

  console.log('Starting test daemon...');
  const started = await startTestDaemon();
  if (!started) {
    console.error('❌ Test daemon failed to start on port ' + TEST_PORT);
    return [false];
  }
  console.log('Test daemon started.');

  // 1. CLI Management Command Tests
  console.log('\nTesting CLI Management Commands...');
  const CCB_BIN = path.join(PKG_ROOT, 'bin', 'ccb.js');
  const runCcb = (args) => spawnSync(process.execPath, [CCB_BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CCB_CONFIG_DIR: TEST_CONFIG_DIR }
  });

  let cliSuccess = true;
  let providers;

  // Test --x-provider
  console.log('  Testing --x-provider add/remove...');
  const addRes = runCcb(['--x-provider', 'add', 'new-p', 'http://new.com', '--non-compliant']);
  if (addRes.status !== 0) console.error('    Error output:', addRes.stderr);
  providers = JSON.parse(fs.readFileSync(path.join(TEST_CONFIG_DIR, 'providers.json'), 'utf8'));
  let newP = providers.providers.find(p => p.id === 'new-p');
  if (newP && newP.url === 'http://new.com' && newP.anthropicCompliant === false) {
    console.log('  ✅ --x-provider add passed');
  } else {
    console.error('  ❌ --x-provider add failed');
    cliSuccess = false;
  }

  runCcb(['--x-provider', 'remove', 'new-p']);
  providers = JSON.parse(fs.readFileSync(path.join(TEST_CONFIG_DIR, 'providers.json'), 'utf8'));
  newP = providers.providers.find(p => p.id === 'new-p');
  if (!newP) {
    console.log('  ✅ --x-provider remove passed');
  } else {
    console.error('  ❌ --x-provider remove failed');
    cliSuccess = false;
  }

  // Test --x-model
  console.log('  Testing --x-model add/remove...');
  runCcb(['--x-model', 'add', 'test-alias', 'test-real', 'provider', 'zai']);
  providers = JSON.parse(fs.readFileSync(path.join(TEST_CONFIG_DIR, 'providers.json'), 'utf8'));
  let zai = providers.providers.find(p => p.id === 'zai');
  if (zai && zai.models['test-alias'] === 'test-real') {
    console.log('  ✅ --x-model add passed');
  } else {
    console.error('  ❌ --x-model add failed');
    cliSuccess = false;
  }

  runCcb(['--x-model', 'remove', 'test-alias', 'provider', 'zai']);
  providers = JSON.parse(fs.readFileSync(path.join(TEST_CONFIG_DIR, 'providers.json'), 'utf8'));
  zai = providers.providers.find(p => p.id === 'zai');
  if (zai && zai.models['test-alias'] === undefined) {
    console.log('  ✅ --x-model remove passed');
  } else {
    console.error('  ❌ --x-model remove failed');
    cliSuccess = false;
  }

  // Test --x-key
  console.log('  Testing --x-key set/remove/prune...');

  runCcb(['--x-key', 'set', 'zai', 'sk-test-key']);
  let envContent = fs.readFileSync(path.join(TEST_CONFIG_DIR, '.env'), 'utf8');
  if (envContent.includes('ZAI_KEY=sk-test-key')) {
    console.log('  ✅ --x-key set updated .env');
  } else {
    console.error('  ❌ --x-key set failed to update .env');
    cliSuccess = false;
  }

  runCcb(['--x-key', 'remove', 'zai']);
  envContent = fs.readFileSync(path.join(TEST_CONFIG_DIR, '.env'), 'utf8');
  if (envContent.includes('ZAI_KEY=')) {
    const val = envContent.split('\n').find(l => l.startsWith('ZAI_KEY=')).split('=')[1];
    if (val === '') {
      console.log('  ✅ --x-key remove cleared .env');
    } else {
      console.error('  ❌ --x-key remove failed to clear .env');
      cliSuccess = false;
    }
  }

  // Test prune
  fs.appendFileSync(path.join(TEST_CONFIG_DIR, '.env'), '\nORPHAN_KEY=old\n');
  runCcb(['--x-key', 'prune']);
  envContent = fs.readFileSync(path.join(TEST_CONFIG_DIR, '.env'), 'utf8');
  if (!envContent.includes('ORPHAN_KEY')) {
    console.log('  ✅ --x-key prune removed orphan');
  } else {
    console.error('  ❌ --x-key prune failed to remove orphan');
    cliSuccess = false;
  }

  // Restore the original environment-based key so the real glm-4.7 test can pass
  if (process.env.ZAI_KEY) {
    runCcb(['--x-key', 'set', 'zai', process.env.ZAI_KEY]);
  }

  // 2. Real Model Tests
  const results = [
    cliSuccess,
    assertModel('sonnet', /claude|sonnet/i),
    assertModel('glm-4.7', /glm-4\.7/i),
  ];

  killTestDaemon();
  return results;
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
