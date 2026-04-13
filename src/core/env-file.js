import fs from 'fs';

/**
 * Parse a .env file into a frozen key-value object.
 *
 * Skips blank lines and comments (#). Values after the first '=' are joined
 * (so `KEY=a=b` → `{ KEY: 'a=b' }`). Returns an empty frozen object if the
 * file does not exist.
 */
export function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return Object.freeze({});
  const env = fs.readFileSync(envPath, 'utf8');
  const result = {};
  for (const line of env.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) result[key.trim()] = valueParts.join('=').trim();
  }
  return Object.freeze(result);
}

/**
 * Set or update a key in a .env file.
 *
 * If the key already exists (or exists as a commented-out `# KEY=...` line),
 * the line is replaced in-place. Otherwise the key is appended. The file is
 * chmod 0600 on non-Windows platforms (best-effort).
 */
export function updateEnvKey(envPath, key, value) {
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  const lines = content.split('\n');
  let found = false;
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`) || trimmed.startsWith(`# ${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    newLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, newLines.join('\n').trim() + '\n', 'utf8');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(envPath, 0o600); } catch { /* best effort */ }
  }
}

/**
 * Remove lines from a .env file matching a predicate.
 *
 * @param {string} envPath - Path to the .env file.
 * @param {function} predicate - Called with each parsed `{ key, value }` object.
 *   Return true to remove the line.
 * @returns {string[]} Array of removed keys.
 */
export function pruneEnvLines(envPath, predicate) {
  if (!fs.existsSync(envPath)) return [];

  const content = fs.readFileSync(envPath, 'utf8');
  const lines = content.split('\n');
  const keptLines = [];
  const removed = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      keptLines.push(line);
      continue;
    }

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      keptLines.push(line);
      continue;
    }

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    if (predicate({ key, value })) {
      removed.push(key);
      continue;
    }
    keptLines.push(line);
  }

  if (removed.length === 0) return removed;

  fs.writeFileSync(envPath, keptLines.join('\n').trim() + '\n', 'utf8');
  return removed;
}

/**
 * Obfuscate an API key for display.
 *
 * - Empty/null/undefined → `(none)`
 * - 8 chars or fewer → `***`
 * - Otherwise → first 3 + `...` + last 4 chars
 */
export function obfuscateKey(key) {
  if (key === null || key === undefined || key === '') return '(none)';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}
