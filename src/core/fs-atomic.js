import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import lockfile from 'proper-lockfile';
import { ProxyError, ConfigError } from './exceptions.js';
import { Result } from './types.js';

// Sync-sleep primitive for acquire backoff. Atomics.wait blocks the thread for a
// bounded number of ms without busy-looping, and is available on Node without
// the Worker/SharedArrayBuffer opt-in *on the main thread of a normal process*.
// We construct a fresh throwaway Int32Array each call — it is never shared, so
// no cross-thread coordination is involved; it is purely the standard idiom for
// "sleep synchronously for N ms". proper-lockfile's SYNC api rejects the
// `retries` option (it throws ESYNC), so the bounded spin+backoff that turns a
// single ELOCKED into a timeout-aware acquire is OURS to drive.
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepMsSync(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

// Tunables — kept module-local (not exported) so callers can't reason about
// them; they are an implementation detail of cross-process serialization.
const LOCK_BACKOFF_START_MS = 2;
const LOCK_BACKOFF_MAX_MS = 64;
const LOCK_DEFAULT_TIMEOUT_MS = 5000; // a CLI mutation must finish within 5s
const LOCK_STALE_TTL_MS = 30000; // a holder older than 30s is assumed dead

// Where the lock FILES live. See hostLocalLockPath() for why this is NOT the
// config dir.
const LOCK_FILE_ROOT = path.join(os.tmpdir(), 'ccb-locks');

/**
 * Error raised when a cross-process config lock cannot be acquired in time.
 *
 * `code` carries a short machine-stable reason (lock_timeout) so callers can
 * branch on it without matching the message string.
 */
export class ConfigLockError extends ProxyError {
  constructor(message, props) {
    super(message, { operation: 'config-lock', code: 'lock_timeout', ...props });
  }
}

/**
 * Write `data` to `filePath` ATOMICALLY: write to `<path>.tmp` in the same
 * directory, then `renameSync` over the target (rename is atomic on the same
 * filesystem). A concurrent reader therefore never observes a truncated or
 * partially-written file — it sees either the old content or the complete new
 * content.
 *
 * Mirrors the proven pattern already in bin/ccb-watchdog.js (runtime.json).
 * If the write or rename fails, the temp file is removed best-effort so a
 * later attempt does not inherit a stale temp.
 *
 * @param {string} filePath - Absolute path to the target file.
 * @param {string} data - File contents (utf8 string).
 * @param {string} [encoding='utf8'] - Write encoding (kept for signature
 *   parity with the fs.writeFileSync calls this replaces).
 */
export function writeFileAtomic(filePath, data, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // The temp is a private scratch artifact, not a data file: open with 'w'
  // (truncate+create) rather than 'wx' (exclusive-create) so a stale temp left
  // by a CRASHED prior write does not wedge every later write with EEXIST. The
  // atomicity guarantee comes from the final rename, not from temp exclusivity.
  const tmp = `${filePath}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data, encoding);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort before rename */ }
    }
  }

  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Rename failed — the target was not touched, but the temp now lingers.
    // Remove it so a retry starts clean.
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * The host-local path that backs the lock for a given config directory.
 *
 * The lock is keyed COARSELY on the config DIRECTORY (`path.dirname(filePath)`),
 * not on the individual file: .env / config.json / providers.json share a single
 * config dir, so one lock makes their RMW cycles serialize against EACH OTHER
 * too (free cross-file atomicity — no interleaving between a .env write and a
 * config.json write).
 *
 * CRITICAL — the lock FILE must NOT live in the config dir. `~/.claude/.ccb/`
 * is Mutagen-synced cross-host (Windows <-> VM) by a session whose ignore set
 * has NO `*.lock` entry. A lockfile dropped there would sync to the other host:
 * a stale/future-mtime lock from host A would poison host B's acquire (or be
 * stolen out from under a live holder). So the lock is written under the
 * HOST-LOCAL, never-synced `os.tmpdir()` tree. Same config-dir abspath hashes
 * to the same lock path → all same-host writers contend on it; different dirs
 * hash apart → unrelated dirs never collide.
 */
function hostLocalLockPath(configDir) {
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 32);
  return path.join(LOCK_FILE_ROOT, hash, 'ccb-config.lock');
}

/**
 * Run `fn` while holding a cross-process lockfile that guards `filePath`.
 *
 * Config files (.env / config.json / providers.json) are mutated by a
 * read-modify-write cycle driven from SEPARATE processes (concurrent `ccb`
 * CLI invocations, or a CLI write racing a daemon re-read). An in-process lock
 * would be useless; the contenders do not share memory. This function acquires
 * a `proper-lockfile` lock on disk so the RMW cycles serialize across processes.
 *
 * The lock is COARSE — one per config DIRECTORY (see hostLocalLockPath) — so
 * every file in that dir is guarded by a single lock; cross-file interleaving
 * is impossible. Acquisition is SYNCHRONOUS with bounded spin+backoff driven
 * here (proper-lockfile's sync api forbids `retries`, so we supply the loop);
 * stale locks (older than staleTtlMs) are stolen by the library so a crashed
 * holder cannot wedge every later writer forever.
 *
 * On success returns `Result.ok(fn())`; if the lock cannot be acquired within
 * the timeout, returns `Result.fail(new ConfigLockError(...))` — it never
 * throws across the boundary, consistent with the codebase's Result style.
 *
 * @param {string} filePath - The data file being guarded. Only its DIRECTORY
 *   matters for the lock key; the file's basename is used only for diagnostics.
 * @param {function} fn - The read-modify-write body. Run only while the lock
 *   is held. Its return value is propagated on success.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000] - Give up acquiring after this long.
 * @param {number} [opts.staleTtlMs=30000] - Steal a lock held longer than this.
 */
export function withConfigLock(filePath, fn, { timeoutMs = LOCK_DEFAULT_TIMEOUT_MS, staleTtlMs = LOCK_STALE_TTL_MS } = {}) {
  const configDir = path.dirname(filePath);
  const lockfilePath = hostLocalLockPath(configDir);
  // The lockfile's parent is a host-local scratch dir; create it eagerly so
  // lockSync's exclusive create does not race two first-writers' mkdir.
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });

  const lockOpts = { lockfilePath, stale: staleTtlMs, retries: 0, realpath: false };

  if (!acquireLockBounded(lockfilePath, lockOpts, timeoutMs)) {
    return Result.fail(new ConfigLockError(
      `Timed out acquiring config lock for ${path.basename(filePath)} after ${timeoutMs}ms`
    ));
  }

  try {
    return Result.ok(fn());
  } finally {
    releaseLockSync(lockfilePath, lockOpts);
  }
}

// proper-lockfile's SYNC api rejects `retries` (ESYNC), so this loop is the
// bounded retry. Each attempt is one non-retrying lockSync: it either takes the
// lock or throws ELOCKED (held by another writer). On ELOCKED we back off and
// retry until the deadline; the library's own `stale` steals a dead holder.
// A non-ELOCKED throw (real fs failure) propagates. Returns true if acquired.
function acquireLockBounded(lockfilePath, lockOpts, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let backoff = LOCK_BACKOFF_START_MS;
  const target = path.dirname(lockfilePath); // proper-lockfile locks the target path

  for (;;) {
    try {
      lockfile.lockSync(target, lockOpts);
      return true;
    } catch (err) {
      if (err.code !== 'ELOCKED') throw err;
    }
    if (Date.now() >= deadline) return false;
    sleepMsSync(backoff);
    backoff = Math.min(backoff * 2, LOCK_BACKOFF_MAX_MS);
  }
}

function releaseLockSync(lockfilePath, lockOpts) {
  const target = path.dirname(lockfilePath);
  try {
    lockfile.unlockSync(target, lockOpts);
  } catch (err) {
    // ENOTACQUIRED: the lock was stolen (holder judged stale) between acquire
    // and release — nothing of ours to release. Any other failure is
    // best-effort: never let cleanup mask the protected work's own result.
    if (err.code !== 'ENOTACQUIRED') throw err;
  }
}

// Coalesce concurrent watcher events into a single callback after a short
// quiet window. inotify/FSEvents can deliver several events for one logical
// atomic replace (unlink old + create new + rename), and editors often write
// in a temp-then-rename dance that bursts events. Debouncing collapses them
// to one reload instead of several racing reads (some of which would observe
// a half-written file).
const WATCH_DEBOUNCE_MS = 50;
function debounce(fn, ms) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
    timer.unref?.();
  };
}

/**
 * Watch a config file for changes, surviving an atomic tmp+rename replace.
 *
 * `fs.watch(filePath, ...)` binds to the file's INODE. An atomic write
 * (write-tmp-then-rename) replaces the inode, so the watcher silently goes
 * dead — it never fires again for the renamed file. This is the hot-reload
 * regression that pairs with writeFileAtomic.
 *
 * The fix: watch the DIRECTORY and filter events by the target FILENAME. A
 * directory watcher does not bind to a specific inode, so a rename-replace of
 * the target surfaces as a `rename`/`change` event naming that file and the
 * callback still fires.
 *
 * @param {string} filePath - Absolute path to the file to watch.
 * @param {function} onChange - Invoked (debounced) when the file changes.
 * @param {function} [onError] - Invoked with the setup/watch error (mirrors
 *   the prior fs.watch try/catch logging the callers already had).
 * @returns {fs.FSWatcher | null} The directory watcher, or null if the dir
 *   could not be watched (onError is called with the reason).
 */
export function watchConfigFile(filePath, onChange, onError) {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const fire = debounce(onChange, WATCH_DEBOUNCE_MS);

  if (!fs.existsSync(dir)) {
    if (onError) onError(new ConfigError(`watch dir missing: ${dir}`));
    return null;
  }

  let watcher;
  try {
    watcher = fs.watch(dir, (eventType, filename) => {
      // Some platforms report the event type ('change' | 'rename'); react to
      // any event touching our target basename regardless of type — a
      // rename-replace shows up here as a 'rename' on this filename.
      if (filename === basename) fire();
    });
  } catch (e) {
    if (onError) onError(e);
    return null;
  }

  watcher.on('error', (e) => {
    if (onError) onError(e);
  });

  return watcher;
}
