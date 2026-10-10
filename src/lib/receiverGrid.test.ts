import assert from 'node:assert/strict';
import { planReceiverGrid, strictNumber } from './receiverGrid';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== receiverGrid tests ===\n');

const base = { xMin: '0.1', xMax: '0.9', yMin: '0.1', yMax: '0.9', z: '1.2', spacing: '0.1' };
const err = (p: ReturnType<typeof planReceiverGrid>) => { assert.equal(p.ok, false); return (p as { error: string }).error; };

check('strictNumber rejects blank/loose text and keeps 0', () => {
  assert.equal(strictNumber(''), null); assert.equal(strictNumber('  '), null);
  assert.equal(strictNumber('1abc'), null); assert.equal(strictNumber('NaN'), null); assert.equal(strictNumber('Infinity'), null);
  assert.equal(strictNumber('0'), 0); assert.equal(strictNumber('-0.5'), -0.5);
});
check('default grid is 9 x 9 = 81 and exceeds the 64 limit', () => {
  assert.match(err(planReceiverGrid(base, 3, 64)), /81 receivers; the maximum is 64/);
});
check('exactly 64 is accepted, 65 is rejected, and no arrays are built for a rejected grid', () => {
  const ok = planReceiverGrid({ ...base, xMin: '0', xMax: '0.7', yMin: '0', yMax: '0.7' }, 3, 64);
  assert.equal(ok.ok, true); if (ok.ok) { assert.equal(ok.count, 64); assert.equal(ok.xs.length * ok.ys.length, 64); }
  assert.match(err(planReceiverGrid({ ...base, xMin: '0', xMax: '0.7', yMin: '0', yMax: '0.8' }, 3, 64)), /72 receivers/);
  assert.match(err(planReceiverGrid({ ...base, spacing: '1e-300' }, 3, 64)), /too small|maximum/);
});
check('floating point does not drop the last grid point and 0 coordinates stay 0', () => {
  const p = planReceiverGrid({ ...base, xMin: '0', xMax: '0.6', yMin: '0', yMax: '0', spacing: '0.1' }, 3, 64);
  assert.equal(p.ok, true);
  if (p.ok) { assert.equal(p.xs.length, 7); assert.equal(p.xs[0], 0); assert.equal(p.xs[6], 0.6); assert.deepEqual(p.ys, [0]); }
});
check('every invalid field produces an error naming that field', () => {
  assert.match(err(planReceiverGrid({ ...base, z: '' }, 3, 64)), /Z Height must be a number/);
  assert.match(err(planReceiverGrid({ ...base, spacing: 'abc' }, 3, 64)), /Spacing must be a number/);
  assert.match(err(planReceiverGrid({ ...base, spacing: '0' }, 3, 64)), /Spacing must be greater than 0/);
  assert.match(err(planReceiverGrid({ ...base, spacing: '-0.1' }, 3, 64)), /Spacing must be greater than 0/);
  assert.match(err(planReceiverGrid({ ...base, xMax: '1.5' }, 3, 64)), /X Max must be between 0 and 1/);
  assert.match(err(planReceiverGrid({ ...base, xMin: '0.9', xMax: '0.1' }, 3, 64)), /X Min must not exceed X Max/);
  assert.match(err(planReceiverGrid({ ...base, z: '9' }, 3, 64)), /Z Height must be between 0 and the room height/);
  assert.match(err(planReceiverGrid(base, NaN, 64)), /Room height/);
});
check('z = 0 is accepted as a legitimate height', () => {
  const p = planReceiverGrid({ ...base, z: '0', xMax: '0.1', yMax: '0.1' }, 3, 64);
  assert.equal(p.ok, true); if (p.ok) assert.equal(p.z, 0);
});
console.log(`\n${passed} checks passed`);
