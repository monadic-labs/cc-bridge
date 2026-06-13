/**
 * History-diff reconciliation (pure).
 *
 * Claude Code re-sends the FULL message array on every request. The adapter
 * compares it to agy's consumed prefix to decide what (if anything) to feed
 * agy. One mechanism unifies four flows (spec Q2, history-diff reconciliation):
 *
 *   - continuation : incoming starts with the consumed prefix and is longer
 *                    → inject only the delta (advance the prefix pointer)
 *   - retry        : incoming deep-equals the consumed set
 *                    → re-emit, do NOT advance (CC is retrying the same turn)
 *   - reanchor     : the prefix diverged (or incoming is truncated/shorter)
 *                    → kill+respawn agy and replay the full reconstructed history
 *
 * Equality is structural (JSON), not by reference — CC's array is a fresh object
 * each request even when the content is identical.
 */

/**
 * Structural equality of two JSON-serializable values.
 * Returns false for either side being undefined when the other is not.
 */
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Is `incoming` a continuation of `prefix`? I.e. prefix is a leading subsequence
 * (positionally and structurally) and incoming is strictly longer.
 */
function isContinuation(prefix, incoming) {
  if (incoming.length <= prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (!deepEqual(prefix[i], incoming[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Reconcile the incoming CC message array against the consumed prefix.
 *
 * @param {Array} consumedPrefix - The messages agy has already consumed.
 * @param {Array} incoming      - The full message array from the current CC request.
 * @returns {{kind:'continuation'|'retry'|'reanchor', delta?:Array, reason:string}}
 */
export function reconcileHistory(consumedPrefix, incoming) {
  const prefix = Array.isArray(consumedPrefix) ? consumedPrefix : [];
  const next = Array.isArray(incoming) ? incoming : [];

  if (isContinuation(prefix, next)) {
    return { kind: 'continuation', delta: next.slice(prefix.length), reason: 'incoming extends the consumed prefix' };
  }

  if (deepEqual(prefix, next)) {
    return { kind: 'retry', reason: 'incoming deep-equals the consumed prefix; re-emit without advancing' };
  }

  return { kind: 'reanchor', delta: [...next], reason: 'incoming diverged from the consumed prefix; replay all' };
}
