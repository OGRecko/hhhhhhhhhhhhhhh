/**
 * Dispatcher had no dedicated test file before this pass, despite being the
 * component that actually enforces MAX_CONCURRENT_SOLVER_JOBS at runtime
 * (the constant itself is covered by publicLimits.test.ts, but nothing
 * verified the Dispatcher honors it under real concurrent load). Added
 * during an independent hardening pass alongside a fix to that constant's
 * value (2 -> 1, to fit the real 2GiB Cloud Run instance - see
 * scripts/deploy-cloud-run.mjs and HARDENING_LEDGER.md).
 */
import assert from 'node:assert/strict';
import { Dispatcher } from './dispatcher';
import { JobStore } from './jobStore';
import { FakeFirestore } from './testing/memoryFirestore';
import { hashCapabilityToken } from './capabilityToken';
import { MemoryArtifactStore } from './testing/memoryArtifactStore';

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== Dispatcher tests ===\n');

const TOKEN = 'a'.repeat(64);

function makeDispatcher(overrides: Record<string, unknown> = {}) {
  const db = new FakeFirestore();
  const store = new JobStore(db);
  const artifacts = new MemoryArtifactStore();
  const calls: string[] = [];
  const runSolver = async () => { calls.push('ran'); return { result: {}, traces: [], waveObjectIds: [] }; };
  const dispatcher = new Dispatcher({
    store,
    executor: { store, artifacts, runSolver, metrics: { inc: () => {} }, workerId: 'test-worker' },
    maxConcurrent: 1,
    ...overrides,
  } as any);
  return { dispatcher, store, calls };
}

await check('maxConcurrent is actually enforced under load, not just configured', async () => {
  const db = new FakeFirestore();
  const store = new JobStore(db);
  const artifacts = new MemoryArtifactStore();
  let concurrentCount = 0;
  let maxObservedConcurrent = 0;
  const releases: Array<() => void> = [];

  const runSolver = async () => {
    concurrentCount++;
    maxObservedConcurrent = Math.max(maxObservedConcurrent, concurrentCount);
    await new Promise<void>((resolve) => releases.push(resolve));
    concurrentCount--;
    return { result: {}, traces: [], waveObjectIds: [] };
  };

  const dispatcher = new Dispatcher({
    store,
    executor: { store, artifacts, runSolver, metrics: { inc: () => {} }, workerId: 'test-worker' },
    maxConcurrent: 1, // matches the production value fixed alongside this test
  } as any);

  const N = 4;
  for (let i = 0; i < N; i++) {
    const sim = `1111111${i}-1111-4111-8111-11111111111${i}`;
    await store.createQueued({ simulationId: sim, jobId: `job-${i}`, type: 'impulse-response', capabilityTokenHash: hashCapabilityToken(TOKEN), createdAt: Date.now(), jobPayload: {}, room: { L: 4, W: 4, H: 3 }, speakers: [], receivers: [] });
    dispatcher.enqueue(sim);
  }

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(maxObservedConcurrent, 1, `expected at most 1 concurrent job, saw ${maxObservedConcurrent}`);

  while (releases.length > 0 || concurrentCount > 0) {
    releases.shift()?.();
    await new Promise((res) => setTimeout(res, 10));
  }
  await dispatcher.whenIdle();
  assert.equal(maxObservedConcurrent, 1, `concurrency exceeded 1 at some point: ${maxObservedConcurrent}`);
  dispatcher.stop();
});

await check('enqueue rejects a job already queued or running (no duplicate execution)', async () => {
  const { dispatcher, store } = makeDispatcher();
  const sim = '11111111-1111-4111-8111-111111111111';
  await store.createQueued({ simulationId: sim, jobId: 'j1', type: 'impulse-response', capabilityTokenHash: hashCapabilityToken(TOKEN), createdAt: Date.now(), jobPayload: {}, room: { L: 4, W: 4, H: 3 }, speakers: [], receivers: [] });
  assert.equal(dispatcher.enqueue(sim), true, 'first enqueue should succeed');
  assert.equal(dispatcher.enqueue(sim), false, 'second enqueue of the same id while queued should be rejected');
  await dispatcher.whenIdle();
  dispatcher.stop();
});

await check('enqueue after stop() is rejected', async () => {
  const { dispatcher, store } = makeDispatcher();
  const sim = '11111111-1111-4111-8111-111111111112';
  await store.createQueued({ simulationId: sim, jobId: 'j2', type: 'impulse-response', capabilityTokenHash: hashCapabilityToken(TOKEN), createdAt: Date.now(), jobPayload: {}, room: { L: 4, W: 4, H: 3 }, speakers: [], receivers: [] });
  dispatcher.stop();
  assert.equal(dispatcher.enqueue(sim), false, 'enqueue after stop() should be rejected');
});

await check('cancelLocal removes a still-queued job before it runs', async () => {
  const { dispatcher, store, calls } = makeDispatcher({ maxConcurrent: 0 }); // never pumps, so it stays queued
  const sim = '11111111-1111-4111-8111-111111111113';
  await store.createQueued({ simulationId: sim, jobId: 'j3', type: 'impulse-response', capabilityTokenHash: hashCapabilityToken(TOKEN), createdAt: Date.now(), jobPayload: {}, room: { L: 4, W: 4, H: 3 }, speakers: [], receivers: [] });
  dispatcher.enqueue(sim);
  assert.equal(dispatcher.stats().queued, 1, 'job should be queued');
  dispatcher.cancelLocal(sim);
  assert.equal(dispatcher.stats().queued, 0, 'cancelLocal should remove it from the local queue');
  assert.equal(calls.length, 0, 'cancelled job before running should never call runSolver');
  dispatcher.stop();
});

await check('stats() reflects queued and running counts correctly', async () => {
  const { dispatcher, store } = makeDispatcher({ maxConcurrent: 0 });
  const sim = '11111111-1111-4111-8111-111111111114';
  await store.createQueued({ simulationId: sim, jobId: 'j4', type: 'impulse-response', capabilityTokenHash: hashCapabilityToken(TOKEN), createdAt: Date.now(), jobPayload: {}, room: { L: 4, W: 4, H: 3 }, speakers: [], receivers: [] });
  dispatcher.enqueue(sim);
  const s = dispatcher.stats();
  assert.equal(s.queued, 1);
  assert.equal(s.running, 0);
  dispatcher.stop();
});

console.log(`\n=== ${passed} passed ===`);
