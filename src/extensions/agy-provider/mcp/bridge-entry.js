#!/usr/bin/env node
/**
 * Bridge-entry subprocess — the THIN stdio↔socket adapter agy spawns.
 *
 * agy launches the MCP server named in `mcp_config.json` as a stdio subprocess.
 * This entry IS that subprocess. It is a DUMB BIDIRECTIONAL PIPE: every byte
 * agy writes to its stdin is forwarded verbatim over the per-session unix
 * socket to the in-ccb actor's bridge server, and every byte the actor replies
 * is forwarded verbatim to agy's stdout. It has ZERO JSON-RPC awareness and
 * ZERO held-call logic — the single block-don't-terminate engine lives in the
 * actor's `createBridgeServer` (bound to the other end of this socket). The
 * entry only correlates the session (CCB_AGY_SESSION_ID) to the socket path.
 *
 * Failure handling: if the socket cannot be reached (the actor isn't listening
 * yet, or died), we exit non-zero so agy sees the MCP server fail fast rather
 * than hang. No retries, no sleeps — the actor must be listening before agy
 * spawns the bridge (spawnPtyAgy resolves on onReady, which fires after the
 * actor's server is up).
 */

import net from 'node:net';
import { socketPathForSession } from './socket-path.js';

const SESSION_ID = process.env.CCB_AGY_SESSION_ID;
const RUNTIME_DIR = process.env.CCB_AGY_RUNTIME_DIR;

if (typeof SESSION_ID !== 'string' || SESSION_ID.length === 0) {
  process.stderr.write('bridge-entry: CCB_AGY_SESSION_ID is required\n');
  process.exit(2);
}
if (typeof RUNTIME_DIR !== 'string' || RUNTIME_DIR.length === 0) {
  process.stderr.write('bridge-entry: CCB_AGY_RUNTIME_DIR is required\n');
  process.exit(2);
}

const socketPath = socketPathForSession(SESSION_ID, RUNTIME_DIR);

const socket = net.createConnection({ path: socketPath });

socket.on('error', (err) => {
  process.stderr.write(`bridge-entry: socket error (${socketPath}): ${err.message}\n`);
  process.exit(1);
});

socket.on('connect', () => {
  // agy's stdin → actor (over the socket).
  process.stdin.pipe(socket);
  // actor → agy's stdout (over the socket).
  socket.pipe(process.stdout);
});

// When agy closes our stdin, close the socket (the actor then sees end-of-turn).
process.stdin.on('end', () => socket.end());
// When the actor closes the socket, exit cleanly.
socket.on('close', () => process.exit(0));
