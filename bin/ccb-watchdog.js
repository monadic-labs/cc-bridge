#!/usr/bin/env node

import net from 'net';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { loadConfigFromFile } from '../src/core/config.js';
import { loadEnv } from '../src/proxy-core.js';
import { getControlIpcPath, INIT_TIMEOUT_MS, DRAIN_TIMEOUT_MS } from '../src/core/daemon-constants.js';
import { parseIpcMessage, serializeIpcMessage, validateWorkerMessage, validateCommandMessage } from '../src/core/ipc-protocol.js';

const USER_CONFIG_DIR = process.env.CCB_CONFIG_DIR || path.join(process.env.HOME || process.env.USERPROFILE, '.claude', '.ccb');
const config = loadConfigFromFile(USER_CONFIG_DIR);
const PORT = config.port;

let activeWorker = null;
let activeWorkerPid = null;
let drainingWorker = null;
let startTime = Date.now();
let keepaliveConnections = new Set();
let sharedServer = null;

function log(msg) {
  process.stdout.write(`[watchdog] ${msg}\n`);
}

function spawnWorker(serverSocket) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ccb.js');

    const worker = spawn(process.execPath, [workerPath, '--__cc-proxy-daemon__'], {
      detached: false,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
      env: { ...process.env, CCB_CONFIG_DIR: USER_CONFIG_DIR, CCB_WORKER_MODE: '1' }
    });

    let initTimer = null;
    let resolved = false;

    const cleanup = () => {
      if (initTimer) clearTimeout(initTimer);
    };

    // Pass the server socket handle to the worker
    worker.send({ type: 'socket', port: PORT }, serverSocket);

    initTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      log(`Worker initialization timed out after ${INIT_TIMEOUT_MS}ms, killing`);
      try { worker.kill(); } catch {}
      reject(new Error('worker initialization timed out'));
    }, INIT_TIMEOUT_MS);

    worker.on('message', (msg) => {
      const validated = validateWorkerMessage(msg);
      if (!validated) {
        log(`Invalid message from worker: ${JSON.stringify(msg)}`);
        return;
      }

      if (validated.type === 'ready') {
        if (resolved) return;
        resolved = true;
        cleanup();
        log(`Worker ready (PID ${validated.pid}, ${validated.routes} routes, ${validated.extensions} extensions)`);
        resolve(worker);
      }

      if (validated.type === 'error') {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new Error(validated.message));
      }
    });

    worker.on('exit', (code) => {
      cleanup();
      if (!resolved) {
        resolved = true;
        reject(new Error(`worker exited during init with code ${code}`));
        return;
      }
      log(`Worker (PID ${worker.pid}) exited with code ${code}`);
      if (activeWorker === worker) {
        activeWorker = null;
        activeWorkerPid = null;
        log('Active worker crashed, respawning...');
        if (sharedServer) {
          spawnWorker(sharedServer).then((newWorker) => {
            activeWorker = newWorker;
            activeWorkerPid = newWorker.pid;
          }).catch((e) => {
            log(`Failed to respawn worker: ${e.message}`);
          });
        }
      }
      if (drainingWorker === worker) {
        drainingWorker = null;
      }
    });

    worker.on('error', (err) => {
      cleanup();
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });
}

async function doRestart(serverSocket, respond) {
  if (drainingWorker) {
    respond({ status: 'error', message: 'restart already in progress' });
    return;
  }

  const oldPid = activeWorkerPid;

  try {
    const newWorker = await spawnWorker(serverSocket);
    const oldWorker = activeWorker;

    drainingWorker = oldWorker;
    activeWorker = newWorker;
    activeWorkerPid = newWorker.pid;

    if (oldWorker) {
      oldWorker.send(serializeIpcMessage({ type: 'drain', timeout: DRAIN_TIMEOUT_MS }));
    }

    respond({ status: 'ok', oldPid, newPid: newWorker.pid });
    log(`Restarted worker (PID ${oldPid} → ${newWorker.pid})`);
  } catch (e) {
    respond({ status: 'error', message: e.message });
    log(`Restart failed: ${e.message}`);
  }
}

function handleControlConnection(socket) {
  let buffer = '';

  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseIpcMessage(line);
      if (!parsed) {
        socket.write(serializeIpcMessage({ status: 'error', message: 'invalid JSON' }));
        continue;
      }

      const cmd = validateCommandMessage(parsed);
      if (!cmd) {
        socket.write(serializeIpcMessage({ status: 'error', message: `unknown command: ${JSON.stringify(parsed)}` }));
        continue;
      }

      if (cmd.cmd === 'keepalive') {
        keepaliveConnections.add(socket);
        socket.write(serializeIpcMessage({ status: 'ok', cmd: 'keepalive' }));
        return;
      }

      if (cmd.cmd === 'status') {
        socket.write(serializeIpcMessage({
          status: 'ok',
          workerPid: activeWorkerPid,
          uptimeMs: Date.now() - startTime,
          keepalives: keepaliveConnections.size
        }));
        socket.end();
        return;
      }

      if (cmd.cmd === 'restart') {
        doRestart(sharedServer, (response) => {
          socket.write(serializeIpcMessage(response));
          socket.end();
        });
        return;
      }

      if (cmd.cmd === 'shutdown') {
        socket.write(serializeIpcMessage({ status: 'ok', cmd: 'shutdown' }));
        if (activeWorker) {
          activeWorker.send(serializeIpcMessage({ type: 'drain', timeout: 5000 }));
        }
        socket.end();
        setTimeout(() => process.exit(0), 6000);
        return;
      }
    }
  });

  socket.on('close', () => {
    keepaliveConnections.delete(socket);
    if (keepaliveConnections.size === 0) {
      log('All keepalive connections closed, shutting down');
      if (activeWorker) {
        activeWorker.send(serializeIpcMessage({ type: 'drain', timeout: 3000 }));
      }
      setTimeout(() => process.exit(0), 4000);
    }
  });

  socket.on('error', () => {
    keepaliveConnections.delete(socket);
  });
}

// ── Main ──

Object.assign(process.env, loadEnv(path.join(USER_CONFIG_DIR, '.env')));

const server = http.createServer((req, res) => {
  res.writeHead(503);
  res.end('watchdog: no active worker');
});

server.listen(PORT, () => {
  sharedServer = server;
  log(`Listening on port ${PORT}`);

  spawnWorker(server).then((worker) => {
    activeWorker = worker;
    activeWorkerPid = worker.pid;
    log(`Initial worker started (PID ${worker.pid})`);

    const pidsFile = path.join(USER_CONFIG_DIR, 'logs', 'proxy.pids');
    if (!fs.existsSync(path.dirname(pidsFile))) fs.mkdirSync(path.dirname(pidsFile), { recursive: true });
    fs.writeFileSync(pidsFile, `${process.pid}\n${worker.pid}\n`, 'utf8');
  }).catch((e) => {
    log(`Failed to spawn initial worker: ${e.message}`);
    process.exit(1);
  });
});

const ipcPath = getControlIpcPath();
const controlServer = net.createServer(handleControlConnection);

controlServer.listen(ipcPath, () => {
  log(`Control IPC listening on ${ipcPath}`);
});

controlServer.on('error', (err) => {
  log(`Control IPC error: ${err.message}`);
});

process.on('SIGINT', () => {
  log('SIGINT received, shutting down');
  if (activeWorker) {
    activeWorker.send(serializeIpcMessage({ type: 'drain', timeout: 3000 }));
  }
  setTimeout(() => process.exit(0), 4000);
});
