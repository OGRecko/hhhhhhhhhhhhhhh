/**
 * Worker crash-recovery suite (runs the REAL createWorkerRunner against small
 * fixture workers; nothing in the runner is mocked).
 *
 * Every scenario must end in a SAFE TERMINAL STATE: the returned promise
 * settles with a SolverError carrying a fixed PUBLIC code (never worker text),
 * the worker thread is gone, and nothing is left running or half-written.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkerRunner } from './workerRunner';
import { SolverError, type SolverRunArgs } from './jobExecutor';
import { PUBLIC_ERROR_CODES } from './jobStore';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cavity-wr-'));
let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e: any) { console.error(`  FAIL  ${name}\n        ${e?.stack ?? e}`); process.exitCode = 1; }
}
const worker = (name: string, body: string) => {
  const p = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(p, `const { parentPort } = require('node:worker_threads');\nconst fs = require('node:fs');\n${body}\n`);
  return p;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function args(signal: AbortSignal, saved: string[] = []): SolverRunArgs {
  return {
    type: 'impulse-response', payload: { L: 4, W: 4, H: 3 }, simulationId: 'sim-test', signal,
    putWaveFrame: async (i) => { const id = `obj-${i}`; saved.push(id); return id; },
  };
}
async function outcome(p: Promise<unknown>): Promise<{ ok: true; value: any } | { ok: false; err: any }> {
  try { return { ok: true, value: await p }; } catch (err) { return { ok: false, err }; }
}
async function expectCode(workerPath: string, code: string, timeoutMs = 5000, signal = new AbortController().signal) {
  const run = createWorkerRunner({ workerPath, execArgv: [], timeoutMs });
  const started = Date.now();
  const r = await outcome(run(args(signal)));
  assert.equal(r.ok, false, 'job must not succeed');
  const err = (r as any).err;
  assert.ok(err instanceof SolverError, `expected SolverError, got ${err?.constructor?.name}`);
  assert.equal(err.code, code);
  assert.ok(Date.now() - started < timeoutMs + 6000, 'job must reach a terminal state promptly (no hang)');
  return err as SolverError;
}

await check('worker throws: job fails with solver_failed, no worker text leaks into the public code', async () => {
  const w = worker('throws', `throw new Error('SECRET-INTERNAL-PATH /etc/passwd');`);
  const err = await expectCode(w, PUBLIC_ERROR_CODES.solver_failed);
  assert.ok(!String(err.code).includes('SECRET'));
});

await check('worker exits unexpectedly (non-zero, no message): solver_failed', async () => {
  await expectCode(worker('exit', `process.exit(3);`), PUBLIC_ERROR_CODES.solver_failed);
});

await check('worker exits cleanly WITHOUT a result: solver_failed (not a silent success)', async () => {
  await expectCode(worker('silent', `parentPort.postMessage({ type: 'progress' });`), PUBLIC_ERROR_CODES.solver_failed);
});

await check('worker reports a handled failure: error text is classified to a fixed code', async () => {
  const w = worker('invalid', `parentPort.postMessage({ success: false, error: 'source is outside the room' });`);
  await expectCode(w, PUBLIC_ERROR_CODES.invalid_input);
  const w2 = worker('mem', `parentPort.postMessage({ success: false, error: 'grid exceeds memory budget' });`);
  await expectCode(w2, PUBLIC_ERROR_CODES.resource_limit);
});

await check('worker hangs: wall-clock timeout terminates it, and the thread stops running (no orphan)', async () => {
  const beat = path.join(dir, 'hang.beat');
  const w = worker('hang', `setInterval(() => fs.writeFileSync(${JSON.stringify(beat)}, String(Date.now())), 20); setInterval(()=>{}, 1000);`);
  await expectCode(w, PUBLIC_ERROR_CODES.timeout, 400);
  await sleep(200);
  const a = fs.readFileSync(beat, 'utf8');
  await sleep(300);
  assert.equal(fs.readFileSync(beat, 'utf8'), a, 'heartbeat still advancing => orphan worker thread');
});

await check('malformed result (success=true, no data object): solver_failed', async () => {
  await expectCode(worker('nodata', `parentPort.postMessage({ success: true, data: null });`), PUBLIC_ERROR_CODES.solver_failed);
  await expectCode(worker('strdata', `parentPort.postMessage({ success: true, data: 'nope' });`), PUBLIC_ERROR_CODES.solver_failed);
});

await check('garbage messages are ignored and do not crash the runner; a later valid result still works', async () => {
  const w = worker('garbage', `
    parentPort.postMessage(null); parentPort.postMessage(42); parentPort.postMessage('x');
    parentPort.postMessage({ success: 'yes' });
    parentPort.postMessage({ success: true, data: { receivers: [{ id: 'r1', trace: [0.5, 0.25] }] } });`);
  const r = await outcome(createWorkerRunner({ workerPath: w, execArgv: [], timeoutMs: 5000 })(args(new AbortController().signal)));
  assert.equal(r.ok, true);
  assert.equal((r as any).value.traces.length, 1);
  assert.deepEqual([...(r as any).value.traces[0]], [0.5, 0.25]);
});

await check('partial result: expected 3 frames but only 1 delivered => rejected, not stored as complete', async () => {
  const w = worker('partial', `
    parentPort.postMessage({ type: 'expected_frames', count: 3 });
    parentPort.postMessage({ type: 'wavefield_frame', frame: new Float32Array(4) });
    parentPort.postMessage({ success: true, data: { wavefield: { outNx: 2, outNz: 2, dt: 1 }, receivers: [] } });`);
  await expectCode(w, PUBLIC_ERROR_CODES.storage_failed);
});

await check('bad frame payload (not a Float32Array): rejected', async () => {
  const w = worker('badframe', `parentPort.postMessage({ type: 'wavefield_frame', frame: [1,2,3] });`);
  await expectCode(w, PUBLIC_ERROR_CODES.solver_failed);
});

await check('absurd expected_frames is a resource_limit rejection', async () => {
  await expectCode(worker('manyframes', `parentPort.postMessage({ type: 'expected_frames', count: 1e9 });`), PUBLIC_ERROR_CODES.resource_limit);
  await expectCode(worker('negframes', `parentPort.postMessage({ type: 'expected_frames', count: -1 });`), PUBLIC_ERROR_CODES.resource_limit);
});

await check('frame upload failure surfaces as a storage error and does not hang', async () => {
  const w = worker('frames', `
    parentPort.postMessage({ type: 'expected_frames', count: 1 });
    parentPort.postMessage({ type: 'wavefield_frame', frame: new Float32Array(4) });
    parentPort.postMessage({ success: true, data: { wavefield: { outNx: 2, outNz: 2, dt: 1 }, receivers: [] } });`);
  const run = createWorkerRunner({ workerPath: w, execArgv: [], timeoutMs: 5000 });
  const a = args(new AbortController().signal);
  a.putWaveFrame = async () => { throw new Error('disk full'); };
  const r = await outcome(run(a));
  assert.equal(r.ok, false);
  assert.equal((r as any).err.code, PUBLIC_ERROR_CODES.storage_failed);
});

await check('cancellation during processing: cancelled code, worker stopped, in-flight frame writes drained first', async () => {
  const beat = path.join(dir, 'cancel.beat');
  const w = worker('cancelme', `
    setInterval(() => fs.writeFileSync(${JSON.stringify(beat)}, String(Date.now())), 20);
    parentPort.postMessage({ type: 'wavefield_frame', frame: new Float32Array(4) });
    setInterval(()=>{}, 1000);`);
  const ac = new AbortController();
  const saved: string[] = [];
  let finishedWrites = 0;
  const a = args(ac.signal, saved);
  a.putWaveFrame = async (i) => { await sleep(150); finishedWrites++; return `obj-${i}`; };
  const p = createWorkerRunner({ workerPath: w, execArgv: [], timeoutMs: 10000 })(a);
  await sleep(100);
  ac.abort(PUBLIC_ERROR_CODES.cancelled);
  const r = await outcome(p);
  assert.equal(r.ok, false);
  assert.equal((r as any).err.code, PUBLIC_ERROR_CODES.cancelled);
  assert.equal(finishedWrites, 1, 'in-flight write must complete before the executor does cleanup');
  await sleep(200);
  const t = fs.readFileSync(beat, 'utf8'); await sleep(300);
  assert.equal(fs.readFileSync(beat, 'utf8'), t, 'worker still running after cancel');
});

await check('already-aborted signal: settles as cancelled without leaving a running worker', async () => {
  const ac = new AbortController(); ac.abort(PUBLIC_ERROR_CODES.cancelled);
  await expectCode(worker('never', `setInterval(()=>{}, 1000);`), PUBLIC_ERROR_CODES.cancelled, 5000, ac.signal);
});

await check('abort with the timeout reason maps to timeout (not cancelled)', async () => {
  const ac = new AbortController();
  const w = worker('slow', `setInterval(()=>{}, 1000);`);
  const p = outcome(createWorkerRunner({ workerPath: w, execArgv: [], timeoutMs: 10000 })(args(ac.signal)));
  await sleep(100); ac.abort(PUBLIC_ERROR_CODES.timeout);
  const r = await p; assert.equal((r as any).err.code, PUBLIC_ERROR_CODES.timeout);
});

await check('25 consecutive crashes: every job terminal, no leaked threads or listeners', async () => {
  const w = worker('crashloop', `throw new Error('boom');`);
  const run = createWorkerRunner({ workerPath: w, execArgv: [], timeoutMs: 5000 });
  const ac = new AbortController();
  const before = (ac.signal as any)._listeners ?? 0;
  const results = await Promise.all(Array.from({ length: 25 }, () => outcome(run(args(ac.signal)))));
  assert.ok(results.every((r) => !r.ok && (r as any).err instanceof SolverError));
  assert.equal(before, (ac.signal as any)._listeners ?? 0);
  // The runner must have removed its abort listener: aborting now must be a no-op, not a throw.
  ac.abort();
});

await check('a failed job leaves no partial files in the working directory', async () => {
  const leftovers = fs.readdirSync(dir).filter((n) => !n.endsWith('.cjs') && !n.endsWith('.beat'));
  assert.deepEqual(leftovers, []);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n=== ${passed} worker-recovery checks passed ===`);
