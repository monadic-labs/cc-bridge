#!/usr/bin/env node

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { URL } from 'url';
import { spawn } from 'child_process';

const DEFAULT_PORT = 9098;
const DEFAULT_CAPTURE_DIR = path.join(os.homedir(), '.claude', '.ccb', 'capture');
const DEFAULT_ENV_FILE = path.join(os.homedir(), '.claude', '.ccb', '.env');
const DEFAULT_AUTH_ENV = 'ZAI_KEY';
const DEFAULT_MODEL = 'glm-5.1';
const DEFAULT_SMALL_FAST_MODEL = 'glm-4.5-air';

function parseArgs(argv) {
  const flags = {
    target: null,
    port: DEFAULT_PORT,
    captureDir: DEFAULT_CAPTURE_DIR,
    authEnv: DEFAULT_AUTH_ENV,
    authToken: null,
    model: DEFAULT_MODEL,
    smallFastModel: DEFAULT_SMALL_FAST_MODEL,
    launchClaude: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const eat = () => argv[++i];
    if (flag === '--target') { flags.target = eat(); continue; }
    if (flag === '--port') { flags.port = parseInt(eat(), 10); continue; }
    if (flag === '--capture-dir') { flags.captureDir = eat(); continue; }
    if (flag === '--auth-token-env') { flags.authEnv = eat(); continue; }
    if (flag === '--auth-token') { flags.authToken = eat(); continue; }
    if (flag === '--model') { flags.model = eat(); continue; }
    if (flag === '--small-fast-model') { flags.smallFastModel = eat(); continue; }
    if (flag === '--launch-claude') { flags.launchClaude = true; continue; }
    if (flag === '--help' || flag === '-h') { flags.help = true; continue; }
    throw new Error(`unknown argument: ${flag}`);
  }
  return flags;
}

function printHelp() {
  process.stdout.write(`Usage: ccb-capture --target <upstream-url> [options]

A pure byte-for-byte transparent proxy that logs each request/response pair to
disk. Use it to diagnose differences between (claude -> upstream) direct and
(claude -> ccb -> upstream). The proxy preserves header case, header order, and
body bytes; only the Host header is rewritten so the upstream TLS handshake and
virtual-host routing work.

Options:
  --target <url>            Upstream base URL (e.g. https://api.z.ai/api/anthropic). REQUIRED.
  --port <n>                Local port (default ${DEFAULT_PORT}).
  --capture-dir <path>      Where to write captures (default ${DEFAULT_CAPTURE_DIR}).
  --auth-token-env <NAME>   Env var holding upstream API key (default ${DEFAULT_AUTH_ENV}).
                            Read from process env first, then ${DEFAULT_ENV_FILE} as fallback.
  --auth-token <literal>    Override: pass the key directly (avoid in shared history).
  --model <name>            ANTHROPIC_MODEL for --launch-claude (default ${DEFAULT_MODEL}).
  --small-fast-model <name> ANTHROPIC_SMALL_FAST_MODEL for --launch-claude (default ${DEFAULT_SMALL_FAST_MODEL}).
  --launch-claude           Also spawn 'claude' with env vars pointed at this proxy.
  -h, --help                Show this help.

Without --launch-claude, the tool prints the env vars to set in your own shell
and listens forever (Ctrl-C to stop).

Capture files per request, all under --capture-dir:
  <ts>-<id>.req.meta.txt      method, url, http version
  <ts>-<id>.req.headers.txt   headers from claude (authorization redacted)
  <ts>-<id>.req.body.bin      request body bytes from claude (verbatim)
  <ts>-<id>.fwd.headers.txt   headers forwarded upstream (authorization redacted)
  <ts>-<id>.res.status.txt    upstream status code + message
  <ts>-<id>.res.headers.txt   response headers from upstream
  <ts>-<id>.res.body.bin      response body bytes from upstream (verbatim)
  <ts>-<id>.{req,fwd,res}.error.txt  any stream error along the path
`);
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function resolveAuthToken(flags) {
  if (flags.authToken) return flags.authToken;
  if (process.env[flags.authEnv]) return process.env[flags.authEnv];
  const fromFile = readEnvFile(DEFAULT_ENV_FILE)[flags.authEnv];
  if (fromFile) return fromFile;
  return null;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function rawHeadersToText(rawHeaders) {
  const lines = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
  }
  return lines.join('\n');
}

function redactAuth(text) {
  return text.replace(
    /^(authorization|x-api-key):\s*.+$/gim,
    (_match, name) => `${name}: [REDACTED]`,
  );
}

// rawHeaders is a flat [name, value, name, value, ...] array preserving case
// and order. Convert to an object the way Node's outgoing-request layer wants,
// applying overrides last so callers can rewrite specific headers (e.g. Host)
// without mutating the rest.
function rawHeadersToOutgoing(rawHeaders, overrides) {
  const obj = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    obj[rawHeaders[i]] = rawHeaders[i + 1];
  }
  return { ...obj, ...overrides };
}

let requestCounter = 0;

function nextRequestId() {
  requestCounter += 1;
  return String(requestCounter).padStart(4, '0');
}

function handleRequest(req, res, upstreamParsed, captureDir) {
  const id = nextRequestId();
  const stem = path.join(captureDir, `${timestamp()}-${id}`);

  fs.writeFileSync(
    `${stem}.req.meta.txt`,
    `method: ${req.method}\nurl: ${req.url}\nhttp_version: ${req.httpVersion}\n`,
  );
  fs.writeFileSync(`${stem}.req.headers.txt`, redactAuth(rawHeadersToText(req.rawHeaders)));

  const reqBodyOut = fs.createWriteStream(`${stem}.req.body.bin`);

  // Verbatim forward: preserve all incoming headers; only override Host so
  // upstream TLS routes correctly. Do NOT drop hop-by-hop headers — claude is
  // the ultimate origin here and we want byte parity, not protocol cleanup.
  const outgoingHeaders = rawHeadersToOutgoing(req.rawHeaders, {
    host: upstreamParsed.host,
  });
  fs.writeFileSync(
    `${stem}.fwd.headers.txt`,
    redactAuth(
      Object.entries(outgoingHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n'),
    ),
  );

  const upstreamReq = https.request({
    method: req.method,
    host: upstreamParsed.hostname,
    port: upstreamParsed.port || 443,
    path: req.url,
    headers: outgoingHeaders,
  }, (upstreamRes) => {
    fs.writeFileSync(
      `${stem}.res.status.txt`,
      `${upstreamRes.statusCode} ${upstreamRes.statusMessage || ''}\n`,
    );
    fs.writeFileSync(`${stem}.res.headers.txt`, rawHeadersToText(upstreamRes.rawHeaders));

    res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, upstreamRes.rawHeaders);
    const resBodyOut = fs.createWriteStream(`${stem}.res.body.bin`);
    upstreamRes.on('data', (chunk) => {
      resBodyOut.write(chunk);
      res.write(chunk);
    });
    upstreamRes.on('end', () => {
      resBodyOut.end();
      res.end();
    });
    upstreamRes.on('error', (err) => {
      fs.writeFileSync(`${stem}.res.error.txt`, String(err.stack || err));
      resBodyOut.end();
      try { res.end(); } catch (_e) { /* already destroyed */ }
    });
    process.stdout.write(`[${id}] ← ${upstreamRes.statusCode} ${upstreamRes.statusMessage || ''}\n`);
  });

  upstreamReq.on('error', (err) => {
    fs.writeFileSync(`${stem}.fwd.error.txt`, String(err.stack || err));
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: 'ccb-capture: upstream connection failed',
        detail: String(err.message || err),
      }));
    }
  });

  req.on('data', (chunk) => {
    reqBodyOut.write(chunk);
    upstreamReq.write(chunk);
  });
  req.on('end', () => {
    reqBodyOut.end();
    upstreamReq.end();
  });
  req.on('error', (err) => {
    fs.writeFileSync(`${stem}.req.error.txt`, String(err.stack || err));
    reqBodyOut.end();
    upstreamReq.destroy(err);
  });

  process.stdout.write(`[${id}] → ${req.method} ${req.url}\n`);
}

function buildClaudeEnv(flags, baseUrl, authToken) {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_MODEL: flags.model,
    ANTHROPIC_SMALL_FAST_MODEL: flags.smallFastModel,
  };
}

function printEnvHints(baseUrl, authEnvName, model, smallFastModel) {
  process.stdout.write(`
Set these in your shell, then run \`claude\`:

PowerShell:
  $env:ANTHROPIC_BASE_URL = "${baseUrl}"
  $env:ANTHROPIC_AUTH_TOKEN = $env:${authEnvName}
  $env:ANTHROPIC_MODEL = "${model}"
  $env:ANTHROPIC_SMALL_FAST_MODEL = "${smallFastModel}"
  claude

bash:
  ANTHROPIC_BASE_URL="${baseUrl}" \\
  ANTHROPIC_AUTH_TOKEN="$${authEnvName}" \\
  ANTHROPIC_MODEL="${model}" \\
  ANTHROPIC_SMALL_FAST_MODEL="${smallFastModel}" \\
  claude
`);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { printHelp(); return; }
  if (!flags.target) {
    process.stderr.write('error: --target is required (see --help)\n');
    process.exit(2);
  }

  const upstreamUrl = flags.target.replace(/\/+$/, '');
  const upstreamParsed = new URL(upstreamUrl);
  const basePath = upstreamParsed.pathname.replace(/\/+$/, '');

  ensureDir(flags.captureDir);

  const authToken = resolveAuthToken(flags);
  if (!authToken && flags.launchClaude) {
    process.stderr.write(
      `error: --launch-claude requires an auth token; set $env:${flags.authEnv}, `
      + `add it to ${DEFAULT_ENV_FILE}, or pass --auth-token\n`,
    );
    process.exit(2);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res, upstreamParsed, flags.captureDir);
  });

  server.on('error', (err) => {
    process.stderr.write(`server error: ${err.message}\n`);
    process.exit(1);
  });

  server.listen(flags.port, '127.0.0.1', () => {
    const actualPort = server.address().port;
    const baseUrl = `http://127.0.0.1:${actualPort}${basePath}`;
    process.stdout.write(
      `ccb-capture listening on ${baseUrl}\n`
      + `  forwarding to ${upstreamUrl}\n`
      + `  capture dir:  ${flags.captureDir}\n`,
    );

    if (!flags.launchClaude) {
      printEnvHints(baseUrl, flags.authEnv, flags.model, flags.smallFastModel);
      process.stdout.write('\n(Listening forever. Ctrl-C to stop.)\n');
      return;
    }

    const env = buildClaudeEnv(flags, baseUrl, authToken);
    process.stdout.write('\nlaunching: claude (with ANTHROPIC_* env injected)\n\n');
    const child = spawn('claude', [], {
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('exit', (code) => {
      process.stdout.write(`\nclaude exited with code ${code}; shutting down capture proxy.\n`);
      server.close(() => process.exit(code || 0));
    });
  });
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
}
