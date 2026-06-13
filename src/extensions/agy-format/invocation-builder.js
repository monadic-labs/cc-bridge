/**
 * Shared helper for building agy CLI invocations.
 *
 * Centralises the single decision: run agy locally (bash -c) vs. via SSH.
 * When no sshHost is supplied, the command runs on the local machine.
 * When sshHost is explicitly provided, the command is forwarded over SSH.
 *
 * The `script -qec ... /dev/null` PTY wrapper is always preserved because
 * agy requires a TTY for both model discovery and prompt execution.
 */

/**
 * Build the {cmd, args} tuple for an agy shell command string.
 *
 * @param {string} shellCommand - The full shell command (PATH export + script -qec ...)
 * @param {string|undefined} sshHost  - Optional SSH host; absent → local execution
 * @returns {{ cmd: string, args: string[] }}
 */
export function buildAgyInvocation(shellCommand, sshHost) {
  if (sshHost) {
    return { cmd: 'ssh', args: [sshHost, shellCommand] };
  }
  return { cmd: 'bash', args: ['-c', shellCommand] };
}
