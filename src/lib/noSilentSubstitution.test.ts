// Regression: unknown materials / missing data must never be silently replaced
// with an invented value (previously alpha=0.10, RT60=0.5 s or 1 s, 90 dB).
import assert from 'node:assert/strict';
import { computeRT60, computeEstimatedGAndSPL, BAND_LABELS } from './roomAcoustics';
import { getAbsorption, UnknownMaterialError, isKnownMaterial } from './absorption';

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e: any) { console.error(`  FAIL  ${name}\n        ${e?.message}`); process.exitCode = 1; }
}
const room = (wall: string, floor = 'wood_floor', ceil = 'drywall_ceil') => ({
  poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  L: 6, W: 4, H: 3, wallMaterial: wall, floorMaterial: floor, ceilMaterial: ceil,
}) as any;

check('strict getAbsorption throws on unknown / null ids', () => {
  assert.throws(() => getAbsorption('no_such_material'), UnknownMaterialError);
  assert.throws(() => getAbsorption(null), UnknownMaterialError);
  assert.equal(isKnownMaterial('drywall'), true);
  assert.equal(isKnownMaterial('toString'), false); // prototype keys are not materials
});
check('unknown wall material => RT60 null in every band (not a 0.10 estimate)', () => {
  const r = computeRT60(room('no_such_material'));
  for (const l of BAND_LABELS) { assert.equal(r.sabine[l], null); assert.equal(r.eyring[l], null); }
});
check('known materials still produce finite RT60', () => {
  const r = computeRT60(room('drywall'));
  assert.ok(Number.isFinite(r.sabine['1000 Hz'] as number));
});
check('SPL/G are null (with reason) when RT60 is missing; no RT60=1 s fabrication', () => {
  const rt = computeRT60(room('no_such_material'));
  const out = computeEstimatedGAndSPL(rt, room('no_such_material'), { x: .2, y: .2 }, { x: .8, y: .8 }, 95);
  for (const l of BAND_LABELS) { assert.equal(out.SPL[l], null); assert.equal(out.G[l], null); assert.ok(out.reasons[l]); }
});
check('missing sensitivity is flagged as fallback; supplied one is not', () => {
  const rt = computeRT60(room('drywall'));
  assert.equal(computeEstimatedGAndSPL(rt, room('drywall'), { x: .2, y: .2 }, { x: .8, y: .8 }, null).sensitivityIsFallback, true);
  assert.equal(computeEstimatedGAndSPL(rt, room('drywall'), { x: .2, y: .2 }, { x: .8, y: .8 }, 92).sensitivityIsFallback, false);
});
check('non-finite coordinates give null, z=0 is a real height', () => {
  const rt = computeRT60(room('drywall'));
  const bad = computeEstimatedGAndSPL(rt, room('drywall'), { x: NaN, y: .2 }, { x: .8, y: .8 }, 92);
  assert.equal(bad.SPL['1000 Hz'], null);
  const z0 = computeEstimatedGAndSPL(rt, room('drywall'), { x: .5, y: .5, z: 0 }, { x: .51, y: .5, z: 1.2 }, 92);
  const zNone = computeEstimatedGAndSPL(rt, room('drywall'), { x: .5, y: .5 }, { x: .51, y: .5, z: 1.2 }, 92);
  assert.notEqual(z0.SPL['1000 Hz'], zNone.SPL['1000 Hz']);
});
console.log(`\n=== ${passed} passed ===`);
