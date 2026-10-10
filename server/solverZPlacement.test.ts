/**
 * Z placement: the solver never silently invents a height.
 *
 * Decision (option "a"): a source/receiver with no Z is still placed (source at 0.7 x room height, receiver at
 * 0.5 x room height, because the UI's add-source flow does not set a source Z), BUT every such placement is
 * reported in the result's `positionAssumptions` (returned by the API as-is) and printed in the PDF report.
 * An explicit Z of 0 is a real height and is never treated as missing.
 *
 * Run with:  npx tsx server/solverZPlacement.test.ts
 */
import assert from 'node:assert/strict';
import {
  ASSUMED_RECEIVER_Z_FRACTION,
  ASSUMED_SOURCE_Z_FRACTION,
  collectPositionAssumptions,
  receiverZMeters,
  runIR,
  runWave,
  type PositionAssumption,
} from './solverWorker';
import { validatePoint } from '../src/lib/publicLimits';

let passed = 0;
let failed = 0;
const quiet = <T,>(fn: () => T): T => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : String(e)}`); }
}

console.log('\n=== Solver Z placement is reported, never silent ===\n');

const H = 3;
const room = { L: 4, W: 4, H, wallMaterial: 'drywall', floorMaterial: 'wood_floor', ceilMaterial: 'drywall_ceil' };

await check('constants keep the documented placement (0.7 source, 0.5 receiver)', () => {
  assert.equal(ASSUMED_SOURCE_Z_FRACTION, 0.7);
  assert.equal(ASSUMED_RECEIVER_Z_FRACTION, 0.5);
});

await check('receiverZMeters: explicit 0 stays 0; undefined and null use the assumption', () => {
  assert.equal(receiverZMeters({ z: 0 }, H), 0);
  assert.equal(receiverZMeters({ z: 1.2 }, H), 1.2);
  assert.equal(receiverZMeters({}, H), 1.5);
  assert.equal(receiverZMeters({ z: null }, H), 1.5);
});

await check('collectPositionAssumptions: lists missing Z only, with index, id and the height actually used', () => {
  const a = collectPositionAssumptions([{ id: 's1', z: 1 }, { id: 's2' }], [{ id: 'r1' }, { id: 'r2', z: 0 }, { id: 'r3', z: null }], H);
  assert.equal(a.length, 3);
  assert.deepEqual(a.map((x) => [x.kind, x.id, x.index]), [['source', 's2', 1], ['receiver', 'r1', 0], ['receiver', 'r3', 2]]);
  assert.ok(Math.abs(a[0].assumedMeters - 2.1) < 1e-12);
  assert.equal(a[1].assumedMeters, 1.5);
});

await check('collectPositionAssumptions: explicit Z everywhere (including 0) yields no assumptions', () => {
  assert.deepEqual(collectPositionAssumptions([{ id: 's', z: 0 }], [{ id: 'r', z: 0 }], H), []);
});

await check('runIR: receiver without Z is placed at 0.5 x H AND reported as assumed', () => {
  const r: any = quiet(() => runIR({ ...room, sources: [{ id: 's', x: 0.2, y: 0.2, z: 1.5 }], receivers: [{ id: 'r', x: 0.8, y: 0.8 }] }));
  const pa: PositionAssumption[] = r.positionAssumptions;
  assert.equal(pa.length, 1);
  assert.equal(pa[0].kind, 'receiver');
  assert.equal(pa[0].id, 'r');
  assert.equal(pa[0].assumedMeters, 1.5);
  const expected = Math.hypot(0.6 * room.L, 0.6 * room.W, 0); // source z 1.5 == assumed receiver z 1.5
  assert.ok(Math.abs(r.receivers[0].delays[0].distanceMeters - expected) < 1e-9);
});

await check('runIR: source without Z is placed at 0.7 x H AND reported as assumed', () => {
  const r: any = quiet(() => runIR({ ...room, sources: [{ id: 's', x: 0.2, y: 0.2 }], receivers: [{ id: 'r', x: 0.8, y: 0.8, z: 1.5 }] }));
  assert.equal(r.positionAssumptions.length, 1);
  assert.equal(r.positionAssumptions[0].kind, 'source');
  assert.ok(Math.abs(r.positionAssumptions[0].assumedMeters - 2.1) < 1e-12);
  const expected = Math.hypot(0.6 * room.L, 0.6 * room.W, 2.1 - 1.5);
  assert.ok(Math.abs(r.receivers[0].delays[0].distanceMeters - expected) < 1e-9);
});

await check('runIR: explicit Z of 0 on source and receiver is accepted, used as 0, and NOT reported as assumed', () => {
  const r: any = quiet(() => runIR({ ...room, sources: [{ id: 's', x: 0.2, y: 0.2, z: 0 }], receivers: [{ id: 'r', x: 0.8, y: 0.8, z: 0 }] }));
  assert.deepEqual(r.positionAssumptions, []);
  const expected = Math.hypot(0.6 * room.L, 0.6 * room.W, 0);
  assert.ok(Math.abs(r.receivers[0].delays[0].distanceMeters - expected) < 1e-9);
});

await check('runWave: missing source Z / receiver Z are reported; explicit 0 is accepted and not reported', () => {
  const base = { ...room, steps: 40, fmax: 250, accuracyMode: 'fast' };
  const assumed: any = quiet(() => runWave({ ...base, source: { x: 0.3, y: 0.3 }, receivers: [{ x: 0.7, y: 0.7 }] }));
  assert.deepEqual(assumed.positionAssumptions.map((a: PositionAssumption) => a.kind), ['source', 'receiver']);
  const explicit: any = quiet(() => runWave({ ...base, source: { x: 0.3, y: 0.3, z: 0 }, receivers: [{ x: 0.7, y: 0.7, z: 0 }] }));
  assert.equal(explicit.success, true);
  assert.deepEqual(explicit.positionAssumptions, []);
});

await check('API validator (validatePoint) still accepts a missing Z and an explicit Z of 0, and rejects Z above H', () => {
  assert.ok('point' in validatePoint({ x: 0.5, y: 0.5 }, H, 'receiver'));
  const zero = validatePoint({ x: 0.5, y: 0.5, z: 0 }, H, 'receiver');
  assert.ok('point' in zero && zero.point.z === 0);
  assert.ok('error' in validatePoint({ x: 0.5, y: 0.5, z: H + 0.1 }, H, 'source'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
