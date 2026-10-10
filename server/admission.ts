/**
 * Admission control: IP rate limits, per-IP active-job cap, and the global
 * solver concurrency cap. All state lives in Firestore so it holds across
 * instances. There is NO test-mode bypass: tests inject a fake Firestore and
 * exercise this exact code.
 */
import crypto from 'node:crypto';
import type { FirestoreLike } from './jobStore';
import { LIMITS } from '../src/lib/publicLimits';

export const RATE_LIMIT_COLLECTION = 'publicRateLimits';
export const SLOT_DOC = 'solverConcurrency/global';

/** Privacy-safe identifier for a client IP: a salted hash, never the raw address. */
export function ipKey(ip: string, salt: string): string {
  return crypto.createHmac('sha256', salt).update(String(ip || 'unknown')).digest('hex').slice(0, 32);
}

export interface RateLimitResult { allowed: boolean; retryAfterSeconds: number }

export class Admission {
  constructor(
    private readonly db: FirestoreLike,
    private readonly salt: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Fixed-window counter. The window start is folded into the document ID, so
   * a new window is a new document and stale documents are reclaimed by cleanup.
   */
  async rateLimit(route: string, ip: string, windowMs: number, max: number): Promise<RateLimitResult> {
    const now = this.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const id = crypto.createHash('sha256').update(`${route}:${ipKey(ip, this.salt)}:${windowStart}`).digest('hex');
    const ref = this.db.collection(RATE_LIMIT_COLLECTION).doc(id);
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
    const allowed = await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? Number(snap.data()?.count ?? 0) : 0;
      if (count >= max) return false;
      tx.set(ref, {
        route, count: count + 1, resetAt: windowStart + windowMs,
        expireAt: new Date(windowStart + windowMs), createdAt: snap.exists ? (snap.data()?.createdAt ?? now) : now,
      });
      return true;
    });
    return { allowed, retryAfterSeconds };
  }

  /** Read-only: is this (route, ip) already at its limit in the current window? Consumes nothing. */
  async isRateLimited(route: string, ip: string, windowMs: number, max: number): Promise<boolean> {
    const now = this.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const id = crypto.createHash('sha256').update(`${route}:${ipKey(ip, this.salt)}:${windowStart}`).digest('hex');
    const snap = await this.db.collection(RATE_LIMIT_COLLECTION).doc(id).get();
    return snap.exists && Number(snap.data()?.count ?? 0) >= max;
  }

  /**
   * Take one global solver slot AND one per-IP active-job slot atomically.
   * Slots expire on their own so a crashed process cannot leak them forever.
   */
  async acquireSlot(ip: string, ttlMs: number): Promise<{ ok: true; slotId: string } | { ok: false; reason: 'global' | 'per_ip' }> {
    const now = this.now();
    const slotId = crypto.randomUUID();
    const owner = ipKey(ip, this.salt);
    const ref = this.db.doc(SLOT_DOC);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const raw = (snap.exists ? snap.data()?.slots : {}) || {};
      const active: Record<string, { until: number; owner: string }> = {};
      for (const [id, v] of Object.entries<any>(raw)) if (Number(v?.until) > now) active[id] = { until: Number(v.until), owner: String(v.owner) };
      const all = Object.values(active);
      if (all.length >= LIMITS.MAX_CONCURRENT_SOLVER_JOBS) return { ok: false as const, reason: 'global' as const };
      if (all.filter((s) => s.owner === owner).length >= LIMITS.MAX_ACTIVE_JOBS_PER_IP) return { ok: false as const, reason: 'per_ip' as const };
      active[slotId] = { until: now + ttlMs, owner };
      tx.set(ref, { slots: active, updatedAt: now });
      return { ok: true as const, slotId };
    });
  }

  async extendSlot(slotId: string, ttlMs: number): Promise<void> {
    const ref = this.db.doc(SLOT_DOC);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const slots = { ...(snap.data()?.slots || {}) };
      if (!slots[slotId]) return;
      slots[slotId] = { ...slots[slotId], until: this.now() + ttlMs };
      tx.set(ref, { slots, updatedAt: this.now() });
    });
  }

  async releaseSlot(slotId: string | undefined | null): Promise<void> {
    if (!slotId) return;
    const ref = this.db.doc(SLOT_DOC);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const slots = { ...(snap.data()?.slots || {}) };
      if (!(slotId in slots)) return;
      delete slots[slotId];
      tx.set(ref, { slots, updatedAt: this.now() });
    });
  }

  /** Delete expired rate-limit windows, paginating until exhausted (no arbitrary ceiling). */
  async purgeExpiredRateLimits(pageSize: number = LIMITS.SCAN_PAGE_SIZE): Promise<number> {
    const now = this.now();
    let deleted = 0;
    for (;;) {
      const page = await this.db.collection(RATE_LIMIT_COLLECTION).where('resetAt', '<', now).limit(pageSize).get();
      if (page.empty) break;
      const batch = (this.db as any).batch();
      for (const d of page.docs) batch.delete(d.ref);
      await batch.commit();
      deleted += page.size;
      // Deleted docs disappear from the query, so re-querying from the top always makes progress.
      if (page.size < pageSize) break;
    }
    return deleted;
  }
}
