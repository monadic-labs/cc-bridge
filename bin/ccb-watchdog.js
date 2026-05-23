#!/usr/bin/env node

import fs from 'fs';
import net from 'net';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import { CCB_DIR_NAME, CCB_VERSION as DEFAULT_VERSION, RUNTIME_FILENAME } from '../src/core/constants.js';

const CCB_VERSION = process.env.CCB_VERSION || DEFAULT_VERSION;
import { getControlIpcPath } from '../src/core/daemon-constants.js';
import { parseIpcMessage, serializeIpcMessage, validateWorkerMessage, validateCommandMessage } from '../src/core/ipc-protocol.js';
import { loadConfigFromFile } from '../src/core/config.js';
import { CONFIG_FILENAME } from '../src/core/constants.js';
import { ConfigCache } from '../src/core/config-cache.js';
import { WatchdogState } from '../src/core/watchdog-state.js';
import { spawnDaemon } from '../src/infra/process-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, '..', 'src', 'proxy.js');

// All daemon-lifecycle state lives in this single instance — the watchdog's
// state machine. Module scope holds the instance, not the fields. See
// src/core/watchdog-state.js for the cohesion-exception rationale.
// SO_REUSEPORT support is recorded in state.activeReusePort; when false
// (Windows / older kernels), parallel restart can't happen — the new worker
// can't bind the same port while the old one still holds it. Triggers
// sequential restart in triggerRestart().
const state = new WatchdogState();
const KEEPALIVE_GRACE_MS = 5000;
const MAX_CONSECUTIVE_CRASHES = 5;
const CRASH_WINDOW_MS = 10000;

const startTime = Date.now();
const runtimeFilePath = path.join(
  process.env.CCB_CONFIG_DIR || path.join(os.homedir(), '.claude', CCB_DIR_NAME),
  RUNTIME_FILENAME
);

// Keepalive sockets — each is associated with the active worker at connect time
const keepaliveConnections = new Set();
const socketWorkerMap = new Map(); // socket -> worker child process

// Draining workers — old versions kept alive per workerKeepaliveS policy
const drainingWorkers = new Map(); // child -> { keepaliveCount, lastKeepaliveAt, timer }

const _configDir = process.env.CCB_CONFIG_DIR || path.join(os.homedir(), '.claude', CCB_DIR_NAME);

function log(msg) {
  process.stdout.write(`[watchdog] ${msg}\n`);
}

// Eager-loaded snapshot — bad config at watchdog startup is fatal (manifesto
// fail-loud). fs.watch invalidates via tryRefresh on file change; a failed
// refresh keeps the previous good snapshot so a runtime edit can't kill
// the watchdog. Eliminates the 9 redundant FS reads across spawn/restart
// /keepalive/drain handlers.
const _configCache = new ConfigCache(() => loadConfigFromFile(_configDir));
try {
  fs.watch(path.join(_configDir, CONFIG_FILENAME), () => {
    const refresh = _configCache.tryRefresh();
    if (!refresh.isSuccess) {
      log(`config hot-reload failed: ${refresh.error.message}`);
    }
  });
} catch (e) {
  log(`config watcher setup failed: ${e.message}`);
}

function getConfig() {
  return _configCache.get();
}

function writeRuntimeFile(port) {
  const dir = path.dirname(runtimeFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = {
    port,
    watchdogPid: process.pid,
    startedAt: new Date(startTime).toISOString(),
    version: CCB_VERSION
  };
  const tmp = runtimeFilePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, runtimeFilePath);
}

function removeRuntimeFile() {
  if (!fs.existsSync(runtimeFilePath)) return;
  try {
    const recorded = JSON.parse(fs.readFileSync(runtimeFilePath, 'utf8'));
    if (recorded.watchdogPid === process.pid) fs.unlinkSync(runtimeFilePath);
  } catch {
    // Stale or unreadable — leave it; another watchdog may own it now.
  }
}

async function triggerRestart(source) {
  if (!state.beginRestart()) {
    log(`Restart requested via ${source} — ignored (already in progress)`);
    return false;
  }
  log(`Restart requested via ${source}`);

  if (!state.activeReusePort) {
    // Sequential restart: tell old worker to drain + wait for it to exit
    // BEFORE spawning new. Without SO_REUSEPORT the kernel won't let two
    // processes bind the same port simultaneously, so the new worker would
    // fail with EADDRINUSE.
    const oldWorker = state.activeWorker;
    if (oldWorker) {
      const oldPid = oldWorker.pid;
      const config = getConfig();
      log(`Sequential restart: draining old worker (PID ${oldPid}) before spawning new`);
      oldWorker.send({ type: 'drain', timeout: config.drainTimeoutMs });
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          log(`Old worker (PID ${oldPid}) didn't exit in ${config.drainTimeoutMs}ms — killing`);
          try { oldWorker.kill('SIGKILL'); } catch { /* already gone */ }
          resolve();
        }, config.drainTimeoutMs);
        oldWorker.on('exit', () => { clearTimeout(timeout); resolve(); });
      });
      state.unbindWorker();
    }
    const fresh = await spawnWorker();
    state.bindWorker(fresh);
    return true;
  }

  // Parallel restart: old worker keeps serving while the new one comes up.
  // SO_REUSEPORT lets the kernel load-balance accepts between them.
  if (state.activeWorker) {
    const oldWorker = state.activeWorker;
    const oldKeepalives = countKeepalivesFor(oldWorker);
    drainingWorkers.set(oldWorker, {
      keepaliveCount: oldKeepalives,
      lastKeepaliveAt: Date.now(),
      timer: null
    });
    log(`Moved active worker (PID ${oldWorker.pid}) to draining (${oldKeepalives} keepalives)`);
  }
  const fresh = await spawnWorker();
  state.bindWorker(fresh);
  return true;
}

async function spawnWorker() {
  log('Spawning new worker...');
  const config = getConfig();

  // No more handle handoff. Workers self-bind via SO_REUSEPORT. The
  // first worker establishes the actual port; subsequent restart-spawned
  // workers reuse that port through env CCB_DAEMON_PORT so we don't walk
  // the fallback range every time.
  const env = { ...process.env, CCB_DAEMON_WORKER: '1' };
  if (state.activePort) env.CCB_DAEMON_PORT = String(state.activePort);

  const child = spawnDaemon(WORKER_SCRIPT, [], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
    env
  });

  // Resolve when the worker reports ready (first-ready); reject on init
  // timeout or worker-side error. Callers that need to know the bound port
  // (entry path setting up IPC) await this.
  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  child._readyPromise = readyPromise;

  const initTimeout = setTimeout(() => {
    log(`Worker initialization timeout (${config.workerInitTimeoutMs}ms) exceeded, killing hung worker`);
    child.kill('SIGKILL');
    readyReject(new Error(`Worker init timeout (${config.workerInitTimeoutMs}ms)`));
  }, config.workerInitTimeoutMs);

  child.on('message', (msg) => {
    const workerMsg = validateWorkerMessage(msg);
    if (!workerMsg) return;

    if (workerMsg.type === 'ready') {
      clearTimeout(initTimeout);
      state.endRestart();
      child._readyAt = Date.now();
      // First-ready: record the worker's chosen port and write runtime.json.
      if (typeof workerMsg.port === 'number' && (!state.activePort || state.activePort !== workerMsg.port)) {
        const previous = state.recordPort(workerMsg.port);
        writeRuntimeFile(state.activePort);
        if (!previous) {
          const fallbackNote = state.activePort === config.port
            ? ''
            : ` (configured ${config.port} was unavailable)`;
          log(`Active port: ${state.activePort}${fallbackNote}`);
        }
      }
      if (typeof workerMsg.reusePort === 'boolean') {
        const previousReusePort = state.recordReusePort(workerMsg.reusePort);
        if (previousReusePort && !workerMsg.reusePort) {
          log('SO_REUSEPORT unsupported on this OS — restart will be sequential (brief connection-refused window).');
        }
      }
      log(`Worker ready (PID ${workerMsg.pid}, ${workerMsg.routes} routes, ${workerMsg.extensions} extensions)`);
      readyResolve({ child, port: state.activePort });

      // Drain old workers only after new worker is confirmed ready
      if (drainingWorkers.size > 0) {
        const keepaliveS = config.workerKeepaliveS;
        for (const [oldWorker, state] of drainingWorkers) {
          if (keepaliveS === -1) {
            log(`Old worker (PID ${oldWorker.pid}) kept alive indefinitely (workerKeepaliveS=-1)`);
            continue;
          }
          if (keepaliveS === 0 && state.keepaliveCount === 0) {
            log(`Draining old worker (PID ${oldWorker.pid}) — no keepalives, policy=0`);
            oldWorker.send({ type: 'drain', timeout: config.drainTimeoutMs });
            continue;
          }
          if (keepaliveS > 0 && state.keepaliveCount === 0) {
            log(`Old worker (PID ${oldWorker.pid}) — no keepalives, starting ${keepaliveS}s grace period`);
            startDrainGraceTimer(oldWorker, keepaliveS);
            continue;
          }
          log(`Old worker (PID ${oldWorker.pid}) has ${state.keepaliveCount} keepalive(s), waiting for natural close`);
        }
      }
    }

    if (workerMsg.type === 'error') {
      clearTimeout(initTimeout);
      log(`Worker error: ${workerMsg.message}`);
      readyReject(new Error(workerMsg.message));
    }

    if (workerMsg.type === 'restart-request') {
      triggerRestart('worker IPC').catch((e) => {
        log(`Restart-request failed: ${e.message}`);
      });
    }
  });

  child.on('exit', (code, signal) => {
    clearTimeout(initTimeout);
    log(`Worker (PID ${child.pid}) exited with code ${code} and signal ${signal}`);

    if (drainingWorkers.has(child)) {
      const state = drainingWorkers.get(child);
      if (state.timer) clearTimeout(state.timer);
      drainingWorkers.delete(child);
      log(`Draining worker (PID ${child.pid}) removed`);
      return;
    }

    if (state.isActiveWorker(child) && !state.isShuttingDown && !state.isWorkerDraining) {
      const now = Date.now();
      if (code !== 0 || !child._readyAt || (now - child._readyAt) < CRASH_WINDOW_MS) {
        state.incrementCrashCount();
      }
      if (code === 0 && child._readyAt && (now - child._readyAt) >= CRASH_WINDOW_MS) {
        state.resetCrashCount();
      }

      if (state.consecutiveCrashCount >= MAX_CONSECUTIVE_CRASHES) {
        log(`${MAX_CONSECUTIVE_CRASHES} consecutive worker crashes, giving up. Check daemon.err for details.`);
        process.exit(1);
      }

      log(`Active worker died unexpectedly, respawning... (crash ${state.consecutiveCrashCount}/${MAX_CONSECUTIVE_CRASHES})`);
      spawnWorker().then((w) => { state.bindWorker(w); }).catch((e) => {
        log(`Failed to respawn worker: ${e.message}`);
        process.exit(1);
      });
    }
  });

  child._readyAt = null;

  return child;
}

function startDrainGraceTimer(worker, keepaliveS) {
  const state = drainingWorkers.get(worker);
  if (!state) return;

  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    const config = getConfig();
    log(`Grace period (${keepaliveS}s) expired for worker (PID ${worker.pid}), sending drain`);
    worker.send({ type: 'drain', timeout: config.drainTimeoutMs });
    state.timer = null;
  }, keepaliveS * 1000);
}

function countKeepalivesFor(worker) {
  let count = 0;
  for (const w of socketWorkerMap.values()) {
    if (w === worker) count++;
  }
  return count;
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
        if (state.activeWorker) {
          socketWorkerMap.set(socket, state.activeWorker);
        }
        if (state.hasKeepaliveGraceTimer) {
          state.clearKeepaliveGraceTimer();
          log('Keepalive grace cancelled by reconnect');
        }
        if (state.hasShutdownTimer) {
          state.clearShutdownTimer();
          state.cancelShutdown();
          log('Shutdown cancelled by new keepalive');
        }
        socket.write(serializeIpcMessage({ status: 'ok', cmd: 'keepalive' }));
        return;
      }

      if (cmd.cmd === 'status') {
        socket.write(serializeIpcMessage({
          status: 'ok',
          workerPid: state.activeWorker ? state.activeWorker.pid : null,
          uptimeMs: Date.now() - startTime,
          keepalives: keepaliveConnections.size,
          drainingWorkers: drainingWorkers.size
        }));
        return;
      }

      if (cmd.cmd === 'sessions') {
        const workers = [];
        const config = getConfig();
        if (state.activeWorker) {
          workers.push({
            pid: state.activeWorker.pid,
            version: CCB_VERSION,
            uptimeMs: Date.now() - startTime,
            keepalives: countKeepalivesFor(state.activeWorker),
            status: 'active'
          });
        }
        for (const [worker] of drainingWorkers) {
          workers.push({
            pid: worker.pid,
            version: CCB_VERSION,
            uptimeMs: Date.now() - startTime,
            keepalives: countKeepalivesFor(worker),
            status: 'draining',
            policy: config.workerKeepaliveS === -1 ? 'indefinite' : config.workerKeepaliveS === 0 ? 'last-keepalive' : `${config.workerKeepaliveS}s-grace`
          });
        }
        socket.write(serializeIpcMessage({
          cmd: 'sessions',
          workers,
          totalKeepalives: keepaliveConnections.size
        }));
        return;
      }

      if (cmd.cmd === 'restart') {
        triggerRestart('IPC').then((ok) => {
          if (ok) socket.write(serializeIpcMessage({ status: 'ok', cmd: 'restart' }));
        }).catch((e) => {
          socket.write(serializeIpcMessage({ status: 'error', cmd: 'restart', message: e.message }));
        });
        return;
      }

      if (cmd.cmd === 'shutdown') {
        log('Shutdown requested via IPC');
        state.beginShutdown();
        const config = getConfig();
        if (state.activeWorker) {
          state.activeWorker.send({ type: 'drain', timeout: config.drainTimeoutMs });
        }
        for (const [worker] of drainingWorkers) {
          worker.send({ type: 'drain', timeout: config.drainTimeoutMs });
        }
        socket.write(serializeIpcMessage({ status: 'ok', cmd: 'shutdown' }));
        setTimeout(() => process.exit(0), config.drainTimeoutMs + 1000);
        return;
      }
    }
  });

  socket.on('close', () => {
    const assignedWorker = socketWorkerMap.get(socket);
    socketWorkerMap.delete(socket);
    keepaliveConnections.delete(socket);

    // Update draining worker keepalive counts
    if (assignedWorker && drainingWorkers.has(assignedWorker)) {
      const state = drainingWorkers.get(assignedWorker);
      state.keepaliveCount = countKeepalivesFor(assignedWorker);
      state.lastKeepaliveAt = Date.now();

      const config = getConfig();
      const keepaliveS = config.workerKeepaliveS;

      if (state.keepaliveCount === 0 && keepaliveS === 0) {
        log(`Last keepalive closed for draining worker (PID ${assignedWorker.pid}), sending drain`);
        assignedWorker.send({ type: 'drain', timeout: config.drainTimeoutMs });
      }
      if (state.keepaliveCount === 0 && keepaliveS > 0 && !state.timer) {
        log(`Last keepalive closed for draining worker (PID ${assignedWorker.pid}), starting ${keepaliveS}s grace`);
        startDrainGraceTimer(assignedWorker, keepaliveS);
      }
    }

    // Newest worker: shut down when last keepalive closes (with grace period)
    if (state.isActiveWorker(assignedWorker) && keepaliveConnections.size === 0 && !state.isShuttingDown) {
      const activeKeepalives = countKeepalivesFor(state.activeWorker);
      if (activeKeepalives === 0) {
        log(`Last keepalive closed, starting ${KEEPALIVE_GRACE_MS}ms grace before shutdown`);
        state.setKeepaliveGraceTimer(setTimeout(() => {
          state.setKeepaliveGraceTimer(null);
          if (keepaliveConnections.size > 0) {
            log('Grace period ended but new keepalive arrived, cancelling shutdown');
            return;
          }
          state.beginShutdown({ draining: true });
          log('Grace period expired, shutting down');
          const config = getConfig();
          if (state.activeWorker) {
            state.activeWorker.send({ type: 'drain', timeout: config.drainTimeoutMs });
          }
          state.setShutdownTimer(setTimeout(() => {
            state.setShutdownTimer(null);
            process.exit(0);
          }, config.drainTimeoutMs + 1000));
        }, KEEPALIVE_GRACE_MS));
      }
    }
  });

  socket.on('error', () => {
    socketWorkerMap.delete(socket);
    keepaliveConnections.delete(socket);
  });
}

(async () => {
  try {
    const worker = await spawnWorker();
    state.bindWorker(worker);
    await worker._readyPromise; // populates state.activePort
  } catch (err) {
    log(`Failed to start worker: ${err.message}`);
    process.exit(1);
  }

  const ipcPath = getControlIpcPath(state.activePort);
  const controlServer = net.createServer(handleControlConnection);

  controlServer.listen(ipcPath, () => {
    log(`Control IPC listening on ${ipcPath}`);
  });

  controlServer.on('error', (err) => {
    log(`Control IPC error: ${err.message}`);
    process.exit(1);
  });
})();

function gracefulShutdown(signal) {
  state.beginShutdown({ draining: true });
  log(`${signal} received, shutting down`);
  const config = getConfig();
  if (state.activeWorker) {
    state.activeWorker.send({ type: 'drain', timeout: config.drainTimeoutMs });
  }
  for (const [worker] of drainingWorkers) {
    worker.send({ type: 'drain', timeout: config.drainTimeoutMs });
  }
  setTimeout(() => process.exit(0), config.drainTimeoutMs + 1000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('exit', removeRuntimeFile);
