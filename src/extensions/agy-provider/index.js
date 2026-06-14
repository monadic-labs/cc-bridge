/**
 * agy-provider extension for cc-bridge.
 *
 * Routes `agyp:` and `gemini-tool:` prefixed models to Google Gemini via the
 * Antigravity CLI (agy) with full MCP tool-call support. Unlike agy-format
 * (one-shot subprocess per request), agy-provider keeps ONE live agy process
 * per session, wired to the ccb-bridge MCP server. agy calls MCP tools; the
 * actor holds those calls until Claude Code returns tool_results, then
 * resolves them back into agy's loop.
 *
 * Routing:
 *   `agyp:Gemini 3.1 Pro`   → strip prefix → display name "Gemini 3.1 Pro"
 *   `gemini-tool:*`         → strip prefix → display name after colon
 *
 * agy-format (order 50) owns `agy.` and bare `gemini` prefixes; this
 * extension (order 60) handles only the new `agyp:` / `gemini-tool:` space
 * so both can coexist without conflict.
 */

import { ProviderConfig } from '../../core/providers.js';
import { resolveAgyBinary } from '../agy-format/binary-resolver.js';
import { convertRequest } from '../agy-format/converters/request.js';
import { createActorRegistry } from './actor-registry.js';
import { SessionActorError } from './exceptions.js';

const PROVIDER_ID = 'agy-provider';

export const EXTENSION_META = {
  activation: 'always',
  title: 'Antigravity Provider (agy tool-use)',
  description: 'Route to Google Gemini models via agy CLI with full MCP tool-call support',
  configuredBy: 'extensions.agy-provider',
  schema: {
    type: 'object',
    properties: {
      sshHost: { type: 'string', description: 'SSH host where agy is installed (optional — omit for local)' },
      agyPath: { type: 'string', description: 'Path to agy binary (optional — auto-resolved when absent)' },
      model: { type: 'string', description: 'Default agy model display name' },
      realGeminiDir: { type: 'string', description: 'Path to real ~/.gemini for read-only auth symlinks' },
      runtimeDir: { type: 'string', description: 'Per-session runtime dir root (sockets, homes, sandboxes)' },
      toolCallDeadlineMs: { type: 'number', description: 'Per-tool-call deadline in ms' },
      readyTimeoutMs: { type: 'number', description: 'agy MCP readiness timeout in ms' },
    },
  },
};

/**
 * Create the agy-provider extension.
 *
 * @param {object} config      - Extension config from providers.json
 * @param {object} [binaryProbe] - Optional probe seam for binary resolution (tests only).
 * @returns {object} Extension object with hooks
 */
export function createAgyProviderExtension(config = {}, binaryProbe = undefined) {
  // Fail early: resolveAgyBinary throws AgyBinaryNotFoundError when agy is absent.
  // extension-loader catches factory throws and skips the extension cleanly.
  resolveAgyBinary(config.agyPath, binaryProbe);

  // agy authenticates via Google OAuth — satisfy the proxy's requireProviderApiKey check.
  // The proxy derives the key name as providerIdToEnvKey('agy-provider') = 'AGY_PROVIDER_KEY'.
  if (!process.env.AGY_PROVIDER_KEY) {
    process.env.AGY_PROVIDER_KEY = 'local';
  }

  const registry = createActorRegistry({ config, probe: binaryProbe });
  registry.scanOrphans();

  process.on('exit', () => {
    // best-effort: synchronous parts (actor.stop, socket close) run; async parts won't.
    registry.reapAll(new SessionActorError('process exit')).catch(() => {});
  });

  return {
    name: PROVIDER_ID,
    ...EXTENSION_META,

    hooks: {
      /**
       * Claim `agyp:` and `gemini-tool:` model namespaces.
       * agy-format (order 50) retains `agy.` / bare `gemini` — no conflict.
       */
      resolveUnmatched: {
        order: 60,
        resolve: async ({ modelName }) => {
          if (typeof modelName !== 'string' || !modelName) return null;
          if (!modelName.startsWith('agyp:') && !modelName.startsWith('gemini-tool:')) return null;

          const displayName = modelName.startsWith('agyp:')
            ? modelName.slice('agyp:'.length)
            : modelName.slice('gemini-tool:'.length);

          const provider = new ProviderConfig({
            id: PROVIDER_ID,
            url: 'agy-provider://local',
            models: {},
            anthropicCompliant: true,
            toolTransforms: {},
          });

          return { provider, model: displayName, providerId: PROVIDER_ID };
        },
      },

      /**
       * Handle upstream requests via the per-session actor bridge.
       * Writes SSE headers, creates the per-turn sink, and awaits the actor's
       * response (tool_use block or final answer emitted over SSE).
       */
      handleUpstream: {
        order: 60,
        handles: (providerId) => providerId === PROVIDER_ID,
        handle: async ({ body, res, ctx }) => {
          const sessionId = ctx.sessionId || ctx.urlSessionId || 'default';
          const model = body.model ?? config.model ?? 'Gemini 3.1 Pro';
          const prompt = convertRequest(body);
          const tools = Array.isArray(body.tools) ? body.tools : [];

          let actor;
          try {
            actor = await registry.ensure(sessionId, { model, prompt, tools });
          } catch (err) {
            if (ctx.clientAborted) return;
            const errorPayload = JSON.stringify({
              type: 'error',
              error: { type: 'upstream_error', message: `agy-provider session setup failed: ${err.message}` },
            });
            if (!res.headersSent) {
              res.writeHead(500, {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(errorPayload),
              });
            }
            res.end(errorPayload);
            return;
          }

          if (ctx.clientAborted) return;

          // SSE headers written AFTER ensure() so errors before this point can
          // still return structured HTTP error responses (not SSE).
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          });

          let turnDone = false;
          let resolveEnd;
          const ended = new Promise((r) => { resolveEnd = r; });
          const finishTurn = () => {
            if (turnDone) return;
            turnDone = true;
            try { res.end(); } catch { /* already closed (client aborted) */ }
            resolveEnd();
          };
          const sink = {
            // Guard res writability: a reused actor may attempt a second emit after
            // the turn already ended (res finished/closed). Writing to a finished
            // res throws "write after end"; an aborted res is undefined-bound. The
            // sink owns res, so it — not the actor — enforces write safety.
            writeSse: (s) => {
              if (turnDone || res.writableEnded || res.destroyed) return;
              try { res.write(s); } catch { /* client gone mid-write */ }
            },
            end: () => finishTurn(),
          };

          // Safety net: client disconnect resolves ended so this handler doesn't
          // block forever waiting for an actor that will never emit.
          res.on('close', () => resolveEnd());

          actor.setTurnResponse(sink, model);
          actor.submit({
            kind: 'cc-request',
            messages: body.messages ?? [],
            toolResults: extractToolResults(body),
            model,
          });

          await ended;
        },
      },
    },
  };
}

/**
 * Extract tool_result blocks from the last user message in the request.
 * These are the Claude Code responses to a prior tool_use block; the actor
 * resolves any held MCP calls against them.
 */
function extractToolResults(body) {
  if (!Array.isArray(body.messages)) return [];
  const last = body.messages.at(-1);
  if (!last || last.role !== 'user') return [];
  if (!Array.isArray(last.content)) return [];
  return last.content.filter((block) => block.type === 'tool_result');
}
