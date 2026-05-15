// Boot an isolated cc-bridge daemon for the browser-test suite to drive.
//
// Real daemon, real disk, real HTTP — no mocks. Each spec uses the per-test
// helpers in spec-helpers.js to reset providers.json / config.json to a known
// fixture before exercising the GUI.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import http from 'http';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const CONFIG_DIR = path.join(os.tmpdir(), 'ccb-browser-test');
const LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const RUNTIME_PATH = path.join(CONFIG_DIR, 'runtime.json');
const PORT = 9119;

export function fixtureProviders() {
  return {
    providers: {
      zai: {
        url: 'https://api.z.ai/api/anthropic',
        apiKey: 'ENV:ZAI_KEY',
        models: { 'glm-4.7': 'glm-4.7' },
        anthropicCompliant: false,
        toolTransforms: { web_search: { search_engine: 'search-prime' } }
      },
      mirror: {
        url: 'https://mirror.example.com/v1',
        models: {},
        anthropicCompliant: true,
        toolTransforms: {}
      }
    },
    routes: {
      models: { 'fast': 'zai.glm-4.7', '*sonnet*': 'mirror.claude-sonnet-4-6' },
      properties: { thinking: 'mirror.claude-opus-4-6' },
      payloadSize: { '>102400': 'mirror.claude-opus-4-6' }
    },
    extensions: {
      'openai-format': { providers: {} }
    }
  };
}

export function fixtureDaemonConfig() {
  return {
    port: PORT,
    anthropicBaseUrl: 'https://api.anthropic.com',
    daemon: {
      healthCheckTimeoutMs: 500,
      pollIntervalMs: 200,
      pollMaxAttempts: 15,
      upstreamTimeoutMs: 600000,
      workerInitTimeoutMs: 20000,
      drainTimeoutMs: 5000,
      // 0 = drain old worker immediately after the new one is ready, so the
      // browser-test restart assertion (which fetches /status to verify
      // worker_pid changed) doesn't have to race a still-alive old worker
      // sharing the port via SO_REUSEPORT.
      workerKeepaliveS: 0,
      ipcTimeoutMs: 5000,
      daemonStartTimeoutMs: 60000,
      daemonStartProgressGraceMs: 15000,
      retry: {
        maxAttempts: 2,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        retryOnStatusCodes: [502, 503, 504],
        retryOnTcpErrors: ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'],
        retryOnBodyPatterns: []
      }
    },
    logging: {
      enabled: true,
      requests: true,
      responses: true,
      history: 5,
      maxBodyLog: 0,
      level: 'info'
    },
    compression: { recompressRequests: true }
  };
}

export function writeFixtures() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, 'providers.json'), JSON.stringify(fixtureProviders(), null, 2));
  fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(fixtureDaemonConfig(), null, 2));
}

async function checkReady() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${PORT}/__ccb_internal__/status`, () => resolve(true));
    req.on('error', () => resolve(false));
    req.setTimeout(500, () => { req.destroy(); resolve(false); });
  });
}

let daemonChild = null;

export async function startDaemon() {
  // Re-use an already-running daemon if its runtime.json still points at PORT.
  if (await checkReady()) return { port: PORT, configDir: CONFIG_DIR };

  writeFixtures();
  const watchdogPath = path.join(ROOT, 'bin', 'ccb-watchdog.js');
  const out = fs.openSync(path.join(LOGS_DIR, 'daemon.log'), 'a');
  const err = fs.openSync(path.join(LOGS_DIR, 'daemon.err'), 'a');
  daemonChild = spawn(process.execPath, [watchdogPath], {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, CCB_CONFIG_DIR: CONFIG_DIR }
  });
  daemonChild.unref();

  for (let i = 0; i < 60; i++) {
    if (await checkReady()) return { port: PORT, configDir: CONFIG_DIR };
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Daemon did not become ready on port ${PORT}`);
}

export async function stopDaemon() {
  try {
    if (fs.existsSync(RUNTIME_PATH)) {
      const r = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
      if (r.watchdogPid) {
        try { process.kill(r.watchdogPid, 'SIGTERM'); } catch { /* gone already */ }
      }
    }
  } catch { /* best effort */ }
  if (daemonChild) {
    try { daemonChild.kill('SIGTERM'); } catch { /* already exited */ }
  }
}

export { CONFIG_DIR, LOGS_DIR, RUNTIME_PATH, PORT };
