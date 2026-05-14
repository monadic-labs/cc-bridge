#!/usr/bin/env node

import { spawnSync as _spawnSync } from 'child_process';
import http from 'http';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { ReadinessTimeoutException, ConfigurationMissingException, ConfigError, ArgumentError } from '../src/core/exceptions.js';
import { loadConfigFromFile, resolveUserConfigDir } from '../src/core/config.js';
import {
  LOGS_DIR_NAME,
  PROVIDERS_FILENAME,
  CONFIG_FILENAME,
  ENV_FILENAME,
  WATCHDOG_SCRIPT_NAME
} from '../src/core/constants.js';
import { addRouteModel, removeRouteModel, formatTree, findProviderKey, addProvider, removeProvider } from '../src/core/model-manager.js';
import { listApiKeys as _listApiKeys, obfuscateKey } from '../src/core/key-manager.js';
import { ensureCompleteConfig, ensureCompleteProviders } from '../src/core/migrator.js';
import { providerIdToEnvKey } from '../src/core/providers.js';
import { loadEnv, updateEnvKey, pruneEnvLines } from '../src/core/env-file.js';
import { parseTarget as _parseTarget, detectFormat as _detectFormat } from '../src/core/config-adapter.js';
import net from 'net';
import { getControlIpcPath } from '../src/core/daemon-constants.js';
import { serializeIpcMessage, parseIpcMessage } from '../src/core/ipc-protocol.js';
import { runKill, spawnDaemon, spawnCommand } from '../src/infra/process-manager.js';
import { createProxyCore } from '../src/proxy-core.js';

const PROXY_FLAG = '--__cc-proxy-daemon__';

const USER_CONFIG_DIR = resolveUserConfigDir();
const LOGS_DIR = path.join(USER_CONFIG_DIR, LOGS_DIR_NAME);
const providersPath = path.join(USER_CONFIG_DIR, PROVIDERS_FILENAME);

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
  const configPath = path.join(USER_CONFIG_DIR, CONFIG_FILENAME);

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
  const server = http.createServer(core.createRequestHandler());

  server.listen(config.port, async () => {
    core.initProviders();
  });
}

export function validateIds(providers) {
  const envKeys = new Set();
  for (const id of Object.keys(providers)) {
    if (!/^[a-z0-9-_]+$/.test(id)) {
      throw new ArgumentError(`Invalid provider ID "${id}". IDs must be lowercase alphanumeric, dashes, or underscores.`);
    }
    const envKey = providerIdToEnvKey(id);
    if (envKeys.has(envKey)) {
      throw new ArgumentError(`Provider ID "${id}" results in duplicate environment key "${envKey}".`);
    }
    envKeys.add(envKey);
  }
}

function readProvidersJson() {
  const providersPath = path.join(USER_CONFIG_DIR, PROVIDERS_FILENAME);
  if (!fs.existsSync(providersPath)) {
    throw new ConfigurationMissingException(`providers.json not found at ${providersPath}. Run 'ccb --x-init' first.`);
  }
  const data = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
  const merged = ensureCompleteProviders(data);
  validateIds(merged.providers);
  return merged;
}

function writeProvidersJson(data) {
  const providersPath = path.join(USER_CONFIG_DIR, PROVIDERS_FILENAME);
  fs.writeFileSync(providersPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function handleRouteCommand() {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);

  if (subcommand === 'add') {
    const _type = args[0];
    const key = args[1];
    const target = args[2];
    if (!_type || !key || !target) {
      process.stderr.write('Usage: ccb --x-route add <model|property|payloadSize> <key> <target>\n');
      process.exit(1);
    }
    const data = readProvidersJson();
    const result = addRouteModel(data, key, target);
    if (!result.isSuccess) {
      process.stderr.write(`Error: ${result.error.message}\n`);
      process.exit(1);
    }
    const updatedData = result.value;
    writeProvidersJson(updatedData);
    console.log(`Added route: ${key} -> ${target}`);
    return;
  }

  if (subcommand === 'remove') {
    const key = args[0];
    if (!key) {
      process.stderr.write('Usage: ccb --x-route remove <key>\n');
      process.exit(1);
    }
    const data = readProvidersJson();
    const result = removeRouteModel(data, key);
    if (!result.isSuccess) {
      process.stderr.write(`Error: ${result.error.message}\n`);
      process.exit(1);
    }
    const updatedData = result.value;
    writeProvidersJson(updatedData);
    console.log(`Removed route: ${key}`);
    return;
  }

  if (subcommand === 'list') {
    const data = readProvidersJson();
    console.log('Routes:');
    for (const [key, target] of Object.entries(data.routes.models)) {
      console.log(`  ${key} -> ${target}`);
    }
    return;
  }

  if (subcommand === 'tree') {
    const data = readProvidersJson();
    console.log(formatTree(data));
    return;
  }

  process.stderr.write('Usage: ccb --x-route <add|remove|list|tree>\n');
  process.exit(1);
}

function handleProviderCommand() {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);

  if (subcommand === 'add') {
    const id = args[0];
    const url = args[1];
    if (!id || !url) {
      process.stderr.write('Usage: ccb --x-provider add <id> <url> [--non-compliant]\n');
      process.exit(1);
    }
    const compliant = !args.includes('--non-compliant');
    const data = readProvidersJson();
    const result = addProvider(data.providers, id, url, compliant);
    if (!result.isSuccess) {
      process.stderr.write(`Error: ${result.error.message}\n`);
      process.exit(1);
    }
    data.providers = result.value;
    writeProvidersJson(data);
    console.log(`Added provider: ${id} (${url}, ${compliant ? 'compliant' : 'non-compliant'})\n`);
    return;
  }

  if (subcommand === 'remove') {
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
    console.log(`Removed provider: ${id}`);
    return;
  }

  if (subcommand === 'list') {
    const data = readProvidersJson();
    console.log('Providers:');
    for (const [id, cfg] of Object.entries(data.providers)) {
      console.log(`  ${id} (${cfg.url})`);
    }
    return;
  }

  process.stderr.write('Usage: ccb --x-provider <add|remove|list>\n');
  process.exit(1);
}

function handleKeySet(args) {
  const providerId = args[0];
  const apiKey = args[1];
  if (!providerId || !apiKey) {
    process.stderr.write('Usage: ccb --x-key set <provider-id> <api-key>\n');
    process.exit(1);
  }

  const data = readProvidersJson();
  const key = findProviderKey(data.providers, providerId);
  if (!key) {
    process.stderr.write(`Error: No provider matching "${providerId}"\n`);
    process.exit(1);
  }

  const envVar = providerIdToEnvKey(key);
  updateEnvKey(path.join(USER_CONFIG_DIR, ENV_FILENAME), envVar, apiKey);
  console.log(`Updated environment variable ${envVar} in ${ENV_FILENAME} for provider "${key}"`);
}

function handleKeyRemove(args) {
  const providerId = args[0];
  if (!providerId) {
    process.stderr.write('Usage: ccb --x-key remove <provider-id>\n');
    process.exit(1);
  }

  const data = readProvidersJson();
  const key = findProviderKey(data.providers, providerId);
  if (!key) {
    process.stderr.write(`Error: No provider matching "${providerId}"\n`);
    process.exit(1);
  }

  const envVar = providerIdToEnvKey(key);
  updateEnvKey(path.join(USER_CONFIG_DIR, ENV_FILENAME), envVar, '');
  console.log(`Cleared environment variable ${envVar} in ${ENV_FILENAME} for provider "${key}"`);
}

function handleKeyList(args) {
  const reveal = args.includes('--reveal');
  const env = loadEnv(path.join(USER_CONFIG_DIR, ENV_FILENAME));
  const providers = readProvidersJson().providers;

  console.log('Provider API Keys:');
  for (const id of Object.keys(providers)) {
    const envKey = providerIdToEnvKey(id);
    const val = env[envKey] || '';
    const display = val ? (reveal ? val : obfuscateKey(val)) : '(not set)';
    console.log(`  [${id}] ${envKey}=${display}`);
  }
}

function handleKeyPrune() {
  const data = readProvidersJson();
  const validEnvKeys = new Set(Object.keys(data.providers).map(id => providerIdToEnvKey(id)));

  const envPath = path.join(USER_CONFIG_DIR, ENV_FILENAME);
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

  console.log(`Pruned ${removed.length} orphaned key(s) from ${ENV_FILENAME}: ${removed.join(', ')}`);
}

function handleKeyCommand() {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);

  if (subcommand === 'set') {
    handleKeySet(args);
    return;
  }

  if (subcommand === 'remove') {
    handleKeyRemove(args);
    return;
  }

  if (subcommand === 'list') {
    handleKeyList(args);
    return;
  }

  if (subcommand === 'prune') {
    handleKeyPrune();
    return;
  }

  process.stderr.write('Usage: ccb --x-key <set|remove|list|prune>\n');
  process.exit(1);
}

function clearLogs() {
  const logsDir = path.join(USER_CONFIG_DIR, LOGS_DIR_NAME);
  if (!fs.existsSync(logsDir)) return;
  const files = fs.readdirSync(logsDir);
  let removed = 0;
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(logsDir, f));
      removed++;
    } catch (e) {
      process.stderr.write(`Warning: Could not delete ${f}: ${e.message}\n`);
    }
  }
  console.log(`Cleared ${removed} log file(s) from ${LOGS_DIR_NAME}`);
}

async function connectToControlIpc(port) {
  const ipcPath = getControlIpcPath(port);
  return new Promise((resolve) => {
    const socket = net.connect(ipcPath, () => {
      resolve(socket);
    });
    socket.on('error', () => {
      resolve(null);
    });
  });
}

async function handleStatusCommand() {
  const config = loadDaemonConfig(USER_CONFIG_DIR);
  const socket = await connectToControlIpc(config.port);
  if (!socket) {
    process.stderr.write('ccb: No running proxy daemon found.\n');
    process.exit(1);
  }

  socket.write(serializeIpcMessage({ cmd: 'status' }));

  let buffer = '';
  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const response = parseIpcMessage(line);
      if (response) {
        process.stdout.write(`Status: ${response.status}\n`);
        process.stdout.write(`Worker PID: ${response.workerPid}\n`);
        process.stdout.write(`Uptime: ${Math.round(response.uptimeMs / 1000)}s\n`);
        process.stdout.write(`Active Keepalives: ${response.keepalives}\n`);
        socket.end();
        process.exit(0);
      }
    }
  });

  socket.on('error', (err) => {
    process.stderr.write(`ccb: IPC error: ${err.message}\n`);
    process.exit(1);
  });

  setTimeout(() => {
    process.stderr.write('ccb: Status request timed out\n');
    socket.destroy();
    process.exit(1);
  }, 5000);
}

async function handleSessionsCommand() {
  const config = loadDaemonConfig(USER_CONFIG_DIR);
  const socket = await connectToControlIpc(config.port);
  if (!socket) {
    process.stderr.write('ccb: No running proxy daemon found.\n');
    process.exit(1);
  }

  socket.write(serializeIpcMessage({ cmd: 'sessions' }));

  let buffer = '';
  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const response = parseIpcMessage(line);
      if (response && response.cmd === 'sessions') {
        if (response.workers && response.workers.length > 0) {
          process.stdout.write('Active Sessions:\n');
          process.stdout.write('  PID    Version  Uptime   Keepalives\n');
          for (const w of response.workers) {
            process.stdout.write(`  ${String(w.pid).padEnd(6)} ${String(w.version).padEnd(8)} ${String(Math.round(w.uptimeMs / 1000) + 's').padEnd(8)} ${w.keepalives}\n`);
          }
          process.stdout.write(`\nTotal: ${response.totalKeepalives} session(s) across ${response.workers.length} worker(s)\n`);
        } else {
          process.stdout.write('No active sessions.\n');
        }
        socket.end();
        process.exit(0);
      }
    }
  });

  socket.on('error', (err) => {
    process.stderr.write(`ccb: IPC error: ${err.message}\n`);
    process.exit(1);
  });

  setTimeout(() => {
    process.stderr.write('ccb: Sessions request timed out\n');
    socket.destroy();
    process.exit(1);
  }, 5000);
}

const CCB_CMDS = {
  '--x-init': () => {
    init();
    process.exit(0);
  },
  '--x-status': () => {
    handleStatusCommand();
  },
  '--x-sessions': () => {
    handleSessionsCommand();
  },
  '--x-gui': () => {
    const config = loadDaemonConfig(USER_CONFIG_DIR);
    const url = `http://localhost:${config.port}/gui`;
    const platform = process.platform;
    let cmd;
    if (platform === 'darwin') {
      cmd = 'open';
    } else if (platform === 'win32') {
      cmd = 'start';
    } else {
      cmd = 'xdg-open';
    }
    spawnCommand(cmd, [url], { detached: true }).unref();
    console.log(`Opening GUI: ${url}`);
    process.exit(0);
  },
  '--x-killall': async () => {
    await runKill();
    process.exit(0);
  },
  '--x-restart': async () => {
    const config = loadDaemonConfig(USER_CONFIG_DIR);
    const socket = await connectToControlIpc(config.port);
    if (!socket) {
      process.stderr.write('ccb: No proxy daemon running.\n');
      process.exit(1);
    }
    socket.write(serializeIpcMessage({ cmd: 'restart' }));
    socket.on('data', (data) => {
      const msg = parseIpcMessage(data.toString());
      if (msg?.status === 'ok') {
        console.log('Restart signal sent to daemon.');
        process.exit(0);
      }
    });
  },
  '--x-clearlogs': () => {
    clearLogs();
    process.exit(0);
  },
  '--x-provider': () => {
    handleProviderCommand();
  },
  '--x-route': () => {
    handleRouteCommand();
  },
  '--x-key': () => {
    handleKeyCommand();
  },
  '--x-version': () => {
    const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
    process.stdout.write(`ccb version ${pkg.version}\n`);
    process.exit(0);
  },
  '--x-help': () => {
    process.stdout.write(`
CCB (Claude Code Bridge) Management Commands:
  --x-version       Print the ccb version
  --x-init          Initialize the config directory (~/.claude/.ccb)
  --x-status        Show current daemon and worker status
  --x-sessions      List all active sessions across workers
  --x-killall       Kill all background proxy processes
  --x-restart       Gracefully restart the proxy daemon (zero-downtime)
  --x-gui           Open the GUI dashboard in your browser
  --x-clearlogs     Delete all log files in the logs directory
  --x-provider ...  Manage providers (add/remove)
  --x-route ...     Manage routing rules (model/property/payloadSize)
  --x-key ...       Manage API keys (.env)
`);
    process.exit(0);
  }
};

function checkProxy(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/v1/models`, { timeout: timeoutMs }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startProxyDaemonProcess() {
  const logsDir = path.join(USER_CONFIG_DIR, LOGS_DIR_NAME);
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const out = fs.openSync(path.join(logsDir, 'daemon.log'), 'a');
  const err = fs.openSync(path.join(logsDir, 'daemon.err'), 'a');

  const watchdogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), WATCHDOG_SCRIPT_NAME);

  const child = spawnDaemon(watchdogPath, [], {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, [PROXY_FLAG]: '1' }
  });

  child.unref();
}

async function ensureDaemon(config) {
  const isUp = await checkProxy(config.port, config.healthCheckTimeoutMs);
  if (!isUp) {
    startProxyDaemonProcess();
    let attempts = 0;
    while (attempts < config.pollMaxAttempts) {
      await new Promise(r => setTimeout(r, config.pollIntervalMs));
      if (await checkProxy(config.port, config.healthCheckTimeoutMs)) return;
      attempts++;
    }
    throw new ReadinessTimeoutException('Proxy daemon failed to start within timeout limit');
  }
}

/**
 * Parse a Windows .cmd npm wrapper to extract the real executable path.
 * npm wrappers look like: "<dp0>\node_modules\...\claude.exe"  %*
 * Returns the resolved absolute path, or null if parsing fails.
 */
function parseCmdWrapper(cmdPath) {
  try {
    const content = fs.readFileSync(cmdPath, 'utf8');
    // Match the quoted exe path on the exec line, e.g.: "%dp0%\...\claude.exe"
    const match = content.match(/"%dp0%\\([^"]+)"|"([^"]+\.exe)"/);
    if (!match) return null;
    const relativePart = match[1] || match[2];
    if (!relativePart) return null;
    // dp0 is the directory of the .cmd file itself
    const dp0 = path.dirname(cmdPath);
    const resolved = path.resolve(dp0, relativePart);
    return fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the real claude binary path on Windows, bypassing .cmd shell wrappers.
 * Falls back to the bare 'claude' string (for non-Windows or if resolution fails).
 */
function resolveClaudeBin() {
  if (process.platform !== 'win32') return 'claude';
  try {
    const result = _spawnSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true });
    const candidates = (result.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
    for (const candidate of candidates) {
      if (candidate.endsWith('.cmd')) {
        const resolved = parseCmdWrapper(candidate);
        if (resolved) return resolved;
        continue;
      }
      if (candidate.endsWith('.exe') && fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch { }
  return 'claude';
}

async function entry() {
  const envPath = path.join(USER_CONFIG_DIR, ENV_FILENAME);
  if (fs.existsSync(envPath)) {
    Object.assign(process.env, loadEnv(envPath));
  }

  if (process.argv.includes(PROXY_FLAG)) {
    runProxyDaemon();
    return;
  }

  for (const cmd of Object.keys(CCB_CMDS)) {
    if (process.argv.includes(cmd)) {
      CCB_CMDS[cmd]();
      return;
    }
  }

  const config = loadConfigFromFile(USER_CONFIG_DIR);
  await ensureDaemon(config);

  const ipcPath = getControlIpcPath(config.port);
  const socket = net.connect(ipcPath, () => {
    socket.write(serializeIpcMessage({ cmd: 'keepalive' }));
  });
  socket.on('error', () => {});

  const args = process.argv.slice(2);
  const baseUrl = `http://localhost:${config.port}`;
  
  const claudeBin = resolveClaudeBin();
  const child = spawnCommand(claudeBin, args, {
    stdio: 'inherit',
    env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl }
  });

  child.on('exit', (code) => {
    socket.destroy();
    process.exit(code ?? 0);
  });
}

function handleError(err) {
  if (err instanceof ReadinessTimeoutException) {
    process.stderr.write(`ccb error: ${err.message}\n`);
    process.exit(1);
  }

  if (err instanceof ConfigurationMissingException) {
    process.stderr.write(`ccb error: ${err.message}\n`);
    process.exit(1);
  }

  if (err instanceof ConfigError) {
    process.stderr.write(`ccb config error: ${err.message}\n`);
    process.exit(1);
  }

  process.stderr.write(`ccb unexpected error: ${err.stack || err}\n`);
  process.exit(1);
}

if (process.argv[1]) {
  const metaPath = fs.realpathSync(fileURLToPath(import.meta.url));
  const argPath = fs.realpathSync(path.resolve(process.argv[1]));
  if (metaPath === argPath) {
    entry().catch(handleError);
  }
}
