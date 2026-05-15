import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key',
  'x-stainless-retry-count', 'anthropic-dangerous-direct-browser-access'
]);

const SENSITIVE_BODY_KEYS = new Set([
  'text', 'thinking', 'data', 'metadata', 'user_id'
]);

function redactHeaderValue(key, value) {
  if (!SENSITIVE_HEADER_KEYS.has(key.toLowerCase())) return value;
  if (typeof value !== 'string' || value.length <= 8) return '[REDACTED]';
  return value.slice(0, 12) + '...[REDACTED]';
}

function redactBodyStructure(body) {
  if (!body || typeof body !== 'object') return body;
  const redacted = Array.isArray(body) ? [] : {};
  for (const [k, v] of Object.entries(body)) {
    if (SENSITIVE_BODY_KEYS.has(k)) {
      redacted[k] = `[redacted: ${typeof v === 'string' ? v.length : 'complex'} chars]`;
      continue;
    }
    if (typeof v === 'object' && v !== null) {
      redacted[k] = redactBodyStructure(v);
      continue;
    }
    redacted[k] = v;
  }
  return redacted;
}

function generateErrorId() {
  const ts = Date.now().toString(36);
  const hex = randomBytes(4).toString('hex');
  return `ccb-${ts}-${hex}`;
}

export class ErrorReporter {
  #logsDir;

  constructor({ logsDir }) {
    this.#logsDir = logsDir;
  }

  write(error, { requestId, route, method, url, model, sessionId, headers, history, responseBody, requestBody, operation, debugMode = false, statusCode, upstreamUrl, elapsedMs } = {}) {
    try {
      const sessionDir = path.join(this.#logsDir, sessionId || '_unknown');
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
      const timestamp = new Date().toISOString();
      const id = requestId ?? 'unknown';
      const errorId = generateErrorId();
      const fileName = `error-${id}-${errorId}-${timestamp.replace(/[:.]/g, '-')}.err`;
      const filePath = path.join(sessionDir, fileName);

      const headersBlock = headers
        ? Object.entries(headers)
            .map(([k, v]) => `${k}: ${redactHeaderValue(k, v)}`)
            .join('\n')
        : 'none';

      let historyBlock = '';
      if (history && history.length > 0) {
        historyBlock = `\n## Recent Requests\n${history.map((h) => h.toLogLine()).join('\n')}\n`;
      }

      let responseBodyBlock = '';
      if (responseBody) {
        const truncated = responseBody.length > 4096
          ? responseBody.slice(0, 4096) + `\n... [truncated, ${responseBody.length} chars total]`
          : responseBody;
        responseBodyBlock = `\n## Response Body\n${truncated}\n`;
      }

      let requestBodyBlock = '';
      if (debugMode && requestBody) {
        const redactedBody = redactBodyStructure(requestBody);
        requestBodyBlock = `\n## Request Body Structure (Redacted)\n${JSON.stringify(redactedBody, null, 2)}\n`;
      }

      const statusLine = statusCode ? `\n- Status: ${statusCode}` : '';
      const upstreamLine = upstreamUrl ? `\n- Upstream: ${upstreamUrl}` : '';
      const elapsedLine = elapsedMs != null ? `\n- Elapsed: ${elapsedMs}ms` : '';

      const content = `# CC-Bridge Error Report
Error ID: ${errorId}
Generated: ${timestamp}

## Context
- Operation: ${operation ?? 'unknown'}
- Request ID: #${id}
- Route: ${route ?? 'unknown'}
- Method: ${method ?? 'unknown'}
- URL: ${url ?? 'unknown'}
- Model: ${model ?? 'unknown'}
- Session: ${sessionId ?? 'unknown'}${statusLine}${upstreamLine}${elapsedLine}

## Error
- Message: ${error?.message || String(error)}
- Code: ${error?.code || 'none'}${requestBodyBlock}${responseBodyBlock}
## Stack
${error?.stack || 'no stack available'}${historyBlock}
## Headers (redacted)
${headersBlock}

---
Error ID: ${errorId}
API keys, tokens, and user metadata redacted. Safe to share in bug reports.
Quote the Error ID in bug reports for correlation.
`;
      fs.writeFileSync(filePath, content, 'utf8');
      return { filePath, errorId };
    } catch {
      return null;
    }
  }
}
