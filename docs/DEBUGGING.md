# CC-Bridge — Debugging & Verification Guide

Operational guide for inspecting what the proxy actually sends upstream, verifying
routing/OAuth, and answering "is the proxy costing me extra tokens?". Written from a
live verification run on 2026-06-11 (z.ai glm-4.7 + Anthropic sonnet/haiku passthrough).

## 1. Config location

Everything lives in `~/.claude/.ccb/`:

| File | Purpose |
| :--- | :--- |
| `config.json` | port, daemon timing, logging level, retry/compression |
| `providers.json` | provider list + per-provider `models` map (exact routes) |
| `.env` | API keys referenced by `ENV:VAR_NAME` (e.g. `ZAI_KEY`) |
| `logs/<session-id>/` | per-session request log + trace payloads |
| `logs/daemon.log`, `logs/daemon.err` | detached worker stdout/stderr |

## 2. Enabling logs

Edit `~/.claude/.ccb/config.json` → `logging`:

```jsonc
"logging": {
  "level": "trace",      // "info" | "debug" | "trace"
  "maxBodyLog": 200000,  // 0 = bodies not logged; raise to capture full bodies
  ...
}
```

Log levels (see `src/core/debug-logger.js`):
- **info** — request/response summary lines only.
- **debug** — also dumps `raw`/`sanitized` payloads on errors.
- **trace** — dumps `raw` (received from claude) and `sanitized` (forwarded upstream)
  payloads for **every** request to `logs/<session>/debug-<reqId>.{raw,sanitized}.json`.

The daemon hot-reloads `config.json`; no restart needed. After debugging, restore the
original (`level: "info"`, `maxBodyLog: 0`) — trace writes the full request body
(system prompt, your CLAUDE.md, prompts) to disk in plaintext.

Reset the daemon if it wedges: `node bin/ccb.js --x-killall` (or `npm run killall`).

## 3. Verifying token overhead (the "proxy costs more" question)

The proxy is a transparent forwarder on a **compliant** provider path. To prove it adds
no tokens, diff the received body against the forwarded body:

```sh
SESS=<session-id-from-summary>
python3 - <<'PY'
import json
raw=json.load(open(f'.../logs/{SESS}/debug-2.raw.json'))
san=json.load(open(f'.../logs/{SESS}/debug-2.sanitized.json'))
diffs=[k for k in set(raw)|set(san) if k!='model'
       and json.dumps(raw.get(k),sort_keys=True)!=json.dumps(san.get(k),sort_keys=True)]
print('fields differing besides model:', diffs or 'NONE')
print('bytes:', len(json.dumps(raw)), '->', len(json.dumps(san)))
PY
```

**Finding (2026-06-11):** for z.ai (`anthropicCompliant: true`), the forwarded body is
byte-identical to the received body except the `model` field is rewritten to the real
upstream model. The internal `_ccbSanitizationReport` field is stripped before forwarding
(`src/core/routing.js` `routeToProvider`). No token inflation.

The reason a trivial prompt still shows ~50k–200k tokens is **Claude Code's own context**
(system prompt + full tool schemas + every CLAUDE.md). That payload is identical whether
you run `ccb` or a plain `claude` with `ANTHROPIC_BASE_URL` pointed at z.ai. To cut tokens,
trim CLAUDE.md and reduce enabled MCP tools — the proxy is not the lever.

Where sanitization *would* change bytes: a **non-compliant** provider
(`anthropicCompliant: false`) converts thinking/redacted_thinking blocks to text and strips
`cache_control` (`src/extensions/sanitization/index.js`). On a compliant provider those are
no-ops, so signed thinking blocks pass through unchanged.

## 4. Reading the session summary

Printed on `ccb` exit and in `logs/<session>/session.log`:

```
#8 Anthropic (claude-sonnet-4-6) | 200 | 2070ms | in:3 out:11
#6 Provider (exact:glm-4.7→glm-4.7) | 200 | 8829ms | in:0 out:103
```

- `Anthropic (...)` = OAuth passthrough to `api.anthropic.com` (no model match).
- `Provider (exact:id→model)` = routed to a custom provider with its API key.
- `in:N out:N` = token counts the proxy parsed from the SSE stream.

## 5. Verifying OAuth passthrough

Run any **official** model name (no route match) and confirm it reports
`Anthropic (...)` with a 200:

```sh
node bin/ccb.js --model sonnet -p "Reply with exactly: OK"
```

Auth handling (`src/core/routing.js` `applyAuthHeaders`):
- **Custom provider:** `authorization` (OAuth) is deleted; `x-api-key` + `Authorization: Bearer`
  are injected from the provider key. OAuth never reaches the third party.
- **Anthropic passthrough:** headers pass through unchanged; claude's OAuth is forwarded as-is.

## 6. Known glitches found 2026-06-11 (see tracker tasks)

1. **`in:0` input tokens for z.ai (cosmetic).** z.ai reports final `input_tokens` in
   `message_delta`; Anthropic reports it in `message_start`. The proxy reads only
   `message_start` (`src/core/api-adapter.js` `getMessageStartInputTokens`), so z.ai shows
   `in:0`. No billing/routing impact. Fix: also read `usage.input_tokens` from `message_delta`.
   Verified by hitting z.ai directly — `message_start` carries `input_tokens: 0`, `message_delta`
   carries the real count.

2. **`Decompression error: ZlibError` on the Anthropic passthrough path.** Reproduces on
   every sonnet/haiku run, never on z.ai. `proxy-upstream.js:121` strips `accept-encoding`
   only for custom providers, so Anthropic may return a compressed body; the SSE path
   re-emits `chunk.toString()` (text) while `filterResponseHeaders` keeps `content-encoding`,
   corrupting compressed responses. Non-fatal (the user-visible answer still returns; the
   failure is on a background request). Fix: strip `accept-encoding` upstream on all paths,
   or decompress-before-transform and drop `content-encoding` when re-emitting.

3. **`HEAD /` → Anthropic 404 logged as an error.** Claude Code's startup reachability probe
   (`HEAD /`, model unknown) routes to `api.anthropic.com`, which 404s a HEAD on root. The
   404 still proves reachability and does not affect the real call, but the proxy's generic
   4xx path files it as an error report under `logs/_unknown/`. Expected, harmless.

## 7. Routing note (current config)

`providers.json` defines only exact routes (`glm-4.7`, `glm-5.1`). With no wildcard routes,
Claude Code's background delegations (model names like `claude-3-5-haiku-*`,
`claude-sonnet-4-*`) do **not** match and fall through to `api.anthropic.com` (OAuth). Only
explicit `--model glm-4.7`/`glm-5.1` traffic reaches z.ai. To route subagent/background
traffic to z.ai, add wildcard routes (`*haiku*`, `*sonnet*`) per the README.
