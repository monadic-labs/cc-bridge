import { WATCHDOG_SCRIPT_NAME } from '../core/constants.js';

/**
 * Pure shutdown planner (functional core).
 *
 * Given a process snapshot (the bag of { pid, ppid, cmd } rows that
 * getProcesses() returns) this module decides WHAT to shut down and in WHAT
 * ORDER. It performs no I/O and signals nothing — the imperative executor
 * does that with injected deps. Keeping the planning pure makes the kill
 * strategy unit-testable without touching the real machine.
 *
 * Ordering contract:
 *   - Each ccb launcher is grouped with its own claude children into one
 *     ShutdownUnit. The claude children are listed BEFORE the launcher so the
 *     graceful Ctrl-C reaches the interactive `claude` first, the way a human
 *     closing the session would.
 *   - Units are returned in a fixed order (sessions, then proxy daemons) so the
 *     executor can walk them one at a time and never shut two claudes down at
 *     once.
 */

// ── Process-matching predicates — the cmd-classification knowledge lives here,
// one home each, mirroring the original runKill() filters verbatim. ──

export function isCcbLauncher(cmd) {
  return cmd.includes('bin/ccb.js')
    || cmd.includes('bin\\ccb.js')
    || /\bccb(\.js|\.cmd)?\b/.test(cmd);
}

export function isClaude(cmd) {
  return cmd.includes('claude');
}

export function isProxyDaemon(cmd) {
  return cmd.includes(WATCHDOG_SCRIPT_NAME)
    || cmd.includes('src/proxy.js')
    || cmd.includes('src\\proxy.js');
}

/**
 * One ccb+claude (or one daemon) shutdown unit. Holds an ordered list of pids
 * to signal and a human label — two cohesive fields describing a single unit
 * of shutdown work. Immutable.
 */
export class ShutdownUnit {
  #label;
  #orderedPids;

  constructor(label, orderedPids) {
    this.#label = label;
    this.#orderedPids = Object.freeze([...orderedPids]);
  }

  describe() { return this.#label; }

  // Tell-Don't-Ask: hand each pid (claude children first, launcher last) to the
  // caller's send function rather than exposing the raw collection.
  signalEach(send) {
    for (const pid of this.#orderedPids) send(pid);
  }

  // Query: which of this unit's pids are still present in the given live set.
  survivingPids(presentPids) {
    return this.#orderedPids.filter(pid => presentPids.has(pid));
  }
}

/**
 * First-class collection of ShutdownUnits in execution order. Immutable.
 */
export class ShutdownPlan {
  #units;

  constructor(units) {
    this.#units = Object.freeze([...units]);
  }

  units() { return this.#units; }
  size() { return this.#units.length; }
  isEmpty() { return this.#units.length === 0; }
}

/**
 * Build the ordered shutdown plan from a process snapshot.
 *
 * @param {Array<{pid:number, ppid:number, cmd:string}>} snapshot
 * @param {number} currentPid - excluded so runKill never targets itself.
 * @returns {ShutdownPlan}
 */
export function planShutdown(snapshot, currentPid) {
  const others = snapshot.filter(proc => proc.pid !== currentPid);

  const ccbProcs = others.filter(proc => isCcbLauncher(proc.cmd));
  const ccbPids = new Set(ccbProcs.map(proc => proc.pid));
  const claudeChildren = others.filter(proc => isClaude(proc.cmd) && ccbPids.has(proc.ppid));

  const sessionUnits = ccbProcs.map(ccb => {
    const childPids = claudeChildren.filter(child => child.ppid === ccb.pid).map(child => child.pid);
    return new ShutdownUnit(`ccb#${ccb.pid}`, [...childPids, ccb.pid]);
  });

  const daemonUnits = others
    .filter(proc => isProxyDaemon(proc.cmd))
    .map(daemon => new ShutdownUnit(`daemon#${daemon.pid}`, [daemon.pid]));

  return new ShutdownPlan([...sessionUnits, ...daemonUnits]);
}
