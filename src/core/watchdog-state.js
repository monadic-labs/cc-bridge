/**
 * WatchdogState — the daemon supervisor's state machine.
 *
 * Manifesto carve-out: this class holds nine fields where the default
 * ceiling is two. Cohesion exception applies — every field describes the
 * watchdog's single conceptual unit: the running daemon's lifecycle state.
 * Decomposing into per-phase classes (binding / shutdown / restart) would
 * require cross-class invariants the supervisor logic already enforces
 * inline (e.g. "you cannot enter shutdown while a restart is in progress"),
 * so the split would create more coupling than it removes.
 *
 * The class encapsulates module-level mutability into one private cell.
 * State mutations happen through named transition methods. A small number
 * of accessors are exposed where the caller legitimately needs the live
 * handle (e.g. ChildProcess#send) — these are documented inline.
 */
export class WatchdogState {
  #activeWorker = null;
  #activePort = null;
  #activeReusePort = true;
  #shuttingDown = false;
  #workerDraining = false;
  #shutdownTimer = null;
  #keepaliveGraceTimer = null;
  #restartInProgress = false;
  #consecutiveCrashCount = 0;

  // ── Restart phase ──

  beginRestart() {
    if (this.#restartInProgress) return false;
    this.#restartInProgress = true;
    return true;
  }

  endRestart() {
    this.#restartInProgress = false;
    this.#consecutiveCrashCount = 0;
  }

  incrementCrashCount() {
    this.#consecutiveCrashCount++;
    return this.#consecutiveCrashCount;
  }

  resetCrashCount() { this.#consecutiveCrashCount = 0; }
  get consecutiveCrashCount() { return this.#consecutiveCrashCount; }
  get isRestartInProgress() { return this.#restartInProgress; }

  // ── Worker binding ──
  // activeWorker getter exposes the ChildProcess handle so the supervisor
  // can call .send / .kill / read .pid on it. The handle is owned by the
  // class; callers must not stash a long-lived reference.

  bindWorker(child) { this.#activeWorker = child; }
  unbindWorker() { this.#activeWorker = null; }
  get activeWorker() { return this.#activeWorker; }
  isActiveWorker(child) { return child === this.#activeWorker; }

  recordPort(port) {
    const previous = this.#activePort;
    this.#activePort = port;
    return previous;
  }
  get activePort() { return this.#activePort; }

  recordReusePort(value) {
    const previous = this.#activeReusePort;
    this.#activeReusePort = value;
    return previous;
  }
  get activeReusePort() { return this.#activeReusePort; }

  // ── Shutdown phase ──

  beginShutdown({ draining = false } = {}) {
    this.#shuttingDown = true;
    this.#workerDraining = draining;
  }

  cancelShutdown() {
    this.#shuttingDown = false;
    this.#workerDraining = false;
  }

  get isShuttingDown() { return this.#shuttingDown; }
  get isWorkerDraining() { return this.#workerDraining; }

  setShutdownTimer(timer) { this.#shutdownTimer = timer; }
  clearShutdownTimer() {
    if (this.#shutdownTimer) clearTimeout(this.#shutdownTimer);
    this.#shutdownTimer = null;
  }
  get hasShutdownTimer() { return this.#shutdownTimer !== null; }

  // ── Keepalive grace ──

  setKeepaliveGraceTimer(timer) { this.#keepaliveGraceTimer = timer; }
  clearKeepaliveGraceTimer() {
    if (this.#keepaliveGraceTimer) clearTimeout(this.#keepaliveGraceTimer);
    this.#keepaliveGraceTimer = null;
  }
  get hasKeepaliveGraceTimer() { return this.#keepaliveGraceTimer !== null; }
}
