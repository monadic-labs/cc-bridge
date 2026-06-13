/**
 * agy-format extension for cc-bridge.
 *
 * Provides access to Google Gemini models through the Antigravity CLI (`agy`).
 * Uses the `handleUpstream` hook to intercept the proxy's HTTP forward and
 * handle requests directly via CLI subprocess calls.
 *
 * Routing:
 *  - `agy.Gemini 3.1 Pro`     -> dot-notation, resolves to agy display name
 *  - `gemini-3.1-pro`         -> fuzzy match against discovered models
 *
 * Configuration (in providers.json extensions section):
 *  - sshHost: (optional) SSH host — only when agy is on a REMOTE machine.
 *             When omitted (the default), agy runs locally via bash -c.
 *  - agyPath: (optional) explicit path to agy binary; auto-resolved when absent.
 *  - cacheTtlMs: model discovery cache TTL (default: 300000)
 *  - requestTimeoutMs: per-request agy subprocess timeout (default: 120000)
 */

import { ProviderConfig } from '../../core/providers.js';
import { execCommand } from '../../infra/process-manager.js';
import { ModelResolver } from './model-resolver.js';
import { buildAgyInvocation } from './invocation-builder.js';
import { resolveAgyBinary, agyDir } from './binary-resolver.js';
import { convertRequest } from './converters/request.js';
import { convertFullResponse, buildSseStream } from './converters/response.js';

const PROVIDER_ID = 'agy';
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

/**
 * Strip ANSI escape codes from a string.
 * Builds regex from char codes to avoid no-control-regex lint violations.
 */
function stripAnsi(str) {
  const e = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  const csi = new RegExp(e + '\\[[0-9;]*[a-zA-Z]', 'g');
  const osc = new RegExp(e + '\\][\\s\\S]*?(?:' + bel + '|' + e + '\\\\)', 'g');
  return str.replace(csi, '').replace(osc, '');
}

export const EXTENSION_META = {
  activation: 'always',
  title: 'Antigravity (agy)',
  description: 'Route to Google Gemini models via the agy CLI tool',
  configuredBy: 'extensions.agy-format',
  schema: {
    type: 'object',
    properties: {
      sshHost: { type: 'string', description: 'SSH host where agy is installed (optional — omit for local execution)' },
      agyPath: { type: 'string', description: 'Path to agy binary (optional — auto-resolved when absent)' },
      cacheTtlMs: { type: 'number', description: 'Model discovery cache TTL in ms' },
      requestTimeoutMs: { type: 'number', description: 'Per-request agy timeout in ms' },
    },
  },
};

/**
 * Create the agy-format extension.
 *
 * @param {object} config - Extension config from providers.json
 * @param {object} [binaryProbe] - Optional probe seam for binary resolution (tests only).
 * @returns {object} Extension object with hooks
 */
export function createAgyFormatExtension(config = {}, binaryProbe = undefined) {
  // Satisfy the proxy's requireProviderApiKey check — agy uses its own Google auth
  if (!process.env.AGY_KEY) {
    process.env.AGY_KEY = 'local';
  }

  // sshHost is optional — absent means local execution (default)
  const sshHost = config.sshHost ?? undefined;
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  // Resolve agy binary: explicit config > PATH > OS fallback > fail loud
  const resolvedAgyPath = resolveAgyBinary(config.agyPath, binaryProbe);
  const resolvedAgyDir = agyDir(resolvedAgyPath);

  const resolver = new ModelResolver({
    sshHost,
    agyPath: resolvedAgyPath,
    cacheTtlMs: config.cacheTtlMs,
  });

  // Trigger initial model discovery (async, non-blocking)
  resolver.discover();

  /**
   * Execute agy with a prompt and model, return the text output.
   */
  async function executeAgy(displayName, prompt) {
    const escapedModel = displayName.replace(/'/g, "'\"'\"'");
    const escapedPrompt = prompt.replace(/'/g, "'\"'\"'");

    const shellCommand = `export PATH=${resolvedAgyDir}:$PATH; script -qec "agy --model '${escapedModel}' -p '${escapedPrompt}'" /dev/null`;
    const { cmd, args } = buildAgyInvocation(shellCommand, sshHost);

    const raw = await execCommand(cmd, args, {
      timeout: requestTimeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });

    return stripAnsi(raw);
  }

  return {
    name: 'agy-format',
    ...EXTENSION_META,

    hooks: {
      /**
       * Resolve unmatched model names to the agy provider.
       * Matches "agy.*" (dot-notation) and "gemini*" (fuzzy) patterns.
       */
      resolveUnmatched: {
        order: 50,
        resolve: async ({ modelName }) => {
          if (typeof modelName !== 'string' || !modelName) return null;

          // Ensure discovery has run
          await resolver.discover();

          let resolved = null;

          // Dot-notation: "agy.Gemini 3.1 Pro" -> use suffix as display name directly
          if (modelName.startsWith('agy.')) {
            const displayName = modelName.slice(4);
            const match = resolver.resolve(displayName);
            if (match) {
              resolved = match;
            }
            if (!resolved) {
              resolved = { displayName, normalizedName: modelName };
            }
          }

          // Prefix match: "gemini-3.1-pro" -> fuzzy match discovered models
          if (!resolved && modelName.startsWith('gemini')) {
            resolved = resolver.resolve(modelName);
          }

          if (!resolved) return null;

          const provider = new ProviderConfig({
            id: PROVIDER_ID,
            url: 'agy://local',
            models: {},
            anthropicCompliant: true,
            toolTransforms: {},
          });

          return { provider, model: resolved.displayName, providerId: PROVIDER_ID };
        },
      },

      /**
       * Handle upstream requests directly by spawning agy CLI.
       * Bypasses HTTP forwarding entirely.
       */
      handleUpstream: {
        order: 50,
        handles: (providerId) => providerId === PROVIDER_ID,
        handle: async ({ body, res, ctx }) => {
          const model = body.model ?? 'unknown';
          const isStream = body.stream === true;

          try {
            const prompt = convertRequest(body);
            const agyOutput = await executeAgy(model, prompt);

            if (ctx.clientAborted) return;

            if (isStream) {
              const sseData = buildSseStream(agyOutput, { model });
              res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                'connection': 'keep-alive',
              });
              res.write(sseData);
              res.end();
              return;
            }

            const response = convertFullResponse(agyOutput, { model });
            const payload = JSON.stringify(response);
            res.writeHead(200, {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            });
            res.end(payload);
          } catch (err) {
            if (ctx.clientAborted) return;

            const message = err.killed
              ? `agy request timed out after ${requestTimeoutMs}ms`
              : `agy execution failed: ${err.message}`;

            const errorPayload = JSON.stringify({
              type: 'error',
              error: { type: 'upstream_error', message },
            });

            if (!res.headersSent) {
              res.writeHead(400, {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(errorPayload),
              });
            }
            res.end(errorPayload);
          }
        },
      },
    },
  };
}
