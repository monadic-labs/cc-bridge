import fs from 'fs';
import path from 'path';
import os from 'os';
import { CONFIG_FILENAME, CCB_DIR_NAME } from './constants.js';
import { ConfigError } from './exceptions.js';
import { ensureCompleteConfig } from './migrator.js';

export class RetryConfig {
  #maxAttempts;
  #baseDelayMs;
  #maxDelayMs;
  #retryOnStatusCodes;
  #retryOnTcpErrors;
  #retryOnBodyPatterns;

  constructor(raw) {
    this.#maxAttempts = raw.maxAttempts ?? 0;
    this.#baseDelayMs = raw.baseDelayMs ?? 500;
    this.#maxDelayMs = raw.maxDelayMs ?? 5000;
    this.#retryOnStatusCodes = Object.freeze([...(raw.retryOnStatusCodes ?? [])]);
    this.#retryOnTcpErrors = Object.freeze([...(raw.retryOnTcpErrors ?? [])]);
    this.#retryOnBodyPatterns = Object.freeze([...(raw.retryOnBodyPatterns ?? [])]);
    Object.freeze(this);
  }

  get maxAttempts() { return this.#maxAttempts; }
  get baseDelayMs() { return this.#baseDelayMs; }
  get maxDelayMs() { return this.#maxDelayMs; }
  get retryOnStatusCodes() { return this.#retryOnStatusCodes; }
  get retryOnTcpErrors() { return this.#retryOnTcpErrors; }
  get retryOnBodyPatterns() { return this.#retryOnBodyPatterns; }
}

export class ProxyConfig {
  #loggingEnabled;
  #logRequests;
  #logResponses;
  #historySize;
  #maxBodyLog;
  #port;
  #anthropicBaseUrl;
  #healthCheckTimeout;
  #pollInterval;
  #pollMaxAttempts;
  #upstreamTimeoutMs;
  #recompressRequests;
  #loggingLevel;
  #retry;
  #workerInitTimeoutMs;
  #drainTimeoutMs;
  #workerKeepaliveS;
  #ipcTimeoutMs;

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

    const level = logging.level || 'info';
    if (!['info', 'debug', 'trace'].includes(level)) {
      throw new ConfigError('logging.level must be "info", "debug", or "trace"');
    }

    const port = raw.port;
    if (port === undefined || port === null) throw new ConfigError('port must be explicitly defined in the config');
    if (typeof port !== 'number' || port < 1 || port > 65535) throw new ConfigError('port must be a valid number between 1 and 65535');

    const anthropicBaseUrl = raw.anthropicBaseUrl;
    if (typeof anthropicBaseUrl !== 'string' || !anthropicBaseUrl.match(/^https?:\/\//)) {
      throw new ConfigError('anthropicBaseUrl must be an http:// or https:// URL string');
    }

    const daemon = raw.daemon;
    if (!daemon || typeof daemon !== 'object') throw new ConfigError('Config must explicitly define a "daemon" object');

    if (typeof daemon.healthCheckTimeoutMs !== 'number') throw new ConfigError('daemon.healthCheckTimeoutMs must be an explicit number');
    if (typeof daemon.pollIntervalMs !== 'number') throw new ConfigError('daemon.pollIntervalMs must be an explicit number');
    if (typeof daemon.pollMaxAttempts !== 'number') throw new ConfigError('daemon.pollMaxAttempts must be an explicit number');
    if (typeof daemon.upstreamTimeoutMs !== 'number' || daemon.upstreamTimeoutMs < 0) throw new ConfigError('daemon.upstreamTimeoutMs must be a non-negative number');
    if (typeof daemon.workerInitTimeoutMs !== 'number' || daemon.workerInitTimeoutMs < 1000) throw new ConfigError('daemon.workerInitTimeoutMs must be a number >= 1000ms');
    if (typeof daemon.drainTimeoutMs !== 'number' || daemon.drainTimeoutMs < 1000) throw new ConfigError('daemon.drainTimeoutMs must be a number >= 1000ms');
    if (typeof daemon.workerKeepaliveS !== 'number' || daemon.workerKeepaliveS < -1) throw new ConfigError('daemon.workerKeepaliveS must be >= -1 (-1=indefinite, 0=exit on last keepalive, >0=grace period in seconds)');
    if (typeof daemon.ipcTimeoutMs !== 'number' || daemon.ipcTimeoutMs < 100) throw new ConfigError('daemon.ipcTimeoutMs must be a number >= 100ms');

    const compression = raw.compression || {};
    if (typeof compression.recompressRequests !== 'boolean') throw new ConfigError('compression.recompressRequests must be explicitly true or false');

    this.#anthropicBaseUrl = anthropicBaseUrl;
    this.#healthCheckTimeout = daemon.healthCheckTimeoutMs;
    this.#pollInterval = daemon.pollIntervalMs;
    this.#pollMaxAttempts = daemon.pollMaxAttempts;
    this.#upstreamTimeoutMs = daemon.upstreamTimeoutMs;
    this.#workerInitTimeoutMs = daemon.workerInitTimeoutMs;
    this.#drainTimeoutMs = daemon.drainTimeoutMs;
    this.#workerKeepaliveS = daemon.workerKeepaliveS;
    this.#ipcTimeoutMs = daemon.ipcTimeoutMs;

    this.#loggingEnabled = logging.enabled;
    this.#logRequests = logging.requests;
    this.#logResponses = logging.responses;
    this.#historySize = logging.history;
    this.#maxBodyLog = logging.maxBodyLog;
    this.#port = port;
    this.#recompressRequests = compression.recompressRequests;
    this.#loggingLevel = level;
    this.#retry = new RetryConfig(daemon.retry ?? {});
    Object.freeze(this);
  }

  get loggingEnabled() { return this.#loggingEnabled; }
  get logRequests() { return this.#logRequests; }
  get logResponses() { return this.#logResponses; }
  get historySize() { return this.#historySize; }
  get maxBodyLog() { return this.#maxBodyLog; }
  get loggingLevel() { return this.#loggingLevel; }
  get port() { return this.#port; }
  get anthropicBaseUrl() { return this.#anthropicBaseUrl; }
  get healthCheckTimeoutMs() { return this.#healthCheckTimeout; }
  get pollIntervalMs() { return this.#pollInterval; }
  get pollMaxAttempts() { return this.#pollMaxAttempts; }
  get upstreamTimeoutMs() { return this.#upstreamTimeoutMs; }
  get recompressRequests() { return this.#recompressRequests; }
  get retry() { return this.#retry; }
  get workerInitTimeoutMs() { return this.#workerInitTimeoutMs; }
  get drainTimeoutMs() { return this.#drainTimeoutMs; }
  get workerKeepaliveS() { return this.#workerKeepaliveS; }
  get ipcTimeoutMs() { return this.#ipcTimeoutMs; }
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
  const configPath = path.join(configDir, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`${CONFIG_FILENAME} missing: ${configPath}. Please run 'ccb --x-init' first.`);
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
  return path.join(os.homedir(), '.claude', CCB_DIR_NAME);
}
