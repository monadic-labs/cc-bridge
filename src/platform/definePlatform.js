// src/platform/definePlatform.js — the sanctioned OS functional-parity
// abstraction (T-whtmar9s, reference implementation).
//
// ## Design intent
// A feature that needs different OS APIs is wrapped HERE with BOTH real
// implementations present. The defining guarantee of this module is that
// "forgot the Windows port" (or the Unix port) cannot compile-past into a
// silent runtime gap: definePlatform THROWS at call time — where the capability
// is defined — if either `unix` or `windows` branch is missing. The error is
// structural, not a runtime discovery on the platform that was forgotten.
//
// The per-OS values are PURE descriptor functions (or any plain values). The
// imperative shell calls selectForPlatform ONCE and dependency-injects the
// chosen branch into the core. Real effects (spawn / fs / syscall) are injected
// by the caller so BOTH branches are unit-testable on a single host — e.g. the
// Windows branch is exercised on Linux by injecting the `win32` platform,
// without running Windows. Platform selection is INJECTABLE (selectForPlatform's
// 2nd arg defaults to process.platform) precisely so tests pick a branch with
// zero global mocking.

/**
 * Stable machine-readable error code for {@link PlatformParityError}.
 * Asserted in tests by value (not by message text).
 */
const PLATFORM_PARITY = 'PLATFORM_PARITY';

/**
 * Error raised when a capability defined via {@link definePlatform} does not
 * declare BOTH the `unix` and `windows` branches. The missing branch makes the
 * capability structurally incomplete, so the abstraction refuses to build the
 * {@link PlatformMap}.
 *
 * `code` is a stable machine-readable reason (PLATFORM_PARITY) so callers branch
 * on it without matching the message string — mirroring the convention in
 * src/core/exceptions.js.
 */
export class PlatformParityError extends Error {
  #code;

  constructor(message, { code = PLATFORM_PARITY } = {}) {
    super(message);
    this.name = 'PlatformParityError';
    this.#code = code;
  }

  get code() { return this.#code; }
}

/**
 * A frozen map of per-platform capability descriptors.
 *
 * @template T
 * @typedef {Object} PlatformMap
 * @property {T} unix - Mandatory. Descriptor for POSIX platforms (linux, darwin,
 *   and any platform without a more specific alias).
 * @property {T} windows - Mandatory. Descriptor for `win32`.
 * @property {T} [linux] - Optional explicit alias (overrides the unix fallback
 *   when present).
 * @property {T} [darwin] - Optional explicit alias (overrides the unix fallback
 *   when present).
 * @property {T} [aix] - Optional explicit alias.
 * @property {T} [freebsd] - Optional explicit alias.
 * @property {T} [openbsd] - Optional explicit alias.
 * @property {T} [sunos] - Optional explicit alias.
 * @property {T} [android] - Optional explicit alias.
 * @property {T} [cygwin] - Optional explicit alias.
 * @property {T} [netbsd] - Optional explicit alias.
 * @property {T} [haiku] - Optional explicit alias.
 */

/**
 * Builds a frozen {@link PlatformMap} from a raw descriptor map.
 *
 * `unix` and `windows` are both REQUIRED — supplying a map missing either (or
 * holding `undefined` for either) throws a {@link PlatformParityError} at call
 * time. Extra alias keys (e.g. `linux`, `darwin`) are preserved verbatim on the
 * returned frozen map and, when present, are preferred over the `unix` fallback
 * during {@link selectForPlatform}.
 *
 * @template T
 * @param {Record<string, T>} map - Raw descriptor map; MUST contain `unix` and
 *   `windows`. May carry extra platform aliases.
 * @returns {PlatformMap<T>} A frozen copy of `map`.
 * @throws {PlatformParityError} code `PLATFORM_PARITY` when `unix` or `windows`
 *   is missing/undefined.
 */
export function definePlatform(map) {
  const missing = missingParityKeys(map);
  if (missing.length > 0) {
    throw new PlatformParityError(
      `definePlatform requires BOTH unix and windows branches; ` +
      `missing: ${missing.join(', ')}. An OS port must never be silently forgotten.`
    );
  }
  return Object.freeze({ ...map });
}

/**
 * Selects the descriptor branch for a platform.
 *
 * Selection rule (first match wins, no `else` chains):
 *   1. `win32`            → `map.windows`
 *   2. an explicit alias  → that key (e.g. `darwin` when `map.darwin` is set)
 *   3. fallback           → `map.unix`
 *
 * `platform` is INJECTABLE (defaults to `process.platform`) so tests pick either
 * branch deterministically without monkey-patching the global.
 *
 * @template T
 * @param {PlatformMap<T>} map - A map produced by {@link definePlatform}.
 * @param {string} [platform=process.platform] - A Node `process.platform`
 *   value (`win32`, `linux`, `darwin`, …). Read exactly once per call.
 * @returns {T} The descriptor for `platform`.
 */
export function selectForPlatform(map, platform = process.platform) {
  if (platform === 'win32') return map.windows;
  if (Object.prototype.hasOwnProperty.call(map, platform)) return map[platform];
  return map.unix;
}

/**
 * Returns the mandatory-branch names that are absent or `undefined` on `map`.
 * Empty result ⇒ parity satisfied. Pure helper; throws nothing.
 *
 * @template T
 * @param {Record<string, T>} map
 * @returns {string[]}
 */
function missingParityKeys(map) {
  const missing = [];
  if (map.unix === undefined) missing.push('unix');
  if (map.windows === undefined) missing.push('windows');
  return missing;
}
