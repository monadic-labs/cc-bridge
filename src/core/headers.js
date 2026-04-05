export const HOP_BY_HOP = Object.freeze(new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]));

export const SENSITIVE_HEADERS = Object.freeze(new Set([
  'authorization', 'cookie', 'set-cookie',
]));

export const ANTHROPIC_HOST = 'api.anthropic.com';

export function copyRequestHeaders(raw) {
  const headers = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'host') continue;
    if (HOP_BY_HOP.has(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  }
  return headers;
}

export function redactHeaders(headers) {
  const redacted = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lower)) {
      redacted[key] = '[REDACTED]';
      continue;
    }
    if (lower === 'x-api-key' && typeof value === 'string' && value.length > 4) {
      redacted[key] = `***${value.slice(-4)}`;
      continue;
    }
    redacted[key] = value;
  }
  return Object.freeze(redacted);
}

export function filterResponseHeaders(raw) {
  const headers = {};
  for (const [k, v] of Object.entries(raw)) {
    if (HOP_BY_HOP.has(k)) continue;
    if (v === undefined) continue;
    headers[k] = v;
  }
  return headers;
}
