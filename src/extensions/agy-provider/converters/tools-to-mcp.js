/**
 * Seam1 — Anthropic tool definitions → MCP tool definitions (pure).
 *
 * Claude Code executes the real tools locally (the "hands"); the bridge only
 * advertises them to Gemini over MCP. By the local-execution criterion (spec
 * Tools Q5): include custom/skill tools AND client-executed built-ins; EXCLUDE
 * server-side tools (web_search / web_search_*) — with no Anthropic server they
 * are dead ends Claude Code can never fulfill, so exposing them would only let
 * Gemini call a tool whose result can never come back.
 *
 * Conversion is ~1:1: Anthropic {name,description,input_schema} →
 * MCP {name,description,inputSchema}. No string round-trip; input is an object
 * and stays an object (spec Schema mapping, Seam1 gotchas).
 */

/**
 * Anthropic server-side tools (web_search and its future-dated variants, e.g.
 * `web_search_20250305`) execute on the Anthropic server and so are excluded
 * from the bridge. Anthropic encodes the dated variant as BOTH a `type` and a
 * `name`, so we prefix-match either field — one constant catches the whole
 * family without an exact-list edit when a new dated version ships.
 */
const SERVER_SIDE_PREFIX = 'web_search';

/**
 * Classify a tool by where it executes.
 *
 * @param {{type?:string, name?:string}} tool - Anthropic tool entry.
 * @returns {'local-exec' | 'server-side'}
 */
export function classifyTool(tool) {
  if (typeof tool?.type === 'string' && tool.type.startsWith(SERVER_SIDE_PREFIX)) {
    return 'server-side';
  }
  if (typeof tool?.name === 'string' && tool.name.startsWith(SERVER_SIDE_PREFIX)) {
    return 'server-side';
  }
  return 'local-exec';
}

/**
 * Convert one Anthropic tool to an MCP tool definition.
 *
 * @param {{name?:string, description?:string, input_schema?:object, parameters?:object, type?:string}} tool
 * @returns {{name:string, description:string, inputSchema:object} | null}
 *   null when the tool is server-side (filtered out — never partially converted).
 */
export function convertToolToMcp(tool) {
  if (classifyTool(tool) === 'server-side') {
    return null;
  }

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema ?? tool.parameters ?? {},
  };
}

/**
 * Convert a list of Anthropic tools to MCP definitions in one pass:
 * server-side tools are dropped, every kept tool is mapped.
 *
 * @param {Array} tools - Anthropic `tools` array.
 * @returns {Array<{name:string, description:string, inputSchema:object}>}
 */
export function convertTools(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  const mapped = [];
  for (const tool of tools) {
    const converted = convertToolToMcp(tool);
    if (converted !== null) {
      mapped.push(converted);
    }
  }
  return mapped;
}
