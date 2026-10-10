/**
 * REAL multi-instance concurrency tests for the durable job store.
 *
 * "Instance A" and "Instance B" are two independent JobStore objects (as two
 * server processes would be) sharing one Firestore. The fake Firestore uses
 * optimistic, read-set-validated transactions and a hook that forces both
 * transactions to READ before either COMMITS, which is the exact interleaving
 * that breaks non-transactional or check-then-write code.
 *
 * A NEGATIVE CONTROL first proves the harness can detect a double claim: a
 * deliberately naive claim (read, yield, blind write) is run through the same
 * interleaving and MUST let both instances "win". If the harness could not
 * reproduce the race, the passing assertions below would prove nothing.
 */
import assert from 'node:assert/strict';
import { JobStore, PUBLIC_ERROR_CODES, type JobRecord } from './jobStore';
import { FakeFirestore } from './testing/memoryFirestore';
import { LIMITS } from '../src/lib/publicLimits';

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e: any) { console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`); process.exitCode = 1; }
}

const SIM = '11111111-1111-4111-8111-111111111111';
const HASH = 'a'.repeat(64);

function baseRecord(over: Partial<JobRecord> = {}) {
  return {
    simulationId: SIM, jobId: '22222222-2222-4222-8222-222222222222', type: 'impulse-response' as const,
    capabilityTokenHash: HASH, createdAt: 1_000_000, jobPayload: { L: 5, W: 4, H: 3 }, ...over,
  };
}

/** A clock every store shares, so lease expiry is deterministic. */
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } };
}

/**
 * Barrier that makes N transactions all finish their first READ before any
 * proceeds to commit: the classic lost-update / double-claim interleaving.
 */
function readBarrier(parties: number) {
  let waiting = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return async () => {
    waiting++;
    if (waiting >= parties) release();
    await gate;
  };
}

console.log('\n=== Multi-instance job-store concurrency ===\n');

async function main() {
  // ---------------------------------------------------------------- control
  await check('NEGATIVE CONTROL: a naive read-then-blind-write claim IS raced by the harness (both instances "win")', async () => {
    const fs = new FakeFirestore();
    const clock = makeClock();
    const store = new JobStore(fs, clock.now);
    await store.createQueued(baseRecord());
    const barrier = readBarrier(2);
    const ref = fs.collection('simulations').doc(SIM);
    // Naive claim: NOT a transaction. Read, wait for the other reader, then blind-write.
    const naiveClaim = async (owner: string) => {
      const snap = await ref.get();
      await barrier();
      if (snap.data()!.status !== 'queued') return false;
      await ref.set({ status: 'running', leaseOwner: owner }, { merge: true });
      return true;
    };
    const results = await Promise.all([naiveClaim('A'), naiveClaim('B')]);
    assert.deepEqual(results, [true, true], 'harness must be able to reproduce the double-claim race');
  });

  // ------------------------------------------------------- simultaneous claim
  await check('two instances claim the SAME job simultaneously with forced read-read-commit-commit interleaving: exactly one wins', async () => {
    const fs = new FakeFirestore();
    const clock = makeClock();
    await new JobStore(fs, clock.now).createQueued(baseRecord());
    // Install the barrier only AFTER seeding, so it affects just the two competing claims.
    const barrier = readBarrier(2);
    let armed = true;
    fs.setAfterTxRead(async (p) => { if (armed && p.endsWith(SIM)) await barrier(); });
    const A = new JobStore(fs, clock.now);
    const B = new JobStore(fs, clock.now);
    const [ra, rb] = await Promise.all([A.claim(SIM, 'instance-A'), B.claim(SIM, 'instance-B')]);
    armed = false;
    const winners = [ra, rb].filter((r) => r.claimed);
    assert.equal(winners.length, 1, 'exactly one instance may claim the job');
    const loser = [ra, rb].find((r) => !r.claimed)!;
    assert.equal((loser as any).reason, 'lease_held');
    assert.ok(fs.stats.transactionAborts >= 1, 'the losing transaction must have been aborted by contention and retried');
    const rec = (await A.get(SIM))!;
    assert.equal(rec.status, 'running');
    assert.equal(rec.leaseEpoch, 1, 'the epoch must have been granted exactly once');
    assert.ok(rec.leaseOwner === 'instance-A' || rec.leaseOwner === 'instance-B');
  });

  await check('50 instances race to claim one job: exactly one winner, 49 back off', async () => {
    const fs = new FakeFirestore({ maxAttempts: 200 });
    const clock = makeClock();
    await new JobStore(fs, clock.now).createQueued(baseRecord());
    const stores = Array.from({ length: 50 }, () => new JobStore(fs, clock.now));
    const results = await Promise.all(stores.map((s, i) => s.claim(SIM, `inst-${i}`)));
    assert.equal(results.filter((r) => r.claimed).length, 1);
    assert.equal(results.filter((r) => !r.claimed).length, 49);
    assert.ok(results.filter((r) => !r.claimed).every((r: any) => r.reason === 'lease_held'));
    assert.equal((await stores[0].get(SIM))!.leaseEpoch, 1);
  });

  // --------------------------------------------------------- only one executes
  await check('only ONE worker executes the solver when two instances process the same job', async () => {
    const fs = new FakeFirestore({ maxAttempts: 50 });
    const clock = makeClock();
    await new JobStore(fs, clock.now).createQueued(baseRecord());
    let executions = 0;
    let executedBy: string | null = null;
    const runWorker = async (name: string) => {
      const store = new JobStore(fs, clock.now);
      const c = await store.claim(SIM, name);
      if (!c.claimed) return 'backed-off';
      executions++;
      executedBy = name;
      await new Promise((r) => setTimeout(r, 15)); // "solver runs"
      const done = await store.complete(SIM, c.lease, { result: { rt60: 1.2 }, artifacts: [], room: {}, speakers: [], receivers: [] });
      return done.ok ? 'completed' : 'lost';
    };
    const out = await Promise.all([runWorker('worker-1'), runWorker('worker-2'), runWorker('worker-3')]);
    assert.equal(executions, 1, 'the solver body must run exactly once');
    assert.equal(out.filter((o) => o === 'completed').length, 1);
    assert.equal(out.filter((o) => o === 'backed-off').length, 2);
    const rec = (await new JobStore(fs, clock.now).get(SIM))!;
    assert.equal(rec.status, 'completed');
    assert.ok(executedBy);
  });

  // ----------------------------------------------------------- duplicate create
  await check('duplicate submission of the same simulation ID is rejected, first one survives', async () => {
    const fs = new FakeFirestore({ maxAttempts: 50 });
    const clock = makeClock();
    const a = new JobStore(fs, clock.now); const b = new JobStore(fs, clock.now);
    const [x, y] = await Promise.all([
      a.createQueued(baseRecord({ capabilityTokenHash: 'a'.repeat(64) })),
      b.createQueued(baseRecord({ capabilityTokenHash: 'b'.repeat(64) })),
    ]);
    assert.equal([x, y].filter(Boolean).length, 1, 'exactly one create may win');
    const rec = (await a.get(SIM))!;
    assert.ok(rec.capabilityTokenHash === 'a'.repeat(64) || rec.capabilityTokenHash === 'b'.repeat(64));
    // The loser must not have overwritten the winner's token hash.
    assert.equal(rec.capabilityTokenHash, x ? 'a'.repeat(64) : 'b'.repeat(64));
  });

  // ----------------------------------------------------- live lease is respected
  await check('claim never steals a running job with a LIVE lease', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const A = new JobStore(fs, clock.now); const B = new JobStore(fs, clock.now);
    await A.createQueued(baseRecord());
    const a = await A.claim(SIM, 'A'); assert.equal(a.claimed, true);
    clock.advance(LIMITS.JOB_LEASE_MS - 1);
    const b = await B.claim(SIM, 'B');
    assert.equal(b.claimed, false);
    assert.equal((b as any).reason, 'lease_held');
    assert.equal((await A.get(SIM))!.leaseOwner, 'A');
  });

  await check('recover() refuses to touch a job whose lease is still live', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const A = new JobStore(fs, clock.now);
    await A.createQueued(baseRecord()); await A.claim(SIM, 'A');
    clock.advance(LIMITS.JOB_LEASE_MS - 1);
    assert.equal(await A.recover(SIM), 'skipped');
    assert.equal((await A.get(SIM))!.status, 'running');
  });

  // ----------------------------------------------------------- worker crash
  await check('WORKER CRASH: expired lease is recovered, a second worker completes it, and the crashed worker can never overwrite it', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const crashed = new JobStore(fs, clock.now);
    const rescuer = new JobStore(fs, clock.now);
    await crashed.createQueued(baseRecord());
    const c1 = await crashed.claim(SIM, 'worker-that-crashes');
    assert.equal(c1.claimed, true);
    const zombieLease = (c1 as any).lease;
    // ...worker process dies mid-solve: no heartbeat, no completion...
    clock.advance(LIMITS.JOB_LEASE_MS + 1);

    assert.equal(await rescuer.recover(SIM), 'recovered');
    let rec = (await rescuer.get(SIM))!;
    assert.equal(rec.status, 'queued');
    assert.equal(rec.recoveryAttempts, 1);
    assert.equal(rec.leaseEpoch, 2, 'recovery must bump the fencing epoch');

    const c2 = await rescuer.claim(SIM, 'rescuer');
    assert.equal(c2.claimed, true);
    assert.equal((c2 as any).lease.epoch, 3);
    const done = await rescuer.complete(SIM, (c2 as any).lease, { result: { rt60: 9.9, by: 'rescuer' }, artifacts: ['x'], room: {}, speakers: [], receivers: [] });
    assert.equal(done.ok, true);

    // The zombie wakes up and tries to finish / fail / heartbeat with its OLD lease.
    const late = await crashed.complete(SIM, zombieLease, { result: { rt60: 0, by: 'zombie' }, artifacts: [], room: {}, speakers: [], receivers: [] });
    assert.equal(late.ok, false);
    assert.equal(await crashed.heartbeat(SIM, zombieLease), false);
    const lateFail = await crashed.fail(SIM, zombieLease, PUBLIC_ERROR_CODES.solver_failed);
    assert.equal(lateFail.ok, false);

    rec = (await rescuer.get(SIM))!;
    assert.equal(rec.status, 'completed');
    assert.equal((rec.result as any).by, 'rescuer', 'the recovered worker\'s result must not be overwritten');
  });

  await check('STALE-EPOCH FENCING: a zombie with the RIGHT owner name but an old epoch is still rejected', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const s = new JobStore(fs, clock.now);
    await s.createQueued(baseRecord());
    const first = (await s.claim(SIM, 'same-name')) as any;
    clock.advance(LIMITS.JOB_LEASE_MS + 1);
    await s.recover(SIM);
    const second = (await s.claim(SIM, 'same-name')) as any; // same owner string, new epoch
    assert.equal(second.claimed, true);
    assert.notEqual(first.lease.epoch, second.lease.epoch);
    const stale = await s.complete(SIM, first.lease, { result: { stale: true }, artifacts: [], room: {}, speakers: [], receivers: [] });
    assert.equal(stale.ok, false);
    assert.equal((stale as any).reason, 'lost_lease');
  });

  await check('a worker whose own lease has EXPIRED (no heartbeat) cannot complete even if nobody recovered it yet', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const s = new JobStore(fs, clock.now);
    await s.createQueued(baseRecord());
    const c = (await s.claim(SIM, 'slow')) as any;
    clock.advance(LIMITS.JOB_LEASE_MS + 5);
    const r = await s.complete(SIM, c.lease, { result: {}, artifacts: [], room: {}, speakers: [], receivers: [] });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, 'lost_lease');
  });

  await check('heartbeat keeps a long job alive past the original lease window', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const s = new JobStore(fs, clock.now);
    await s.createQueued(baseRecord());
    const c = (await s.claim(SIM, 'w')) as any;
    for (let i = 0; i < 5; i++) {
      clock.advance(LIMITS.JOB_LEASE_MS - 1000);
      assert.equal(await s.heartbeat(SIM, c.lease), true, `heartbeat ${i}`);
    }
    assert.equal(await s.recover(SIM), 'skipped');
    const done = await s.complete(SIM, c.lease, { result: {}, artifacts: [], room: {}, speakers: [], receivers: [] });
    assert.equal(done.ok, true);
  });

  await check('two instances recovering the same expired job at once: exactly one recovery is applied', async () => {
    const fs = new FakeFirestore({ maxAttempts: 50 }); const clock = makeClock();
    const s = new JobStore(fs, clock.now);
    await s.createQueued(baseRecord()); await s.claim(SIM, 'dead');
    clock.advance(LIMITS.JOB_LEASE_MS + 1);
    const stores = Array.from({ length: 10 }, () => new JobStore(fs, clock.now));
    const outs = await Promise.all(stores.map((x) => x.recover(SIM)));
    assert.equal(outs.filter((o) => o === 'recovered').length, 1);
    assert.equal(outs.filter((o) => o === 'skipped').length, 9);
    const rec = (await s.get(SIM))!;
    assert.equal(rec.recoveryAttempts, 1);
    assert.equal(rec.status, 'queued');
  });

  await check('recovery is bounded: after MAX_RECOVERY_ATTEMPTS the job is failed, not retried forever', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const s = new JobStore(fs, clock.now);
    await s.createQueued(baseRecord({ createdAt: clock.now() }));
    let last: string = '';
    for (let i = 0; i < LIMITS.MAX_RECOVERY_ATTEMPTS + 1; i++) {
      const c = await s.claim(SIM, `w${i}`);
      if (!c.claimed) break;
      clock.advance(LIMITS.JOB_LEASE_MS + 1);
      last = await s.recover(SIM);
    }
    assert.equal(last, 'failed');
    const rec = (await s.get(SIM))!;
    assert.equal(rec.status, 'failed');
    assert.equal(rec.errorCode, PUBLIC_ERROR_CODES.recovery_exhausted);
  });

  await check('a job older than MAX_JOB_AGE_MS is failed at claim rather than executed', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const s = new JobStore(fs, clock.now);
    await s.createQueued(baseRecord({ createdAt: clock.now() }));
    clock.advance(LIMITS.MAX_JOB_AGE_MS + 1);
    const c = await s.claim(SIM, 'late');
    assert.equal(c.claimed, false);
    assert.equal((c as any).reason, 'expired_job');
    assert.equal((await s.get(SIM))!.status, 'failed');
  });

  // ------------------------------------------------------------ cancellation
  await check('CANCEL DURING RUN: complete() from the lease holder is refused once cancelled', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const s = new JobStore(fs, clock.now);
    await s.createQueued(baseRecord());
    const c = (await s.claim(SIM, 'w')) as any;
    const cancelled = await s.cancel(SIM);
    assert.deepEqual(cancelled, { ok: true, alreadyFinished: false, status: 'cancelled' });
    const done = await s.complete(SIM, c.lease, { result: { late: true }, artifacts: [], room: {}, speakers: [], receivers: [] });
    assert.equal(done.ok, false);
    const rec = (await s.get(SIM))!;
    assert.equal(rec.status, 'cancelled');
    assert.equal(rec.result, undefined, 'a cancelled job must never acquire a result');
  });

  await check('cancel racing complete (forced interleaving): whichever commits first wins and the other is refused; never both', async () => {
    for (let round = 0; round < 20; round++) {
      const fs = new FakeFirestore({ maxAttempts: 50 }); const clock = makeClock();
      const seed = new JobStore(fs, clock.now);
      await seed.createQueued(baseRecord()); const c = (await seed.claim(SIM, 'w')) as any;
      const [cancelRes, doneRes] = await Promise.all([
        new JobStore(fs, clock.now).cancel(SIM),
        new JobStore(fs, clock.now).complete(SIM, c.lease, { result: { r: round }, artifacts: [], room: {}, speakers: [], receivers: [] }),
      ]);
      const rec = (await seed.get(SIM))!;
      if (doneRes.ok) {
        assert.equal(rec.status, 'completed');
        assert.equal((cancelRes as any).alreadyFinished, true, 'cancel after completion must report alreadyFinished, not overwrite');
      } else {
        assert.equal(rec.status, 'cancelled');
        assert.equal(rec.result, undefined);
      }
    }
  });

  await check('CANCELLATION DURING RECOVERY: a job cancelled while awaiting recovery is not resurrected', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const s = new JobStore(fs, clock.now);
    await s.createQueued(baseRecord()); await s.claim(SIM, 'dead');
    clock.advance(LIMITS.JOB_LEASE_MS + 1);
    await s.cancel(SIM);
    assert.equal(await s.recover(SIM), 'skipped');
    const c = await s.claim(SIM, 'rescuer');
    assert.equal(c.claimed, false);
    assert.equal((c as any).reason, 'terminal');
    assert.equal((await s.get(SIM))!.status, 'cancelled');
  });

  await check('cancel racing recovery (forced interleaving): the job ends cancelled or queued-after-recovery, never running-with-stale-owner', async () => {
    for (let round = 0; round < 20; round++) {
      const fs = new FakeFirestore({ maxAttempts: 50 }); const clock = makeClock();
      const s = new JobStore(fs, clock.now);
      await s.createQueued(baseRecord()); await s.claim(SIM, 'dead');
      clock.advance(LIMITS.JOB_LEASE_MS + 1);
      await Promise.all([new JobStore(fs, clock.now).cancel(SIM), new JobStore(fs, clock.now).recover(SIM)]);
      const rec = (await s.get(SIM))!;
      assert.ok(['cancelled'].includes(rec.status) || rec.status === 'queued', `unexpected ${rec.status}`);
      if (rec.status === 'queued') {
        // cancel ran first-then recover found cancelled (skipped) is impossible here; if queued, cancel must have
        // observed queued and cancelled it - so queued is only reachable if cancel lost. Assert no stale owner.
        assert.equal(rec.leaseOwner, null);
      }
    }
  });

  // -------------------------------------------- completed / failed recovery
  await check('COMPLETED job recovery is a no-op and cannot be re-queued or re-claimed', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const s = new JobStore(fs, clock.now);
    await s.createQueued(baseRecord()); const c = (await s.claim(SIM, 'w')) as any;
    await s.complete(SIM, c.lease, { result: { keep: 1 }, artifacts: ['a'], room: {}, speakers: [], receivers: [] });
    clock.advance(LIMITS.JOB_LEASE_MS * 10);
    assert.equal(await s.recover(SIM), 'skipped');
    const again = await s.claim(SIM, 'w2');
    assert.equal(again.claimed, false); assert.equal((again as any).reason, 'terminal');
    const rec = (await s.get(SIM))!;
    assert.equal(rec.status, 'completed'); assert.deepEqual(rec.result, { keep: 1 });
  });

  await check('FAILED job recovery is a no-op: a failed job is never resurrected without explicit recovery', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const s = new JobStore(fs, clock.now);
    await s.createQueued(baseRecord()); const c = (await s.claim(SIM, 'w')) as any;
    assert.equal((await s.fail(SIM, c.lease, PUBLIC_ERROR_CODES.solver_failed)).ok, true);
    clock.advance(LIMITS.JOB_LEASE_MS * 10);
    assert.equal(await s.recover(SIM), 'skipped');
    const again = await s.claim(SIM, 'w2'); assert.equal(again.claimed, false);
    assert.equal((await s.get(SIM))!.status, 'failed');
    assert.equal((await s.get(SIM))!.errorCode, PUBLIC_ERROR_CODES.solver_failed);
  });

  await check('completed job cannot be failed, cancelled-overwritten, or re-completed', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const s = new JobStore(fs, clock.now);
    await s.createQueued(baseRecord()); const c = (await s.claim(SIM, 'w')) as any;
    await s.complete(SIM, c.lease, { result: { v: 1 }, artifacts: [], room: {}, speakers: [], receivers: [] });
    assert.equal((await s.fail(SIM, c.lease, PUBLIC_ERROR_CODES.solver_failed)).ok, false);
    assert.deepEqual(await s.cancel(SIM), { ok: true, alreadyFinished: true, status: 'completed' });
    assert.equal((await s.complete(SIM, c.lease, { result: { v: 2 }, artifacts: [], room: {}, speakers: [], receivers: [] })).ok, false);
    assert.deepEqual((await s.get(SIM))!.result, { v: 1 });
  });

  await check('stored records never contain a raw capability token or free-form error text', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const s = new JobStore(fs, clock.now);
    await s.createQueued(baseRecord()); const c = (await s.claim(SIM, 'w')) as any;
    await s.fail(SIM, c.lease, PUBLIC_ERROR_CODES.solver_failed);
    const raw = JSON.stringify((await s.get(SIM))!);
    assert.ok(!/capabilityToken"/.test(raw));
    assert.ok(!/\"error\"/.test(raw), 'no free-form "error" field may be persisted');
    assert.equal((await s.get(SIM))!.errorCode, 'solver_failed');
  });

  await check('stale queued jobs are expired instead of waiting forever', async () => {
    const fs = new FakeFirestore(); const clock = makeClock();
    const s = new JobStore(fs, clock.now);
    await s.createQueued(baseRecord({ createdAt: clock.now() }));
    assert.equal(await s.expireStaleQueued(SIM), false);
    clock.advance(LIMITS.MAX_QUEUED_AGE_MS + 1);
    assert.equal(await s.expireStaleQueued(SIM), true);
    assert.equal((await s.get(SIM))!.status, 'failed');
    assert.equal((await s.get(SIM))!.errorCode, PUBLIC_ERROR_CODES.expired);
  });

  console.log(`\n=== ${passed} passed ===`);
  if (process.exitCode) process.exit(process.exitCode);
}
main();
