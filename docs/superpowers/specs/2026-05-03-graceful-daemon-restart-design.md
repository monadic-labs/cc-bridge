# Graceful Daemon Restart via Socket Handoff

**Date:** 2026-05-03
**Status:** Draft

## Problem

Restarting the cc-bridge daemon (e.g. after a code update via `npm link`) kills all connected Claude Code sessions because the listening socket is closed. Clients get `ECONNRESET` and lose their conversation context.

Config hot-reload already works for `providers.json` changes, but code-level changes require a full process restart.

## Design

### Architecture: Watchdog + Worker

Replace the single daemon process with a watchdog/worker pair. The watchdog owns the listening socket and spawns workers. On restart, the watchdog spawns a new worker with the same socket, waits for it to initialize, then drains the old one.

```
                     ┌─────────────────┐
                     │   Watchdog      │
                     │  (port 9099)    │
                     │  (control IPC)  │
                     └────────┬────────┘
                              │ socket handle via IPC
                   ┌──────────┴──────────┐
                   │                     │
            ┌──────▼──────┐      ┌──────▼──────┐
            │  Worker A   │      │  Worker B   │
            │  (draining) │      │  (active)   │
            └─────────────┘      └─────────────┘
```

### Components

#### 1. Watchdog (`bin/ccb-watchdog.js`)

Lightweight parent process. Responsibilities:

- **Bind the HTTP socket** on the configured port (default 9099)
- **Spawn worker**, pass the server socket via `child_process.send({ type: 'socket' }, serverSocket)`
- **Listen on control IPC** for commands (named pipe on Windows, unix domain socket on POSIX)
- **Own keepalive tracking natively** — CLI processes ping the control IPC socket for keepalives. The watchdog counts them directly. No delegation to workers.
- **Trigger restart** when a `restart` command arrives on the control IPC:
  1. Spawn new worker, pass the same socket handle
  2. Wait for new worker to send `{ type: 'ready' }` via IPC (signals full initialization)
  3. Only then send `{ type: 'drain' }` to old worker
  4. Old worker stops accepting, finishes in-flight, exits
  5. Watchdog continues serving through new worker

The watchdog is intentionally tiny — it does no routing, no extension loading, no upstream forwarding. Its only job is socket ownership, worker lifecycle, and keepalive counting.

#### 2. Worker (refactored `src/proxy-core.js`)

The existing proxy logic, modified to:

- **Receive the server socket** from watchdog via `process.on('message', (msg, handle) => ...)`
- **Run all current proxy logic** unchanged (routing, extensions, upstream forwarding)
- **Send `{ type: 'ready' }` to watchdog** after full initialization (providers loaded, extensions registered, server listening on passed socket)
- **On `drain` message**: call `server.close()` (stops accepting new connections on the shared socket), then wait for in-flight requests to complete, then `process.exit(0)`
- **No keepalive logic** — keepalive is handled entirely by the watchdog over the control IPC

#### 3. Control IPC (`ccb-ctrl.sock`)

A local IPC socket for communication between `ccb` CLI and the watchdog:

- **Path:** `~/.claude/.ccb/ccb-ctrl.sock`
- **Protocol:** newline-delimited JSON
- **Commands (CLI → Watchdog):**
  - `{ "cmd": "restart" }` — trigger graceful worker restart
  - `{ "cmd": "status" }` — return worker PID, uptime, route count
  - `{ "cmd": "shutdown" }` — drain and exit everything
  - `{ "cmd": "keepalive" }` — open a persistent connection; watchdog tracks it for lifecycle

On Windows, the path uses `\\?\pipe\ccb-ctrl` (named pipe). On POSIX, a unix domain socket file.

Uses Node's built-in `net` module — zero native dependencies, works with standard `npm install`.

### IPC Message Protocol

All IPC messages are strictly typed, parsed into immutable parameter objects on receipt.

**Watchdog → Worker:**
| Message | Fields | Purpose |
|---------|--------|---------|
| `SocketMessage` | `{ type: 'socket', port: number }` + socket handle | Pass the listening socket |
| `DrainMessage` | `{ type: 'drain', timeout: number }` | Signal worker to stop accepting and drain |

**Worker → Watchdog:**
| Message | Fields | Purpose |
|---------|--------|---------|
| `ReadyMessage` | `{ type: 'ready', pid: number, routes: number, extensions: number }` | Worker fully initialized |
| `ErrorMessage` | `{ type: 'error', message: string }` | Worker failed to initialize |

**CLI → Watchdog (over control IPC):**
| Message | Fields | Purpose |
|---------|--------|---------|
| `RestartCommand` | `{ cmd: 'restart' }` | Trigger graceful restart |
| `StatusCommand` | `{ cmd: 'status' }` | Query watchdog state |
| `ShutdownCommand` | `{ cmd: 'shutdown' }` | Full shutdown |
| `KeepaliveCommand` | `{ cmd: 'keepalive' }` | Persistent connection for lifecycle |

Each message is validated and frozen on receipt. Unknown message types are rejected with an error response.

### Drain Sequence (Corrected)

The key fix: **drain is gated on the new worker's `ready` signal**. No traffic is dropped.

```
Time ──────────────────────────────────────────────────────────────►

Watchdog:  [spawn B]──[send socket to B]──[wait...]──[recv ready from B]──[send drain to A]
Worker A:  [serving]─────────────────────────────────────────────────[close()][drain][exit]
Worker B:                  [init: load extensions, parse config]──[ready!]──[serving]
```

During overlap (after B is ready, while A is draining), the OS round-robins new connections between A and B since they share the same socket fd. After A calls `server.close()`, only B accepts new connections. Existing connections on A complete normally.

**Initialization race condition eliminated**: if Worker B crashes during init (before sending `ready`), Worker A never receives a drain signal and continues serving uninterrupted. The watchdog logs the failure and cleans up the dead worker.

### Long-Running Request Drain Strategy

Claude Code requests can run for minutes (large context, tool use chains, streaming). The drain handles this progressively:

1. **Soft drain**: `server.close()` immediately — no new connections accepted on A
2. **Wait for in-flight**: Worker A tracks active response streams. Each `proxyRes.on('end')` / `res.on('close')` decrements a counter
3. **Drain timeout**: configurable, defaults to `upstreamTimeoutMs` (600s). Matches the proxy's own timeout — if a request hasn't completed in that window, it was already going to timeout anyway
4. **Force exit**: if connections remain after the drain timeout, Worker A logs a warning with the count of killed connections and exits. Clients reconnect automatically — same behavior as a network blip

The memory overhead is bounded: at most two workers exist simultaneously, for at most the drain timeout duration.

### Startup Flow

```
ccb (CLI)
  → connect to control IPC (ccb-ctrl.sock)
  → if connection succeeds (watchdog alive):
      → send keepalive over control IPC
      → launch claude with ANTHROPIC_BASE_URL
  → if connection fails (no watchdog):
      → bind port 9099
      → spawn watchdog process, pass the socket
      → watchdog spawns worker, passes socket via IPC
      → worker initializes, sends ready
      → CLI connects to control IPC
      → CLI sends keepalive over control IPC
      → CLI launches claude with ANTHROPIC_BASE_URL
```

### Restart Flow (`ccb --x-restart`)

```
ccb --x-restart
  → connect to control IPC (ccb-ctrl.sock)
  → send { "cmd": "restart" }
  → watchdog:
      → spawn new worker
      → pass the server socket handle
      → wait for { "type": "ready" } from new worker
      → send { "type": "drain" } to old worker
      → old worker: close(), drain in-flight, exit(0)
  → watchdog responds: { "status": "ok", "oldPid": N, "newPid": M }
  → CLI prints "Restarted worker (PID N → PID M)"
```

### Keepalive via Control IPC

Keepalive is decoupled from the HTTP proxy entirely:

- Each `ccb` CLI process opens a persistent connection to the control IPC socket
- The watchdog counts active control IPC connections as keepalives
- When all control IPC connections close, the watchdog drains the worker and exits
- Worker crashes do not affect the keepalive count — the watchdog owns it natively

This eliminates the distributed state risk: the watchdog's lifecycle counter is always accurate, even if the worker crashes mid-flight.

### File Structure

```
bin/
  ccb.js            # CLI entry (modified: connects to control IPC, spawns watchdog)
  ccb-watchdog.js   # NEW: watchdog process
src/
  proxy-core.js     # MODIFIED: accepts socket via IPC, sends ready, handles drain
```

### What Changes for Users

- **Nothing** for normal usage. `ccb` still launches Claude Code the same way.
- `ccb --x-restart` is the new command for graceful restart.
- `ccb --x-killall` still works (kills watchdog, which kills worker).
- npm-linked installs get the new watchdog after the npm link update + `ccb --x-restart`.

### Error Handling

- **Worker crash during init**: watchdog detects exit before `ready`. Logs error, does NOT drain old worker. Old worker continues serving. CLI sees restart failure.
- **Worker init hang (initialization timeout)**: watchdog attaches a strict timer when spawning a new worker (default 10s). If `ready` is not received within this window, the watchdog explicitly kills the pending worker (`worker.kill()`), discards the reference, logs an initialization timeout error, and leaves the active worker operating uninterrupted. CLI receives a `{ "status": "error", "message": "worker initialization timed out" }` response.
- **Worker crash while active**: watchdog detects exit, spawns a new worker immediately. Clients may see a brief error on in-flight requests, but new connections resume once the new worker sends `ready`.
- **Watchdog crash**: OS closes the socket. All connections die. CLI reconnects by spawning a new watchdog on next invocation (same as today).
- **Drain timeout exceeded**: worker force-exits after `upstreamTimeoutMs`. Logged as a warning with killed connection count.

### Out of Scope

- Hot module reload (could be added later as an optimization)
- Automatic file watching to detect code changes (user triggers via `ccb --x-restart`)
- Multiple workers for load balancing (single active worker + at most one draining worker)
