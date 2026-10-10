import crypto from 'node:crypto';
import { CAPABILITY_TOKEN_HEX_LENGTH, LIMITS } from '../src/lib/publicLimits';

export { CAPABILITY_TOKEN_HEX_LENGTH };
export const CAPABILITY_TOKEN_BYTES = LIMITS.CAPABILITY_TOKEN_BYTES;

const TOKEN_RE = /^[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

/** 256 bits from the OS CSPRNG, hex-encoded. */
export function createCapabilityToken(): string {
  return crypto.randomBytes(LIMITS.CAPABILITY_TOKEN_BYTES).toString('hex');
}

export function hashCapabilityToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time check of a presented token against a stored hash. Tokens have
 * one exact shape (64 lowercase hex), so anything else is rejected outright
 * rather than hashed, and the comparison always runs on equal-length buffers.
 */
export function capabilityTokenMatches(token: unknown, tokenHash: unknown): boolean {
  const wellFormedToken = typeof token === 'string' && TOKEN_RE.test(token);
  const wellFormedHash = typeof tokenHash === 'string' && HASH_RE.test(tokenHash);
  // Hash a fixed dummy when the token is malformed so work is comparable.
  const actual = Buffer.from(hashCapabilityToken(wellFormedToken ? (token as string) : '0'.repeat(64)), 'hex');
  const expected = Buffer.from(wellFormedHash ? (tokenHash as string) : '0'.repeat(64), 'hex');
  const equal = crypto.timingSafeEqual(actual, expected);
  return wellFormedToken && wellFormedHash && equal;
}

/**
 * Extract a Bearer token from an Authorization header. The header is length
 * capped BEFORE any parsing so an attacker cannot make us process megabytes.
 * Tokens are accepted ONLY from this header: never a URL, query or body.
 */
export function extractBearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string' || header.length === 0 || header.length > LIMITS.MAX_AUTH_HEADER_CHARS) return undefined;
  const m = /^Bearer ([0-9a-f]{64})$/.exec(header);
  return m ? m[1] : undefined;
}
