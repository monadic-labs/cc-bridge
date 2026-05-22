import path from 'path';

const GUI_PREFIX = '/gui';

// Resolves a request URL under /gui to a concrete file path inside guiDir,
// or returns null when the request must be 404'd. Pure function; no I/O.
//
// Security boundary: every URL that escapes guiDir (literal '..', percent-encoded
// '..', absolute paths injected after /gui/, null bytes, malformed
// percent-encoding, or anything not under /gui) returns null. Callers MUST
// treat null as a hard 404, not a fallback.
export function resolveGuiPath(guiDir, urlPath) {
  if (typeof guiDir !== 'string' || guiDir.length === 0) return null;
  if (typeof urlPath !== 'string') return null;

  const cleanUrl = urlPath.split('?')[0].split('#')[0];

  if (cleanUrl === GUI_PREFIX || cleanUrl === GUI_PREFIX + '/') {
    return path.join(guiDir, 'index.html');
  }
  if (!cleanUrl.startsWith(GUI_PREFIX + '/')) return null;

  const rawRelative = cleanUrl.slice(GUI_PREFIX.length + 1);
  // Reject leading '/' to prevent absolute-path injection like '/gui//etc/passwd'.
  if (rawRelative.startsWith('/')) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(rawRelative);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const candidate = path.resolve(guiDir, decoded);
  const guiDirWithSep = guiDir.endsWith(path.sep) ? guiDir : guiDir + path.sep;
  if (!candidate.startsWith(guiDirWithSep) && candidate !== guiDir) return null;

  return candidate;
}
