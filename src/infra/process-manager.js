import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export function runKill({ logsDir, target, port }) {
  const pidsFile = path.join(logsDir, 'proxy.pids');
  const isWin = process.platform === 'win32';

  function tryKill(pid) {
    if (isWin) return tryKillWindows(pid);
    return tryKillUnix(pid);
  }

  function tryKillWindows(pid) {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'pipe' });
      console.log(`Successfully killed proxy process: ${pid}`);
      return true;
    } catch (err) {
      if (err.stderr?.toString().includes('not found')) {
        console.log(`Process ${pid} is no longer running.`);
        return false;
      }
      console.log(`Failed to kill process ${pid}: ${err.message}`);
      return false;
    }
  }

  function tryKillUnix(pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Successfully killed proxy process: ${pid}`);
      return true;
    } catch (err) {
      if (err.code === 'ESRCH') {
        console.log(`Process ${pid} is no longer running.`);
        return false;
      }
      console.log(`Failed to kill process ${pid}: ${err.message}`);
      return false;
    }
  }

  function findPidsByPort() {
    try {
      const out = execSync(isWin ? 'netstat -ano' : `lsof -i :${port} -t`, { encoding: 'utf8' });
      if (isWin) return parseWindowsNetstat(out, port);
      return out.split('\n').filter(Boolean).map((p) => parseInt(p, 10));
    } catch {
      return [];
    }
  }

  let pids = readPidsFile(pidsFile);

  if (!pids.length) {
    const byPort = findPidsByPort();
    if (byPort.length) {
      console.log(`No PID file, but found proxy on port ${port}: PID(s) ${byPort.join(', ')}`);
      pids = byPort;
    } else {
      console.log(`No proxy processes are currently tracked or listening on port ${port}.`);
      return;
    }
  }

  let remainingPids = [...pids];
  if (!target) {
    for (const pid of pids) {
      if (tryKill(pid)) remainingPids = remainingPids.filter((p) => p !== pid);
    }
    console.log('All tracked proxies have been killed.');
  } else {
    const targetPid = Number(target);
    if (!pids.includes(targetPid)) {
      console.log(`PID ${targetPid} is not in the list of tracked proxies.`);
    } else {
      if (tryKill(targetPid)) remainingPids = remainingPids.filter((p) => p !== targetPid);
    }
  }

  writePidsFile(pidsFile, remainingPids);
}

function readPidsFile(pidsFile) {
  if (!fs.existsSync(pidsFile)) return [];
  try {
    return fs.readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number);
  } catch {
    console.log('Could not read pids file.');
    return [];
  }
}

function parseWindowsNetstat(output, targetPort) {
  const pids = new Set();
  const portStr = `:${targetPort}`;
  for (const line of output.split('\n')) {
    if (line.includes(portStr) && line.includes('LISTENING')) {
      const pid = parseInt(line.trim().split(/\s+/).pop(), 10);
      if (pid > 0) pids.add(pid);
    }
  }
  return [...pids];
}

function writePidsFile(pidsFile, remainingPids) {
  if (remainingPids.length > 0) {
    if (!fs.existsSync(path.dirname(pidsFile))) fs.mkdirSync(path.dirname(pidsFile), { recursive: true });
    fs.writeFileSync(pidsFile, remainingPids.join('\n') + '\n', 'utf8');
    return;
  }
  if (fs.existsSync(pidsFile)) fs.unlinkSync(pidsFile);
}
