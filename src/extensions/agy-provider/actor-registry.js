/**
 * Actor registry — imperative shell owning Map<sessionId, SessionResources>.
 *
 * Generalizes the per-session lifecycle proven inline in src/test.js ~4100–4240:
 *   buildMcpConfig → provisionSessionHome → createBridgeSocketServer →
 *   createSessionActor (before start()) → spawnPtyAgy
 *
 * One live agy per session. Concurrent ensure() calls for the same sessionId
 * await the same Promise (stored before await — no double-provision window).
 *
 * ≤2 instance fields: `sessions` (Map) + `cfg` (config bundle).
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveAgyBinary, agyDir } from '../agy-format/binary-resolver.js';
import { buildGeminiMd } from './provisioning/gemini-md.js';
import { buildPermissionsSettings } from './provisioning/permissions.js';
import { buildMcpConfig } from './provisioning/mcp-config.js';
import { provisionSessionHome } from './provisioning/session-home.js';
import { socketPathForSession } from './mcp/socket-path.js';
import { createBridgeSocketServer } from './mcp/bridge-socket-server.js';
import { createSessionActor } from './session/actor.js';
import { spawnPtyAgy } from './session/pty-spawn.js';
import { SessionActorError } from './exceptions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BRIDGE_ENTRY = path.join(__dirname, 'mcp', 'bridge-entry.js');

const DEFAULT_REAP_GRACE_MS = 5_000;
const DEFAULT_TOOL_CALL_DEADLINE_MS = 90_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;

/**
 * One session's live resources.
 *
 * Cohesion exception (manifesto §Class & function design): 4 fields, single
 * conceptual unit — one active agy session's lifecycle handles. Created,
 * accessed, and torn down together. Alternative (4 parallel Maps keyed by
 * sessionId) would spread the invariant "these 4 always travel together"
 * across the module without any independent reason to change them separately.
 */
function makeResources(actor, socketServer, child, dirs) {
  return Object.freeze({ actor, socketServer, child, dirs });
}

/**
 * Registry config bundle.
 *
 * Cohesion exception: all fields configure "how this registry provisions and
 * manages sessions" — agyPath + sshHost (spawn target), model (default display
 * name), runtimeDir + realGeminiDir (filesystem roots), 3 timing knobs. No
 * two fields have independent reason to change relative to the others.
 */
function buildCfg(config, probe) {
  const agyPath = resolveAgyBinary(config?.agyPath, probe);
  return Object.freeze({
    agyPath,
    sshHost: config?.sshHost,
    model: config?.model ?? 'Gemini 3.1 Pro',
    realGeminiDir: config?.realGeminiDir ?? path.join(os.homedir(), '.gemini'),
    runtimeDir: config?.runtimeDir ?? path.join(os.tmpdir(), 'ccb-agy'),
    toolCallDeadlineMs: config?.toolCallDeadlineMs ?? DEFAULT_TOOL_CALL_DEADLINE_MS,
    readyTimeoutMs: config?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    reapGraceMs: config?.reapGraceMs ?? DEFAULT_REAP_GRACE_MS,
  });
}

/** Convert Anthropic-format tool def to MCP inputSchema shape. */
function normalizeTool(tool) {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.input_schema ?? tool.inputSchema ?? {},
  };
}

/**
 * Wait for child to exit within graceMs, then SIGKILL if still alive.
 * No arbitrary sleeps — waits on the 'close' event with a bounded deadline.
 */
function waitForChildExit(child, graceMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }

    let timer = null;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };

    child.once('close', done);

    timer = setTimeout(() => {
      child.removeListener('close', done);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }, graceMs);
  });
}

async function provision(cfg, sessions, sessionId, { model, prompt, tools }) {
  const resolvedModel = model ?? cfg.model;
  const runtimeDir = cfg.runtimeDir;
  const homeDir = path.join(runtimeDir, 'homes', sessionId);
  const sandboxDir = path.join(runtimeDir, 'sandboxes', sessionId);

  const mcpConfig = buildMcpConfig({
    bridgeCommand: process.execPath,
    bridgeArgs: [BRIDGE_ENTRY],
    sessionId,
    runtimeDir,
  });
  const provisioned = provisionSessionHome({
    homeDir,
    realGeminiDir: cfg.realGeminiDir,
    sandboxDir,
    geminiMd: buildGeminiMd(),
    permissionsSettings: buildPermissionsSettings({}),
    mcpConfig,
  });

  const actorRef = { current: null };
  const socketServer = createBridgeSocketServer({
    socketPath: socketPathForSession(sessionId, runtimeDir),
    listTools: () => (tools ?? []).map(normalizeTool),
    onToolCall: (call) => {
      actorRef.current.submit({
        kind: 'mcp-tool-call',
        mcpId: call.mcpId,
        name: call.name,
        arguments: call.arguments,
      });
    },
    onFinalAnswer: (text) => {
      actorRef.current.submit({ kind: 'mcp-final-answer', text });
    },
  });

  // Actor BEFORE start(): a tool call between start() and actorRef assignment
  // would deref null. start() opens the socket only after the actor is wired.
  actorRef.current = createSessionActor({
    server: socketServer,
    config: { toolCallDeadlineMs: cfg.toolCallDeadlineMs },
  });
  socketServer.start();

  const env = {
    ...process.env,
    HOME: provisioned.home,
    CCB_AGY_SESSION_ID: sessionId,
    CCB_AGY_RUNTIME_DIR: runtimeDir,
    PATH: `${agyDir(cfg.agyPath)}:${process.env.PATH}`,
  };

  let spawnResult;
  try {
    spawnResult = await spawnPtyAgy({
      agyPath: cfg.agyPath,
      model: resolvedModel,
      prompt,
      sandboxDir,
      env,
      server: socketServer,
      sshHost: cfg.sshHost,
      readyTimeoutMs: cfg.readyTimeoutMs,
    });
  } catch (err) {
    socketServer.stop();
    throw err;
  }

  const resources = makeResources(
    actorRef.current,
    socketServer,
    spawnResult.child,
    { homeDir, sandboxDir },
  );

  // Wire onDeath: agy exiting triggers reap (best-effort, idempotent).
  spawnResult.onDeath(() => {
    reapEntry(cfg, sessions, sessionId, new SessionActorError('agy process exited')).catch(() => {});
  });

  return resources;
}

async function reapEntry(cfg, sessions, sessionId, reason) {
  const existing = sessions.get(sessionId);
  if (!existing) {
    return; // Already reaped or never provisioned.
  }
  sessions.delete(sessionId);

  let resources;
  try {
    resources = await existing;
  } catch {
    return; // Provision failed — nothing to tear down.
  }

  const { actor, socketServer, child } = resources;

  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  await waitForChildExit(child, cfg.reapGraceMs);
  actor.stop(reason ?? new SessionActorError('session reaped'));
  socketServer.stop();
}

/**
 * Create the actor registry.
 *
 * @param {object} deps
 * @param {object} deps.config - { agyPath?, sshHost?, model?, realGeminiDir?,
 *   runtimeDir?, toolCallDeadlineMs?, readyTimeoutMs?, reapGraceMs? }
 * @param {object} [deps.probe] - binary-resolution seam (tests only).
 */
export function createActorRegistry({ config, probe }) {
  const cfg = buildCfg(config, probe);
  const sessions = new Map();

  async function ensure(sessionId, opts) {
    const existing = sessions.get(sessionId);
    if (existing) {
      const res = await existing;
      return res.actor;
    }

    const promise = provision(cfg, sessions, sessionId, opts);
    sessions.set(sessionId, promise);

    let resources;
    try {
      resources = await promise;
    } catch (err) {
      sessions.delete(sessionId);
      throw err;
    }

    sessions.set(sessionId, resources);
    return resources.actor;
  }

  function get(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    if (typeof entry.then === 'function') return null;
    return entry.actor;
  }

  async function reap(sessionId, reason) {
    return reapEntry(cfg, sessions, sessionId, reason);
  }

  async function reapAll(reason) {
    const ids = [...sessions.keys()];
    await Promise.all(ids.map((id) => reapEntry(cfg, sessions, id, reason)));
  }

  function scanOrphans() {
    // Startup GC: unlink stale per-session sockets left by a prior crashed run.
    // Bounded, never throws (a scan failure must not abort startup).
    try {
      const runtimeDir = cfg.runtimeDir;
      const entries = fs.readdirSync(runtimeDir);
      for (const entry of entries) {
        if (!entry.startsWith('ccb-agy-bridge-') || !entry.endsWith('.sock')) continue;
        const sessionId = entry.slice('ccb-agy-bridge-'.length, -'.sock'.length);
        if (sessions.has(sessionId)) continue;
        try { fs.rmSync(path.join(runtimeDir, entry), { force: true }); } catch { /* best-effort */ }
      }
    } catch { /* bounded, never throws */ }
  }

  return { ensure, get, reap, reapAll, scanOrphans };
}
