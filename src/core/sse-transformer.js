export class SseResponseTransformer {
  #buffer = '';
  #thinkingIndexes = new Set();

  transformChunk(chunkStr) {
    this.#buffer += chunkStr;
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop(); // keep last partial line

    let output = '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) {
        output += line + '\n';
        continue;
      }
      try {
        const evt = JSON.parse(line.slice(6));
        let modified = false;

        if (evt.type === 'content_block_start' && evt.content_block) {
          if (evt.content_block.type === 'thinking' || evt.content_block.type === 'redacted_thinking') {
            this.#thinkingIndexes.add(evt.index);
            evt.content_block = { type: 'text', text: '```thinking\n' };
            modified = true;
          }
        } else if (evt.type === 'content_block_delta' && evt.delta && this.#thinkingIndexes.has(evt.index)) {
          if (evt.delta.type === 'thinking_delta') {
            evt.delta = { type: 'text_delta', text: evt.delta.thinking || '' };
            modified = true;
          } else if (evt.delta.type === 'redacted_thinking_delta') {
            evt.delta = { type: 'text_delta', text: evt.delta.data || '' };
            modified = true;
          }
        } else if (evt.type === 'content_block_stop' && this.#thinkingIndexes.has(evt.index)) {
          const extraDelta = { type: 'content_block_delta', index: evt.index, delta: { type: 'text_delta', text: '\n```\n' } };
          output += 'data: ' + JSON.stringify(extraDelta) + '\n\n';
          this.#thinkingIndexes.delete(evt.index);
        }

        output += modified ? `data: ${JSON.stringify(evt)}\n` : `${line}\n`;
      } catch {
        output += line + '\n';
      }
    }
    return output;
  }

  flush() {
    const out = this.#buffer;
    this.#buffer = '';
    return out;
  }
}
