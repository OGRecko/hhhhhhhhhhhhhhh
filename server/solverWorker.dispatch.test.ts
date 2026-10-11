/**
 * Regression: the solver worker must run when loaded as a real worker thread.
 *
 * Background: the worker dispatch (`if (workerData) ... runIR/runWave`) once sat ABOVE the module-level
 * `const` helpers it calls. Module evaluation then threw "Cannot access 'zIsMissing' before initialization"
 * on every real job, so every simulation ended as solver_failed. The other solver tests import the module
 * without workerData, so the dispatch never ran and they could not catch it. This suite runs the REAL
 * worker thread through the production runner (nothing mocked).
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createWorkerRunner } from './workerRunner';
import { validateSolverRequest } from '../src/lib/publicLimits';

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e: any) { console.error(`  FAIL  ${name}\n        ${e?.stack ?? e}`); process.exitCode = 1; }
}

const body = {
  projectName: 'dispatch-regression', roomName: 'Dispatch room', L: 6, W: 4, H: 3,
  poly: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.4, y: 0.4 }, { x: 0.9, y: 0.4 }, { x: 0.9, y: 0.6 }, { x: 0.4, y: 0.6 }, { x: 0.4, y: 0.9 }, { x: 0.1, y: 0.9 }],
  wallMaterial: 'concrete', floorMaterial: 'concrete', ceilMaterial: 'concrete',
  sources: [{ id: 's1', brand: 'Generic', model: 'Generic', x: 0.2, y: 0.5, z: 1.2, gainDb: 0, delayMs: 0, muted: false, referencePowerW: 1, isDirectional: false }],
  receivers: [{ id: 'r1', name: 'R1', x: 0.7, y: 0.5, z: 1.2 }],
};

async function main() {
  console.log('\n=== Solver worker dispatch (real worker thread) ===\n');

  await check('a valid impulse-response job completes in a real worker thread', async () => {
    const validated = validateSolverRequest(body, 'impulse-response');
    assert.equal((validated as any).ok, true, `fixture must validate: ${(validated as any).error}`);
    const run = createWorkerRunner({
      workerPath: fileURLToPath(new URL('./solverWorker.ts', import.meta.url)),
      execArgv: ['--import', 'tsx'],
      timeoutMs: 120_000,
    });
    const out: any = await run({
      type: 'impulse-response',
      payload: (validated as any).request,
      simulationId: 'sim-dispatch-regression',
      signal: new AbortController().signal,
      putWaveFrame: async (i: number) => `obj-${i}`,
    } as any);
    // The runner returns { result, traces, waveObjectIds }; result is the solver output.
    assert.ok(out && out.result, 'the runner must return the solver result');
    assert.equal(typeof out.result.rt60, 'number', 'the worker must return a computed RT60');
    assert.ok(Number.isFinite(out.result.rt60), 'RT60 must be finite');
  });

  console.log(`\n=== ${passed} passed ===`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
