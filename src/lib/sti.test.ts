/**
 * sti.ts (the real MTF/Schroeder-method STI, as opposed to the RT60/SNR
 * curve-fit proxy in roomAcoustics.ts) had zero test coverage before this
 * pass, despite containing a numerically load-bearing claim in its own
 * comment: modulationIndex() needs a factor of 2 to recover true modulation
 * depth, "verified against a synthetic 100%-modulated test signal" - but
 * that verification wasn't captured anywhere runnable. This file captures
 * it, plus end-to-end sanity checks on computeRealSTI itself.
 */
import assert from 'node:assert/strict';
import { computeRealSTI } from './sti';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== sti.ts tests ===\n');

// Reimplemented here (not exported from sti.ts) purely to verify the
// documented factor-of-2 claim in isolation, the same way the module
// comment says it was originally checked.
function modulationIndex(energy: number[], F: number, dt: number): number {
  let re = 0, im = 0, total = 0;
  for (let n = 0; n < energy.length; n++) {
    const e = energy[n];
    const phase = 2 * Math.PI * F * n * dt;
    re += e * Math.cos(phase);
    im += e * Math.sin(phase);
    total += e;
  }
  if (total <= 0) return 0;
  return (2 * Math.sqrt(re * re + im * im)) / total;
}

check('modulationIndex recovers full depth (1.0) for a 100%-modulated envelope, confirming the factor of 2', () => {
  const dt = 0.001, N = 10000, F = 2.0;
  const energy = Array.from({ length: N }, (_, n) => 1 + 1.0 * Math.cos(2 * Math.PI * F * n * dt));
  const m = modulationIndex(energy, F, dt);
  assert.ok(Math.abs(m - 1.0) < 1e-6, `expected ~1.0 for 100% modulation depth, got ${m}`);
});

check('modulationIndex scales linearly with modulation depth (50% -> ~0.5)', () => {
  const dt = 0.001, N = 10000, F = 2.0;
  const energy = Array.from({ length: N }, (_, n) => 1 + 0.5 * Math.cos(2 * Math.PI * F * n * dt));
  const m = modulationIndex(energy, F, dt);
  assert.ok(Math.abs(m - 0.5) < 1e-6, `expected ~0.5 for 50% modulation depth, got ${m}`);
});

check('modulationIndex is near-zero when probed at a frequency the signal is not modulated at', () => {
  const dt = 0.001, N = 10000;
  const energy = Array.from({ length: N }, (_, n) => 1 + Math.cos(2 * Math.PI * 2.0 * n * dt));
  const m = modulationIndex(energy, 5.0, dt); // probe 5Hz on a 2Hz-modulated signal
  assert.ok(m < 1e-6, `expected ~0 when probing an unrelated frequency, got ${m}`);
});

check('a trace too short to resolve the lowest modulation frequency (0.63Hz) is reported as insufficient', () => {
  const shortTrace = new Array(50).fill(0.01);
  const result = computeRealSTI(shortTrace, 0.001); // 50ms, needs ~1.6s
  assert.equal(result.sufficient, false);
  assert.equal(result.value, 0);
  assert.equal(result.qualityLabel, 'Unavailable');
});

check('a sufficiently long trace produces a bounded [0,1] STI value with sufficient=true', () => {
  const dt = 0.0005, durationSec = 2.0;
  const N = Math.round(durationSec / dt);
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  const trace = Array.from({ length: N }, (_, n) => Math.exp(-(n * dt) / 0.3) * rand());
  const result = computeRealSTI(trace, dt);
  assert.equal(result.sufficient, true);
  assert.ok(result.value >= 0 && result.value <= 1, `STI value ${result.value} out of [0,1]`);
});

check('bands at or above Nyquist are excluded from the result, not silently zeroed', () => {
  // Sample rate 2000Hz -> Nyquist 1000Hz. 1000Hz itself and everything above must be absent.
  const dt = 1 / 2000, durationSec = 2.0;
  const N = Math.round(durationSec / dt);
  let seed = 1;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  const trace = Array.from({ length: N }, (_, n) => Math.exp(-(n * dt) / 0.3) * rand());
  const result = computeRealSTI(trace, dt);
  const bands = Object.keys(result.perBandTransmissionIndex);
  assert.deepEqual(bands.sort(), ['250 Hz', '500 Hz'].sort(), `expected only sub-Nyquist bands (125Hz excluded by design, 1000Hz+ excluded by Nyquist), got ${JSON.stringify(bands)}`);
});

check('the combined STI averages only over bands actually present, not the full nominal band count', () => {
  // Regression for the bug already fixed in sti.ts's own comment: dividing
  // by the full BANDS_USED_IN_COMBINATION.length even when some bands were
  // skipped for Nyquist would silently understate STI. Verify the two
  // per-band values and the combined value are mutually consistent.
  const dt = 1 / 2000, durationSec = 2.0;
  const N = Math.round(durationSec / dt);
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  const trace = Array.from({ length: N }, (_, n) => Math.exp(-(n * dt) / 0.3) * rand());
  const result = computeRealSTI(trace, dt);
  const values = Object.values(result.perBandTransmissionIndex);
  const expectedAvg = Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
  assert.equal(result.value, expectedAvg, `combined STI ${result.value} should equal the average of only the present bands ${JSON.stringify(values)} (expected ${expectedAvg})`);
});

console.log(`\n=== ${passed} passed ===`);
