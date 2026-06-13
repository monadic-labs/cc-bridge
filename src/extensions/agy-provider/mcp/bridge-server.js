/**
 * The stdio MCP bridge server (Seam — the held-call core).
 *
 * This is the heart of block-don't-terminate. One instance runs per agy
 * session as agy's MCP child server over stdio. Each non-terminal `tools/call`
 * is HELD OPEN: the server stashes the call, hands it to `onToolCall` (the
 * actor), and writes NO response. The response is written later, when Claude
 * Code's matching tool_result arrives, by `fulfill(mcpId, result)`.
 *
 * `submit_final_answer` is the one terminal pseudo-tool: agy calls it to emit
 * its final answer (verified reliable), so it is acknowledged immediately and
 * `onFinalAnswer(text)` fires — PTY text is input/keepalive only, never parsed.
 *
 * Functional core / imperative shell: the pure wire codec (json-rpc.js) parses
 * and builds every envelope; THIS module owns the I/O — the readline loop over
 * `stdio.in` and the writes to `stdio.out` — plus the held-call map. Tests inject
 * `stdio` (real PassThrough pipes) so the behaviour runs through the real
 * transport with no dynamic mocks (manifesto §Test doubles: Fake/real only).
 */

import readline from 'node:readline';
import { CCB_VERSION } from '../../../core/constants.js';
import { McpBridgeError } from '../exceptions.js';
import { parseMessage, buildResult, buildError, ERROR_CODES } from './json-rpc.js';

/**
 * The MCP protocol version the bridge advertises on `initialize`.
 *
 * The spike (agy v1.0.8) sent `initialize` with protocolVersion `2025-11-25`
 * and ACCEPTED this server's `2024-11-05` reply — agy then proceeded to
 * tools/list + tools/call (evidence: /tmp/agy-mcp-spike/received.log lines 2-12).
 * `2024-11-05` is the value agy is confirmed to tolerate; do not change it
 * without re-verifying against the log.
 */
export const PROTOCOL_VERSION = '2024-11-05';

/** The terminal pseudo-tool agy calls to emit its final answer over MCP. */
export const SUBMIT_FINAL_ANSWER_TOOL = Object.freeze({
  name: 'submit_final_answer',
  description: 'Emit the final answer. Call this ONCE when the task is complete.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The final answer text' },
    },
    required: ['text'],
    additionalProperties: false,
  },
});

/**
 * Validate the injected dependencies once, at construction. Fail loud with a
 * named domain error so a wiring mistake surfaces at the boundary, not as a
 * later opaque TypeError mid-dispatch (manifesto §Exceptions: throw early at
 * boundaries; domain-specific exception types only).
 *
 * @param {object} deps
 * @returns {object} the normalized deps
 */
function validateDeps(deps) {
  if (deps === null || typeof deps !== 'object') {
    throw new McpBridgeError('bridge-server deps must be an object');
  }
  if (typeof deps.listTools !== 'function') {
    throw new McpBridgeError('listTools must be a function');
  }
  if (typeof deps.onToolCall !== 'function') {
    throw new McpBridgeError('onToolCall must be a function');
  }
  if (typeof deps.onFinalAnswer !== 'function') {
    throw new McpBridgeError('onFinalAnswer must be a function');
  }
  const stdio = deps.stdio ?? { in: process.stdin, out: process.stdout };
  if (!stdio.in || typeof stdio.in.on !== 'function') {
    throw new McpBridgeError('stdio.in must be a readable stream');
  }
  if (!stdio.out || typeof stdio.out.write !== 'function') {
    throw new McpBridgeError('stdio.out must be a writable stream');
  }
  return { listTools: deps.listTools, onToolCall: deps.onToolCall, onFinalAnswer: deps.onFinalAnswer, stdio };
}

/**
 * Create the stdio MCP bridge server.
 *
 * The server object is one cohesive concept — a live JSON-RPC server holding
 * calls open — so its fields (deps, readline interface, the pending-call map,
 * the ready queue, the ready-handshake state) are kept together under the
 * cohesion exception (each describes this one server instance; splitting them
 * would distribute a single lifecycle across objects).
 *
 * @param {object} deps
 * @param {() => Array} deps.listTools        - returns current CC tool defs (Seam1 output).
 * @param {(call:{mcpId:*,name:string,arguments:object}) => void} deps.onToolCall
 *        - actor receives each HELD call; the server writes nothing until fulfill().
 * @param {(finalText:string) => void} deps.onFinalAnswer - fires on submit_final_answer.
 * @param {{in:NodeJS.ReadableStream, out:NodeJS.WritableStream}} [deps.stdio]
 *        - injected transport for tests; defaults to process stdio.
 * @returns {{start:Function, fulfill:Function, rejectAll:Function, stop:Function, onReady:Function}}
 */
export function createBridgeServer(rawDeps) {
  const deps = validateDeps(rawDeps);
  const { listTools, onToolCall, onFinalAnswer, stdio } = deps;

  // The held-call map: mcpId → { name } for telemetry on resolve/reject.
  // Per the locked architecture: Map<tool_use_id, PendingCall>. The deadline
  // timer lives in the actor (Unit 6), not here — the server only resolves.
  const pending = new Map();
  // Ready callbacks fire after the server has answered initialize AND tools/list
  // (the deterministic readiness signal — pty-spawn resolves on this, no sleep).
  let initializeAnswered = false;
  let toolsListAnswered = false;
  const readyCallbacks = [];
  let readlineInterface = null;
  let stopped = false;

  const write = (envelope) => stdio.out.write(`${envelope}\n`);

  function fireReadyIfHandshakeComplete() {
    if (initializeAnswered && toolsListAnswered) {
      const callbacks = readyCallbacks.splice(0);
      callbacks.forEach((cb) => cb());
    }
  }

  function handleInitialize(id) {
    initializeAnswered = true;
    write(buildResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'ccb-agy-bridge', version: CCB_VERSION },
    }));
    fireReadyIfHandshakeComplete();
  }

  function handleToolsList(id) {
    const tools = [...listTools(), SUBMIT_FINAL_ANSWER_TOOL];
    toolsListAnswered = true;
    write(buildResult(id, { tools }));
    fireReadyIfHandshakeComplete();
  }

  function handleSubmitFinalAnswer(id, argumentsObj) {
    const finalText = typeof argumentsObj?.text === 'string' ? argumentsObj.text : '';
    onFinalAnswer(finalText);
    write(buildResult(id, { content: [{ type: 'text', text: 'ack' }], isError: false }));
  }

  function holdToolCall(id, name, argumentsObj) {
    pending.set(id, { name });
    onToolCall({ mcpId: id, name, arguments: argumentsObj ?? {} });
    // Intentionally NO write: the call is held until fulfill().
  }

  function handleToolsCall(id, params) {
    const name = params?.name;
    const argumentsObj = params?.arguments;
    if (name === SUBMIT_FINAL_ANSWER_TOOL.name) {
      handleSubmitFinalAnswer(id, argumentsObj);
      return;
    }
    holdToolCall(id, name, argumentsObj);
  }

  function dispatch(message) {
    const { id, method, params } = message;

    // Notifications carry no id and expect no reply (agy sends
    // notifications/initialized and notifications/roots/list_changed).
    if (id === undefined || id === null) {
      return;
    }

    if (method === 'initialize') {
      handleInitialize(id);
      return;
    }
    if (method === 'tools/list') {
      handleToolsList(id);
      return;
    }
    if (method === 'tools/call') {
      handleToolsCall(id, params);
      return;
    }

    write(buildError(id, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method ?? '<missing>'}`));
  }

  function onLine(line) {
    const parsed = parseMessage(line);
    if (!parsed.isSuccess) {
      return; // malformed JSON-RPC: log+skip, never crash the loop
    }
    dispatch(parsed.value);
  }

  return {
    /** Begin reading stdio. Idempotent: a second call is a no-op. */
    start() {
      if (readlineInterface) {
        return;
      }
      readlineInterface = readline.createInterface({ input: stdio.in, crlfDelay: Infinity });
      readlineInterface.on('line', onLine);
    },

    /**
     * Resolve a held tools/call with the given result (Claude Code's
     * tool_result, already converted via Seam3). Writes the result envelope
     * and drops the stash. Fails loud on an unknown id — a phantom fulfill is
     * a wiring bug (the deadline or teardown already resolved it), never silent.
     *
     * @param {*} mcpId - the held call's id (from onToolCall).
     * @param {{content:Array, isError:boolean}} result
     */
    fulfill(mcpId, result) {
      if (!pending.has(mcpId)) {
        throw new McpBridgeError(`fulfill: unknown mcpId ${JSON.stringify(mcpId)}`);
      }
      pending.delete(mcpId);
      const content = Array.isArray(result?.content) ? result.content : [{ type: 'text', text: String(result?.content ?? '') }];
      write(buildResult(mcpId, { content, isError: result?.isError === true }));
    },

    /**
     * Clean teardown: error every still-held call so agy's loop terminates
     * (a held call with no response would hang agy indefinitely). Called on
     * session death / actor stop.
     *
     * @param {Error|McpBridgeError|string} [error]
     */
    rejectAll(error) {
      const message = error instanceof Error ? error.message : (typeof error === 'string' ? error : 'session teardown');
      const ids = [...pending.keys()];
      pending.clear();
      ids.forEach((id) => write(buildError(id, ERROR_CODES.INTERNAL_ERROR, message)));
    },

    /** Stop reading stdio. Held calls are left as-is; call rejectAll first. */
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      readlineInterface?.close();
      readlineInterface = null;
    },

    /**
     * Register a callback fired once the readiness handshake (initialize +
     * tools/list answered) completes. Fires immediately if already ready.
     * The deterministic readiness signal pty-spawn awaits (no PTY scrape, no sleep).
     *
     * @param {() => void} cb
     */
    onReady(cb) {
      if (initializeAnswered && toolsListAnswered) {
        cb();
        return;
      }
      readyCallbacks.push(cb);
    },

    /** Test-only introspection: how many calls are currently held. */
    get pendingCount() {
      return pending.size;
    },
  };
}
