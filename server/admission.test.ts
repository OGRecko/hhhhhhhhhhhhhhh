/**
 * admission.ts had no dedicated test file before this pass, despite being
 * the code that enforces per-IP rate limits, the global solver concurrency
 * cap, and the per-IP active-job cap - all security/capacity-relevant.
 * Read through in full first (no bugs found on inspection); this file
 * verifies the claims made in its own comments by actually exercising it,
 * including a genuine race between two concurrent acquireSlot() calls using
 * FakeFirestore's forced-interleaving hook, to prove the transaction really
 * prevents over-admission rather than just looking correct on paper.
 */
import assert from 'node:assert/strict';
import { Admission, ipKey } from './admission';
import { FakeFirestore } from './testing/memoryFirestore';
import { LIMITS } from '../src/lib/publicLimits';

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== Admission tests ===\n');

const SALT = 'test-salt';

await check('rateLimit allows up to max requests in a window, then denies', async () => {
  const db = new FakeFirestore();
  let now = 1_000_000;
  const admission = new Admission(db, SALT, () => now);
  const windowMs = 60_000, max = 3;

  for (let i = 0; i < max; i++) {
    const r = await admission.rateLimit('route', '1.2.3.4', windowMs, max);
    assert.equal(r.allowed, true, `request ${i + 1} of ${max} should be allowed`);
  }
  const denied = await admission.rateLimit('route', '1.2.3.4', windowMs, max);
  assert.equal(denied.allowed, false, 'request beyond max should be denied');
  assert.ok(denied.retryAfterSeconds > 0, 'a denied request should report a positive retryAfterSeconds');
});

await check('rateLimit resets in a new fixed window', async () => {
  const db = new FakeFirestore();
  let now = 1_000_000;
  const admission = new Admission(db, SALT, () => now);
  const windowMs = 60_000, max = 1;

  assert.equal((await admission.rateLimit('route', '1.2.3.4', windowMs, max)).allowed, true);
  assert.equal((await admission.rateLimit('route', '1.2.3.4', windowMs, max)).allowed, false, 'still in the same window');
  now += windowMs; // advance into the next fixed window
  assert.equal((await admission.rateLimit('route', '1.2.3.4', windowMs, max)).allowed, true, 'a new window should reset the count');
});

await check('rateLimit tracks different IPs and different routes independently', async () => {
  const db = new FakeFirestore();
  const admission = new Admission(db, SALT, () => 1_000_000);
  const windowMs = 60_000, max = 1;

  assert.equal((await admission.rateLimit('routeA', '1.1.1.1', windowMs, max)).allowed, true);
  assert.equal((await admission.rateLimit('routeA', '2.2.2.2', windowMs, max)).allowed, true, 'a different IP should have its own counter');
  assert.equal((await admission.rateLimit('routeB', '1.1.1.1', windowMs, max)).allowed, true, 'a different route should have its own counter for the same IP');
  assert.equal((await admission.rateLimit('routeA', '1.1.1.1', windowMs, max)).allowed, false, 'the original route+IP should still be capped');
});

await check('isRateLimited reflects state without consuming a slot', async () => {
  const db = new FakeFirestore();
  const admission = new Admission(db, SALT, () => 1_000_000);
  const windowMs = 60_000, max = 1;

  assert.equal(await admission.isRateLimited('route', '1.2.3.4', windowMs, max), false, 'nothing consumed yet');
  await admission.rateLimit('route', '1.2.3.4', windowMs, max);
  assert.equal(await admission.isRateLimited('route', '1.2.3.4', windowMs, max), true, 'at max after one consuming call');
  // Calling isRateLimited itself must not consume a slot - check idempotence.
  assert.equal(await admission.isRateLimited('route', '1.2.3.4', windowMs, max), true);
});

await check('ipKey never exposes the raw IP and is stable for the same IP+salt', () => {
  const a = ipKey('203.0.113.5', SALT);
  const b = ipKey('203.0.113.5', SALT);
  const c = ipKey('203.0.113.6', SALT);
  assert.equal(a, b, 'same IP+salt should hash the same');
  assert.notEqual(a, c, 'different IPs should hash differently');
  assert.ok(!a.includes('203.0.113.5'), 'the hash must not contain the raw IP');
});

await check('acquireSlot enforces the global concurrency cap', async () => {
  const db = new FakeFirestore();
  const admission = new Admission(db, SALT, () => 1_000_000);
  // LIMITS.MAX_CONCURRENT_SOLVER_JOBS is 1 in production (see HARDENING_LEDGER.md);
  // exercise generically against whatever it currently is rather than hardcoding.
  const cap = LIMITS.MAX_CONCURRENT_SOLVER_JOBS;

  const results = [];
  for (let i = 0; i < cap; i++) {
    results.push(await admission.acquireSlot(`ip-${i}`, 60_000)); // different IPs so per-IP cap doesn't interfere
  }
  for (const r of results) assert.equal(r.ok, true, `all ${cap} slots up to the global cap should succeed`);

  const overflow = await admission.acquireSlot('ip-overflow', 60_000);
  assert.equal(overflow.ok, false);
  if (!overflow.ok) assert.equal(overflow.reason, 'global');
});

await check('acquireSlot enforces the per-IP active-job cap independent of the global cap', async () => {
  // This only distinguishes from the global cap when MAX_ACTIVE_JOBS_PER_IP
  // < MAX_CONCURRENT_SOLVER_JOBS - with today's production values (both 1,
  // see HARDENING_LEDGER.md for why MAX_CONCURRENT_SOLVER_JOBS was lowered
  // to 1) a single IP hitting its own cap of 1 is indistinguishable from
  // hitting the global cap of 1, and acquireSlot's global check runs first
  // (see admission.ts), so it correctly reports 'global' in that case, not
  // 'per_ip'. Skip rather than assert something structurally impossible
  // given the current constants; if the gap between the two limits ever
  // widens again, this starts actually exercising the per-IP branch.
  if (LIMITS.MAX_ACTIVE_JOBS_PER_IP >= LIMITS.MAX_CONCURRENT_SOLVER_JOBS) {
    console.log(`    (skipped: MAX_ACTIVE_JOBS_PER_IP=${LIMITS.MAX_ACTIVE_JOBS_PER_IP} >= MAX_CONCURRENT_SOLVER_JOBS=${LIMITS.MAX_CONCURRENT_SOLVER_JOBS}, so the global cap is hit first or simultaneously)`);
    return;
  }
  const db = new FakeFirestore();
  const admission = new Admission(db, SALT, () => 1_000_000);
  const perIpCap = LIMITS.MAX_ACTIVE_JOBS_PER_IP;

  const results = [];
  for (let i = 0; i < perIpCap; i++) {
    results.push(await admission.acquireSlot('same-ip', 60_000));
  }
  for (const r of results) assert.equal(r.ok, true, `all ${perIpCap} slots for one IP up to its cap should succeed`);

  const overflow = await admission.acquireSlot('same-ip', 60_000);
  assert.equal(overflow.ok, false);
  if (!overflow.ok) assert.equal(overflow.reason, 'per_ip');
});

await check('expired slots free up capacity without an explicit release', async () => {
  const db = new FakeFirestore();
  let now = 1_000_000;
  const admission = new Admission(db, SALT, () => now);
  const cap = LIMITS.MAX_CONCURRENT_SOLVER_JOBS;

  for (let i = 0; i < cap; i++) {
    const r = await admission.acquireSlot(`ip-${i}`, 1_000); // short TTL
    assert.equal(r.ok, true);
  }
  assert.equal((await admission.acquireSlot('ip-new', 60_000)).ok, false, 'should be at cap before expiry');

  now += 2_000; // past the short TTL of the earlier slots
  const afterExpiry = await admission.acquireSlot('ip-new', 60_000);
  assert.equal(afterExpiry.ok, true, 'expired slots should not count against the cap');
});

await check('releaseSlot frees the slot immediately, before its TTL', async () => {
  const db = new FakeFirestore();
  const admission = new Admission(db, SALT, () => 1_000_000);
  const cap = LIMITS.MAX_CONCURRENT_SOLVER_JOBS;

  const slots = [];
  for (let i = 0; i < cap; i++) {
    const r = await admission.acquireSlot(`ip-${i}`, 600_000); // long TTL
    assert.equal(r.ok, true);
    if (r.ok) slots.push(r.slotId);
  }
  assert.equal((await admission.acquireSlot('ip-new', 60_000)).ok, false);

  await admission.releaseSlot(slots[0]);
  const afterRelease = await admission.acquireSlot('ip-new', 60_000);
  assert.equal(afterRelease.ok, true, 'releasing one slot should free capacity immediately');
});

await check('extendSlot keeps a slot alive past what its original TTL would have allowed', async () => {
  const db = new FakeFirestore();
  let now = 1_000_000;
  const admission = new Admission(db, SALT, () => now);
  const r = await admission.acquireSlot('ip-a', 1_000);
  assert.equal(r.ok, true);
  if (!r.ok) return;

  now += 500;
  await admission.extendSlot(r.slotId, 1_000); // extend from the new "now"
  now += 900; // total elapsed since acquire: 1400ms, past the original 1000ms TTL, but within the extension

  // A second slot for a different IP should still be blocked by the (still-alive) first slot at cap=1,
  // proving extendSlot actually pushed the expiry forward rather than being a no-op.
  if (LIMITS.MAX_CONCURRENT_SOLVER_JOBS === 1) {
    const other = await admission.acquireSlot('ip-b', 60_000);
    assert.equal(other.ok, false, 'the extended slot should still be occupying the only global slot');
  }
});

await check('extendSlot on an already-expired or unknown slot is a harmless no-op', async () => {
  const db = new FakeFirestore();
  const admission = new Admission(db, SALT, () => 1_000_000);
  await admission.extendSlot('nonexistent-slot-id', 60_000); // must not throw
});

await check('releaseSlot on an unknown or already-released slot is a harmless no-op', async () => {
  const db = new FakeFirestore();
  const admission = new Admission(db, SALT, () => 1_000_000);
  await admission.releaseSlot('nonexistent-slot-id'); // must not throw
  await admission.releaseSlot(undefined); // must not throw
  await admission.releaseSlot(null); // must not throw
});

await check('two concurrent acquireSlot calls racing for the last global slot: exactly one wins', async () => {
  // This is the real point of this file: prove the Firestore transaction
  // actually serializes the two calls rather than both reading a stale
  // "0 active slots" snapshot and both succeeding.
  if (LIMITS.MAX_CONCURRENT_SOLVER_JOBS !== 1) {
    console.log('    (skipped: this race test assumes a global cap of 1)');
    return;
  }
  const db = new FakeFirestore();
  const admission = new Admission(db, SALT, () => 1_000_000);

  // Force both transactions to complete their read before either commits,
  // by releasing both reads via a shared gate.
  let readersWaiting = 0;
  let releaseReaders: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { releaseReaders = resolve; });
  db.setAfterTxRead(async () => {
    readersWaiting++;
    if (readersWaiting === 2) releaseReaders?.();
    await gate;
  });

  const [a, b] = await Promise.all([
    admission.acquireSlot('ip-a', 60_000),
    admission.acquireSlot('ip-b', 60_000),
  ]);

  const outcomes = [a.ok, b.ok];
  assert.equal(outcomes.filter((ok) => ok).length, 1, `exactly one of two racing acquireSlot calls should succeed, got ${JSON.stringify(outcomes)}`);
  assert.ok(db.stats.transactionAborts >= 1, 'the race should have caused at least one transaction retry/abort');
});

await check('purgeExpiredRateLimits deletes only windows whose resetAt has passed', async () => {
  const db = new FakeFirestore();
  let now = 1_000_000;
  const admission = new Admission(db, SALT, () => now);
  const windowMs = 1_000;

  await admission.rateLimit('route', 'ip-old', windowMs, 10); // resetAt = now+1000
  now += 5_000; // this window is now long expired
  await admission.rateLimit('route', 'ip-new', windowMs, 10); // resetAt = now(6M)+1000, not expired yet

  const deleted = await admission.purgeExpiredRateLimits();
  assert.equal(deleted, 1, `expected exactly 1 expired window purged, got ${deleted}`);
  assert.equal(await admission.isRateLimited('route', 'ip-new', windowMs, 10), false, 'the still-live window should be untouched (still under its own max)');
});

await check('purgeExpiredRateLimits pages through more entries than one page size', async () => {
  const db = new FakeFirestore();
  let now = 1_000_000;
  const admission = new Admission(db, SALT, () => now);
  const windowMs = 1_000;
  const pageSize = 3;
  const N = 10;

  for (let i = 0; i < N; i++) await admission.rateLimit('route', `ip-${i}`, windowMs, 10);
  now += 5_000; // expire them all

  const deleted = await admission.purgeExpiredRateLimits(pageSize);
  assert.equal(deleted, N, `expected all ${N} expired windows purged across multiple pages of size ${pageSize}, got ${deleted}`);
});

console.log(`\n=== ${passed} passed ===`);
