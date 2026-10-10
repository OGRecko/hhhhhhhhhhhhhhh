/**
 * Small, dependency-free HTTP helpers shared by the API layer.
 *
 * Everything here works on Node's own IncomingMessage/ServerResponse so the
 * API can be mounted inside Express in production AND exercised over a real
 * socket in tests without Express installed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LIMITS } from '../src/lib/publicLimits';

/** An error whose message is safe to show to any caller. Nothing else ever reaches a response body. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly publicMessage: string,
    public readonly extra?: Record<string, unknown>,
    /** Close the connection after replying (used when the body was not consumed). */
    public readonly closeConnection = false,
  ) {
    super(publicMessage);
    this.name = 'HttpError';
  }
}

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) { res.end(); return; }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function sendBuffer(res: ServerResponse, status: number, contentType: string, data: Buffer, headers: Record<string, string> = {}): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Cache-Control': 'private, no-store',
    'Content-Type': contentType,
    'Content-Length': data.length,
    ...headers,
  });
  res.end(data);
}

/**
 * Read and parse a JSON body with a hard byte ceiling.
 *
 *  - Content-Length above the limit is refused BEFORE reading a single byte.
 *  - Chunked/lying clients are cut off the moment the running total passes the limit.
 *  - A slow client must finish inside `timeoutMs` (slow-loris).
 *  - Only `application/json` is accepted.
 *
 * Every failure is an HttpError with a fixed public message: no parser text,
 * no stack, no echo of the body.
 */
export function readJsonBody(req: IncomingMessage, limitBytes: number, timeoutMs: number = LIMITS.BODY_READ_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!/^application\/json\s*(;|$)/.test(ct)) {
      return reject(new HttpError(415, 'Content-Type must be application/json.', undefined, true));
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const n = Number(declared);
      if (!Number.isInteger(n) || n < 0) return reject(new HttpError(400, 'Invalid Content-Length.', undefined, true));
      if (n > limitBytes) return reject(new HttpError(413, 'Request body too large.', undefined, true));
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      fn();
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) return finish(() => reject(new HttpError(413, 'Request body too large.', undefined, true)));
      chunks.push(chunk);
    };
    const onEnd = () => finish(() => {
      if (total === 0) return reject(new HttpError(400, 'Request body must be a JSON object.'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON.'));
      }
    });
    const onError = () => finish(() => reject(new HttpError(400, 'Request could not be read.', undefined, true)));
    const onAborted = () => finish(() => reject(new HttpError(400, 'Request aborted.', undefined, true)));
    const timer = setTimeout(() => finish(() => reject(new HttpError(408, 'Request timed out.', undefined, true))), timeoutMs);
    (timer as any).unref?.();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;

function normaliseIp(raw: string | undefined | null): string {
  if (!raw) return 'unknown';
  let ip = raw.trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return IP_RE.test(ip) ? ip : 'unknown';
}

/**
 * Client address for rate limiting.
 *
 * `trustedHops` is the EXACT number of trusted reverse proxies in front of the
 * app (0 = none: use the socket address and ignore X-Forwarded-For entirely).
 * With N trusted hops the client is the Nth entry from the RIGHT of
 * X-Forwarded-For, because each trusted proxy appends the address it saw; any
 * entries further left were supplied by the client and are ignored. If the
 * header has fewer than N entries the request did not come through the proxy
 * chain we trust, so we fall back to the socket address.
 */
export function clientIp(req: IncomingMessage, trustedHops: number | false): string {
  const socketIp = normaliseIp(req.socket?.remoteAddress);
  if (!trustedHops || trustedHops < 1) return socketIp;
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw || raw.length > 2000) return socketIp;
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < trustedHops) return socketIp;
  return normaliseIp(parts[parts.length - trustedHops]);
}

/**
 * Per-process fixed-window limiter for CHEAP routes (reads, auth failures,
 * client error reports), where a Firestore transaction per request would cost
 * more than the abuse it prevents. Expensive routes use the Firestore-backed,
 * cross-instance limiter in admission.ts instead.
 *
 * Memory is bounded: when the key table is full the oldest windows are
 * discarded, so an attacker rotating keys cannot grow it without limit.
 */
export class LocalRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number = Date.now, private readonly maxKeys: number = LIMITS.MAX_LOCAL_LIMITER_KEYS) {}

  /** Records one hit; returns whether it is within `max` for the current window. */
  hit(key: string, windowMs: number, max: number): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    const start = Math.floor(now / windowMs) * windowMs;
    const id = `${windowMs}:${key}`;
    let w = this.windows.get(id);
    if (!w || w.start !== start) {
      if (!w && this.windows.size >= this.maxKeys) this.evict(start);
      w = { start, count: 0 };
      this.windows.set(id, w);
    }
    w.count++;
    return { allowed: w.count <= max, retryAfterSeconds: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
  }

  /** Non-recording check. */
  isBlocked(key: string, windowMs: number, max: number): boolean {
    const now = this.now();
    const start = Math.floor(now / windowMs) * windowMs;
    const w = this.windows.get(`${windowMs}:${key}`);
    return !!w && w.start === start && w.count >= max;
  }

  get size(): number { return this.windows.size; }

  private evict(currentStart: number): void {
    // Drop stale windows first; if that frees nothing, drop the oldest tenth.
    for (const [k, w] of this.windows) if (w.start < currentStart) this.windows.delete(k);
    if (this.windows.size < this.maxKeys) return;
    let n = Math.ceil(this.maxKeys / 10);
    for (const k of this.windows.keys()) { this.windows.delete(k); if (--n <= 0) break; }
  }
}
