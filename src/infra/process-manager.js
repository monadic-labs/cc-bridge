import { execSync } from 'child_process';
import process from 'process';

function getProcesses() {
  const isWin = process.platform === 'win32';
  try {
    if (isWin) {
      const out = execSync('wmic process get processid,parentprocessid,commandline /format:csv', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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
    } else {
      const out = execSync('ps -A -o pid,ppid,command', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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
    }
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
      try { process.kill(pid, 'SIGINT'); } catch {}
      return true;
    } catch {
      return false;
    }
  }

  function forceKill(pid) {
    try {
      if (isWin) execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
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
    (p.cmd.includes('--__cc-proxy-daemon__') || p.cmd.includes('src/proxy.js') || p.cmd.includes('src\\proxy.js'))
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
