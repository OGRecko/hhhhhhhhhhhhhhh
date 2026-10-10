/**
 * executeJob had no direct tests. The only thing that ran it was the
 * dispatcher test, whose stub solver always succeeds - so the failure,
 * timeout, cancellation, lease-loss, artifact-budget and cleanup branches
 * (most of the function) had never executed. Each test below drives one
 * outcome and checks the persisted job state AND what was left in artifact
 * storage, since "did cleanup delete the right thing" is where this code
 * could do real damage (deleting another worker's completed result).
 */
import assert from 'node:assert/strict';
import { executeJob, SolverError, type ExecutorDeps, type SolverRunner } from './jobExecutor';
import { JobStore, PUBLIC_ERROR_CODES } from './jobStore';
import { FakeFirestore } from './testing/memoryFirestore';
import { MemoryArtifactStore } from './testing/memoryArtifactStore';
import { hashCapabilityToken } from './capabilityToken';
import { LIMITS } from '../src/lib/publicLimits';

// executeJob deliberately unref()s its heartbeat and timeout timers so a
// lingering job can never keep a shutting-down server alive. In production the
// HTTP server and the dispatcher's sweep interval hold the event loop open. In
// a bare test process nothing does, so a test awaiting a timeout would see the
// loop drain and Node would exit with "unsettled top-level await". Hold the
// loop open for the duration of the run instead of touching production code.
const keepAlive = setInterval(() => {}, 1_000);

let passed = 0;
const check = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== jobExecutor tests ===\n');

const TOKEN = 'a'.repeat(64);
let counter = 0;
const nextSim = () => { counter++; const h = counter.toString(16).padStart(12, '0'); return `aaaaaaaa-aaaa-4aaa-8aaa-${h}`; };

async function setup(runSolver: SolverRunner, overrides: Partial<ExecutorDeps> = {}) {
  const store = new JobStore(new FakeFirestore());
  const artifacts = new MemoryArtifactStore();
  const counts: Record<string, number> = {};
  const metrics = { inc: (k: string) => { counts[k] = (counts[k] ?? 0) + 1; } } as any;
  const sim = nextSim();
  await store.createQueued({ simulationId: sim, jobId: `job-${sim}`, type: 'impulse-response', capabilityTokenHash: hashCapabilityToken(TOKEN), createdAt: Date.now(), jobPayload: { L: 4, W: 3, H: 2.5 }, room: { L: 4, W: 3, H: 2.5 }, speakers: [], receivers: [] });
  const deps: ExecutorDeps = { store, artifacts, runSolver, metrics, workerId: 'w1', heartbeatMs: 20, timeoutMs: 5_000, ...overrides };
  return { store, artifacts, counts, sim, deps };
}
const trace = (n = 8) => new Float32Array(n).fill(0.5);
const ok = (extra: Partial<Awaited<ReturnType<SolverRunner>>> = {}): SolverRunner => async () => ({ result: { fine: true }, traces: [trace()], waveObjectIds: [], ...extra });

await check('success: completes, persists the trace artifact, records it on the job', async () => {
  const { store, artifacts, counts, sim, deps } = await setup(ok());
  const out = await executeJob(deps, sim);
  assert.deepEqual(out, { status: 'completed' });
  const rec = await store.get(sim);
  assert.equal(rec?.status, 'completed');
  assert.equal(artifacts.keysFor(sim).length, 1, 'one receiver trace should be stored');
  assert.equal(counts.simulations_started, 1);
  assert.equal(counts.simulations_completed, 1);
});

await check('a receiver with no trace is recorded as an empty id, not stored', async () => {
  const { store, artifacts, sim, deps } = await setup(ok({ traces: [trace(), null, new Float32Array(0)] }));
  assert.equal((await executeJob(deps, sim)).status, 'completed');
  assert.equal(artifacts.keysFor(sim).length, 1, 'only the non-empty trace is stored');
  const ids = ((await store.get(sim))?.result as any).traceObjectIds as string[];
  assert.equal(ids.length, 3);
  assert.deepEqual([ids[1], ids[2]], ['', '']);
});

await check('a claim that is refused backs off without touching the job or running the solver', async () => {
  let ran = false;
  const { store, sim, deps } = await setup(async () => { ran = true; return { result: {}, traces: [], waveObjectIds: [] }; });
  await store.cancel(sim); // job is now terminal, claim must be refused
  const out = await executeJob(deps, sim);
  assert.equal(out.status, 'backed_off');
  assert.equal(ran, false, 'solver must not run for a job that could not be claimed');
});

await check('solver throwing a plain Error becomes solver_failed with no raw message leaked', async () => {
  const { store, artifacts, counts, sim, deps } = await setup(async () => { throw new Error('secret internal path /var/x/y'); });
  const out = await executeJob(deps, sim);
  assert.deepEqual(out, { status: 'failed', code: PUBLIC_ERROR_CODES.solver_failed });
  const rec = await store.get(sim);
  assert.equal(rec?.status, 'failed');
  assert.ok(!JSON.stringify(rec).includes('secret internal path'), 'raw solver error text must not be persisted');
  assert.equal(artifacts.keysFor(sim).length, 0);
  assert.equal(counts.simulations_failed, 1);
});

await check('a SolverError keeps its own public code', async () => {
  const { store, counts, sim, deps } = await setup(async () => { throw new SolverError(PUBLIC_ERROR_CODES.invalid_input, 'detail'); });
  const out = await executeJob(deps, sim);
  assert.deepEqual(out, { status: 'failed', code: PUBLIC_ERROR_CODES.invalid_input });
  assert.equal((await store.get(sim))?.status, 'failed');
  assert.equal(counts.simulations_failed, 1);
});

await check('a hung solver is aborted at the timeout and reported as timeout', async () => {
  const { store, counts, sim, deps } = await setup(
    ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    { timeoutMs: 60 },
  );
  const out = await executeJob(deps, sim);
  assert.deepEqual(out, { status: 'failed', code: PUBLIC_ERROR_CODES.timeout });
  assert.equal((await store.get(sim))?.status, 'failed');
  assert.equal(counts.worker_timeouts, 1);
});

await check('a solver that ignores the abort signal and finishes late is still reported as timeout, not success', async () => {
  const { store, artifacts, sim, deps } = await setup(
    async () => { await new Promise((r) => setTimeout(r, 150)); return { result: {}, traces: [trace()], waveObjectIds: [] }; },
    { timeoutMs: 40 },
  );
  const out = await executeJob(deps, sim);
  assert.deepEqual(out, { status: 'failed', code: PUBLIC_ERROR_CODES.timeout });
  assert.equal((await store.get(sim))?.status, 'failed');
  assert.equal(artifacts.keysFor(sim).length, 0, 'a timed-out job must not leave a stored trace behind');
});

await check('client cancel mid-run: job ends cancelled and its artifacts are deleted', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { store, artifacts, sim, deps } = await setup(async ({ putWaveFrame, signal }) => {
    const id = await putWaveFrame(0, new Float32Array(4));
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => resolve()); void gate; });
    return { result: {}, traces: [trace()], waveObjectIds: [id] };
  });
  const running = executeJob(deps, sim);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(artifacts.keysFor(sim).length, 1, 'the wave frame should exist before the cancel');
  await store.cancel(sim);
  const out = await running;
  release();
  assert.equal(out.status, 'cancelled');
  assert.equal((await store.get(sim))?.status, 'cancelled');
  assert.equal(artifacts.keysFor(sim).length, 0, 'cancelled job must not leave artifacts behind');
});

await check('storage outage while persisting a trace becomes storage_failed and cleans up', async () => {
  const { store, artifacts, counts, sim, deps } = await setup(ok());
  artifacts.failPuts = 1;
  const out = await executeJob(deps, sim);
  assert.deepEqual(out, { status: 'failed', code: PUBLIC_ERROR_CODES.storage_failed });
  assert.equal((await store.get(sim))?.status, 'failed');
  assert.equal(artifacts.keysFor(sim).length, 0);
  assert.equal(counts.storage_failures, 1);
});

await check('too many wavefield frames is rejected as resource_limit', async () => {
  const { store, counts, sim, deps } = await setup(async ({ putWaveFrame }) => {
    await putWaveFrame(LIMITS.MAX_WAVEFIELD_FRAMES, new Float32Array(1)); // index at the cap is out of range
    return { result: {}, traces: [], waveObjectIds: [] };
  });
  const out = await executeJob(deps, sim);
  assert.deepEqual(out, { status: 'failed', code: PUBLIC_ERROR_CODES.resource_limit });
  assert.equal((await store.get(sim))?.status, 'failed');
  assert.equal(counts.resource_limit_rejections, 1);
});

await check('the last legal wavefield frame index (cap - 1) is accepted', async () => {
  const { store, sim, deps } = await setup(async ({ putWaveFrame }) => {
    const id = await putWaveFrame(LIMITS.MAX_WAVEFIELD_FRAMES - 1, new Float32Array(1));
    return { result: {}, traces: [], waveObjectIds: [id] };
  });
  assert.equal((await executeJob(deps, sim)).status, 'completed');
  assert.equal((await store.get(sim))?.status, 'completed');
});

await check('total artifact bytes over the budget is rejected as resource_limit', async () => {
  const { store, artifacts, sim, deps } = await setup(async () => {
    // One Float32Array whose byteLength exceeds the whole budget, allocated lazily via a fake length.
    const big = { length: 1, byteLength: LIMITS.MAX_ARTIFACT_BYTES + 1, buffer: new ArrayBuffer(0), byteOffset: 0 } as unknown as Float32Array;
    return { result: {}, traces: [big], waveObjectIds: [] };
  });
  const out = await executeJob(deps, sim);
  assert.deepEqual(out, { status: 'failed', code: PUBLIC_ERROR_CODES.resource_limit });
  assert.equal((await store.get(sim))?.status, 'failed');
  assert.equal(artifacts.keysFor(sim).length, 0);
});

await check('a result document over the size cap is rejected as resource_limit, not stored', async () => {
  const { store, sim, deps } = await setup(ok({ result: { blob: 'x'.repeat(LIMITS.MAX_RESULT_DOC_BYTES + 10) } }));
  const out = await executeJob(deps, sim);
  assert.deepEqual(out, { status: 'failed', code: PUBLIC_ERROR_CODES.resource_limit });
  assert.equal((await store.get(sim))?.status, 'failed');
});

await check('onFinished fires exactly once per claimed job (success and failure), never on a back-off', async () => {
  let finished = 0;
  const onFinished = async () => { finished++; };

  const a = await setup(ok(), { onFinished });
  await executeJob(a.deps, a.sim);
  assert.equal(finished, 1, 'success');

  const b = await setup(async () => { throw new Error('x'); }, { onFinished });
  await executeJob(b.deps, b.sim);
  assert.equal(finished, 2, 'failure');

  const c = await setup(ok(), { onFinished });
  await c.store.cancel(c.sim);
  await executeJob(c.deps, c.sim);
  assert.equal(finished, 2, 'a refused claim must not call onFinished (the slot belongs to whoever owns the job)');
});

await check('registerAbort/unregisterAbort are paired, and the registered controller really aborts the solver', async () => {
  const events: string[] = [];
  let captured: AbortController | undefined;
  const { store, sim, deps } = await setup(
    ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    {
      registerAbort: (id, c) => { events.push(`register:${id}`); captured = c; },
      unregisterAbort: (id) => { events.push(`unregister:${id}`); },
    },
  );
  const running = executeJob(deps, sim);
  await new Promise((r) => setTimeout(r, 30));
  captured?.abort(); // the dispatcher's fast-path cancel
  const out = await running;
  assert.equal(out.status, 'failed');
  assert.deepEqual(events, [`register:${sim}`, `unregister:${sim}`]);
  assert.equal((await store.get(sim))?.status, 'failed');
});

await check('a successfully completed job is not deleted by a later failed attempt at cleanup', async () => {
  // A finished job's artifacts are referenced by its record; a stray second
  // execution must back off rather than clean them up.
  const { store, artifacts, sim, deps } = await setup(ok());
  assert.equal((await executeJob(deps, sim)).status, 'completed');
  const before = artifacts.keysFor(sim).slice();
  assert.equal(before.length, 1);
  const again = await executeJob({ ...deps, runSolver: async () => { throw new Error('should not run'); } }, sim);
  assert.equal(again.status, 'backed_off');
  assert.deepEqual(artifacts.keysFor(sim), before, 'the completed job\'s artifacts must be untouched');
  assert.equal((await store.get(sim))?.status, 'completed');
});

await check('an already-completed job refuses a second worker and its stored artifact is untouched', async () => {
  // Object ids are deterministic per simulation, so a second worker shares ids with the
  // winner. It must back off at the claim and must not clean up the winner's result.
  const ctx = await setup(async () => { throw new Error('the second worker must never run the solver'); });
  const { store, artifacts, sim } = ctx;
  const winner = (await store.claim(sim, 'winner')) as any;
  assert.ok(winner.lease, 'setup: the winner should have claimed the job');
  const traceId = `${sim}_receiver_0.bin`;
  await artifacts.put(traceId, Buffer.from('winner-data'));
  const done = await store.complete(sim, winner.lease, { result: { traceObjectIds: [traceId], waveObjectIds: [] }, artifacts: [traceId], room: {}, speakers: [], receivers: [] });
  assert.ok((done as any).ok, 'setup: the winner should have completed');

  const out = await executeJob(ctx.deps, sim);
  assert.equal(out.status, 'backed_off');
  assert.equal((await store.get(sim))?.status, 'completed');
  assert.equal(artifacts.objects.get(traceId)?.toString(), 'winner-data', "the winner's stored result must be untouched");
});

await check('cleanupUnlessCompleted: a terminal-refusal while the record is completed leaves the shared objects alone', async () => {
  // Reach cleanupUnlessCompleted's "completed" guard directly: our complete() is refused as
  // terminal because the record is completed, and we already wrote the shared ids.
  const ctx = await setup(async () => ({ result: {}, traces: [], waveObjectIds: [] }));
  const { store, artifacts, sim } = ctx;
  const traceId = `${sim}_receiver_0.bin`;
  const runSolver: SolverRunner = async () => {
    // While we run, someone completes the job out from under us using OUR lease's job record.
    const cur = await store.get(sim);
    assert.equal(cur?.status, 'running');
    await artifacts.put(traceId, Buffer.from('shared-data'));
    // Force the record to completed with the same object referenced, as a winner would.
    const lease = { owner: 'w1', epoch: cur!.leaseEpoch } as any;
    await store.complete(sim, lease, { result: { traceObjectIds: [traceId], waveObjectIds: [] }, artifacts: [traceId], room: {}, speakers: [], receivers: [] });
    return { result: {}, traces: [trace()], waveObjectIds: [] };
  };
  const out = await executeJob({ ...ctx.deps, runSolver }, sim);
  assert.equal((await store.get(sim))?.status, 'completed');
  assert.notEqual(out.status, 'failed');
  assert.ok(artifacts.objects.has(traceId), 'a completed job\'s artifact must survive this worker\'s refused completion');
});

await check('a failed job\'s artifacts are removed even when bulk delete fails (per-id fallback)', async () => {
  const ctx = await setup(async ({ putWaveFrame }) => {
    await putWaveFrame(0, new Float32Array(4));
    await putWaveFrame(1, new Float32Array(4));
    throw new Error('solver blew up after writing frames');
  });
  ctx.artifacts.deleteAllForSimulation = async () => { throw new Error('bulk delete unavailable'); };
  const out = await executeJob(ctx.deps, ctx.sim);
  assert.deepEqual(out, { status: 'failed', code: PUBLIC_ERROR_CODES.solver_failed });
  assert.equal(ctx.artifacts.keysFor(ctx.sim).length, 0, 'the per-id fallback must still remove every frame that was written');
});

await check('a failed job removes frames the solver wrote before failing (cleanup actually runs)', async () => {
  const ctx = await setup(async ({ putWaveFrame }) => {
    await putWaveFrame(0, new Float32Array(4));
    throw new Error('boom');
  });
  assert.equal((await executeJob(ctx.deps, ctx.sim)).status, 'failed');
  assert.equal(ctx.artifacts.keysFor(ctx.sim).length, 0, 'frames written before the failure must not be left behind');
});

clearInterval(keepAlive);
console.log(`\n=== ${passed} passed ===`);
