import assert from 'node:assert/strict';
import { computePerBandImpulseResponseParams } from './impulseResponseParams';
let passed = 0;
function check(n: string, f: () => void) { try { f(); passed++; console.log(`  PASS  ${n}`); } catch (e: any) { console.error(`  FAIL  ${n}\n        ${e.message}`); process.exitCode = 1; } }
const dt = 1 / 16000, n = 16000;
let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
const trace = Array.from({ length: n }, (_, i) => rnd() * Math.exp(-i * dt * 6.9 / 0.6));
check('bands centred above reliableFmaxHz are N/A, lower bands are numbers', () => {
  const r = computePerBandImpulseResponseParams(trace, dt, 0.6, 700);
  const labels = r.bandLabels;
  const num = labels.filter(l => r.c50[l] !== null);
  assert.ok(num.length >= 1 && num.length < labels.length, `numeric bands: ${num.join(',')}`);
  for (const l of labels) { const hz = parseFloat(l); if (hz > 700) assert.equal(r.c50[l], null, `${l} c50`); }
  for (const l of labels) { const hz = parseFloat(l); if (hz > 700) { assert.equal(r.d50[l], null); assert.equal(r.centerTimeMs[l], null); } }
});
check('without a limit behaviour is unchanged', () => {
  const r = computePerBandImpulseResponseParams(trace, dt, 0.6);
  assert.ok(r.c50[r.bandLabels[0]] !== null);
});
console.log(`\n=== ${passed} passed ===`);
