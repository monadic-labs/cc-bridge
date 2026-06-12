# AGENTS.md — CC-Bridge internal architecture reference

This file is for AI agents and contributors working inside this repo. For user-facing
usage, configuration, and CLI reference, see [README.md](./README.md).

---

## Purpose

`@monadic-labs/ccb` (CC-Bridge) is a local HTTP proxy that sits between the Claude Code
CLI and upstream LLM providers. It is **Anthropic-protocol-native**: requests from Claude
Code arrive at the proxy unchanged and are forwarded without format translation on the
default (Anthropic OAuth) path. Custom provider routes apply extension-based transforms
(sanitization, format conversion, etc.) before forwarding. OAuth tokens are stripped
before any request reaches a custom provider and are never stored or replayed.

---

## Entry points

| File | Role |
|---|---|
| `bin/ccb.js` | CLI entry point — parses management flags, starts/checks the daemon, then spawns `claude` with `ANTHROPIC_BASE_URL` |
| `bin/ccb-watchdog.js` | Daemon supervisor — forks the worker process (`src/proxy.js`), owns the IPC socket, handles graceful restart and crash recovery |
| `src/proxy.js` | Worker entry point — creates the HTTP server; passes control to `proxy-core.js` in worker mode |
| `src/proxy-core.js` | Core orchestrator — wires config, providers, extensions, routing policy, logger, auth gate, and the HTTP request handler |
| `bin/ccb-capture.js` | Standalone capture tool — stands up a lightweight proxy that records requests to disk, then optionally launches `claude` |

---

## Request lifecycle

```
Claude CLI → HTTP POST /v1/messages
  → proxy-core: auth gate (loopback check + bearer/cookie)
  → proxy-request.handleRequestEnd
      → decompress body (compression.js)
      → proxy-routing.processRequestBody
          → routing.js: applyRoutingWithMatch / routeToAnthropic / routeToProvider
          → routing-rules.js: policy.evaluateWithRule (exact, wildcard, property, payloadSize)
          → api-key-resolver.js: requireProviderApiKey (ProviderApiKeyError on missing env var)
          → extensions: transformRequest (sanitization, non-compliant-transform, web-search-zai, etc.)
      → recompress if needed (compression.js)
  → proxy-upstream.forwardToUpstream
      → HTTP/HTTPS to upstream
      → SseResponseTransformer (sse-transformer.js) for streaming — chunks forwarded live
      → non-SSE non-error: passthrough chunked to client immediately (no buffer wait)
      → on 4xx/5xx: fallback-handler.js checks rule.hasFallback → retry on fallback chain (depth ≤ 3)
  → proxy-response.handleResponseEnd
      → decompress response, log, accumulate tokens, close connection
```

---

## Module map — `src/core/`

### Config and startup
| Module | One-line role |
|---|---|
| `config.js` | Parses and validates `config.json`; exports `ProxyConfig` and `loadConfigFromFile` |
| `config-cache.js` | `ConfigCache` — eager initial load (fail-loud at startup); `tryRefresh()` is best-effort for hot-reload |
| `config-adapter.js` | Format adapter — detects v1/v2 config, normalizes to internal shape; `parseTarget("provider.model")` |
| `constants.js` | Package-wide string constants (filenames, dir names, version, watchdog script name) |
| `daemon-constants.js` | IPC socket path resolver (platform-aware: named pipe on Windows, Unix socket otherwise) |
| `migrator.js` | `ensureCompleteProviders` / `ensureCompleteConfig` — fills missing fields from defaults |
| `watchdog-state.js` | `WatchdogState` value object — encapsulates the watchdog's nine lifecycle fields behind named transition methods |

### Routing and providers
| Module | One-line role |
|---|---|
| `providers.js` | `ProviderConfig`, `ProvidersMap`, `providerIdToEnvKey` — provider registry and model resolution |
| `routing.js` | `routeToAnthropic`, `routeToProvider`, `applyRoutingWithMatch`, `applyAuthHeaders`, `extractSessionId` |
| `routing-rules.js` | `buildRoutingPolicy` — compiles `providers.json` routes into a typed `RoutingPolicy`; supports exact, wildcard (`*pat*`), property, payloadSize, and pool rules |
| `rule-manager.js` | CRUD helpers for route rules (used by `--x-route` CLI commands) |
| `model-manager.js` | CRUD helpers for provider + route entries (used by `--x-provider`, `--x-route`) |
| `api-key-resolver.js` | `requireProviderApiKey` — reads env var from `process.env`; throws `ProviderApiKeyError` (HTTP 400) when unset |
| `fallback-handler.js` | `shouldAttemptFallback`, `resolveFallbackMatch`, `buildFallbackRequest` — fallback chain logic |

### Request / response pipeline
| Module | One-line role |
|---|---|
| `proxy-request.js` | `handleRequestEnd` — orchestrates decompress → route → compress → forward |
| `proxy-routing.js` | `resolveRouting`, `processRequestBody` — pure routing resolution injected into `proxy-request` |
| `proxy-upstream.js` | `forwardToUpstream` — HTTP/HTTPS forwarding, retry loop, SSE streaming, fallback dispatch |
| `proxy-response.js` | `handleResponseEnd` — decompress response, log, token accumulation, close |
| `sse-transformer.js` | `SseResponseTransformer` — per-chunk SSE transform with metadata accumulator (tokens, model) |
| `sse-parser.js` | `parseSseMetadata` — end-of-stream token extraction from buffered SSE body |
| `compression.js` | `decompress` / `compress` — gzip/deflate/br, returns `Result<Buffer>` |
| `headers.js` | Header filtering (hop-by-hop stripping), `copyRequestHeaders`, `filterResponseHeaders`, `redactHeaders` |

### Security
| Module | One-line role |
|---|---|
| `auth-gate.js` | `AuthSecret`, `isLoopbackAddress`, `isAuthorizedRequest`, `buildSetCookieHeader` — admin-route auth (Bearer + HttpOnly cookie) |
| `api-secrets.js` | `redactProviderApiKeys`, `hasLiteralApiKey` — masks literal `apiKey` values in config responses; preserves `ENV:VAR` references |
| `gui-path.js` | `resolveGuiPath` — serves GUI static files; rejects path traversal (`..`, percent-encoded `../`, null bytes) |

### Shared infrastructure
| Module | One-line role |
|---|---|
| `exceptions.js` | Domain exception hierarchy: `ProxyError`, `ConfigError`, `ConfigurationMissingException`, `RoutingError`, `AuthError`, `UpstreamError`, `ProviderApiKeyError`, `SessionInfoError`, etc. |
| `types.js` | Core value objects: `Result<T,E>`, `Option<T>`, `ProxyRequestContext`, `ProxyResponseContext`, `RoutingResult`, `RequestInfo`, `RequestSummary`, `SessionMetrics`, `KeepaliveState` |
| `extension-loader.js` | `discoverExtensions`, `buildRegistry`, `watchExtensions` — scans `src/extensions/`, loads factories, sets up file watcher for hot-reload |
| `extension-registry.js` | `ExtensionRegistry` — ordered hook registry for request transform, SSE chunk transform, fallback, format conversion, load balancing, and lifecycle hooks |
| `ipc-protocol.js` | `serializeIpcMessage` / `parseIpcMessage` — newline-delimited JSON over the control socket (status, keepalive, restart) |
| `env-file.js` | `loadEnv`, `updateEnvKey`, `pruneEnvLines` — reads/writes `~/.claude/.ccb/.env` (mode 0600) |
| `key-manager.js` | `listApiKeys`, `obfuscateKey` — thin wrappers used by `--x-key list` |
| `api-adapter.js` | Pure accessors over the Anthropic request/response shape (`getModel`, `getMessages`, `getSseEventType`, etc.) — isolates field-name coupling |
| `debug-logger.js` | `DebugLogger` — writes raw/sanitized payload dumps to per-session log dirs when `logging.level` is `"trace"` |

### `src/infra/`
| Module | One-line role |
|---|---|
| `process-manager.js` | `spawnDaemon`, `spawnCommand`, `runKill`, `runSync`, `getProcesses` — the only place in `src/` that may call `spawn`/`execSync` directly (enforced by the `no-direct-spawn` ESLint rule) |
| `logger.js` | `Logger` — request/response logging, history ring buffer, per-session log subdirectories |
| `error-reporter.js` | `ErrorReporter` — structured error capture with context; appends to the session error log |
| `gui/app.js` | Express-style handler for the web GUI (`/gui`, `/api/*`) |

---

## Extensions — `src/extensions/`

Extensions register hooks into `ExtensionRegistry`. The loader discovers them by
scanning the directory for `index.js` files with a `createXxxExtension` export.

| Extension | Activation | What it does |
|---|---|---|
| `load-balancer` | `always` | Selects a provider from a named pool using round-robin, least-conn, random, or weighted strategy |
| `openai-format` | `provider-driven` (`extensions.openai-format.providers[*].format = "openai"`) | Converts Anthropic requests to OpenAI chat-completion format and converts OpenAI SSE chunks back |
| `sanitization` | `always` | Converts `thinking`, `redacted_thinking`, and `connector_text` blocks to plain text when routing to providers that don't support them |
| `thinking-sse` | `always` | Converts thinking blocks in live SSE streams to `\`\`\`thinking` fences for providers with `anthropicCompliant=false` |
| `fallback` | `route-driven` | Decides if an HTTP 4xx/5xx or TCP error triggers fallback and builds the fallback request from the rule's declared fallback chain |
| `web-search-zai` | `provider-driven` (`providers[*].toolTransforms.web_search`) | Translates Claude's `web_search` tool format to z.ai's native format and back |
| `non-compliant-transform` | `always` | For `anthropicCompliant=false` providers: strips `betas`, flattens system prompt array to string |

---

## Routing config schema

`~/.claude/.ccb/providers.json` — two top-level keys:

```json
{
  "providers": {
    "<id>": {
      "url": "https://...",
      "anthropicCompliant": true,
      "apiKey": "ENV:MY_KEY"
    }
  },
  "routes": {
    "models": {
      "exact-name": "provider.model",
      "*wildcard*": { "target": "provider.model", "fallback": ["provider.model"] }
    },
    "properties": { "thinking": "provider.model" },
    "payloadSize": { ">102400": "provider.model" }
  }
}
```

- **Provider IDs** must be `[a-z0-9-_]+` (enforced at load and by `--x-provider add`).
- **`apiKey: "ENV:VAR"`** — the proxy reads the named env var at routing time. The value is never stored in `providers.json`. Missing env var raises `ProviderApiKeyError` (HTTP 400).
- **`anthropicCompliant: false`** — activates non-compliant-transform and thinking-sse extensions for that provider.
- **Targets** use `"provider.model"` dot notation. The proxy resolves the provider from the left segment.
- **Wildcard rules** use `*pattern*` glob syntax. They catch delegated haiku/sonnet calls from Claude Code subagents.
- **Fallback chains** — each rule may declare one fallback target; chains recurse to depth 3 (`MAX_FALLBACK_DEPTH`).
- **OAuth passthrough** — requests with no matching rule go to `api.anthropic.com` with the original `Authorization` header intact.
- **Custom provider path** — `authorization` header is stripped; `x-api-key` is injected from the resolved env var.

---

## Custom ESLint rules — `scripts/eslint-rules/`

These rules encode project coding standards and run as part of `npm test`.

| Rule file | What it enforces |
|---|---|
| `no-else.js` | Bans `else` and `else if` — use guard clauses and early returns |
| `no-generic-error.js` | Bans `new Error(...)` in `src/` — use domain exceptions from `src/core/exceptions.js` |
| `no-raw-path-constants.js` | Bans inline string literals for known CC-Bridge path segments — import from `src/core/constants.js` |
| `no-direct-spawn.js` | Bans `spawn`/`execSync`/`execFileSync` in `src/` — route through `src/infra/process-manager.js` |
| `no-hardcoded-sleep.js` | Bans `setTimeout`/`setInterval` with hardcoded delays in `src/` — poll a readiness signal instead |
| `daemon-detached.js` | Requires daemon spawns to set `detached: true`, `stdio: "ignore"`, and call `.unref()` |
| `no-unsafe-command-interpolation.js` | Detects template-literal interpolation of unvalidated variables into shell command strings |

---

## How to run tests

```sh
npm test            # runs ESLint over src/ and bin/, then node src/test.js
npm run test:browser  # Playwright browser integration tests (requires a running proxy)
npm run lint          # lint only
```

`src/test.js` guards against direct invocation: it checks `process.env.npm_lifecycle_event`
and exits with an error if called as `node src/test.js` instead of through `npm test`.
The ESLint pass runs first; test.js only runs when lint is clean.

---

## Key invariants — read before editing

- **No `else` / `else if`** — enforced by `no-else.js`. Use guard clauses and early returns.
- **Domain exceptions only** — never `new Error("...")`. Use the typed hierarchy in `exceptions.js`.
- **No hand-concatenated paths** — use `node:path` `join`/`resolve`. No hardcoded absolute paths in source (enforced by `no-raw-path-constants.js`).
- **No direct spawn** — any process launch must go through `src/infra/process-manager.js`. Direct `spawn`/`execSync` elsewhere is a lint error.
- **No hardcoded sleeps** — poll a deterministic readiness signal. Bounded retry + `ReadinessTimeoutException` is the approved pattern.
- **Config fails loud at startup** — `ConfigCache` constructor calls the loader eagerly; a bad `providers.json` or `config.json` at daemon start is fatal. Hot-reload failures preserve last-known-good state.
- **Admin routes are loopback-gated unconditionally** — `/api/*`, `/gui`, `/__ccb_internal__/*` reject non-loopback peers even when `daemon.bindHost` is `0.0.0.0`.
- **Missing provider API key is a structured error** — `ProviderApiKeyError` (HTTP 400) with the env var name. It is never silently ignored.
- **OAuth token isolation** — the `authorization` header is stripped before any custom-provider request leaves the proxy. The token never reaches a third-party endpoint.

---

## Config and data locations

| Path | Contents |
|---|---|
| `~/.claude/.ccb/providers.json` | Provider definitions and routing rules |
| `~/.claude/.ccb/config.json` | Port, daemon timing, logging settings |
| `~/.claude/.ccb/.env` | Provider API keys (mode 0600 on Unix) |
| `~/.claude/.ccb/logs/` | Per-session and daemon log files |
| `~/.claude/.ccb/runtime.json` | Active port written by the watchdog on startup |
| `~/.claude/.ccb/versions.json` | Registered daemon versions for `--x-version` |
