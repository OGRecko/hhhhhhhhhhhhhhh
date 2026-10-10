/**
 * API validator and worker must agree on source gain, and duplicate ids must be rejected before simulation.
 * Run with:  npx tsx server/boundaryValidation.test.ts
 */
import assert from 'node:assert/strict';
import { LIMITS, validateSolverRequest } from '../src/lib/publicLimits';
import { runIR } from './solverWorker';

let passed = 0;
let failed = 0;
const quiet = <T,>(fn: () => T): T => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return fn(); } finally { console.log = l; console.error = e; } };
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : String(e)}`); }
}
console.log('\n=== API / worker boundary validation ===\n');

const base = { L: 4, W: 4, H: 3, wallMaterial: 'drywall', floorMaterial: 'wood_floor', ceilMaterial: 'drywall_ceil', steps: 60, fmax: 250, accuracyMode: 'fast',
  sources: [{ id: 's', x: 0.3, y: 0.3, z: 1 }], receivers: [{ id: 'r', x: 0.6, y: 0.6, z: 1 }] };
const withGain = (g: unknown) => ({ ...base, sources: [{ ...base.sources[0], gainDb: g }] });

check('API rejects duplicate receiver ids and duplicate source ids with a clear message', () => {
  const r1 = validateSolverRequest({ ...base, receivers: [{ id: 'r', x: .5, y: .5, z: 1 }, { id: 'r', x: .4, y: .4, z: 1 }] }, 'impulse-response');
  assert.ok('error' in r1 && /Duplicate receiver id/.test(r1.error));
  const r2 = validateSolverRequest({ ...base, sources: [{ id: 's', x: .5, y: .5, z: 1 }, { id: 's', x: .4, y: .4, z: 1 }] }, 'impulse-response');
  assert.ok('error' in r2 && /Duplicate source id/.test(r2.error));
});

check('API still accepts distinct ids, and entries without ids', () => {
  assert.ok('request' in validateSolverRequest({ ...base, receivers: [{ id: 'a', x: .5, y: .5, z: 1 }, { id: 'b', x: .4, y: .4, z: 1 }] }, 'impulse-response'));
  assert.ok('request' in validateSolverRequest({ ...base, receivers: [{ x: .5, y: .5, z: 1 }, { x: .4, y: .4, z: 1 }] }, 'impulse-response'));
});

check('limits are unchanged: 16 sources, 64 receivers, 50,000,000 cells', () => {
  assert.equal(LIMITS.MAX_SOURCES, 16);
  assert.equal(LIMITS.MAX_RECEIVERS, 64);
  assert.equal(LIMITS.MAX_GRID_CELLS, 50_000_000);
});

check('worker rejects gain outside the API range instead of producing non-finite samples', () => {
  for (const g of [LIMITS.MAX_SOURCE_GAIN_DB + 1, LIMITS.MIN_SOURCE_GAIN_DB - 1, 1e9, NaN, Infinity]) {
    assert.ok('error' in validateSolverRequest(withGain(g), 'impulse-response'), `API should reject ${g}`);
    assert.throws(() => quiet(() => runIR(withGain(g))), /Invalid source gainDb/, `worker should reject ${g}`);
  }
});

check('worker accepts the API boundary values and an explicit 0 dB, with fully finite output', () => {
  for (const g of [LIMITS.MIN_SOURCE_GAIN_DB, 0, LIMITS.MAX_SOURCE_GAIN_DB]) {
    assert.ok('request' in validateSolverRequest(withGain(g), 'impulse-response'), `API should accept ${g}`);
    const r = quiet(() => runIR(withGain(g))) as unknown as { receivers: Array<{ trace: number[] }> };
    assert.ok(r.receivers[0].trace.every(Number.isFinite), `non-finite sample at gain ${g}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
