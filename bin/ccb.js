#!/usr/bin/env node

import { spawnSync as _spawnSync } from 'child_process';
import http from 'http';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import net from 'net';

import { 
  ReadinessTimeoutException, 
  ConfigurationMissingException, 
  ConfigError, 
  ArgumentError 
} from '../src/core/exceptions.js';

import { 
  loadConfigFromFile, 
  resolveUserConfigDir 
} from '../src/core/config.js';

import {
  CCB_VERSION,
  LOGS_DIR_NAME,
  PROVIDERS_FILENAME,
  CONFIG_FILENAME,
  VERSIONS_FILENAME,
  RUNTIME_FILENAME,
  ENV_FILENAME,
  WATCHDOG_SCRIPT_NAME
} from '../src/core/constants.js';

import { 
  addRouteModel, 
  removeRouteModel, 
  formatTree, 
  findProviderKey, 
  addProvider, 
  removeProvider 
} from '../src/core/model-manager.js';

import { 
  listApiKeys as _listApiKeys, 
  obfuscateKey 
} from '../src/core/key-manager.js';

import { 
  ensureCompleteConfig, 
  ensureCompleteProviders 
} from '../src/core/migrator.js';

import { providerIdToEnvKey } from '../src/core/providers.js';

import { 
  loadEnv, 
  updateEnvKey, 
  pruneEnvLines 
} from '../src/core/env-file.js';

import { 
  parseTarget as _parseTarget, 
  detectFormat as _detectFormat 
} from '../src/core/config-adapter.js';

import { getControlIpcPath } from '../src/core/daemon-constants.js';
import { serializeIpcMessage, parseIpcMessage } from '../src/core/ipc-protocol.js';
import { runKill, spawnDaemon, spawnCommand, getProcesses } from '../src/infra/process-manager.js';

const USER_CONFIG_DIR = resolveUserConfigDir();
const LOGS_DIR = path.join(USER_CONFIG_DIR, LOGS_DIR_NAME);
const providersPath = path.join(USER_CONFIG_DIR, PROVIDERS_FILENAME);
const VERSIONS_PATH = path.join(USER_CONFIG_DIR, VERSIONS_FILENAME);
const RUNTIME_PATH = path.join(USER_CONFIG_DIR, RUNTIME_FILENAME);

function readRuntimeState() {
  try {
    if (!fs.existsSync(RUNTIME_PATH)) return null;
    return JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function readActivePort(config) {
  const runtime = readRuntimeState();
  if (runtime && typeof runtime.port === 'number') return runtime.port;
  return config.port;
}

function loadVersions() {
  const versions = readJsonFile(VERSIONS_PATH) ?? { current: CCB_VERSION, versions: {} };
  // Ensure current version is always in the list
  const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const watchdogPath = path.join(pkgRoot, 'bin', WATCHDOG_SCRIPT_NAME);
  versions.versions[CCB_VERSION] = watchdogPath;
  return versions;
}

function saveVersions(versions) {
  fs.writeFileSync(VERSIONS_PATH, JSON.stringify(versions, null, 2) + '\n', 'utf8');
}

async function handleVersionsCommand() {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);

  if (subcommand === 'add') {
    const version = args[0];
    const watchdogPath = args[1];
    if (!version || !watchdogPath) {
      process.stderr.write('Usage: ccb --x-version add <version> <watchdog-path>\n');
      process.exit(1);
    }
    const versions = loadVersions();
    versions.versions[version] = path.resolve(watchdogPath);
    saveVersions(versions);
    console.log(`Added version ${version}: ${watchdogPath}`);
    return;
  }

  if (subcommand === 'remove') {
    const version = args[0];
    if (!version) {
      process.stderr.write('Usage: ccb --x-version remove <version>\n');
      process.exit(1);
    }
    const versions = loadVersions();
    delete versions.versions[version];
    saveVersions(versions);
    console.log(`Removed version ${version}`);
    return;
  }

  if (subcommand === 'list' || !subcommand) {
    const versions = loadVersions();
    console.log('Available Versions:');
    for (const [v, p] of Object.entries(versions.versions)) {
      const currentMarker = v === versions.current ? ' (current)' : '';
      const localMarker = v === CCB_VERSION ? ' (local binary)' : '';
      console.log(`  ${v.padEnd(8)} ${p}${currentMarker}${localMarker}`);
    }
    return;
  }

  if (subcommand === 'set' || subcommand === 'switch') {
    const version = args[0];
    if (!version) {
      process.stderr.write(`Usage: ccb --x-version ${subcommand} <version>\n`);
      process.exit(1);
    }
    const versions = loadVersions();
    if (!versions.versions[version]) {
      process.stderr.write(`Error: Version ${version} not found in registry.\n`);
      process.exit(1);
    }
    versions.current = version;
    saveVersions(versions);
    console.log(`Default version set to ${version}`);
    return;
  }

  if (subcommand === 'create') {
    const version = args[0];
    const targetDir = args[1] || `../cc-bridge-${version}`;
    if (!version) {
      process.stderr.write('Usage: ccb --x-version create <version> [target-dir]\n');
      process.exit(1);
    }
    console.log(`Creating git worktree for ${version} at ${targetDir}...`);
    try {
      _spawnSync('git', ['worktree', 'add', targetDir, version], { stdio: 'inherit', windowsHide: true });
      const watchdogPath = path.resolve(targetDir, 'bin', WATCHDOG_SCRIPT_NAME);
      const versions = loadVersions();
      versions.versions[version] = watchdogPath;
      saveVersions(versions);
      console.log(`Registered version ${version}: ${watchdogPath}`);
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
    return;
  }
}

async function listSessions() {
  const config = loadDaemonConfig();
  const procs = getProcesses();
  const workers = procs.filter(p => p.cmd.includes(WATCHDOG_SCRIPT_NAME));

  if (workers.length === 0) {
    console.log('No active ccb workers found.');
    return;
  }

  console.log('Active Sessions:');
  console.log('  PID    Version  Uptime   Sessions  Connections  Log Path');

  for (const worker of workers) {
    const port = await findPortForPid(worker.pid);
    if (!port) {
      console.log(`  ${String(worker.pid).padEnd(6)} [Unknown Port]`);
      continue;
    }

    const socket = await connectToControlIpc(port);
    if (!socket) {
      console.log(`  ${String(worker.pid).padEnd(6)} [IPC Unavailable (Port ${port})]`);
      continue;
    }

    try {
      const status = await queryWorkerStatusIpc(socket, config.ipcTimeoutMs);
      const uptime = formatDuration(status.uptimeMs / 1000);
      console.log(`  ${String(worker.pid).padEnd(6)} ${CCB_VERSION.padEnd(8)} ${uptime.padEnd(8)} ${String(status.keepalives).padEnd(9)} ${String(status.drainingWorkers).padEnd(12)} (Port ${port})`);
    } catch (e) {
      console.log(`  ${String(worker.pid).padEnd(6)} [Query Failed: ${e.message}]`);
    } finally {
      socket.end();
    }
  }
}

function queryWorkerStatusIpc(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    socket.write(serializeIpcMessage({ cmd: 'status' }));
    let buffer = '';
    const onData = (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const response = parseIpcMessage(line);
        if (response && response.status === 'ok') {
          socket.off('data', onData);
          resolve(response);
          return;
        }
      }
    };
    socket.on('data', onData);
    setTimeout(() => {
      socket.off('data', onData);
      reject(new Error('Timeout'));
    }, timeoutMs);
  });
}

async function findPortForPid(pid) {
  const isWin = process.platform === 'win32';
  try {
    if (isWin) {
      const out = _spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).stdout;
      const lines = out.split('\n');
      for (const line of lines) {
        if (line.includes('LISTENING') && line.includes(String(pid))) {
          const match = line.match(/0\.0\.0\.0:(\d+)/) || line.match(/127\.0\.0\.1:(\d+)/) || line.match(/\[::\]:(\d+)/);
          if (match) return parseInt(match[1], 10);
        }
      }
      return null;
    }

    const out = _spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-p', String(pid)], { encoding: 'utf8' }).stdout;
    const match = out.match(/:(\d+)\s+\(LISTEN\)/);
    if (match) return parseInt(match[1], 10);
  } catch { }
  return null;
}


function formatDuration(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

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

function loadDaemonConfig() {
  return loadConfigFromFile(USER_CONFIG_DIR);
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
  const config = loadConfigFromFile(USER_CONFIG_DIR);
  const port = readActivePort(config);
  const socket = await connectToControlIpc(port);
  if (!socket) {
    process.stderr.write(`ccb: No running proxy daemon found on port ${port}.\n`);
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
      if (response && response.status === 'ok') {
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
  }, config.ipcTimeoutMs);
}

async function handleSessionsCommand() {
  await listSessions();
  process.exit(0);
}

const CCB_CMDS = {
  '--x-init': () => {
    init();
    process.exit(0);
  },
  '--x-status': () => handleStatusCommand(),
  '--x-sessions': () => handleSessionsCommand(),
  '--x-gui': async () => {
    const config = loadDaemonConfig(USER_CONFIG_DIR);
    try {
      await ensureDaemon(config, null);
    } catch (e) {
      process.stderr.write(`ccb: Failed to start the proxy daemon: ${e.message}\n`);
      process.stderr.write(`See ${path.join(LOGS_DIR, 'daemon.err')} for details.\n`);
      process.exit(1);
    }
    const port = readActivePort(config);
    const url = `http://localhost:${port}/gui`;
    const platform = process.platform;
    let cmd = 'xdg-open';
    if (platform === 'darwin') cmd = 'open';
    if (platform === 'win32') cmd = 'start';

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
    const port = readActivePort(config);
    const socket = await connectToControlIpc(port);
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
  '--x-provider': () => handleProviderCommand(),
  '--x-route': () => handleRouteCommand(),
  '--x-key': () => handleKeyCommand(),
  '--x-version': () => handleVersionsCommand(),
  '--x-help': () => {
    process.stdout.write(`
  CCB (Claude Code Bridge) Management Commands:
  --x-version [add|remove|list|set]  Manage or list versions
  --x-init                           Initialize the config directory (~/.claude/.ccb)
  --x-status                         Show current daemon and worker status
  --x-sessions                       List all active sessions across workers
  --x-killall                        Kill all background proxy processes
  --x-restart                        Gracefully restart the proxy daemon (zero-downtime)
  --x-gui                            Open the GUI dashboard in your browser
  --x-clearlogs                      Delete all log files in the logs directory
  --x-provider ...                   Manage providers (add/remove)
  --x-route ...                      Manage routing rules (model/property/payloadSize)
  --x-key ...                        Manage API keys (.env)

  Usage for Passthrough:
  ccb [--version <v>] [claude args]
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

function fetchSessionInfo(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/__ccb_internal__/session`, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function displaySessionSummary(info) {
  if (!info) return;
  process.stdout.write('\n── Session Summary ──\n');
  if (info.claude_session_id) {
    process.stdout.write(`  Claude Session: ${info.claude_session_id}\n`);
  }
  process.stdout.write(`  Requests: ${info.total_requests} | Tokens: ${info.total_input_tokens} in / ${info.total_output_tokens} out\n`);
  process.stdout.write(`  Uptime: ${info.uptime_sec}s | Worker PID: ${info.worker_pid}\n`);
  if (info.history && info.history.length > 0) {
    process.stdout.write(`  Recent:\n`);
    for (const line of info.history.slice(-5)) {
      process.stdout.write(`    ${line}\n`);
    }
  }
  process.stdout.write('─────────────────────\n');
}

  function startProxyDaemonProcess(versionInfo) {
  const logsDir = path.join(USER_CONFIG_DIR, LOGS_DIR_NAME);
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const out = fs.openSync(path.join(logsDir, 'daemon.log'), 'a');
  const err = fs.openSync(path.join(logsDir, 'daemon.err'), 'a');

  let watchdogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), WATCHDOG_SCRIPT_NAME);
  if (versionInfo && versionInfo.path) {
    watchdogPath = versionInfo.path;
  }

  const child = spawnDaemon(watchdogPath, [], {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, CCB_VERSION: versionInfo?.name || CCB_VERSION }
  });

  child.unref();
  }

  async function ensureDaemon(config, versionInfo) {
  // Existing daemon? readActivePort returns runtime.json port if recorded, else config.port.
  if (await checkProxy(readActivePort(config), config.healthCheckTimeoutMs)) return;

  startProxyDaemonProcess(versionInfo);

  // Phase-aware startup wait. The hard ceiling is daemonStartTimeoutMs (defaults
  // to workerInitTimeoutMs — typically 20s — so a slow first boot can finish).
  // The "stuck" detector is daemonStartProgressGraceMs: if no new bytes appear
  // in daemon.log for that long AND the daemon isn't reachable, declare it
  // stuck. Each new chunk of log resets the stuck timer because that's evidence
  // the worker is still making forward progress through bind/initProviders/
  // extension-discovery.
  const totalBudgetMs = config.daemonStartTimeoutMs;
  const stuckGraceMs = config.daemonStartProgressGraceMs;
  const logPath = path.join(LOGS_DIR, 'daemon.log');

  const started = Date.now();
  let lastLogSize = (() => { try { return fs.statSync(logPath).size; } catch { return 0; } })();
  let lastProgressAt = Date.now();

  while (Date.now() - started < totalBudgetMs) {
    await new Promise(r => setTimeout(r, config.pollIntervalMs));

    // Did the daemon write anything new? Treat that as forward progress.
    let currentSize;
    try { currentSize = fs.statSync(logPath).size; } catch { currentSize = lastLogSize; }
    if (currentSize > lastLogSize) {
      lastLogSize = currentSize;
      lastProgressAt = Date.now();
    }

    if (await checkProxy(readActivePort(config), config.healthCheckTimeoutMs)) return;

    if (Date.now() - lastProgressAt > stuckGraceMs) {
      throw new ReadinessTimeoutException(
        `Proxy daemon stuck — no log activity for ${stuckGraceMs}ms. See ${logPath} and ${path.join(LOGS_DIR, 'daemon.err')}.`
      );
    }
  }
  throw new ReadinessTimeoutException(
    `Proxy daemon failed to start within ${totalBudgetMs}ms (daemonStartTimeoutMs). ` +
    `Raise it in your ccb config.json if your startup is legitimately slow, or check ${path.join(LOGS_DIR, 'daemon.err')}.`
  );
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

  for (const cmd of Object.keys(CCB_CMDS)) {
    if (process.argv.includes(cmd)) {
      await CCB_CMDS[cmd]();
      return;
    }
  }

  // Handle version flag for passthrough
  let requestedVersion = null;
  const versionIdx = process.argv.indexOf('--version');
  if (versionIdx !== -1 && process.argv.length > versionIdx + 1) {
    requestedVersion = process.argv[versionIdx + 1];
    // Remove --version <v> from args so they don't go to Claude
    process.argv.splice(versionIdx, 2);
  }

  const versions = loadVersions();
  const targetVersionName = requestedVersion || versions.current || CCB_VERSION;
  const targetVersionPath = versions.versions[targetVersionName];

  if (requestedVersion && !targetVersionPath) {
    process.stderr.write(`Error: Version ${requestedVersion} not found in registry.\n`);
    process.exit(1);
  }

  const config = loadConfigFromFile(USER_CONFIG_DIR);
  await ensureDaemon(config, targetVersionPath ? { name: targetVersionName, path: targetVersionPath } : null);

  const activePort = readActivePort(config);
  const ipcPath = getControlIpcPath(activePort);
  const KEEPALIVE_INTERVAL_MS = 15000;

  let ipcSocket = null;
  let keepaliveTimer = null;
  let claudeAlive = true;

  function connectKeepalive() {
    if (ipcSocket) {
      ipcSocket.removeAllListeners();
      ipcSocket.destroy();
    }

    ipcSocket = net.connect(ipcPath, () => {
      ipcSocket.write(serializeIpcMessage({ cmd: 'keepalive' }));
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = setInterval(() => {
        if (ipcSocket && !ipcSocket.destroyed) {
          ipcSocket.write(serializeIpcMessage({ cmd: 'keepalive' }));
        }
      }, KEEPALIVE_INTERVAL_MS);
    });

    ipcSocket.on('error', () => {});

    ipcSocket.on('close', () => {
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      if (claudeAlive) connectKeepalive();
    });
  }

  connectKeepalive();

  const args = process.argv.slice(2);
  const baseUrl = `http://localhost:${activePort}`;

  const claudeBin = resolveClaudeBin();
  const child = spawnCommand(claudeBin, args, {
    stdio: 'inherit',
    env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl }
  });

  child.on('exit', async (code) => {
    claudeAlive = false;
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    const sessionInfo = await fetchSessionInfo(activePort, config.healthCheckTimeoutMs);
    displaySessionSummary(sessionInfo);
    if (ipcSocket) ipcSocket.destroy();
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
