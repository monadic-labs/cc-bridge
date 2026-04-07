#!/usr/bin/env node

import { spawn, execSync } from 'child_process';
import http from 'http';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { createProxyCore, runKill, loadEnv } from '../src/proxy-core.js';
import { ReadinessTimeoutException, ConfigurationMissingException, ConfigError } from '../src/core/exceptions.js';
import { loadConfigFromFile, resolveUserConfigDir } from '../src/core/config.js';
import { addModel, removeModel, listModels, listProviders, formatTree, findProviderIndex, addProvider, removeProvider } from '../src/core/model-manager.js';
import { listApiKeys, obfuscateKey } from '../src/core/key-manager.js';
import { ensureCompleteConfig, ensureCompleteProviders } from '../src/core/migrator.js';
import { providerIdToEnvKey } from '../src/core/providers.js';

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

    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), PROXY_FLAG],
      { 
        detached: true, 
        stdio: ['ignore', out, err], 
        windowsHide: true, 
        env: { ...process.env, CCB_CONFIG_DIR: USER_CONFIG_DIR }
      }
    );
    child.unref();

    pollUntilReady(config)
      .then(isUp => {
        if (isUp) return resolve();
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
  if (await checkProxy(config)) return;
  await startProxyDaemon(config);
}

async function main() {
  ensureLogsDir();
  const config = loadDaemonConfig();
  await ensureProxyReady(config);

  const args = process.argv.slice(2);
  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://localhost:${config.port}` };

  try {
    fs.appendFileSync(path.join(LOGS_DIR, 'proxy.log'), `\n[ccb] Spawning with args: ${JSON.stringify(args)}\n`);
  } catch {}

  const cli = getClaudeCommand();
  const spawnCmd = cli.isNode ? process.execPath : cli.cmd;
  const spawnArgs = cli.isNode ? [cli.cmd, ...args] : args;

  const keepaliveReq = http.get(`http://localhost:${config.port}/__ccb_internal__/keepalive`);
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


const CCB_CMDS = {
  '--x-init': () => {
    init();
    process.exit(0);
  },
  '--x-killall': async () => {
    await runKill();
    process.exit(0);
  },
  '--x-help': () => {
    process.stdout.write(`
CCB (Claude Code Bridge) Management Commands:
  --x-init          Initialize the config directory (~/.claude/.ccb)
  --x-killall       Kill all background proxy processes
  --x-model ...     Manage provider models
  --x-provider ...  Manage providers (add/remove)
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

  for (const p of providers) {
    if (!p.id) {
      throw new ConfigError(`Provider missing "id" field: ${p.url}`);
    }
    if (!idPattern.test(p.id)) {
      throw new ConfigError(`Invalid provider ID format: "${p.id}". Use only lowercase alphanumeric, hyphens, or underscores.`);
    }
    if (ids.has(p.id)) {
      throw new ConfigError(`Duplicate provider ID: "${p.id}" in providers.json`);
    }
    
    const envKey = providerIdToEnvKey(p.id);
    if (envKeys.has(envKey)) {
      throw new ConfigError(`Provider ID collision: "${p.id}" maps to same environment variable "${envKey}" as another provider.`);
    }

    ids.add(p.id);
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
  validateIds(merged.providers);
  return merged;
}

function writeProvidersJson(data) {
  const providersPath = path.join(USER_CONFIG_DIR, 'providers.json');
  fs.writeFileSync(providersPath, JSON.stringify(data, null, 2), 'utf8');
}

function parseModelAddArgs(args) {
  if (args.length < 3) return null;
  const providerIdx = args.indexOf('provider');
  if (providerIdx === -1) return null;
  const providerId = args[providerIdx + 1];
  if (!providerId) return null;
  const modelArgs = args.slice(0, providerIdx);
  if (modelArgs.length === 1) return { alias: modelArgs[0], realModel: modelArgs[0], providerId };
  if (modelArgs.length === 2) return { alias: modelArgs[0], realModel: modelArgs[1], providerId };
  return null;
}

function parseModelRemoveArgs(args) {
  if (args.length < 3) return null;
  const providerIdx = args.indexOf('provider');
  if (providerIdx === -1) return null;
  const providerId = args[providerIdx + 1];
  if (!providerId) return null;
  return { alias: args[0], providerId };
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

function handleKeyPrune() {
  const data = readProvidersJson();
  const validEnvKeys = new Set(data.providers.map(p => providerIdToEnvKey(p.id)));
  
  const envPath = path.join(USER_CONFIG_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    console.log('No .env file found.');
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  const lines = content.split('\n');
  const prunedLines = [];
  const removed = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      prunedLines.push(line);
      continue;
    }

    const match = trimmed.match(/^([A-Z0-9_]+_KEY)=/i);
    if (match) {
      const key = match[1].toUpperCase();
      if (!validEnvKeys.has(key)) {
        removed.push(key);
        continue;
      }
    }
    prunedLines.push(line);
  }

  if (removed.length === 0) {
    console.log('No orphaned keys found.');
    return;
  }

  fs.writeFileSync(envPath, prunedLines.join('\n').trim() + '\n', 'utf8');
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
}

function handleKeySet(args) {
  const providerId = args[0];
  const apiKey = args[1];
  if (!providerId || apiKey === undefined) {
    process.stderr.write('Usage: ccb --x-key set <provider-id> <api-key>\n');
    process.exit(1);
  }

  const data = readProvidersJson();
  const idx = findProviderIndex(data.providers, providerId);
  if (idx === -1) {
    process.stderr.write(`Error: No provider matching "${providerId}"\n`);
    process.exit(1);
  }

  const provider = data.providers[idx];
  const envVar = providerIdToEnvKey(provider.id);
  updateEnvFile(envVar, apiKey);
  console.log(`Updated environment variable ${envVar} in .env for provider "${provider.id}"`);
}

function handleKeyRemove(args) {
  const providerId = args[0];
  if (!providerId) {
    process.stderr.write('Usage: ccb --x-key remove <provider-id>\n');
    process.exit(1);
  }

  const data = readProvidersJson();
  const idx = findProviderIndex(data.providers, providerId);
  if (idx === -1) {
    process.stderr.write(`Error: No provider matching "${providerId}"\n`);
    process.exit(1);
  }

  const provider = data.providers[idx];
  const envVar = providerIdToEnvKey(provider.id);
  updateEnvFile(envVar, '');
  console.log(`Cleared environment variable ${envVar} in .env for provider "${provider.id}"`);
}

function handleKeyList(args) {
  const reveal = args.includes('--reveal');
  const data = readProvidersJson();
  if (data.providers.length === 0) {
    console.log('No providers configured.');
    return;
  }
  for (const p of data.providers) {
    const envVar = providerIdToEnvKey(p.id);
    const val = process.env[envVar] || '';
    const keyDisplay = reveal ? (val || '(none)') : obfuscateKey(val);
    console.log(`[${p.id}] ${p.url}  ${keyDisplay} (env: ${envVar})`);
  }
}

function handleModelCommand() {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);

  if (subcommand === 'add') return handleModelAdd(args);
  if (subcommand === 'remove') return handleModelRemove(args);
  if (subcommand === 'list') return handleModelList(args);
  if (subcommand === 'providers') return handleProvidersList();
  if (subcommand === 'tree') return handleTree();

  process.stderr.write(`Usage:
  ccb --x-model add <alias> [real-model] provider <provider-id>   Add a model to a provider
  ccb --x-model remove <alias> provider <provider-id>             Remove a model from a provider
  ccb --x-model list <provider-id>                                 List models for a provider
  ccb --x-model providers                                          List all providers
  ccb --x-model tree                                               Show provider/model hierarchy
`);
  process.exit(1);
}

function handleModelAdd(args) {
  const parsed = parseModelAddArgs(args);
  if (!parsed) {
    process.stderr.write('Usage: ccb --x-model add <alias> [real-model] provider <provider-id>\n');
    process.exit(1);
  }

  const data = readProvidersJson();
  const result = addModel(data.providers, parsed.providerId, parsed.alias, parsed.realModel);
  if (!result.isSuccess) {
    process.stderr.write(`Error: ${result.error.message}\n`);
    process.exit(1);
  }

  data.providers = result.value;
  writeProvidersJson(data);
  console.log(`Added model "${parsed.alias}"${parsed.alias !== parsed.realModel ? ` → ${parsed.realModel}` : ''} to provider matching "${parsed.providerId}"`);
}

function handleModelRemove(args) {
  const parsed = parseModelRemoveArgs(args);
  if (!parsed) {
    process.stderr.write('Usage: ccb --x-model remove <alias> provider <provider-id>\n');
    process.exit(1);
  }

  const data = readProvidersJson();
  const result = removeModel(data.providers, parsed.providerId, parsed.alias);
  if (!result.isSuccess) {
    process.stderr.write(`Error: ${result.error.message}\n`);
    process.exit(1);
  }

  data.providers = result.value;
  writeProvidersJson(data);
  console.log(`Removed model "${parsed.alias}" from provider matching "${parsed.providerId}"`);
}

function handleModelList(args) {
  const providerId = args[0];
  if (!providerId) {
    process.stderr.write('Usage: ccb --x-model list <provider-id>\n');
    process.exit(1);
  }

  const data = readProvidersJson();
  const result = listModels(data.providers, providerId);
  if (!result.isSuccess) {
    process.stderr.write(`Error: ${result.error.message}\n`);
    process.exit(1);
  }

  const { url, compliant, models } = result.value;
  console.log(`${url} (${compliant ? 'compliant' : 'non-compliant'})`);
  if (models.length === 0) {
    console.log('  (no models)');
    return;
  }
  for (const [alias, real] of models) {
    const label = alias === real ? alias : `${alias} → ${real}`;
    console.log(`  ${label}`);
  }
}

function handleProvidersList() {
  const data = readProvidersJson();
  const providers = listProviders(data.providers);
  if (providers.length === 0) {
    console.log('No providers configured.');
    return;
  }
  for (const p of providers) {
    const tag = p.compliant ? 'compliant' : 'non-compliant';
    console.log(`${p.url} (${tag}, ${p.modelCount} model(s))`);
  }
}

function handleTree() {
  const data = readProvidersJson();
  console.log(formatTree(data.providers));
}

async function entry() {
  Object.assign(process.env, loadEnv(path.join(USER_CONFIG_DIR, '.env')));
  
  if (process.argv.includes(PROXY_FLAG)) {
    runProxyDaemon();
    return;
  }

  if (process.argv[2] === '--x-model') return handleModelCommand();
  if (process.argv[2] === '--x-provider') return handleProviderCommand();
  if (process.argv[2] === '--x-key') return handleKeyCommand();

  const cmd = CCB_CMDS[process.argv[2]];
  if (cmd) return cmd();

  await main();
}

entry().catch(handleError);

function handleError(err) {
  process.stderr.write(`ccb error: ${err.name} - ${err.message}\n`);
  process.exit(1);
}
