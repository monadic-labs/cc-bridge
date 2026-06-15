/**
 * Shutdown executor (imperative shell).
 *
 * Walks a ShutdownPlan ONE unit at a time (serial) and, for each unit:
 *   1. sends TWO SEQUENTIAL Ctrl-C (SIGINT) to every pid in the unit — claude
 *      children first, launcher last — the way a human closes the session;
 *   2. POLLS for exit up to a generous deadline (never a blind fixed sleep);
 *   3. only as an absolute last resort, force-kills whatever is still alive.
 *
 * Every effectful dependency is injected via `env`, so the behaviour can be
 * driven against fake child processes with zero risk to the live daemon or to
 * a real `claude` that may be mid-OAuth-refresh:
 *   env.listPids()           -> number[]  currently-alive pids
 *   env.signalGraceful(pid)  -> void       SIGINT (POSIX) / taskkill /T (win)
 *   env.signalForce(pid)     -> void       SIGKILL (POSIX) / taskkill /F /T
 *   env.sleep(ms)            -> Promise    deterministic delay primitive
 *   env.now()                -> number     monotonic-ish clock (ms)
 *   env.config               -> partial config overrides (optional)
 */

export const DEFAULT_SHUTDOWN_CONFIG = Object.freeze({
  // Two sequential Ctrl-C: the interactive `claude` needs the second press to
  // confirm-quit. One SIGINT alone never closes it.
  sigintCount: 2,
  // Gap between the two Ctrl-C presses.
  sigintGapMs: 250,
  // Poll cadence while waiting for a unit to exit on its own.
  pollIntervalMs: 250,
  // Generous grace before force is even considered — far beyond claude's
  // server-rotate -> disk-persist window, so a force can never land mid-refresh.
  graceMs: 30_000,
  // SIGKILL strictly as a last resort, and only after the full grace elapses.
  forceAfterGrace: true,
});

function resolveContext(env) {
  const config = Object.freeze({ ...DEFAULT_SHUTDOWN_CONFIG, ...(env.config ?? {}) });
  return Object.freeze({ ...env, config });
}

async function requestGracefulStop(unit, context) {
  const { sigintCount, sigintGapMs } = context.config;
  for (let round = 0; round < sigintCount; round++) {
    unit.signalEach(context.signalGraceful);
    const isLastRound = round === sigintCount - 1;
    if (isLastRound) return;
    await context.sleep(sigintGapMs);
  }
}

async function pollForExit(unit, context) {
  const { pollIntervalMs, graceMs } = context.config;
  const deadline = context.now() + graceMs;
  for (;;) {
    const present = new Set(context.listPids());
    const survivors = unit.survivingPids(present);
    if (survivors.length === 0) return [];
    if (context.now() >= deadline) return survivors;
    await context.sleep(pollIntervalMs);
  }
}

function forceStop(survivors, context) {
  if (!context.config.forceAfterGrace) return [];
  if (survivors.length === 0) return [];
  for (const pid of survivors) context.signalForce(pid);
  return survivors;
}

async function shutdownUnit(unit, context) {
  await requestGracefulStop(unit, context);
  const survivors = await pollForExit(unit, context);
  const forced = forceStop(survivors, context);
  return Object.freeze({ unit: unit.describe(), exitedGracefully: survivors.length === 0, forced });
}

/**
 * Execute the plan serially and return one frozen outcome per unit.
 *
 * @param {import('./kill-planner.js').ShutdownPlan} plan
 * @param {object} env - injected effectful dependencies (see file header).
 * @returns {Promise<ReadonlyArray<object>>}
 */
export async function executeShutdown(plan, env) {
  const context = resolveContext(env);
  const outcomes = [];
  for (const unit of plan.units()) {
    outcomes.push(await shutdownUnit(unit, context));
  }
  return Object.freeze(outcomes);
}
