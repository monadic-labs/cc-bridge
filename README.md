# CC-Bridge: High-Fidelity Multi-Provider Proxy for Claude Code

`@monadic-labs/ccb` (CC-Bridge) is a local HTTP proxy that sits between the [Claude Code CLI](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) and upstream LLM providers. It is an **Anthropic-protocol-native** infrastructure layer that lets you use multiple providers while preserving your official session context.

## Why this exists

The Claude CLI is natively configured to speak to `api.anthropic.com`. CC-Bridge leverages Anthropic's supported `ANTHROPIC_BASE_URL` to route requests dynamically, solving two critical problems:

1.  **OAuth Preservation:** Unlike other proxies that force you to replace all authentication with API keys, CC-Bridge preserves your native OAuth session for official models.
2.  **Stable History:** Ensure your conversation history remains valid and stable even when switching between different providers and models mid-session.

The CLI remains totally unmodified. Everything is handled by invoking `ccb` instead of `claude`.

## Quick start

```sh
# 1. Install
npm install -g @monadic-labs/ccb

# 2. Initialize config directory
ccb --x-init

# 3. Add a provider (example: an Anthropic-compatible endpoint with your own API key)
ccb --x-provider add my-mirror https://api.anthropic-mirror.example.com/v1

# 4. Add a model to that provider
ccb --x-route add model my-sonnet my-mirror.claude-sonnet-4-6

# 5. Set your API key for the provider
ccb --x-key set my-mirror sk-ant-your-key-here

# 6. Use it
ccb --model my-sonnet -p "Hello, which model are you?"
```

That's it. The proxy daemon starts automatically in the background. When you quit, it shuts itself down.

## How it works

```
ccb --model my-sonnet
       |
       v
  Claude CLI (ANTHROPIC_BASE_URL -> localhost:9099)
       |
       v
  CC-Bridge proxy daemon
       |
       +-- model matches providers.json --> custom endpoint (API key injected)
       |
       +-- no match ----------------------> api.anthropic.com (OAuth pass-through)
```

1.  `ccb` ensures the proxy daemon is alive on `localhost:9099`.
2.  It launches your real `claude` CLI with `ANTHROPIC_BASE_URL` pointed at the proxy.
3.  Matched requests are routed to your configured endpoint. Unmatched requests go straight to Anthropic.
4.  When you quit, the daemon detects inactivity and shuts itself down.

---

## Installation

```sh
npm install -g @monadic-labs/ccb
```

This registers both `ccb` and `cc-bridge` as global commands. Use whichever you like.

### Command conflict?

If `ccb` is already taken on your system, just use the long name:

```sh
cc-bridge --model custom-model
```

Or alias it yourself:

```sh
alias mycc="cc-bridge"
```

---

## Configuration

Everything lives in `~/.claude/.ccb/`. Run the setup command first:

```sh
ccb --x-init
```

### providers.json

Defines which providers and routes are available. Edit by hand or use the CLI commands below.

```json
{
  "providers": {
    "my-mirror": {
      "url": "https://api.anthropic-mirror.example.com/v1",
      "anthropicCompliant": true
    },
    "z": {
      "url": "https://api.z.ai/api/anthropic",
      "anthropicCompliant": false
    }
  },
  "routes": {
    "models": {
      "my-sonnet": "my-mirror.claude-sonnet-4-6",
      "my-opus": "my-mirror.claude-opus-4-6",
      "*haiku*": {
        "target": "z.glm-4.7",
        "fallback": ["my-mirror.claude-haiku-3-5"]
      },
      "*sonnet*": {
        "target": "z.glm-5",
        "fallback": ["z.glm-4.7"]
      }
    },
    "properties": {
      "thinking": "z.glm-5.1"
    },
    "payloadSize": {
      ">102400": "my-mirror.claude-opus-4-6"
    }
  }
}
```

#### Providers

*   **providers** — Object keyed by provider ID. Each provider has:
    *   **url** — The upstream API endpoint.
    *   **anthropicCompliant** — Set to `false` for endpoints that don't speak the Anthropic API format.
    *   **apiKey** — (Optional) `"ENV:VAR_NAME"` to load the API key from an environment variable.

#### Routes

All routing lives under `routes`. Targets use `"provider.model"` dot notation. Unmatched requests go to `api.anthropic.com` (OAuth passthrough).

*   **routes.models** — Match by model name. Keys are model names or wildcard patterns.
    *   Plain keys (`"my-sonnet"`) match exactly. Value can be a bare string target or an object with `target` and optional `fallback`.
    *   Wildcard keys (`"*haiku*"`) match any model name containing the pattern. This is how you catch subagent delegation -- Claude Code sends `claude-sonnet-4-6` or `claude-3-5-haiku-*` when delegating to background agents.
*   **routes.properties** — Match if the request body contains a specific top-level key.
    *   `"thinking"` — Extended thinking / reasoning tasks.
    *   `"stream"` — Streaming requests.
    *   `"max_tokens"` — Long-output requests.
*   **routes.payloadSize** — Match by byte size of the `messages` array. Keys like `">102400"` use operator prefixes.
*   **fallback** — (Optional) Array of `"provider.model"` targets. If the primary upstream returns 4xx/5xx, the proxy retries on the first fallback. Fallbacks chain up to depth 3.

### Common routing patterns

Route subagent tasks away from Anthropic (e.g. expired subscription):
Claude Code delegates to haiku/sonnet for background tasks. Wildcard patterns catch these before they reach `api.anthropic.com`.
```json
"*haiku*": { "target": "z.glm-4.7", "fallback": ["my-mirror.claude-haiku-3-5"] },
"*sonnet*": { "target": "z.glm-5", "fallback": ["z.glm-4.7"] }
```

Route thinking/reasoning tasks:
```json
"thinking": "z.glm-5.1"
```

Route large conversations:
```json
">102400": "my-mirror.claude-opus-4-6"
```

### API keys

Use the CLI to set keys -- it handles the `.env` file for you:
```sh
ccb --x-key set my-mirror sk-ant-your-key-here
```
Keys are stored in `~/.claude/.ccb/.env` (created with mode 0600 on Unix) and loaded by the proxy on startup and hot-reload. Never put real keys in `providers.json`.

### config.json

Port, daemon timing, and logging settings. Created automatically by `--x-init`. All fields must be explicitly defined -- no silent defaults.

| Field | Default | Description |
| :--- | :--- | :--- |
| `port` | 9099 | Port the proxy daemon listens on |
| `anthropicBaseUrl` | `"https://api.anthropic.com"` | Base URL for unmatched (Anthropic) requests. Override for enterprise gateways or VPC endpoints. |
| `daemon.healthCheckTimeoutMs` | 500 | Socket timeout (ms) for health-check probes during startup |
| `daemon.pollIntervalMs` | 300 | Interval (ms) between startup health-check retries |
| `daemon.pollMaxAttempts` | 10 | Maximum number of startup health-check retries |
| `daemon.upstreamTimeoutMs` | 600000 | Inactivity timeout (ms) on the upstream connection — fires only if the upstream goes silent for this duration. Matches the Anthropic SDK's 10-minute default. Set to 0 to disable. |
| `logging.enabled` | true | Enable/disable all logging |
| `logging.requests` | true | Log request summaries |
| `logging.responses` | true | Log response summaries |
| `logging.history` | 5 | Number of recent requests kept in memory for error context |
| `logging.maxBodyLog` | 10000 | Maximum characters of body to include in debug logs |
| `logging.level` | "info" | Log level: "info", "debug", or "trace" |
| `compression.recompressRequests` | true | Re-compress request bodies after sanitization if the original was compressed |

---

## Usage

Replace `claude` with `ccb` in your terminal:

```sh
# Interactive session with a custom model
ccb --model my-sonnet

# Inline task with official Claude Sonnet (pass-through to api.anthropic.com)
ccb --model sonnet -p "Write a python script to parse logs."

# The proxy daemon auto-starts in the background!
```

### Behind the scenes:
1.  `ccb` checks if the proxy daemon is alive on `localhost:9099`.
2.  If not, it spawns one as a detached background process.
3.  It launches your real `claude` CLI with `ANTHROPIC_BASE_URL` pointed at the proxy.
4.  When you quit, the daemon notices and shuts itself down.

---

## CLI management

### Provider management
```sh
ccb --x-provider add myapi https://api.example.com/v1
ccb --x-provider add myapi https://api.example.com/v1 --non-compliant
ccb --x-provider remove myapi
```

### Route management
```sh
# Add an exact model route
ccb --x-route add model my-sonnet myapi.claude-sonnet-4-6

# Add a wildcard route with fallback
ccb --x-route add model "*haiku*" z.glm-4.7 --fallback myapi.claude-haiku-3-5

# Add a property route (detects thinking/reasoning tasks)
ccb --x-route add property thinking z.glm-5.1

# Add a payload size route (large context > 100KB)
ccb --x-route add payloadSize 102400 myapi.claude-opus-4-6 --operator ">"

# List all routes
ccb --x-route list

# Show route tree
ccb --x-route tree

# Remove a route by name
ccb --x-route remove "*haiku*"
```

### API key management
```sh
ccb --x-key set my-mirror sk-ant-your-key-here
ccb --x-key list
ccb --x-key list --reveal
ccb --x-key remove my-mirror
ccb --x-key prune          # removes orphaned keys from .env
```

### Housekeeping
```sh
ccb --x-init               # initialize/re-sync config directory
ccb --x-killall            # kill all background proxy + claude processes
ccb --x-clearlogs          # delete all log files in the logs directory
ccb --x-help               # show help
```

---

## Features

*   **Protocol Fidelity.** As an Anthropic-native proxy, it does not translate between API formats. Requests arrive at the provider as Claude Code sent them.
*   **Official OAuth Isolation.** The Anthropic OAuth token is forwarded to official endpoints. It is stripped before a request reaches a custom provider.
*   **Subagent Routing.** Detect Claude Code's delegated haiku/sonnet tasks via wildcard rules and route them to your preferred provider.
*   **Per-Rule Fallback.** Each routing rule can declare a fallback provider. If the primary upstream fails (4xx/5xx), the proxy automatically retries on the fallback. Fallbacks chain up to depth 3.
*   **Stable Model Switching.** Switch between official models and custom mirrors without session instability.
*   **Hot Reload.** Edit `providers.json` and the daemon picks up changes -- no session restarts required.
*   **Ephemeral Lifecycle.** The daemon features an event-driven auto-shutdown; it lives as long as the CLI session is active.
*   **Zero Runtime Dependencies.** Only Node.js built-ins. No external package overhead.

---

## Disclaimer

CC-Bridge is an independent, community-built network utility. It is not affiliated with, endorsed by, or connected to Anthropic in any way.

This tool is designed solely for legitimate model routing. The user assumes total and exclusive liability for ensuring their use of CC-Bridge complies with the Terms of Service of every upstream API provider they configure.

### How CC-Bridge handles authentication

There are two traffic paths, and they are strictly isolated:

1.  **Official Claude models (OAuth path):** When a request targets an official Anthropic model (no match in `providers.json`), CC-Bridge forwards the request unchanged to `api.anthropic.com`. The OAuth token originates from and is consumed by the official `claude` CLI. CC-Bridge does not extract, store, decrypt, replay, or independently use the OAuth token in any way. It acts as a transparent localhost network hop -- functionally identical to a corporate proxy, VPN, or Anthropic's own documented `ANTHROPIC_BASE_URL` support for proxy gateways.
2.  **Custom provider models:** When a request matches a custom provider, CC-Bridge strips the OAuth token entirely (`authorization` header is deleted) and injects a separate API key (`x-api-key`) that the user provides themselves. The OAuth token never reaches any third-party endpoint.

### Anthropic Terms of Service

Anthropic's Consumer Terms of Service state:
> OAuth authentication (used with Free, Pro, and Max plans) is intended exclusively for Claude Code and Claude.ai. Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service -- including the Agent SDK -- is not permitted and constitutes a violation of the Consumer Terms of Service.

CC-Bridge does not use OAuth tokens in "another product." The token is used by the official `claude` CLI, through that CLI's own HTTP request. CC-Bridge is a network intermediary on localhost, not a separate client.

This legal characterization has not been tested or validated by Anthropic. Anthropic may update their Terms of Service at any time to address localhost proxies, `ANTHROPIC_BASE_URL` usage, or similar patterns. Users should actively monitor Anthropic's legal documentation for changes -- CC-Bridge does not receive legal update notifications.

[https://www.anthropic.com/legal/consumer-terms](https://www.anthropic.com/legal/consumer-terms)

Use is at your own discretion and sole risk.

### Misuse

Any misuse of knowledge of this tool's implementation -- including but not limited to token extraction, credential replay, unauthorized API access, or circumvention of provider rate limits or access controls -- is not endorsed, not supported, and explicitly disclaimed by the authors. The tool is provided as-is for legitimate routing of requests between a user's own accounts.

---

## License

ISC License

Copyright (c) 2026 @monadic-labs

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
