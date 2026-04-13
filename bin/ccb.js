#!/usr/bin/env node

import { spawn, execSync } from 'child_process';
import { randomBytes } from 'crypto';
import http from 'http';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { createProxyCore, runKill } from '../src/proxy-core.js';
import { ReadinessTimeoutException, ConfigurationMissingException, ConfigError } from '../src/core/exceptions.js';
import { loadConfigFromFile, resolveUserConfigDir } from '../src/core/config.js';
import { addRouteModel, removeRouteModel, listModels, listProviders, formatTree, findProviderKey, addProvider, removeProvider } from '../src/core/model-manager.js';
import { listApiKeys, obfuscateKey } from '../src/core/key-manager.js';
import { ensureCompleteConfig, ensureCompleteProviders } from '../src/core/migrator.js';
import { providerIdToEnvKey } from '../src/core/providers.js';
import { loadEnv, updateEnvKey, pruneEnvLines } from '../src/core/env-file.js';
import { parseTarget, detectFormat } from '../src/core/config-adapter.js';

const PROXY_FLAG = '--__cc-proxy-daemon__';

const USER_CONFIG_DIR = resolveUserConfigDir();
const LOGS_DIR = path.join(USER_CONFIG_DIR, 'logs');
const providersPath = path.join(USER_CONFIG_DIR, 'providers.json');

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { console.warn(`Warning: Could not parse ${path.basename(filePath)}. Preserving it and starting fresh.`); return null; }
}

function writeJsonIfNeeded(filePath, newJson) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, newJson, 'utf8');
    return `Created: ${filePath}`;
  }
  const existingRaw = fs.readFileSync(filePath, 'utf8').trim();
  if (existingRaw !== newJson.trim()) {
    fs.writeFileSync(filePath, newJson, 'utf8');
    return `Updated: ${filePath}`;
  }
  return `No changes needed for: ${filePath}`;
}

function init() {
  if (!fs.existsSync(USER_CONFIG_DIR)) fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

  const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const examplePath = path.join(pkgRoot, 'providers.example.json');
  const configPath = path.join(USER_CONFIG_DIR, 'config.json');

  const providersData = readJsonFile(providersPath) ?? readJsonFile(examplePath) ?? {};
  const mergedProviders = ensureCompleteProviders(providersData);
  validateIds(mergedProviders.providers);
  process.stdout.write(writeJsonIfNeeded(providersPath, JSON.stringify(mergedProviders, null, 2)) + '\n');

  const configData = readJsonFile(configPath) ?? {};
  const mergedConfig = ensureCompleteConfig(configData);
  process.stdout.write(writeJsonIfNeeded(configPath, JSON.stringify(mergedConfig, null, 2)) + '\n');
}

function ensureDaemonConfig() {
  if (!process.argv.includes(PROXY_FLAG)) return;
  if (!fs.existsSync(USER_CONFIG_DIR)) {
    throw new ConfigurationMissingException(`Config directory missing: ${USER_CONFIG_DIR}. Please run 'ccb --x-init' first.`);
  }
  if (!fs.existsSync(providersPath)) {
    throw new ConfigurationMissingException(`providers.json missing: ${providersPath}. Please run 'ccb --x-init' first.`);
  }
}

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function loadDaemonConfig() {
  return loadConfigFromFile(USER_CONFIG_DIR);
}

function runProxyDaemon() {
  ensureDaemonConfig();
  ensureLogsDir();
  const config = loadDaemonConfig();
  const core = createProxyCore({ configDir: USER_CONFIG_DIR, port: config.port });
  core.initProviders();

  core.emit(`CC-Bridge proxy daemon started on http://localhost:${config.port}`);
  core.emit(`Logs directory: ${LOGS_DIR}`);
  core.emit(`Providers: ${core.providerCount} route(s) loaded`);

  const server = http.createServer(core.createRequestHandler());
  server.listen(config.port);
}

function checkProxy(config) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${config.port}/v1/models`, () => resolve(true));
    req.on('error', () => resolve(false));
    req.setTimeout(config.healthCheckTimeoutMs, () => { req.destroy(); resolve(false); });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollUntilReady(config) {
  const { pollMaxAttempts, pollIntervalMs } = config;
  for (let attempt = 0; attempt < pollMaxAttempts; attempt++) {
    if (await checkProxy(config)) return true;
    if (attempt < pollMaxAttempts - 1) await sleep(pollIntervalMs);
  }
  return false;
}

function startProxyDaemon(config) {
  return new Promise((resolve, reject) => {
    const logsDir = path.join(USER_CONFIG_DIR, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    const out = fs.openSync(path.join(logsDir, 'daemon.log'), 'a');
    const err = fs.openSync(path.join(logsDir, 'daemon.err'), 'a');

    const keepaliveSecret = randomBytes(32).toString('hex');

    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), PROXY_FLAG],
      {
        detached: true,
        stdio: ['ignore', out, err],
        windowsHide: true,
        env: { ...process.env, CCB_CONFIG_DIR: USER_CONFIG_DIR, CCB_KEEPALIVE_SECRET: keepaliveSecret }
      }
    );
    child.unref();

    pollUntilReady(config)
      .then(isUp => {
        if (isUp) return resolve(keepaliveSecret);
        reject(new ReadinessTimeoutException('Proxy daemon failed to start within timeout limit'));
      })
      .catch(reject);
  });
}

function resolveWindowsCmdPath() {
  try {
    const stdout = execSync('where claude', { encoding: 'utf8' });
    const paths = stdout.split('\n').map(p => p.trim()).filter(Boolean);
    const cmdPath = paths.find(p => p.toLowerCase().endsWith('.cmd'));
    if (!cmdPath) return { cmd: paths[0] || 'claude', isNode: false };
    return parseCmdWrapper(cmdPath);
  } catch {
    return { cmd: 'claude', isNode: false };
  }
}

function parseCmdWrapper(cmdPath) {
  try {
    const content = fs.readFileSync(cmdPath, 'utf8');
    const m = content.match(/"?(?:%~dp0%?\\\\?|[%]dp0[%]\\\\?)([^\n"]+\.js)"?/i);
    if (m) return { cmd: path.resolve(path.dirname(cmdPath), m[1]), isNode: true };
  } catch {}
  return { cmd: cmdPath, isNode: false };
}

function getClaudeCommand() {
  if (process.platform !== 'win32') return { cmd: 'claude', isNode: false };
  return resolveWindowsCmdPath();
}

async function ensureProxyReady(config) {
  if (!fs.existsSync(USER_CONFIG_DIR)) init();
  if (await checkProxy(config)) {
    // Daemon already running — read secret it wrote at startup
    const secretFile = path.join(USER_CONFIG_DIR, 'logs', 'proxy.secret');
    try { return fs.readFileSync(secretFile, 'utf8').trim(); } catch { return ''; }
  }
  return await startProxyDaemon(config);
}

async function main() {
  ensureLogsDir();
  const config = loadDaemonConfig();
  const keepaliveSecret = await ensureProxyReady(config);

  // Generate a stable session ID for this ccb invocation. It is embedded in
  // ANTHROPIC_BASE_URL so every API request from this CLI process arrives at
  // the proxy with the same /s/{ownSessionId}/ prefix. The proxy extracts it
  // and uses it to name log files — no dependency on CLI internals.
  const ownSessionId = randomBytes(8).toString('hex');

  const args = process.argv.slice(2);
  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://localhost:${config.port}/s/${ownSessionId}` };

  try {
    fs.appendFileSync(path.join(LOGS_DIR, 'proxy.log'), `\n[ccb] Spawning with args: ${JSON.stringify(args)}\n`);
  } catch {}

  const cli = getClaudeCommand();
  const spawnCmd = cli.isNode ? process.execPath : cli.cmd;
  const spawnArgs = cli.isNode ? [cli.cmd, ...args] : args;

  const keepaliveOptions = keepaliveSecret ? { headers: { 'x-ccb-keepalive-secret': keepaliveSecret } } : {};
  const keepaliveReq = http.get(`http://localhost:${config.port}/__ccb_internal__/keepalive`, keepaliveOptions);
  keepaliveReq.on('error', () => { /* Ignore errors, if it dies it dies */ });

  const child = spawn(spawnCmd, spawnArgs, { stdio: 'inherit', env, shell: false });

  let sigintCount = 0;
  const handleSigInt = () => {
    sigintCount++;
    if (sigintCount >= 3) {
      process.exit(130);
    }
    // Forward to child. Claude CLI might need two SIGINTs to exit gracefully.
    try { child.kill('SIGINT'); } catch {}
  };
  process.on('SIGINT', handleSigInt);

  child.on('exit', (code) => {
    keepaliveReq.destroy();
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    keepaliveReq.destroy();
    process.stderr.write(`ccb: failed to launch claude: ${err.message}\n`);
    process.exit(1);
  });
}


function clearLogs() {
  if (!fs.existsSync(LOGS_DIR)) {
    console.log('No logs directory found.');
    return;
  }
  const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log') || f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No log files to clear.');
    return;
  }
  let removed = 0;
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(LOGS_DIR, f));
      removed++;
    } catch (e) {
      process.stderr.write(`Warning: Could not delete ${f}: ${e.message}\n`);
    }
  }
  console.log(`Cleared ${removed} log file(s) from ${LOGS_DIR}`);
}

const CCB_CMDS = {
  '--x-init': () => {
    init();
    process.exit(0);
  },
  '--x-killall': async () => {
    await runKill();
    process.exit(0);
  },
  '--x-clearlogs': () => {
    clearLogs();
    process.exit(0);
  },
  '--x-help': () => {
    process.stdout.write(`
CCB (Claude Code Bridge) Management Commands:
  --x-init          Initialize the config directory (~/.claude/.ccb)
  --x-killall       Kill all background proxy processes
  --x-clearlogs     Delete all log files in the logs directory
  --x-provider ...  Manage providers (add/remove)
  --x-route ...     Manage routing rules (model/property/payloadSize)
  --x-key ...       Manage provider API keys
  --x-help          Show this help message
`);
    process.exit(0);
  }
};

function handleProviderCommand() {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);

  if (subcommand === 'add') return handleProviderAdd(args);
  if (subcommand === 'remove') return handleProviderRemove(args);

  process.stderr.write(`Usage:
  ccb --x-provider add <id> <url> [--non-compliant]   Add a new provider
  ccb --x-provider remove <id>                        Remove a provider
`);
  process.exit(1);
}

function handleProviderAdd(args) {
  const id = args[0];
  const url = args[1];
  const compliant = !args.includes('--non-compliant');

  if (!id || !url) {
    process.stderr.write('Usage: ccb --x-provider add <id> <url> [--non-compliant]\n');
    process.exit(1);
  }

  const data = readProvidersJson();
  const result = addProvider(data.providers, id, url, compliant);
  if (!result.isSuccess) {
    process.stderr.write(`Error: ${result.error.message}\n`);
    process.exit(1);
  }

  data.providers = result.value;
  writeProvidersJson(data);
  console.log(`Added provider "${id}" (${url}) [${compliant ? 'compliant' : 'non-compliant'}]`);
}

function handleProviderRemove(args) {
  const id = args[0];
  if (!id) {
    process.stderr.write('Usage: ccb --x-provider remove <id>\n');
    process.exit(1);
  }

  const data = readProvidersJson();
  const result = removeProvider(data.providers, id);
  if (!result.isSuccess) {
    process.stderr.write(`Error: ${result.error.message}\n`);
    process.exit(1);
  }

  data.providers = result.value;
  writeProvidersJson(data);
  console.log(`Removed provider "${id}"`);
}

export function validateIds(providers) {
  const ids = new Set();
  const envKeys = new Set();
  const idPattern = /^[a-z0-9-_]+$/;

  // Support both v2 (object) and v1 (array) for robustness
  const entries = Array.isArray(providers)
    ? providers.map(p => [p.id, p])
    : Object.entries(providers);

  for (const [id, cfg] of entries) {
    if (!id) {
      throw new ConfigError(`Provider missing ID`);
    }
    if (!idPattern.test(id)) {
      throw new ConfigError(`Invalid provider ID format: "${id}". Use only lowercase alphanumeric, hyphens, or underscores.`);
    }
    if (ids.has(id)) {
      throw new ConfigError(`Duplicate provider ID: "${id}" in providers.json`);
    }

    const envKey = providerIdToEnvKey(id);
    if (envKeys.has(envKey)) {
      throw new ConfigError(`Provider ID collision: "${id}" maps to same environment variable "${envKey}" as another provider.`);
    }

    ids.add(id);
    envKeys.add(envKey);
  }
}

function readProvidersJson() {
  const providersPath = path.join(USER_CONFIG_DIR, 'providers.json');
  if (!fs.existsSync(providersPath)) {
    throw new ConfigurationMissingException(`providers.json not found at ${providersPath}. Run 'ccb --x-init' first.`);
  }
  const data = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
  const merged = ensureCompleteProviders(data);

  // Auto-migrate v1 → v2 on first read
  const format = detectFormat(data);
  if (format === 'v1') {
    writeProvidersJson(merged);
  }

  validateIds(merged.providers);
  return merged;
}

function writeProvidersJson(data) {
  const providersPath = path.join(USER_CONFIG_DIR, 'providers.json');
  fs.writeFileSync(providersPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function handleRouteCommand() {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);

  if (subcommand === 'add') return handleRouteAdd(args);
  if (subcommand === 'remove') return handleRouteRemove(args);
  if (subcommand === 'list') return handleRouteList();
  if (subcommand === 'tree') return handleRouteTree();

  process.stderr.write(`Usage:
  ccb --x-route add model <name> <provider.model> [--fallback <provider.model>]
  ccb --x-route add property <name> <provider.model> [--fallback <provider.model>]
  ccb --x-route add payloadSize <threshold> <provider.model> [--operator gt|lt]
  ccb --x-route remove <name>
  ccb --x-route list
  ccb --x-route tree
`);
  process.exit(1);
}

function handleRouteAdd(args) {
  const routeType = args[0];
  if (!routeType) {
    process.stderr.write('Error: Route type required (model, property, or payloadSize)\n');
    process.exit(1);
  }

  const data = readProvidersJson();

  if (routeType === 'model') {
    const name = args[1];
    const targetDot = args[2];
    if (!name || !targetDot) {
      process.stderr.write('Usage: ccb --x-route add model <name> <provider.model> [--fallback <provider.model>]\n');
      process.exit(1);
    }

    // Validate target provider exists
    try {
      const parsed = parseTarget(targetDot);
      if (!data.providers[parsed.providerId]) {
        process.stderr.write(`Error: No provider "${parsed.providerId}"\n`);
        process.exit(1);
      }
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }

    const fallbackIdx = args.indexOf('--fallback');
    const fallback = fallbackIdx !== -1 && args[fallbackIdx + 1] ? [args[fallbackIdx + 1]] : undefined;

    const result = addRouteModel(data, name, targetDot, fallback);
    if (!result.isSuccess) {
      process.stderr.write(`Error: ${result.error.message}\n`);
      process.exit(1);
    }

    writeProvidersJson(result.value);
    console.log(`Added model route "${name}" → ${targetDot}${fallback ? ` (fallback: ${fallback[0]})` : ''}`);
    return;
  }

  if (routeType === 'property') {
    const propName = args[1];
    const targetDot = args[2];
    if (!propName || !targetDot) {
      process.stderr.write('Usage: ccb --x-route add property <name> <provider.model>\n');
      process.exit(1);
    }

    try {
      const parsed = parseTarget(targetDot);
      if (!data.providers[parsed.providerId]) {
        process.stderr.write(`Error: No provider "${parsed.providerId}"\n`);
        process.exit(1);
      }
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }

    if (!data.routes) data.routes = { models: {}, properties: {}, payloadSize: {} };
    if (!data.routes.properties) data.routes.properties = {};
    data.routes.properties[propName] = targetDot;

    writeProvidersJson(data);
    console.log(`Added property route "${propName}" → ${targetDot}`);
    return;
  }

  if (routeType === 'payloadSize') {
    const threshold = args[1];
    const targetDot = args[2];
    if (!threshold || !targetDot) {
      process.stderr.write('Usage: ccb --x-route add payloadSize <threshold> <provider.model> [--operator gt|lt]\n');
      process.exit(1);
    }

    try {
      const parsed = parseTarget(targetDot);
      if (!data.providers[parsed.providerId]) {
        process.stderr.write(`Error: No provider "${parsed.providerId}"\n`);
        process.exit(1);
      }
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }

    const operatorIdx = args.indexOf('--operator');
    const operator = operatorIdx !== -1 && args[operatorIdx + 1] ? args[operatorIdx + 1] : '>';
    const key = `${operator}${threshold}`;

    if (!data.routes) data.routes = { models: {}, properties: {}, payloadSize: {} };
    if (!data.routes.payloadSize) data.routes.payloadSize = {};
    data.routes.payloadSize[key] = targetDot;

    writeProvidersJson(data);
    console.log(`Added payloadSize route "${key}" → ${targetDot}`);
    return;
  }

  process.stderr.write(`Error: Unknown route type "${routeType}". Use model, property, or payloadSize.\n`);
  process.exit(1);
}

function handleRouteRemove(args) {
  const name = args[0];
  if (!name) {
    process.stderr.write('Usage: ccb --x-route remove <name>\n');
    process.exit(1);
  }

  const data = readProvidersJson();

  // Try to remove from each route section
  if (data.routes?.models?.[name] !== undefined) {
    const result = removeRouteModel(data, name);
    if (result.isSuccess) {
      writeProvidersJson(result.value);
      console.log(`Removed model route "${name}"`);
      return;
    }
  }
  if (data.routes?.properties?.[name] !== undefined) {
    const updated = JSON.parse(JSON.stringify(data));
    delete updated.routes.properties[name];
    writeProvidersJson(updated);
    console.log(`Removed property route "${name}"`);
    return;
  }
  if (data.routes?.payloadSize?.[name] !== undefined) {
    const updated = JSON.parse(JSON.stringify(data));
    delete updated.routes.payloadSize[name];
    writeProvidersJson(updated);
    console.log(`Removed payloadSize route "${name}"`);
    return;
  }

  process.stderr.write(`Error: Route "${name}" not found\n`);
  process.exit(1);
}

function handleRouteList() {
  const data = readProvidersJson();
  const routes = data.routes ?? {};
  let count = 0;

  const models = routes.models ?? {};
  for (const [name, value] of Object.entries(models)) {
    const v = typeof value === 'string' ? value : `${value.target}${value.fallback ? ` [fallback: ${value.fallback.join(', ')}]` : ''}`;
    console.log(`[model] ${name} → ${v}`);
    count++;
  }

  const properties = routes.properties ?? {};
  for (const [name, value] of Object.entries(properties)) {
    const v = typeof value === 'string' ? value : value.target;
    console.log(`[property] ${name} → ${v}`);
    count++;
  }

  const payloadSizes = routes.payloadSize ?? {};
  for (const [name, value] of Object.entries(payloadSizes)) {
    const v = typeof value === 'string' ? value : value.target;
    console.log(`[payloadSize] ${name} → ${v}`);
    count++;
  }

  if (count === 0) console.log('(no routes)');
}

function handleRouteTree() {
  const data = readProvidersJson();
  console.log(formatTree(data));
}

function handleKeyPrune() {
  const data = readProvidersJson();
  const validEnvKeys = new Set(Object.keys(data.providers).map(id => providerIdToEnvKey(id)));

  const envPath = path.join(USER_CONFIG_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    console.log('No .env file found.');
    return;
  }

  const removed = pruneEnvLines(envPath, ({ key }) => {
    if (!key.endsWith('_KEY')) return false;
    return !validEnvKeys.has(key.toUpperCase());
  });

  if (removed.length === 0) {
    console.log('No orphaned keys found.');
    return;
  }

  console.log(`Pruned ${removed.length} orphaned key(s) from .env: ${removed.join(', ')}`);
}

function updateEnvFile(key, value) {
  const envPath = path.join(USER_CONFIG_DIR, '.env');
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  const lines = content.split('\n');
  let found = false;
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`) || trimmed.startsWith(`# ${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    newLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, newLines.join('\n').trim() + '\n', 'utf8');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(envPath, 0o600); } catch { /* best effort */ }
  }
}

function handleKeySet(args) {
  const providerId = args[0];
  const apiKey = args[1];
  if (!providerId || apiKey === undefined) {
    process.stderr.write('Usage: ccb --x-key set <provider-id> <api-key>\n');
    process.exit(1);
  }

  const data = readProvidersJson();
  const key = findProviderKey(data.providers, providerId);
  if (key === null) {
    process.stderr.write(`Error: No provider matching "${providerId}"\n`);
    process.exit(1);
  }

  const envVar = providerIdToEnvKey(key);
  updateEnvKey(path.join(USER_CONFIG_DIR, '.env'), envVar, apiKey);
  console.log(`Updated environment variable ${envVar} in .env for provider "${key}"`);
}

function handleKeyRemove(args) {
  const providerId = args[0];
  if (!providerId) {
    process.stderr.write('Usage: ccb --x-key remove <provider-id>\n');
    process.exit(1);
  }

  const data = readProvidersJson();
  const key = findProviderKey(data.providers, providerId);
  if (key === null) {
    process.stderr.write(`Error: No provider matching "${providerId}"\n`);
    process.exit(1);
  }

  const envVar = providerIdToEnvKey(key);
  updateEnvKey(path.join(USER_CONFIG_DIR, '.env'), envVar, '');
  console.log(`Cleared environment variable ${envVar} in .env for provider "${key}"`);
}

function handleKeyList(args) {
  const reveal = args.includes('--reveal');
  const data = readProvidersJson();
  const keys = Object.keys(data.providers);
  if (keys.length === 0) {
    console.log('No providers configured.');
    return;
  }
  for (const id of keys) {
    const cfg = data.providers[id];
    const envVar = providerIdToEnvKey(id);
    const val = process.env[envVar] || '';
    const keyDisplay = reveal ? (val || '(none)') : obfuscateKey(val);
    console.log(`[${id}] ${cfg.url}  ${keyDisplay} (env: ${envVar})`);
  }
}

function handleKeyCommand() {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);

  if (subcommand === 'set') return handleKeySet(args);
  if (subcommand === 'remove') return handleKeyRemove(args);
  if (subcommand === 'list') return handleKeyList(args);
  if (subcommand === 'prune') return handleKeyPrune();

  process.stderr.write(`Usage:
  ccb --x-key set <provider-id> <api-key>       Set API key for a provider
  ccb --x-key remove <provider-id>              Remove API key from a provider
  ccb --x-key list [--reveal]                    List API keys for all providers
  ccb --x-key prune                             Remove orphaned keys from .env
`);
  process.exit(1);
}

async function entry() {
  Object.assign(process.env, loadEnv(path.join(USER_CONFIG_DIR, '.env')));

  if (process.argv.includes(PROXY_FLAG)) {
    runProxyDaemon();
    return;
  }

  if (process.argv[2] === '--x-route') return handleRouteCommand();
  if (process.argv[2] === '--x-provider') return handleProviderCommand();
  if (process.argv[2] === '--x-key') return handleKeyCommand();

  const cmd = CCB_CMDS[process.argv[2]];
  if (cmd) return cmd();

  await main();
}

function handleError(err) {
  process.stderr.write(`ccb error: ${err.name} - ${err.message}\n`);
  process.exit(1);
}

// Only run when executed directly, not when imported (e.g. by test.js)
if (process.argv[1]) {
  const metaPath = fs.realpathSync(fileURLToPath(import.meta.url));
  const argPath = fs.realpathSync(path.resolve(process.argv[1]));
  if (metaPath === argPath) {
    entry().catch(handleError);
  }
}
