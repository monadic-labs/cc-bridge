import fs from 'fs';
import path from 'path';

function redactBodyStructure(body) {
  if (!body || typeof body !== 'object') return body;
  const redacted = Array.isArray(body) ? [] : {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'text' || k === 'thinking' || k === 'data') {
      redacted[k] = `[redacted: ${typeof v === 'string' ? v.length : 'complex'} chars]`;
    } else if (typeof v === 'object' && v !== null) {
      redacted[k] = redactBodyStructure(v);
    } else {
      redacted[k] = v;
    }
  }
  return redacted;
}

export class ErrorReporter {
  #logsDir;

  constructor({ logsDir }) {
    this.#logsDir = logsDir;
  }

  write(error, { requestId, route, method, url, model, sessionId, headers, history, responseBody, requestBody, operation, debugMode = false } = {}) {
    try {
      if (!fs.existsSync(this.#logsDir)) fs.mkdirSync(this.#logsDir, { recursive: true });
      const timestamp = new Date().toISOString();
      const id = requestId ?? 'unknown';
      const fileName = `error-${id}-${timestamp.replace(/[:.]/g, '-')}.err`;
      const filePath = path.join(this.#logsDir, fileName);

      const headersBlock = headers
        ? Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n')
        : 'none';

      let historyBlock = '';
      if (history && history.length > 0) {
        historyBlock = `\n## Recent Requests\n${history.map((h) => h.toLogLine()).join('\n')}\n`;
      }

      let responseBodyBlock = '';
      if (responseBody) {
        responseBodyBlock = `\n## Response Body\n${responseBody}\n`;
      }

      let requestBodyBlock = '';
      if (debugMode && requestBody) {
        const redactedBody = redactBodyStructure(requestBody);
        requestBodyBlock = `\n## Request Body Structure (Redacted)\n${JSON.stringify(redactedBody, null, 2)}\n`;
      }

      const content = `# CC-Bridge Error Report
Generated: ${timestamp}

## Context
- Operation: ${operation ?? 'unknown'}
- Request ID: #${id}
- Route: ${route ?? 'unknown'}
- Method: ${method ?? 'unknown'}
- URL: ${url ?? 'unknown'}
- Model: ${model ?? 'unknown'}
- Session: ${sessionId ?? 'unknown'}

## Error
- Message: ${error?.message || String(error)}
- Code: ${error?.code || 'none'}
${requestBodyBlock}
${responseBodyBlock}
## Stack
${error?.stack || 'no stack available'}
${historyBlock}
## Headers (redacted)
${headersBlock}

---
API keys and tokens redacted. Safe to share in bug reports.
`;
      fs.writeFileSync(filePath, content, 'utf8');
      return filePath;
    } catch {
      return null;
    }
  }
}
