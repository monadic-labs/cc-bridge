import { Result } from './types.js';
import { ArgumentError, AuthError } from './exceptions.js';

const COOKIE_NAME = 'ccb-auth';
const BEARER_PREFIX = 'Bearer ';
const MIN_SECRET_LENGTH = 16;

// Wraps the shared admin secret. Validation in constructor; frozen after.
// Equality is constant-time at the byte level (Node Buffer compare); the
// auth path is not a high-throughput hot path so the cost is negligible.
export class AuthSecret {
  #value;

  constructor(raw) {
    if (typeof raw !== 'string') {
      throw new ArgumentError('AuthSecret: value must be a string', { context: { type: typeof raw } });
    }
    if (raw.length < MIN_SECRET_LENGTH) {
      throw new ArgumentError(`AuthSecret: value must be >= ${MIN_SECRET_LENGTH} characters`, { context: { length: raw.length } });
    }
    this.#value = raw;
    Object.freeze(this);
  }

  get value() { return this.#value; }

  equals(other) {
    if (!(other instanceof AuthSecret)) return false;
    const a = Buffer.from(this.#value);
    const b = Buffer.from(other.value);
    if (a.length !== b.length) return false;
    return Buffer.compare(a, b) === 0;
  }
}

// Pure predicate. Returns true iff the address represents a loopback peer
// (IPv4 127/8, IPv6 ::1 in any canonical form, IPv4-mapped IPv6 127/8).
// Treats any non-string / malformed input as non-loopback (fail-closed).
export function isLoopbackAddress(remoteAddress) {
  if (typeof remoteAddress !== 'string' || remoteAddress.length === 0) return false;

  // IPv4: 127.0.0.0/8
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(remoteAddress)) {
    return remoteAddress.startsWith('127.');
  }

  // IPv6 canonical ::1 (also expanded form)
  if (remoteAddress === '::1') return true;
  if (/^0+:0+:0+:0+:0+:0+:0+:0*1$/.test(remoteAddress)) return true;

  // IPv4-mapped IPv6: ::ffff:127.x.x.x and ::ffff:7fNN:NNNN
  const mappedDotted = remoteAddress.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mappedDotted) return mappedDotted[1].startsWith('127.');
  const mappedHex = remoteAddress.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    return (hi & 0xff00) === 0x7f00;
  }

  return false;
}

// Pure parser. Pulls the ccb-auth cookie value from a Cookie header.
// Returns null when the header is missing, empty, or doesn't contain the
// expected key as an EXACT match (no leading whitespace before the '=').
export function parseAuthCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const trimmed = part.replace(/^\s+/, '');
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const name = trimmed.slice(0, eqIndex);
    if (name !== COOKIE_NAME) continue;
    return trimmed.slice(eqIndex + 1);
  }
  return null;
}

// Pure validator. Inspects a request-shaped object (anything with `headers`)
// and returns Result<void, AuthError>. Accepts Authorization: Bearer <secret>
// OR Cookie: ccb-auth=<secret>. Bearer is checked first; on mismatch, falls
// back to cookie. Any presence-but-wrong-value returns wrong_secret; total
// absence returns missing_credentials; non-Bearer schemes return
// unsupported_scheme.
export function isAuthorizedRequest(req, secret) {
  if (!req || typeof req !== 'object' || !req.headers || typeof req.headers !== 'object') {
    throw new ArgumentError('isAuthorizedRequest: req must have a headers object');
  }
  if (!(secret instanceof AuthSecret)) {
    throw new ArgumentError('isAuthorizedRequest: secret must be an AuthSecret');
  }

  // Node normalizes incoming headers to lowercase; tests cover both cases.
  const authHeader = req.headers.authorization ?? req.headers.Authorization;
  const cookieHeader = req.headers.cookie ?? req.headers.Cookie;

  const cookieToken = parseAuthCookie(cookieHeader);

  if (typeof authHeader === 'string' && authHeader.length > 0) {
    if (!authHeader.startsWith(BEARER_PREFIX)) {
      if (cookieToken !== null && cookieToken === secret.value) return Result.ok(undefined);
      return Result.fail(new AuthError('Unsupported Authorization scheme; expected Bearer', { reason: 'unsupported_scheme' }));
    }
    const token = authHeader.slice(BEARER_PREFIX.length);
    if (token.length === 0) {
      if (cookieToken !== null && cookieToken === secret.value) return Result.ok(undefined);
      return Result.fail(new AuthError('Empty Bearer token', { reason: 'missing_credentials' }));
    }
    if (token === secret.value) return Result.ok(undefined);
    if (cookieToken !== null && cookieToken === secret.value) return Result.ok(undefined);
    return Result.fail(new AuthError('Wrong secret', { reason: 'wrong_secret' }));
  }

  if (cookieToken !== null) {
    if (cookieToken === secret.value) return Result.ok(undefined);
    return Result.fail(new AuthError('Wrong secret', { reason: 'wrong_secret' }));
  }

  return Result.fail(new AuthError('No Authorization header or ccb-auth cookie', { reason: 'missing_credentials' }));
}

// Returns the value for a Set-Cookie header that pins the secret as
// HttpOnly + SameSite=Strict + Path=/. No Domain (origin-only). No Max-Age
// (session cookie — discarded when the browser closes).
export function buildSetCookieHeader(secret) {
  if (!(secret instanceof AuthSecret)) {
    throw new ArgumentError('buildSetCookieHeader: secret must be an AuthSecret');
  }
  return `${COOKIE_NAME}=${secret.value}; HttpOnly; SameSite=Strict; Path=/`;
}
