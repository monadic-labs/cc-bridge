/**
 * GEMINI.md operating-manual builder (pure).
 *
 * The GEMINI.md in each session's sandbox is the bridge operating manual. It
 * steers agy toward MCP-only routing and the terminal answer channel. Together
 * with the antigravity-cli permissions deny-rules (provisioning/permissions.js),
 * it forces agy to: (1) do ALL file/shell work through the MCP tools Claude
 * Code fulfills, and (2) emit its final answer by calling `submit_final_answer`
 * instead of printing it (so the adapter never parses PTY content).
 *
 * The deny-rules are the hard enforcement; this text is the steering that tells
 * agy WHY its native tools are unavailable and WHERE its answer must go.
 */

/** The load-bearing directives every GEMINI.md must carry (asserted in tests). */
export const REQUIRED_DIRECTIVES = Object.freeze([
  'no native file or shell tools',
  'submit_final_answer',
  'do NOT just print it',
]);

/**
 * Build the GEMINI.md operating-manual text for one session sandbox.
 *
 * Pure: returns a string, no I/O. The session-home shell writes it to disk.
 *
 * @returns {string} the GEMINI.md body.
 */
export function buildGeminiMd() {
  return [
    '# Bridge operating manual',
    '',
    'You are operating through a bridge: another program (Claude Code) is your hands, and you are the brain. You work through the tools it provides over MCP.',
    '',
    '## Tools',
    '',
    'You have no native file or shell tools — they are denied by policy. Do ALL file and shell work by calling the provided MCP tools. Every tool call is delivered to Claude Code, which executes the real action and returns the result to you.',
    '',
    '## Finishing',
    '',
    'When the task is fully complete, call the `submit_final_answer` tool with your final answer — do NOT just print it. Your printed text is not delivered to the user; only `submit_final_answer` is.',
  ].join('\n') + '\n';
}
