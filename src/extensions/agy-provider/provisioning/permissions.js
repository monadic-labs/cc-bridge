/**
 * antigravity-cli settings builder (pure).
 *
 * Merges the spike-confirmed permission deny/allow rules into the user's real
 * antigravity-cli `settings.json` base, WITHOUT clobbering the user's other
 * settings (theme, history, telemetry, etc.). The deny-rules are the hard
 * enforcement that makes agy's native read/write/shell tools return
 * `Permission denied ... Matches user-configured deny rule` and fall back to
 * the MCP tools (Phase 0 finding B); `allow:["mcp(*)"]` keeps the bridge path open.
 *
 * Pure: returns a new settings object, no I/O. The session-home shell writes it.
 */

/**
 * The deny/allow rules confirmed effective in the spike (adversarial-test.log,
 * perm-spike.log). Frozen so a caller cannot mutate the shared contract.
 */
export const PERMISSION_RULES = Object.freeze({
  deny: Object.freeze(['read_file(*)', 'write_file(*)', 'command(*)', 'unsandboxed(*)']),
  allow: Object.freeze(['mcp(*)']),
});

/**
 * Merge the bridge's permission deny/allow into a base antigravity-cli settings
 * object. Returns a NEW object; the base is never mutated. Other top-level keys
 * (and any other `permissions` sub-keys) survive untouched.
 *
 * The deny/allow arrays REPLACE any user values for those two sub-keys: the
 * bridge's enforcement must be authoritative (a user's looser rule would
 * re-open the native-tool correctness hole). Every other permissions sub-key
 * is preserved.
 *
 * @param {object} [baseSettings] - the user's real settings.json contents (or {}).
 * @returns {object} a new settings object with bridge permissions merged in.
 */
export function buildPermissionsSettings(baseSettings) {
  const base = (baseSettings && typeof baseSettings === 'object' && !Array.isArray(baseSettings))
    ? baseSettings
    : {};

  const existingPermissions = (base.permissions && typeof base.permissions === 'object' && !Array.isArray(base.permissions))
    ? base.permissions
    : {};

  return {
    ...base,
    permissions: {
      ...existingPermissions,
      deny: [...PERMISSION_RULES.deny],
      allow: [...PERMISSION_RULES.allow],
    },
  };
}
