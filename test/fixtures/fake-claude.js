// Deterministic stand-in for the real `claude` CLI, used ONLY by the shutdown
// behaviour test. It models the OAuth server-rotate -> disk-persist window:
//
//   - On startup it acquires a lockfile (the .oauth_refresh.lock analogue).
//   - The SECOND sequential SIGINT (Ctrl-C) begins a graceful shutdown that
//     holds the lock across an UNINTERRUPTIBLE critical section, then writes a
//     clean-exit marker, releases the lock, and exits 0.
//   - A SIGKILL mid-section is un-trappable: no marker is written and the lock
//     is left behind — the exact corruption signature this bug fix prevents.
//
// argv: <lockPath> <markerPath> <readyPath> <criticalMs>
import fs from 'fs';

const [lockPath, markerPath, readyPath, criticalMsRaw] = process.argv.slice(2);
const criticalMs = Number(criticalMsRaw ?? '300');

fs.writeFileSync(lockPath, String(process.pid));

let sigintCount = 0;

function holdCriticalSectionThenExit() {
  const enteredAt = Date.now();
  // Synchronous busy-wait: blocks the event loop so further signals cannot
  // interrupt the persist — exactly like claude finishing its token write.
  while (Date.now() - enteredAt < criticalMs) { /* hold the critical section */ }
  fs.writeFileSync(markerPath, JSON.stringify({ pid: process.pid, enteredAt, exitedAt: Date.now() }));
  fs.rmSync(lockPath, { force: true });
  process.exit(0);
}

process.on('SIGINT', () => {
  sigintCount += 1;
  // First Ctrl-C only arms the quit prompt; the second confirms it. A single
  // SIGINT (the old mis-targeted strategy) must never close this process.
  if (sigintCount < 2) return;
  holdCriticalSectionThenExit();
});

// Ignore SIGTERM so the test proves the Ctrl-C (SIGINT) path specifically.
process.on('SIGTERM', () => { /* deliberately ignored */ });

// Keep the event loop alive until signalled.
setInterval(() => { /* idle */ }, 60_000);

fs.writeFileSync(readyPath, '1');
