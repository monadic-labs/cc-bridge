# Changelog

All notable changes to `@monadic-labs/ccb` are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Admin surface hardening: HTTP listener now binds to `127.0.0.1` by default
  (opt-in LAN exposure via `daemon.bindHost: '0.0.0.0'`); `/api/*`, `/gui`,
  and `/__ccb_internal__/*` are loopback-gated unconditionally; a randomly
  generated proxy secret backs an HttpOnly-cookie auth gate with Bearer
  fallback for CLI clients; the `/gui` route resolver rejects path
  traversal (`..`, percent-encoded `../`, null bytes); `GET /api/config`
  redacts literal `apiKey` fields (ENV: references are preserved).
- Routing to a provider whose env var is unset now raises a structured
  `ProviderApiKeyError` (HTTP 400 with the missing env var name) instead
  of silently sending the upstream request with no provider credentials.

### Added
- `--version` honors POSIX convention: prints `@monadic-labs/ccb <semver>`
  and exits 0.
- `daemon.bindHost` config option (default `127.0.0.1`).
- `SessionMetrics` and `KeepaliveState` value objects.
- `WatchdogState` value object encapsulating the daemon supervisor's
  nine lifecycle fields behind named transition methods (no more
  module-level mutable bindings in `bin/ccb-watchdog.js`).
- `ConfigCache` with eager initial load (fail-loud at startup) and
  best-effort `tryRefresh()` for hot-reload.
- SSE metadata accumulator threaded through `SseResponseTransformer` so
  in-flight token counts skip the end-of-stream buffer re-parse.

### Changed
- `--x-use-version <v>` replaces the previous `--version <v>` semantic
  for selecting a specific installed daemon version on passthrough.
- `initProviders()` raises `ConfigError` when `providers.json` is missing
  or malformed at startup; hot-reload preserves last-known-good state.
- `DEFAULT_RAW_PROVIDERS` ships complete `models` + `toolTransforms`
  entries, and `ensureCompleteProviders` fills these per-provider for
  sparse user input.
- Non-SSE non-error responses now stream chunks to the client as they
  arrive instead of buffering until the upstream completes — TTFB
  improves from upstream-completion time to upstream-TTFB time. The
  fallback / retry / SSE / error paths still buffer (they need the full
  body to decide what to do next).
- Integration tests inspect the proxy's session log when the TUI-based
  oracle times out. When the Claude CLI input-buffer race prevents the
  test from sending its prompt at all, the assertion resolves to
  `INCONCLUSIVE` (warning, suite stays green) instead of `FAIL`.

### Removed
- Workspace artifacts (`.claude/`, `.eo.json`, `CODE_MAP.json`,
  `docs/superpowers/`, `eslint.config.js`, `scripts/eslint-rules/`,
  `test-results/`, `test/browser/`, `src/test.js-tail`) no longer ship
  in the published npm tarball. Explicit `files` whitelist:
  `bin/`, `src/`, `scripts/setup-user-dir.js`, `providers.example.json`,
  `README.md`, `LICENSE`, `CHANGELOG.md`.

## [2.0.0] - Unreleased

Initial public release on `@monadic-labs/ccb`. Native Anthropic-protocol
proxy for the Claude Code CLI with v2 provider/route config schema,
loopback-only admin surface, multi-provider OAuth-preserving routing,
and per-session log subdirectories.

[Unreleased]: https://github.com/monadic-labs/cc-bridge/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/monadic-labs/cc-bridge/releases/tag/v2.0.0
