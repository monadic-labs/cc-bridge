import fs from 'fs';
import path from 'path';
import { redactHeaders } from '../core/headers.js';
import { parseSseMetadata } from '../core/sse-parser.js';
import { RequestSummary } from '../core/types.js';
import { decompress } from '../core/compression.js';

export class Logger {
  #logsDir;
  #defaultLog;
  #history;
  #maxHistory;

  constructor({ logsDir, defaultLog, maxHistory }) {
    this.#logsDir = logsDir;
    this.#defaultLog = defaultLog;
    this.#history = [];
    this.#maxHistory = maxHistory;
  }

  async emit(line, sessionId) {
    const out = line + '\n';
    process.stdout.write(out);
    try {
      if (!fs.existsSync(this.#logsDir)) fs.mkdirSync(this.#logsDir, { recursive: true });
      const logPath = sessionId
        ? path.join(this.#logsDir, `session-${sessionId}.log`)
        : this.#defaultLog;
      await fs.promises.appendFile(logPath, out);
    } catch { /* best effort */ }
  }

  async logRequest(requestInfo, config) {
    if (!config.loggingEnabled || !config.logRequests) return;
    const { id, route, url, contentLength, messageCount, sessionId } = requestInfo;
    await this.emit(`[REQ #${id}] → ${route} ${url} | ${contentLength} bytes | ${messageCount} messages`, sessionId);

    if (config.maxBodyLog <= 0) return;
    await this.emit(`Headers: ${JSON.stringify(redactHeaders(requestInfo.headers), null, 2)}`, sessionId);
    const bodyStr = JSON.stringify(requestInfo.body, null, 2);
    const truncated = bodyStr.length > config.maxBodyLog
      ? bodyStr.slice(0, config.maxBodyLog) + `\n... [truncated, ${bodyStr.length} chars total]`
      : bodyStr;
    await this.emit(`Body: ${truncated}`, sessionId);
  }

  async logResponse(id, statusCode, headers, rawBody, sessionId, config) {
    if (!config.loggingEnabled || !config.logResponses) return;
    const isSse = (headers['content-type'] ?? '').includes('text/event-stream');

    if (isSse) return this.#logSseResponse(id, statusCode, rawBody, sessionId);
    return this.#logJsonResponse(id, statusCode, rawBody, sessionId, config);
  }

  async #logSseResponse(id, statusCode, raw, sessionId) {
    const meta = parseSseMetadata(raw);
    const blockSummary = meta.blocks.map((b) => b.toSummary()).join(', ');
    const tokenInfo = `in:${meta.inputTokens} out:${meta.outputTokens}`;
    await this.emit(`[RES #${id}] ← ${statusCode} | ${tokenInfo} | blocks: ${blockSummary || 'none'}`, sessionId);
    for (const b of meta.blocks) {
      await this.emit(`  block: ${JSON.stringify({ type: b.type, name: b.name, signature: b.signature })}`, sessionId);
    }
    if (meta.hasError) {
      await this.emit(`[RES #${id}] SSE error: ${JSON.stringify(meta.error)}`, sessionId);
    }
  }

  async #logJsonResponse(id, statusCode, raw, sessionId, config) {
    let detail = '';
    try {
      const parsed = JSON.parse(raw);
      if (parsed.error) detail = ` | error: ${parsed.error.type} "${parsed.error.message}"`;
    } catch { }
    await this.emit(`[RES #${id}] ← ${statusCode}${detail}`, sessionId);

    if (config.maxBodyLog <= 0) return;
    const truncated = raw.length > config.maxBodyLog
      ? raw.slice(0, config.maxBodyLog) + `\n... [truncated, ${raw.length} chars total]`
      : raw;
    await this.emit(`Body: ${truncated}`, sessionId);
  }

  addSummary(summary) {
    this.#history.push(summary);
    while (this.#history.length > this.#maxHistory) this.#history.shift();
  }

  getHistory() { return Object.freeze([...this.#history]); }

  async decompressChunks(chunks, encoding) {
    const buffer = Buffer.concat(chunks);
    const res = await decompress(buffer, encoding);
    return res.isSuccess ? res.value.toString() : buffer.toString();
  }
}
