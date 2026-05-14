import { spawn, execSync, spawnSync } from 'child_process';
import process from 'process';
import path from 'path';
import { WATCHDOG_SCRIPT_NAME } from '../core/constants.js';

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

export async function runKill() {
  const isWin = process.platform === 'win32';
  const currentPid = process.pid;

  async function signalGraceful(pid) {
    try {
      // Signal twice as requested for Claude Code to catch it
      process.kill(pid, 'SIGINT');
      await sleep(200);
      try { process.kill(pid, 'SIGINT'); } catch { }
      return true;
    } catch {
      return false;
    }
  }

  function forceKill(pid) {
    try {
      // eslint-disable-next-line local/no-direct-spawn
      if (isWin) { execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore', windowsHide: true }); return true; }
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  let procs = getProcesses();

  const ccbProcs = procs.filter(p =>
    p.pid !== currentPid &&
    (p.cmd.includes('bin/ccb.js') || p.cmd.includes('bin\\ccb.js') || /\bccb(\.js|\.cmd)?\b/.test(p.cmd))
  );

  const ccbPids = new Set(ccbProcs.map(p => p.pid));

  if (ccbProcs.length > 0) {
    console.log(`Sending graceful shutdown signals to ${ccbProcs.length} CCB session(s)...`);
    for (const p of ccbProcs) {
      await signalGraceful(p.pid);
    }

    console.log('Waiting 5 seconds for sessions to save and exit...');
    await sleep(5000);
  }

  procs = getProcesses();

  const survivingCcb = procs.filter(p => ccbPids.has(p.pid));

  const survivingClaude = procs.filter(p =>
    p.pid !== currentPid &&
    p.cmd.includes('claude') &&
    ccbPids.has(p.ppid)
  );

  let killed = 0;
  for (const p of [...survivingClaude, ...survivingCcb]) {
    if (forceKill(p.pid)) {
      console.log(`Forcefully killed persistent process ${p.pid} (${p.cmd.substring(0, 50)}...)`);
      killed++;
    }
  }

  if (killed === 0 && ccbProcs.length > 0) {
    console.log('All CCB sessions exited gracefully.');
  }

  // Rescan for daemons that might be hanging
  procs = getProcesses();
    const daemonProcs = procs.filter(p =>
    p.pid !== currentPid &&
    (p.cmd.includes(WATCHDOG_SCRIPT_NAME) || p.cmd.includes('src/proxy.js') || p.cmd.includes('src\\proxy.js'))
  );

  killed = 0;
  for (const p of daemonProcs) {
    if (forceKill(p.pid)) {
      console.log(`Killed dangling proxy daemon ${p.pid} (${p.cmd.substring(0, 50)}...)`);
      killed++;
    }
  }

  if (killed === 0 && daemonProcs.length === 0) {
    console.log('No dangling proxy daemons found.');
  }
}
