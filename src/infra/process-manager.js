import { spawn, execFile, execSync, spawnSync } from 'child_process';
import process from 'process';
import path from 'path';
import { SubprocessTimeoutError, SubprocessOutputError, SubprocessExitError } from '../core/exceptions.js';
import { planShutdown } from './kill-planner.js';
import { executeShutdown } from './kill-executor.js';

/**
 * Spawn a Node.js script as a background/detached process.
 * Never uses a shell — the Node binary is invoked directly so no
 * cmd.exe window ever appears on Windows.
 */
export function spawnDaemon(scriptPath, args, options) {
  // eslint-disable-next-line local/no-direct-spawn
  return spawn(process.execPath, [scriptPath, ...args], { windowsHide: true, ...options });
}

/**
 * Spawn a named command (e.g. "claude") that may require PATH resolution.
 * Uses shell only on Windows for bare command names; absolute paths skip the shell entirely.
 */
export function spawnCommand(cmd, args, options) {
  const isWin = process.platform === 'win32';
  const needsShell = isWin && !path.isAbsolute(cmd);
  // eslint-disable-next-line local/no-direct-spawn
  return spawn(cmd, args, { windowsHide: true, shell: needsShell, ...options });
}

export function runSync(cmd, args, options) {
  // eslint-disable-next-line local/no-direct-spawn
  return spawnSync(cmd, args, { windowsHide: true, ...options });
}

/**
 * Execute a command and return buffered stdout via callback-style execFile.
 * Returns a Promise that resolves with stdout string.
 * Used by extensions that need subprocess output (e.g. SSH commands).
 */
export function execCommand(cmd, args, options) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line local/no-direct-spawn
    execFile(cmd, args, { windowsHide: true, ...options }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout ?? '');
    });
  });
}

/**
 * Spawn a command, write `input` to its stdin, and return buffered stdout.
 *
 * Designed for CLI tools that read their prompt from stdin (e.g. `agy -p`).
 * Avoids shell argument expansion entirely — the input is delivered over the
 * pipe, so there is no per-argument size limit (MAX_ARG_STRLEN) and no shell
 * quoting or injection surface.
 *
 * @param {string}   cmd     - Absolute path or PATH-resolvable command name.
 * @param {string[]} args    - Arguments (no shell — each element is one argv).
 * @param {string}   input   - Text to write to stdin (UTF-8).
 * @param {object}   [options]
 * @param {number}   [options.timeout]   - Hard-kill timeout in ms (default: none).
 * @param {number}   [options.maxBuffer] - Max stdout bytes (default: 10 MB).
 * @returns {Promise<string>} Resolves with stdout string on exit 0.
 * @throws On non-zero exit, spawn error, or timeout.
 */
export function spawnWithStdin(cmd, args, input, options = {}) {
  const { timeout, maxBuffer = 10 * 1024 * 1024 } = options;

  return new Promise((resolve, reject) => {
    // eslint-disable-next-line local/no-direct-spawn
    const child = spawn(cmd, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let timedOut = false;
    let settled = false;

    function settle(err, value) {
      if (settled) return;
      settled = true;
      if (err) return reject(err);
      resolve(value);
    }

    let killTimer = null;
    if (timeout != null) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* process may have already exited */ }
      }, timeout);
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
        settle(Object.assign(new SubprocessOutputError(`stdout exceeded maxBuffer (${maxBuffer} bytes)`, { maxBytes: maxBuffer }), { killed: true }));
        return;
      }
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (killTimer != null) clearTimeout(killTimer);
      settle(err);
    });

    child.on('close', (code) => {
      if (killTimer != null) clearTimeout(killTimer);
      if (timedOut) {
        settle(Object.assign(new SubprocessTimeoutError(`Process killed after ${timeout}ms timeout`, { timeoutMs: timeout }), { killed: true }));
        return;
      }
      if (code !== 0) {
        const errMsg = stderr.trim() || `exited with code ${code}`;
        settle(Object.assign(new SubprocessExitError(errMsg, { exitCode: code }), { killed: false }));
        return;
      }
      settle(null, stdout);
    });

    try {
      child.stdin.write(input, 'utf8');
      child.stdin.end();
    } catch (err) {
      settle(err);
    }
  });
}

export function getProcesses() {
  const isWin = process.platform === 'win32';
  try {
    if (isWin) {
      // eslint-disable-next-line local/no-direct-spawn
      const out = execSync('wmic process get processid,parentprocessid,commandline /format:csv', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const lines = out.split('\n').map(l => l.trim()).filter(l => l && !l.includes('ProcessId'));
      return lines.map(line => {
        const parts = line.split(',');
        if (parts.length < 4) return null;
        return {
          pid: parseInt(parts[parts.length - 1], 10),
          ppid: parseInt(parts[parts.length - 2], 10),
          cmd: parts.slice(1, parts.length - 2).join(',')
        };
      }).filter(Boolean);
    }
    // eslint-disable-next-line local/no-direct-spawn
    const out = execSync('ps -A -o pid,ppid,command', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const lines = out.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('PID'));
    return lines.map(line => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: parseInt(match[1], 10),
        ppid: parseInt(match[2], 10),
        cmd: match[3]
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * POSIX single-pid signaller. Returns a (pid) => void that sends `signalName`,
 * swallowing the "process already gone" race.
 */
function posixSignaller(signalName) {
  return (pid) => {
    try { process.kill(pid, signalName); } catch { /* already exited */ }
  };
}

/**
 * Windows tree-kill via taskkill /T. `force` adds /F (un-graceful); without it
 * taskkill requests a graceful close. Both walk the whole process tree.
 */
function windowsTaskkill(force) {
  const forceFlag = force ? '/F ' : '';
  return (pid) => {
    try {
      // eslint-disable-next-line local/no-direct-spawn
      execSync(`taskkill ${forceFlag}/PID ${pid} /T`, { stdio: 'ignore', windowsHide: true });
    } catch { /* process may have already exited */ }
  };
}

/**
 * Build the real, effectful shutdown environment for executeShutdown().
 * The single seam where process signalling, process listing, the clock, and
 * the delay primitive enter — everything below the planner/executor is injected.
 */
function buildShutdownEnv() {
  const isWin = process.platform === 'win32';
  return {
    listPids: () => getProcesses().map(proc => proc.pid),
    signalGraceful: isWin ? windowsTaskkill(false) : posixSignaller('SIGINT'),
    signalForce: isWin ? windowsTaskkill(true) : posixSignaller('SIGKILL'),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

function formatOutcome(outcome) {
  if (outcome.exitedGracefully) return `${outcome.unit}: exited gracefully.`;
  if (outcome.forced.length > 0) return `${outcome.unit}: force-killed after grace (${outcome.forced.join(', ')}).`;
  return `${outcome.unit}: still alive after grace (force disabled).`;
}

/**
 * Gracefully shut down every ccb session and dangling proxy daemon.
 *
 * Composition root: snapshot the machine, plan the shutdown (pure), then run it
 * serially with real injected deps. Each ccb+claude unit is closed with two
 * sequential Ctrl-C and a poll-for-exit before any force — so a `claude` that
 * may be mid-OAuth-refresh is never SIGKILLed out from under its disk-persist.
 */
export async function runKill() {
  const snapshot = getProcesses();
  const plan = planShutdown(snapshot, process.pid);
  if (plan.isEmpty()) {
    console.log('No CCB sessions or proxy daemons found.');
    return;
  }
  console.log(`Gracefully shutting down ${plan.size()} unit(s) one at a time...`);
  const outcomes = await executeShutdown(plan, buildShutdownEnv());
  for (const outcome of outcomes) console.log(formatOutcome(outcome));
}
