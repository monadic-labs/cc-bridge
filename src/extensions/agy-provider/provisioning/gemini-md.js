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
  'no native tools available',
  'submit_final_answer',
  'you MUST call `submit_final_answer`',
  'Do NOT just print the answer',
]);

/**
 * Build the GEMINI.md operating-manual text for one session sandbox.
 *
 * Pure: returns a string, no I/O. The session-home shell writes it to disk.
 *
 * The steering text is the lever that makes agy route tool calls through the
 * MCP AND emit its final answer via `submit_final_answer` (verified against
 * real agy in the Phase-0 spike). It is deliberately emphatic and explicit:
 * agy reliably honors a hard "you MUST call submit_final_answer; do NOT print"
 * directive and an explicit two-step procedure, but will print-and-exit if the
 * instruction is soft. The deny-rules (permissions.js) are the hard enforcement
 * of no-native-tools; this text tells agy why and where its answer must go.
 *
 * @returns {string} the GEMINI.md body.
 */
export function buildGeminiMd() {
  return [
    '# Instructions',
    '',
    'You have no native tools available. Native file read, write, and command tools are blocked by policy.',
    '',
    'To do any file or shell work, you MUST use the MCP tools provided over the bridge — they are the only tools available to you.',
    '',
    'When you have determined the final answer to the user\'s task, you MUST call the `submit_final_answer` MCP tool with the complete answer text in the `text` argument. Do NOT just print the answer as text — you MUST call `submit_final_answer`. This is required for the answer to be captured correctly.',
    '',
    'There is no other way to complete the task: (1) use the MCP tools to do the work, (2) call `submit_final_answer` with the result.',
  ].join('\n') + '\n';
}
