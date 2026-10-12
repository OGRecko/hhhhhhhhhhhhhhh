import assert from 'node:assert/strict';
import { LIMITS, validateRoomDimensions, validateSteps, validateFmax, validatePointList, finiteNumber, validatePolygon, validateSolverRequest, pointInPolygon } from '../src/lib/publicLimits';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== Public Resource Limit Tests ===\n');

check('the public solver ceiling is exactly 50 million cells', () => { assert.equal(LIMITS.MAX_GRID_CELLS, 50_000_000); });
check('room dimensions accept exact maximums', () => {
  assert.equal(validateRoomDimensions({ L: 100, W: 100, H: 30 }).ok, true);
});
check('room dimensions reject one above every maximum', () => {
  assert.equal(validateRoomDimensions({ L: 100.001, W: 10, H: 10 }).ok, false);
  assert.equal(validateRoomDimensions({ L: 10, W: 100.001, H: 10 }).ok, false);
  assert.equal(validateRoomDimensions({ L: 10, W: 10, H: 30.001 }).ok, false);
});
check('room dimensions reject non-finite and undersized values', () => {
  assert.equal(validateRoomDimensions({ L: Infinity, W: 10, H: 10 }).ok, false);
  assert.equal(validateRoomDimensions({ L: 0, W: 10, H: 10 }).ok, false);
  assert.equal(finiteNumber('10'), null);
});
check('steps use the authoritative default and boundary', () => {
  assert.deepEqual(validateSteps(undefined), { ok: true, steps: LIMITS.DEFAULT_STEPS });
  assert.deepEqual(validateSteps(LIMITS.MAX_STEPS), { ok: true, steps: LIMITS.MAX_STEPS });
  assert.equal(validateSteps(LIMITS.MAX_STEPS + 1).ok, false);
  assert.equal(validateSteps(1.5).ok, false);
  assert.equal(validateSteps('3000').ok, false);
});
check('fmax is strict and bounded', () => {
  assert.equal(validateFmax(LIMITS.MIN_FMAX_HZ).ok, true);
  assert.equal(validateFmax(LIMITS.MAX_FMAX_HZ).ok, true);
  assert.equal(validateFmax(LIMITS.MAX_FMAX_HZ + 1).ok, false);
  assert.equal(validateFmax(Infinity).ok, false);
});
check('source and receiver counts enforce authoritative boundaries', () => {
  const src = { x: .5, y: .5, z: 1 };
  const recv = { x: .5, y: .5, z: 1 };
  assert.equal(validatePointList([src], 2, 'source').ok, true);
  assert.equal(validatePointList(Array.from({length: LIMITS.MAX_SOURCES}, () => src), 2, 'source').ok, true);
  assert.equal(validatePointList(Array.from({length: LIMITS.MAX_SOURCES + 1}, () => src), 2, 'source').ok, false);
  assert.equal(validatePointList(Array.from({length: LIMITS.MAX_RECEIVERS}, () => recv), 2, 'receiver').ok, true);
  assert.equal(validatePointList(Array.from({length: LIMITS.MAX_RECEIVERS + 1}, () => recv), 2, 'receiver').ok, false);
});
check('coordinates and labels reject unsafe values', () => {
  assert.equal(validatePointList([{ x: NaN, y: .5 }], 2, 'source').ok, false);
  assert.equal(validatePointList([{ x: .5, y: .5, z: 3 }], 2, 'source').ok, false);
  assert.equal(validatePointList([{ x: .5, y: .5, name: 'a\nsecret' }], 2, 'source').ok, false);
});

check('room polygon validates geometry, wall arrays, and openings', () => {
  const poly = [{x:0.1,y:0.1},{x:0.7,y:0.1},{x:0.7,y:0.9},{x:0.1,y:0.9}];
  assert.equal(validatePolygon(poly).ok, true);
  assert.equal(pointInPolygon({x:0.4,y:0.5}, poly), true);
  assert.equal(pointInPolygon({x:0.9,y:0.5}, poly), false);
  assert.equal(validatePolygon([{x:0,y:0},{x:1,y:1},{x:0,y:1},{x:1,y:0}]).ok, false);
  const v = validateSolverRequest({ L:10,W:10,H:3, poly, wallMaterial:'drywall', floorMaterial:'wood_floor', ceilMaterial:'stonewool', wallSegMats:['concrete',null,null,null], wallOpenings:[null,'full',{start:.2,end:.5},null], sources:[{x:.4,y:.5,z:1}], receivers:[{x:.5,y:.5,z:1}], steps:2 }, 'wave');
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.request.poly.length, 4);
    assert.equal(v.request.wallSegMats[0], 'concrete');
    assert.equal(v.request.wallOpenings[1], 'full');
  }
});
check('solver request rejects source outside a custom footprint', () => {
  const v = validateSolverRequest({ L:10,W:10,H:3, poly:[{x:.2,y:.2},{x:.8,y:.2},{x:.8,y:.8},{x:.2,y:.8}], sources:[{x:.1,y:.1,z:1}], receivers:[{x:.5,y:.5,z:1}] }, 'wave');
  assert.equal(v.ok, false);
});
// Regression: a request with no surface material and no explicit absorption was queued and then failed in the
// worker as solver_failed. Each surface must now carry a material or an explicit absorption, named in the error.
check('solver request rejects a surface with neither material nor absorption, naming the field', () => {
  const base = { L:4,W:4,H:3, sources:[{x:.5,y:.5,z:1.5}], receivers:[{x:.25,y:.75,z:1.5}] };
  const none = validateSolverRequest(base, 'impulse-response');
  assert.equal(none.ok, false);
  assert.match(none.ok ? '' : none.error, /wallMaterial or wallAbsorption is required/);
  const noFloor = validateSolverRequest({ ...base, wallMaterial:'concrete', ceilMaterial:'concrete' }, 'impulse-response');
  assert.equal(noFloor.ok, false);
  assert.match(noFloor.ok ? '' : noFloor.error, /floorMaterial or floorAbsorption is required/);
  const noCeil = validateSolverRequest({ ...base, wallMaterial:'concrete', floorMaterial:'concrete' }, 'impulse-response');
  assert.equal(noCeil.ok, false);
  assert.match(noCeil.ok ? '' : noCeil.error, /ceilMaterial or ceilAbsorption is required/);
});
check('solver request accepts explicit absorption in place of materials', () => {
  const base = { L:4,W:4,H:3, sources:[{x:.5,y:.5,z:1.5}], receivers:[{x:.25,y:.75,z:1.5}] };
  assert.equal(validateSolverRequest({ ...base, wallAbsorption:.2, floorAbsorption:.2, ceilAbsorption:.2 }, 'impulse-response').ok, true);
  assert.equal(validateSolverRequest({ ...base, wallMaterial:'concrete', floorMaterial:'concrete', ceilMaterial:'concrete' }, 'impulse-response').ok, true);
});

console.log(`\n=== ${passed} passed ===`);

const directionalSource = { x: .5, y: .5, z: 1.2, isDirectional: true, yawDeg: 15, pitchDeg: -5, rollDeg: 2, directivityData: {
  frequencies: [1000], angularResolution: 10, brand: 'Test', model: 'Directional',
  points: { '0,0': [0], '90,0': [-6], '180,0': [-12], '270,0': [-6] }
} };
const directionalResult = validatePointList([directionalSource], 2, 'source');
assert.equal(directionalResult.ok, true);
if (directionalResult.ok) {
  assert.equal(directionalResult.points[0].isDirectional, true);
  assert.equal(directionalResult.points[0].directivityData?.frequencies[0], 1000);
  assert.equal(directionalResult.points[0].yawDeg, 15);
}
assert.equal(validatePointList([{ ...directionalSource, directivityData: { frequencies: [1000], angularResolution: 10, points: { '0,0': [NaN] } } }], 2, 'source').ok, false);
