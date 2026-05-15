import fs from 'fs';
import path from 'path';

export class DebugLogger {
  #logsDir;
  #level;

  constructor({ logsDir, level }) {
    this.#logsDir = logsDir;
    this.#level = level || 'info';
  }

  get isDebug() { return this.#level === 'debug' || this.#level === 'trace'; }
  get isTrace() { return this.#level === 'trace'; }

  async logPayload(sessionId, requestId, type, data) {
    if (!this.isDebug && type !== 'error-body') return;
    if (this.isDebug && type === 'raw' && !this.isTrace) {
        // In debug mode, only log raw on errors (handled separately)
        // unless it's trace mode which logs everything
        return;
    }

    try {
      const sessionDir = path.join(this.#logsDir, sessionId || '_unknown');
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
      const filename = `debug-${requestId}.${type}.json`;
      const fullPath = path.join(sessionDir, filename);

      let content = JSON.stringify(data, null, 2);
      if (typeof data === 'string') content = data;
      if (Buffer.isBuffer(data)) content = data.toString();

      await fs.promises.writeFile(fullPath, content, 'utf8');
    } catch { /* best effort */ }
  }

  // Specifically for dumping payloads when an error occurs
  async dumpErrorPayloads(sessionId, requestId, { raw, sanitized }) {
    if (!this.isDebug) return;
    await this.logPayload(sessionId, requestId, 'error-raw', raw);
    await this.logPayload(sessionId, requestId, 'error-sanitized', sanitized);
  }
}
