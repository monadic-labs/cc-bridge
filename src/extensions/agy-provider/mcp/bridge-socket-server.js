/**
 * Actor-side adapter-socket server (imperative shell — the server half of the
 * stdio↔socket transport).
 *
 * Real agy spawns the MCP server named in `mcp_config` as a stdio subprocess;
 * that subprocess is `bridge-entry.js` (the dumb client half), which connects
 * to THIS per-session unix socket. On each accepted connection, this server
 * binds the EXISTING Unit 3 `createBridgeServer` to the socket stream —
 * `stdio:{ in: socket, out: socket }` — so the held-call engine is Unit 3,
 * VERBATIM. This module owns ZERO held-call / JSON-RPC / business logic; it is
 * purely the accept loop + readiness bubbling.
 *
 * Readiness: the connection's bridge fires `onReady` after it answers agy's
 * `initialize` + `tools/list`. This module bubbles that single signal up (the
 * FIRST connection's ready) so `spawnPtyAgy` can resolve on it — no sleep.
 */

import net from 'node:net';
import fsDefault from 'node:fs';
import { createBridgeServer } from './bridge-server.js';
import { McpBridgeError } from '../exceptions.js';

/**
 * Create the actor-side socket server for one session.
 *
 * @param {object} deps
 * @param {string} deps.socketPath      - the per-session unix socket path (socketPathForSession).
 * @param {() => Array} deps.listTools  - current CC tool defs (forwarded to the bridge).
 * @param {(call:object) => void} deps.onToolCall     - forwarded (held calls reach the actor).
 * @param {(text:string) => void} deps.onFinalAnswer  - forwarded (submit_final_answer).
 * @param {object} [deps.fs]            - injected fs (real node:fs in prod; tmp tree in tests).
 * @returns {{start:Function, onReady:Function, fulfill:Function, rejectAll:Function, stop:Function, get socketPath()}}
 */
export function createBridgeSocketServer(deps) {
  const socketPath = requireNonEmptyString(deps?.socketPath, 'socketPath');
  if (typeof deps?.listTools !== 'function') {
    throw new McpBridgeError('listTools must be a function');
  }
  if (typeof deps?.onToolCall !== 'function') {
    throw new McpBridgeError('onToolCall must be a function');
  }
  if (typeof deps?.onFinalAnswer !== 'function') {
    throw new McpBridgeError('onFinalAnswer must be a function');
  }
  const fs = deps.fs ?? fsDefault;
  const { listTools, onToolCall, onFinalAnswer } = deps;

  let listener = null;
  let activeBridge = null;     // the bridge bound to the current connection
  let readyFired = false;
  const readyCallbacks = [];

  function onConnection(socket) {
    // Bind Unit 3's bridge to this connection's socket stream — the sole BDT
    // engine, unmodified. Each session has one connection (one agy), so there
    // is at most one active bridge; a new connection replaces a dead one.
    activeBridge = createBridgeServer({ listTools, onToolCall, onFinalAnswer, stdio: { in: socket, out: socket } });
    activeBridge.onReady(() => {
      if (readyFired) {
        return;
      }
      readyFired = true;
      const cbs = readyCallbacks.splice(0);
      cbs.forEach((cb) => cb());
    });
    activeBridge.start();
    socket.on('close', () => { if (activeBridge) { activeBridge.stop(); } });
  }

  return {
    /** Begin listening on the socket. Idempotent. */
    start() {
      if (listener) {
        return;
      }
      try { fs.rmSync(socketPath, { force: true }); } catch { /* absent */ }
      listener = net.createServer(onConnection);
      listener.listen(socketPath);
    },

    /** Register a readiness callback (fires once, after the bridge answers initialize+tools/list). */
    onReady(cb) {
      if (readyFired) {
        cb();
        return;
      }
      readyCallbacks.push(cb);
    },

    /**
     * Resolve a held tools/call — delegated to the active connection's bridge.
     * A closed connection means the held call's transport is gone (agy exited or
     * the actor's per-call deadline fired during teardown): fulfilling it is a
     * benign no-op, not an error (mirrors rejectAll's teardown semantics).
     */
    fulfill(mcpId, result) {
      if (!activeBridge) {
        return;
      }
      activeBridge.fulfill(mcpId, result);
    },

    /** Reject every held call (teardown) — delegated to the active bridge. */
    rejectAll(error) {
      if (activeBridge) {
        activeBridge.rejectAll(error);
      }
    },

    /** Stop listening + close the active bridge. */
    stop() {
      if (activeBridge) {
        activeBridge.stop();
        activeBridge = null;
      }
      if (listener) {
        listener.close();
        listener = null;
      }
      try { fs.rmSync(socketPath, { force: true }); } catch { /* absent */ }
    },

    get socketPath() {
      return socketPath;
    },
  };
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new McpBridgeError(`${label} must be a non-empty string`);
  }
  return value;
}
