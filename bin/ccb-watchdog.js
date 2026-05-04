#!/usr/bin/env node

import net from 'net';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import { CCB_DIR_NAME } from '../src/core/constants.js';
import { getControlIpcPath } from '../src/core/daemon-constants.js';
import { parseIpcMessage, serializeIpcMessage, validateWorkerMessage, validateCommandMessage } from '../src/core/ipc-protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, '..', 'src', 'proxy.js');

let activeWorker = null;
let drainingWorker = null;
let startTime = Date.now();
let keepaliveConnections = new Set();
let _sharedServer = null;
let shuttingDown = false;
let shutdownTimer = null;

function log(msg) {
  process.stdout.write(`[watchdog] ${msg}\n`);
}

function spawnWorker() {
  log('Spawning new worker...');
  // eslint-disable-next-line local/no-direct-spawn
  const child = spawn(process.execPath, [WORKER_SCRIPT], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
    env: { ...process.env, CCB_DAEMON_WORKER: '1' }
  });

  child.on('message', (msg) => {
    const workerMsg = validateWorkerMessage(msg);
    if (!workerMsg) return;

    if (workerMsg.type === 'ready') {
      log(`Worker ready (PID ${workerMsg.pid}, ${workerMsg.routes} routes, ${workerMsg.extensions} extensions)`);
      if (drainingWorker) {
        log(`Killing old draining worker (PID ${drainingWorker.pid})`);
        drainingWorker.kill('SIGTERM');
        drainingWorker = null;
      }
    }

    if (workerMsg.type === 'error') {
      log(`Worker error: ${workerMsg.message}`);
    }
  });

  child.on('exit', (code, signal) => {
    log(`Worker (PID ${child.pid}) exited with code ${code} and signal ${signal}`);
    if (child === activeWorker && !shuttingDown) {
      log('Active worker died unexpectedly, respawning...');
      activeWorker = spawnWorker();
    }
  });

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
        log('Restart requested via IPC');
        if (activeWorker) {
          drainingWorker = activeWorker;
          drainingWorker.send({ type: 'drain', timeout: 5000 });
        }
        activeWorker = spawnWorker();
        socket.write(serializeIpcMessage({ status: 'ok', cmd: 'restart' }));
        return;
      }

      if (cmd.cmd === 'shutdown') {
        log('Shutdown requested via IPC');
        shuttingDown = true;
        if (activeWorker) {
          activeWorker.send({ type: 'drain', timeout: 3000 });
        }
        socket.write(serializeIpcMessage({ status: 'ok', cmd: 'shutdown' }));
        setTimeout(() => process.exit(0), 4000);
        return;
      }
    }
  });

  socket.on('close', () => {
    keepaliveConnections.delete(socket);
    if (keepaliveConnections.size === 0 && !shuttingDown) {
      shuttingDown = true;
      log('All keepalive connections closed, shutting down');
      if (activeWorker) {
        activeWorker.send({ type: 'drain', timeout: 3000 });
      }
      shutdownTimer = setTimeout(() => {
        shutdownTimer = null;
        process.exit(0);
      }, 4000);
    }
  });

  socket.on('error', () => {
    keepaliveConnections.delete(socket);
  });
}

const _configDir = process.env.CCB_CONFIG_DIR || path.join(os.homedir(), '.claude', CCB_DIR_NAME);

activeWorker = spawnWorker();

const ipcPath = getControlIpcPath();
const controlServer = net.createServer(handleControlConnection);

controlServer.listen(ipcPath, () => {
  log(`Control IPC listening on ${ipcPath}`);
});

controlServer.on('error', (err) => {
  log(`Control IPC error: ${err.message}`);
});

process.on('SIGINT', () => {
  shuttingDown = true;
  log('SIGINT received, shutting down');
  if (activeWorker) {
    activeWorker.send({ type: 'drain', timeout: 3000 });
  }
  setTimeout(() => process.exit(0), 4000);
});
