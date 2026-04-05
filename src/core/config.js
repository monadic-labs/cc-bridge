import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigError } from './exceptions.js';
import { ensureCompleteConfig } from './migrator.js';

export class ProxyConfig {
  #loggingEnabled;
  #logRequests;
  #logResponses;
  #historySize;
  #maxBodyLog;
  #port;
  #healthCheckTimeout;
  #pollInterval;
  #pollMaxAttempts;

  constructor(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new ConfigError('Config must be a valid JSON object', { context: { raw } });
    }
    const logging = raw.logging;
    if (!logging || typeof logging !== 'object') {
      throw new ConfigError('Config must explicitly define a "logging" object');
    }

    if (typeof logging.enabled !== 'boolean') throw new ConfigError('logging.enabled must be explicitly true or false');
    if (typeof logging.requests !== 'boolean') throw new ConfigError('logging.requests must be explicitly true or false');
    if (typeof logging.responses !== 'boolean') throw new ConfigError('logging.responses must be explicitly true or false');
    if (typeof logging.history !== 'number') throw new ConfigError('logging.history must be an explicit number');
    if (typeof logging.maxBodyLog !== 'number') throw new ConfigError('logging.maxBodyLog must be an explicit number');

    const port = raw.port;
    if (port === undefined || port === null) throw new ConfigError('port must be explicitly defined in the config');
    if (typeof port !== 'number' || port < 1 || port > 65535) throw new ConfigError('port must be a valid number between 1 and 65535');

    const daemon = raw.daemon;
    if (!daemon || typeof daemon !== 'object') throw new ConfigError('Config must explicitly define a "daemon" object');

    if (typeof daemon.healthCheckTimeoutMs !== 'number') throw new ConfigError('daemon.healthCheckTimeoutMs must be an explicit number');
    if (typeof daemon.pollIntervalMs !== 'number') throw new ConfigError('daemon.pollIntervalMs must be an explicit number');
    if (typeof daemon.pollMaxAttempts !== 'number') throw new ConfigError('daemon.pollMaxAttempts must be an explicit number');

    this.#healthCheckTimeout = daemon.healthCheckTimeoutMs;
    this.#pollInterval = daemon.pollIntervalMs;
    this.#pollMaxAttempts = daemon.pollMaxAttempts;

    this.#loggingEnabled = logging.enabled;
    this.#logRequests = logging.requests;
    this.#logResponses = logging.responses;
    this.#historySize = logging.history;
    this.#maxBodyLog = logging.maxBodyLog;
    this.#port = port;
    Object.freeze(this);
  }

  get loggingEnabled() { return this.#loggingEnabled; }
  get logRequests() { return this.#logRequests; }
  get logResponses() { return this.#logResponses; }
  get historySize() { return this.#historySize; }
  get maxBodyLog() { return this.#maxBodyLog; }
  get port() { return this.#port; }
  get healthCheckTimeoutMs() { return this.#healthCheckTimeout; }
  get pollIntervalMs() { return this.#pollInterval; }
  get pollMaxAttempts() { return this.#pollMaxAttempts; }
}

export function parseConfig(jsonString) {
  if (!jsonString || typeof jsonString !== 'string') {
    throw new ConfigError('Config string must be provided');
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    throw new ConfigError(`Failed to parse config JSON: ${e.message}`);
  }
  return new ProxyConfig(parsed);
}

export function loadConfigFromFile(configDir) {
  const configPath = path.join(configDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`config.json missing: ${configPath}. Please run 'ccb --x-init' first.`);
  }
  let raw = fs.readFileSync(configPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`Failed to parse config JSON: ${e.message}`);
  }
  const merged = ensureCompleteConfig(parsed);
  if (JSON.stringify(parsed) !== JSON.stringify(merged)) {
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  }
  return new ProxyConfig(merged);
}

export function resolveUserConfigDir() {
  if (process.env.CCB_CONFIG_DIR) return process.env.CCB_CONFIG_DIR;
  return path.join(os.homedir(), '.claude', '.ccb');
}
