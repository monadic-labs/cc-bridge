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

  async logPayload(requestId, type, data) {
    if (!this.isDebug && type !== 'error-body') return;
    if (this.isDebug && type === 'raw' && !this.isTrace) {
        // In debug mode, only log raw on errors (handled separately)
        // unless it's trace mode which logs everything
        return; 
    }

    try {
      if (!fs.existsSync(this.#logsDir)) fs.mkdirSync(this.#logsDir, { recursive: true });
      const filename = `debug-${requestId}.${type}.json`;
      const fullPath = path.join(this.#logsDir, filename);
      const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      await fs.promises.writeFile(fullPath, content, 'utf8');
    } catch { /* best effort */ }
  }

  // Specifically for dumping payloads when an error occurs
  async dumpErrorPayloads(requestId, { raw, sanitized }) {
    if (!this.isDebug) return;
    await this.logPayload(requestId, 'error-raw', raw);
    await this.logPayload(requestId, 'error-sanitized', sanitized);
  }
}
