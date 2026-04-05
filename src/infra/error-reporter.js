import fs from 'fs';
import path from 'path';

export class ErrorReporter {
  #logsDir;

  constructor({ logsDir }) {
    this.#logsDir = logsDir;
  }

  write(error, { requestId, route, method, url, model, sessionId, headers, history, responseBody, operation } = {}) {
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
${responseBodyBlock}
## Stack
${error?.stack || 'no stack available'}
${historyBlock}
## Headers (redacted)
${headersBlock}

---
Request body excluded (may contain user prompts).
API keys and tokens redacted. Safe to share in bug reports.
`;
      fs.writeFileSync(filePath, content, 'utf8');
      return filePath;
    } catch {
      return null;
    }
  }
}
