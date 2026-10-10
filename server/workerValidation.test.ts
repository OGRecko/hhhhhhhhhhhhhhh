// The solver worker must reject exactly what the API rejects (shared validators), never "repair" input.
import assert from 'node:assert/strict';
import { runWave } from './solverWorker';
import { validateSolverRequest } from '../src/lib/publicLimits';

let passed = 0;
const quiet = <T,>(fn: () => T): T => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };
const check = (name: string, fn: () => void) => { try { fn(); passed++; console.log(`  PASS  ${name}`); } catch (e: any) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; } };
const base = { L: 4, W: 4, H: 3, steps: 5, fmax: 200, accuracyMode: 'fast', wallMaterial: 'drywall', floorMaterial: 'wood_floor', ceilMaterial: 'drywall_ceil', source: { x: .2, y: .2, z: 1.5 }, receivers: [{ x: .8, y: .8, z: 1.5 }] };
const throws = (extra: any, re: RegExp) => { let m = ''; try { quiet(() => runWave({ ...base, ...extra } as any)); } catch (e: any) { m = String(e.message); } assert.match(m, re); };
const bowtie = [{ x: .1, y: .1 }, { x: .9, y: .5 }, { x: .9, y: .1 }, { x: .1, y: .7 }];

check('self-intersecting polygon is rejected by the worker', () => throws({ poly: bowtie }, /cross/i));
check('API validator rejects the same polygon', () => assert.equal((validateSolverRequest({ ...base, poly: bowtie }, 'wave') as any).ok, false));
check('wallOpenings of wrong length is an error, not silently dropped', () => throws({ poly: [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .9, y: .9 }, { x: .1, y: .9 }], wallOpenings: ['full'] }, /wallOpenings/));
check('wallSegMats of wrong length is an error', () => throws({ poly: [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .9, y: .9 }, { x: .1, y: .9 }], wallSegMats: ['drywall'] }, /wallSegMats/));
check('unknown material is refused, not replaced by a default', () => throws({ wallMaterial: 'no_such_material' }, /Unknown material/));
console.log(`\n=== ${passed} passed ===`);
