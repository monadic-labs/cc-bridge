/**
 * The per-session single-threaded actor (imperative shell — mailbox + held-call owner).
 *
 * This is the block-don't-terminate brain per session. Every event (a Claude
 * Code request, an MCP tool call from agy, agy's final answer, death) enters a
 * single FIFO mailbox and is processed ONE AT A TIME by a single consumer loop.
 *
 * Concurrency justification (manifesto §Testing — async-fuzzing sanctioned
 * escape): there is exactly ONE consumer draining the mailbox and exactly ONE
 * mutable field it owns (`#pending`, the held-call map). No two events are ever
 * processed concurrently, so there is no interleaving over shared state and no
 * scheduler-dependent race to fuzz — the actor is a serial state machine. This
 * is the single-shot / no-shared-mutable-state escape, stated inline.
 *
 * The actor OWNS id correlation: agy's MCP `_meta` carries no usable tool id,
 * so the actor mints `toolu_<seq>` for each held call, stores it keyed by the
 * MCP call id, and resolves the held call (via the bridge server) when Claude
 * Code's matching `tool_result` arrives. Per-call deadlines fire BEFORE agy's
 * `--print-timeout` so a held call can never leak past the session budget.
 */

import { buildToolUseSseSequence } from '../converters/tool-use-emit.js';
import { reconcileHistory } from './history-diff.js';
import { SessionActorError } from '../exceptions.js';

const DEFAULT_TOOL_CALL_DEADLINE_MS = 90_000;

/** A no-op response sink until the handleUpstream handler sets one per turn. */
const NO_RESPONSE = Object.freeze({
  writeSse: () => {},
  end: () => {},
});

/**
 * Create the per-session actor.
 *
 * @param {object} deps
 * @param {{fulfill:Function, rejectAll:Function}} deps.server - the bridge bound to agy's MCP transport.
 * @param {object} [deps.config] - { toolCallDeadlineMs }.
 * @returns {Actor} with submit(event), stop(reason), setTurnResponse(sink), get state().
 */
export function createSessionActor({ server, config }) {
  if (!server || typeof server.fulfill !== 'function' || typeof server.rejectAll !== 'function') {
    throw new SessionActorError('actor requires a server with fulfill + rejectAll');
  }
  const toolCallDeadlineMs = config?.toolCallDeadlineMs ?? DEFAULT_TOOL_CALL_DEADLINE_MS;

  // ONE consumer, ONE owned mutable field (manifesto async-escape, see header).
  const mailbox = [];
  let draining = false;
  const pending = new Map(); // mcpId → PendingCall { mcpId, toolUseId, deadlineTimer }
  let consumedPrefix = [];
  let seq = 0;
  let finalSeq = 0;
  let status = 'ready';
  // The current turn's SSE sink (set by handleUpstream; cleared when the turn ends).
  let turnResponse = NO_RESPONSE;
  let turnModel = 'unknown';
  // Buffered SSE from a tool call that arrived before setTurnResponse installed a real sink.
  // Flushed immediately when the next setTurnResponse call arrives.
  let pendingEmit = null;

  function genToolUseId() {
    seq += 1;
    return `toolu_${seq.toString().padStart(6, '0')}`;
  }

  function setState(next) {
    status = next;
  }

  async function drain() {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (mailbox.length > 0 && status !== 'stopped') {
        const event = mailbox.shift();
        await process(event);
      }
    } finally {
      draining = false;
    }
  }

  function armDeadline(mcpId) {
    const fire = () => {
      const call = pending.get(mcpId);
      if (!call) {
        return; // already resolved (tool_result arrived in time)
      }
      pending.delete(mcpId);
      // Fire BEFORE agy's --print-timeout: the held call is fulfilled with an
      // error so agy's loop continues instead of leaking to a hard session kill.
      server.fulfill(mcpId, { content: [{ type: 'text', text: 'tool execution deadline exceeded' }], isError: true });
    };
    return setTimeout(fire, toolCallDeadlineMs);
  }

  async function process(event) {
    if (status === 'stopped') {
      return;
    }

    if (event.kind === 'mcp-tool-call') {
      handleMcpToolCall(event);
      return;
    }
    if (event.kind === 'cc-request') {
      handleCcRequest(event);
      return;
    }
    if (event.kind === 'mcp-final-answer') {
      handleFinalAnswer(event);
      return;
    }
    if (event.kind === 'death') {
      handleDeath(event);
      return;
    }
    throw new SessionActorError(`actor: unknown event kind ${event.kind}`);
  }

  function handleMcpToolCall(event) {
    const { mcpId, name, arguments: args } = event;
    const toolUseId = genToolUseId();
    const deadlineTimer = armDeadline(mcpId);
    pending.set(mcpId, { mcpId, toolUseId, deadlineTimer });

    // Emit the tool_use SSE block, then CLOSE the response (spec Q2:
    // stateless Messages API forbids holding the HTTP response across CC's
    // tool execution — the ONLY thing held is agy's MCP call, in `pending`).
    const block = { type: 'tool_use', id: toolUseId, name, input: args ?? {} };
    const sse = buildToolUseSseSequence({ messageId: `msg_${toolUseId}`, model: turnModel, toolUseBlocks: [block], usage: { inputTokens: 0, outputTokens: 0 } });
    if (turnResponse === NO_RESPONSE) {
      // Sink not yet installed by handleUpstream — buffer and flush when setTurnResponse arrives.
      pendingEmit = sse;
      return;
    }
    turnResponse.writeSse(sse);
    turnResponse.end();
    turnResponse = NO_RESPONSE;
  }

  function handleCcRequest(event) {
    const { messages, toolResults, model } = event;
    if (typeof model === 'string') {
      turnModel = model;
    }
    const diff = reconcileHistory(consumedPrefix, messages ?? []);

    if (diff.kind === 'reanchor') {
      // Divergence: the prefix no longer matches. Full replay on a fresh agy.
      // (The actual kill+respawn is the registry/pty-spawn layer's job, Unit 7;
      // the actor signals it by surfacing the reanchor and replaying the full
      // reconstructed history. For Unit 6 the consumed prefix is reset.)
      consumedPrefix = [];
    }

    // Resolve any tool_result(s) Claude Code is returning this turn.
    if (Array.isArray(toolResults)) {
      for (const tr of toolResults) {
        resolveToolResult(tr);
      }
    }

    // Continuation/retry: advance the consumed prefix only on a real extension.
    if (diff.kind === 'continuation') {
      consumedPrefix = messages;
    }
    // retry (deep-equal): re-emit, do NOT advance — consumedPrefix stays.
  }

  function resolveToolResult(toolResult) {
    // Find the held MCP call whose toolUseId matches this tool_result.
    let matchedMcpId = null;
    for (const [mcpId, call] of pending) {
      if (call.toolUseId === toolResult.tool_use_id) {
        matchedMcpId = mcpId;
        break;
      }
    }
    if (matchedMcpId === null) {
      return; // no held call for this id (stale result or already resolved)
    }
    const call = pending.get(matchedMcpId);
    clearTimeout(call.deadlineTimer);
    pending.delete(matchedMcpId);
    // Content string | array both handled by Seam3 (tool-result-to-mcp); here
    // we pass the already-converted structured result the caller supplies.
    server.fulfill(matchedMcpId, toMcpResult(toolResult));
  }

  function toMcpResult(toolResult) {
    const content = typeof toolResult.content === 'string'
      ? [{ type: 'text', text: toolResult.content }]
      : toolResult.content;
    return { content, isError: toolResult.is_error === true };
  }

  function handleFinalAnswer(event) {
    // Terminal: emit the final text and end the turn. agy called
    // submit_final_answer, so the answer arrived over MCP — never parsed PTY.
    finalSeq += 1;
    const messageId = `msg_final_${finalSeq.toString().padStart(6, '0')}`;
    const text = typeof event.text === 'string' ? event.text : '';
    turnResponse.writeSse(buildFinalAnswerSse(messageId, turnModel, text));
    turnResponse.end();
    turnResponse = NO_RESPONSE;
  }

  function handleDeath(event) {
    server.rejectAll(event.error ?? new SessionActorError('agy process died'));
    for (const call of pending.values()) {
      clearTimeout(call.deadlineTimer);
    }
    pending.clear();
    turnResponse.end();
    turnResponse = NO_RESPONSE;
    setState('stopped');
  }

  return {
    /**
     * Enqueue an event. Events are processed serially (single consumer).
     * Supported kinds: 'cc-request', 'mcp-tool-call', 'mcp-final-answer', 'death'.
     */
    submit(event) {
      if (status === 'stopped') {
        return;
      }
      mailbox.push(event);
      void drain();
    },

    /**
     * Set the SSE response sink + model for the current turn. Called by the
     * handleUpstream handler before it submits the cc-request. The actor emits
     * tool_use / final-answer SSE into this sink and ends it.
     */
    setTurnResponse(sink, model) {
      turnResponse = sink ?? NO_RESPONSE;
      if (typeof model === 'string') {
        turnModel = model;
      }
      if (pendingEmit !== null && turnResponse !== NO_RESPONSE) {
        const sse = pendingEmit;
        pendingEmit = null;
        turnResponse.writeSse(sse);
        turnResponse.end();
        turnResponse = NO_RESPONSE;
      }
    },

    /** Stop the actor: reject all held calls, clear timers, go stopped. */
    stop(reason) {
      handleDeath({ error: reason ?? new SessionActorError('actor stopped') });
    },

    get state() {
      return { status, pendingCount: pending.size };
    },
  };
}

/**
 * Build a complete SSE sequence for a final (end_turn) answer.
 * Reuses the block-event shape; the text is one content_block of type text.
 */
function buildFinalAnswerSse(messageId, model, text) {
  const events = [];
  events.push(`event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: { id: messageId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  })}`);
  events.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`);
  events.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`);
  events.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`);
  events.push(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })}`);
  events.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`);
  return events.join('\n\n') + '\n\n';
}
