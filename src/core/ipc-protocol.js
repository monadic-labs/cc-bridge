const VALID_WORKER_TYPES = Object.freeze(['ready', 'error']);
const VALID_COMMANDS = Object.freeze(['restart', 'status', 'shutdown', 'keepalive', 'sessions']);

export function serializeIpcMessage(obj) {
  return JSON.stringify(obj) + '\n';
}

export function parseIpcMessage(line) {
  try {
    const parsed = JSON.parse(line);
    return Object.freeze(parsed);
  } catch {
    return null;
  }
}

export function validateWorkerMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!VALID_WORKER_TYPES.includes(raw.type)) return null;

  if (raw.type === 'ready') {
    if (typeof raw.pid !== 'number') return null;
    if (typeof raw.routes !== 'number') return null;
    if (typeof raw.extensions !== 'number') return null;
    return Object.freeze({ type: 'ready', pid: raw.pid, routes: raw.routes, extensions: raw.extensions });
  }

  if (raw.type === 'error') {
    if (typeof raw.message !== 'string') return null;
    return Object.freeze({ type: 'error', message: raw.message });
  }

  return null;
}

export function validateCommandMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!VALID_COMMANDS.includes(raw.cmd)) return null;
  return Object.freeze({ cmd: raw.cmd });
}
