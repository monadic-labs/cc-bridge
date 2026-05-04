#!/usr/bin/env node

import net from 'net';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import { CCB_DIR_NAME } from '../src/core/constants.js';
import { getControlIpcPath } from '../src/core/daemon-constants.js';
import { parseIpcMessage, serializeIpcMessage, validateWorkerMessage, validateCommandMessage } from '../src/core/ipc-protocol.js';
import { loadConfigFromFile } from '../src/core/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, '..', 'src', 'proxy.js');

let activeWorker = null;
let drainingWorker = null;
let startTime = Date.now();
let keepaliveConnections = new Set();
let sharedServer = null;
let shuttingDown = false;
let shutdownTimer = null;
let restartInProgress = false;

const _configDir = process.env.CCB_CONFIG_DIR || path.join(os.homedir(), '.claude', CCB_DIR_NAME);

function log(msg) {
  process.stdout.write(`[watchdog] ${msg}\n`);
}

function spawnWorker() {
  log('Spawning new worker...');
  const config = loadConfigFromFile(_configDir);

  // Create shared server if not exists (watchdog owns the listening socket)
  if (!sharedServer) {
    sharedServer = http.createServer();
    sharedServer.listen(config.port, () => {
      log(`Watchdog listening on port ${config.port}`);
    });
    sharedServer.on('error', (err) => {
      log(`Shared server error: ${err.message}`);
      process.exit(1);
    });
  }

  const child = spawn(process.execPath, [WORKER_SCRIPT], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
    env: { ...process.env, CCB_DAEMON_WORKER: '1' }
  });

  // Init timeout
  const initTimeout = setTimeout(() => {
    log(`Worker initialization timeout (${config.workerInitTimeoutMs}ms) exceeded, killing hung worker`);
    child.kill('SIGKILL');
  }, config.workerInitTimeoutMs);

  child.on('message', (msg) => {
    const workerMsg = validateWorkerMessage(msg);
    if (!workerMsg) return;

    if (workerMsg.type === 'ready') {
      clearTimeout(initTimeout);
      restartInProgress = false;
      log(`Worker ready (PID ${workerMsg.pid}, ${workerMsg.routes} routes, ${workerMsg.extensions} extensions)`);

      if (drainingWorker) {
        log(`Sending drain signal to old worker (PID ${drainingWorker.pid})`);
        drainingWorker.send({ type: 'drain', timeout: config.drainTimeoutMs });
      }
    }

    if (workerMsg.type === 'error') {
      clearTimeout(initTimeout);
      log(`Worker error: ${workerMsg.message}`);
    }
  });

  child.on('exit', (code, signal) => {
    clearTimeout(initTimeout);
    log(`Worker (PID ${child.pid}) exited with code ${code} and signal ${signal}`);

    if (child === drainingWorker) {
      log('Draining worker exited');
      drainingWorker = null;
      return;
    }

    if (child === activeWorker && !shuttingDown) {
      log('Active worker died unexpectedly, respawning...');
      activeWorker = spawnWorker();
    }
  });

  // Pass the listening socket handle to the worker
  const handle = sharedServer._handle;
  child.send({ type: 'socket', port: config.port }, handle);

  return child;
}

function handleControlConnection(socket) {
  socket.on('data', (data) => {
    const messages = data.toString().split('\n');
    for (const line of messages) {
      if (!line.trim()) continue;
      const cmd = validateCommandMessage(parseIpcMessage(line));
      if (!cmd) {
        log(`Received invalid IPC command: ${line}`);
        continue;
      }

      if (cmd.cmd === 'keepalive') {
        keepaliveConnections.add(socket);
        if (shutdownTimer) {
          clearTimeout(shutdownTimer);
          shutdownTimer = null;
          shuttingDown = false;
          log('Shutdown cancelled by new keepalive');
        }
        socket.write(serializeIpcMessage({ status: 'ok', cmd: 'keepalive' }));
        return;
      }

      if (cmd.cmd === 'status') {
        socket.write(serializeIpcMessage({
          status: 'ok',
          workerPid: activeWorker ? activeWorker.pid : null,
          uptimeMs: Date.now() - startTime,
          keepalives: keepaliveConnections.size
        }));
        return;
      }

      if (cmd.cmd === 'restart') {
        if (restartInProgress) {
          socket.write(serializeIpcMessage({ status: 'error', message: 'restart already in progress' }));
          return;
        }
        restartInProgress = true;
        log('Restart requested via IPC');

        if (activeWorker) {
          drainingWorker = activeWorker;
        }
        activeWorker = spawnWorker();
        socket.write(serializeIpcMessage({ status: 'ok', cmd: 'restart' }));
        return;
      }

      if (cmd.cmd === 'shutdown') {
        log('Shutdown requested via IPC');
        shuttingDown = true;
        const config = loadConfigFromFile(_configDir);
        if (activeWorker) {
          activeWorker.send({ type: 'drain', timeout: config.drainTimeoutMs });
        }
        socket.write(serializeIpcMessage({ status: 'ok', cmd: 'shutdown' }));
        setTimeout(() => process.exit(0), config.drainTimeoutMs + 1000);
        return;
      }
    }
  });

  socket.on('close', () => {
    keepaliveConnections.delete(socket);
    if (keepaliveConnections.size === 0 && !shuttingDown) {
      shuttingDown = true;
      log('All keepalive connections closed, shutting down');
      const config = loadConfigFromFile(_configDir);
      if (activeWorker) {
        activeWorker.send({ type: 'drain', timeout: config.drainTimeoutMs });
      }
      shutdownTimer = setTimeout(() => {
        shutdownTimer = null;
        process.exit(0);
      }, config.drainTimeoutMs + 1000);
    }
  });

  socket.on('error', () => {
    keepaliveConnections.delete(socket);
  });
}

activeWorker = spawnWorker();

const ipcPath = getControlIpcPath();
const controlServer = net.createServer(handleControlConnection);

controlServer.listen(ipcPath, () => {
  log(`Control IPC listening on ${ipcPath}`);
});

controlServer.on('error', (err) => {
  log(`Control IPC error: ${err.message}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  shuttingDown = true;
  log('SIGINT received, shutting down');
  const config = loadConfigFromFile(_configDir);
  if (activeWorker) {
    activeWorker.send({ type: 'drain', timeout: config.drainTimeoutMs });
  }
  setTimeout(() => process.exit(0), config.drainTimeoutMs + 1000);
});
