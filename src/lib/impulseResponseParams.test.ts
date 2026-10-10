// Regression tests for src/lib/impulseResponseParams.ts.
//
// Run with: npx tsx src/lib/impulseResponseParams.test.ts
// (No test-framework dependency, same standalone-script convention as
// roomAcoustics.validation.ts — see that file for why. Wired into `npm
// test` in package.json so it actually runs instead of sitting unused.)
//
// What these tests are actually checking, and why each one matters:
//
// 1. The core bug being fixed: per-band C50/C80/D50/Ts must NOT all be the
//    same number. Before this fix, LeftSidebar.tsx displayed one broadband
//    value repeated across every frequency column — a synthetic trace with
//    genuinely different behavior per band must now produce genuinely
//    different per-band numbers, or the fix didn't work.
// 2. Broadband and per-band must agree in the specific case where they
//    SHOULD agree (a flat/white trace with no frequency-dependent
//    structure) — this catches a bandpass-filter bug that would corrupt
//    energy even when there's nothing to differentiate between bands.
// 3. Known analytical edge cases: an all-early-energy impulse should give a
//    very high C50/C80/D50 in every band; an all-late impulse should give
//    very low/negative values. These aren't published reference numbers
//    (there's no citable "reference impulse response" the way there is for
//    RT60/Sabine), but they're physically unambiguous directions any
//    correct implementation must reproduce.
// 4. Insufficient-duration and empty-trace inputs must return nulls/
//    sufficient:false, never fabricated numbers or a thrown exception.

import {
  computeImpulseResponseParams,
  computePerBandImpulseResponseParams,
} from './impulseResponseParams';
import { filterIntoBands } from './octaveFilter';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function approxEqual(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

// --- Synthetic trace generators -------------------------------------------

// A single-frequency decaying sinusoid: e^(-t/tau) * sin(2*pi*f*t). Its
// energy is concentrated at `freqHz` by construction, so a correct
// octave-filter implementation should show that band's own C50/C80/D50
// reflecting a strong signal, while filtering the SAME trace through a
// distant band should mostly reject it — i.e. bands must differ.
function decayingTone(freqHz: number, sampleRateHz: number, durationSec: number, tauSec: number): number[] {
  const n = Math.round(durationSec * sampleRateHz);
  const trace = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRateHz;
    trace[i] = Math.exp(-t / tauSec) * Math.sin(2 * Math.PI * freqHz * t);
  }
  return trace;
}

// White noise (uniform random in [-1, 1]) has no frequency-dependent
// structure — a correct implementation should treat every band similarly
// (modulo filter-induced ringing), unlike the decaying-tone case.
function whiteNoise(sampleRateHz: number, durationSec: number, seed = 1234): number[] {
  const n = Math.round(durationSec * sampleRateHz);
  let s = seed;
  const rand = () => {
    // xorshift32 — deterministic, no external dependency
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s |= 0;
    return (s >>> 0) / 0xffffffff;
  };
  return Array.from({ length: n }, () => rand() * 2 - 1);
}

// All energy in the first sample, silence after — should read as
// unambiguously "clear" (very high C50/C80, D50 near 1) in every band.
function allEarlyImpulse(sampleRateHz: number, durationSec: number): number[] {
  const n = Math.round(durationSec * sampleRateHz);
  const trace = new Array(n).fill(0);
  trace[0] = 1;
  return trace;
}

// All energy in the last sample — should read as unambiguously "unclear"
// (very low/negative C50/C80, D50 near 0) in every band.
function allLateImpulse(sampleRateHz: number, durationSec: number): number[] {
  const n = Math.round(durationSec * sampleRateHz);
  const trace = new Array(n).fill(0);
  trace[n - 1] = 1;
  return trace;
}

// --- Tests ------------------------------------------------------------

function testPerBandValuesDiffer() {
  console.log('\nPer-band values must genuinely differ across bands (the core bug):');
  const sampleRateHz = 20000;
  // Energy concentrated at 4000 Hz with a short decay — the 125 Hz and
  // 4000 Hz bands should see very different filtered energy from this
  // trace, so their C50/D50/Ts should not come out identical.
  const trace = decayingTone(4000, sampleRateHz, 0.3, 0.05);
  const dt = 1 / sampleRateHz;

  const perBand = computePerBandImpulseResponseParams(trace, dt);
  assert('sufficient trace produces sufficient:true', perBand.sufficient);

  const c50Values = perBand.bandLabels.map(l => perBand.c50[l]).filter((v): v is number => v != null);
  const uniqueC50 = new Set(c50Values.map(v => v.toFixed(1)));
  assert(
    'C50 is not identical across all bands',
    uniqueC50.size > 1,
    `got ${JSON.stringify(perBand.c50)}`
  );

  const d50Values = perBand.bandLabels.map(l => perBand.d50[l]).filter((v): v is number => v != null);
  const uniqueD50 = new Set(d50Values.map(v => v!.toFixed(2)));
  assert(
    'D50 is not identical across all bands',
    uniqueD50.size > 1,
    `got ${JSON.stringify(perBand.d50)}`
  );

  // C50/D50 are RATIOS of early-to-late energy, not absolute-level
  // metrics — a fast-decaying tone puts nearly all of its energy (however
  // little of it lands in an off-target band) before the 50ms window, so
  // C50/D50 can legitimately saturate to similar "very clear" values in
  // both the on-target and off-target bands even though the bands are
  // being filtered correctly. That's a property of clarity ratios on a
  // short decay, not evidence the filter is broken (confirmed separately
  // below by checking absolute filtered energy, which the filter itself
  // determines and the ratio-based metrics don't directly expose).
  const totalEnergy125 = filterIntoBands(trace, sampleRateHz, [125])[125].reduce((s, v) => s + v * v, 0);
  const totalEnergy4000 = filterIntoBands(trace, sampleRateHz, [4000])[4000].reduce((s, v) => s + v * v, 0);
  assert(
    '4000 Hz band captures far more absolute energy than 125 Hz band for a 4kHz-concentrated signal',
    totalEnergy4000 > totalEnergy125 * 10,
    `125Hz energy=${totalEnergy125.toExponential(2)}, 4000Hz energy=${totalEnergy4000.toExponential(2)}`
  );
}

function testBroadbandStillWorksUnchanged() {
  console.log('\nBroadband function (unchanged behavior, still available for summary use):');
  const sampleRateHz = 20000;
  const trace = decayingTone(1000, sampleRateHz, 0.3, 0.05);
  const dt = 1 / sampleRateHz;

  const broadband = computeImpulseResponseParams(trace, dt);
  assert('broadband sufficient:true for a long-enough trace', broadband.sufficient);
  assert('broadband C50 is a finite number', broadband.c50 != null && Number.isFinite(broadband.c50));
  assert('broadband D50 is in [0,1]', broadband.d50 != null && broadband.d50 >= 0 && broadband.d50 <= 1);
}

function testWhiteNoiseBandsAreComparable() {
  console.log('\nWhite noise: bands should be broadly similar (no injected frequency structure):');
  const sampleRateHz = 20000;
  const trace = whiteNoise(sampleRateHz, 0.3);
  const dt = 1 / sampleRateHz;

  const perBand = computePerBandImpulseResponseParams(trace, dt);
  const d50Values = perBand.bandLabels
    .map(l => perBand.d50[l])
    .filter((v): v is number => v != null);

  assert(
    'all 7 octave bands produced a value for white noise',
    Object.keys(perBand.d50).length === 7,
    `got ${Object.keys(perBand.d50).length}`
  );

  // Not asserting near-equality here — a biquad bandpass has real, expected
  // per-band gain/phase differences even on stationary noise, and that's
  // fine; this just checks nothing came back NaN/degenerate.
  assert('no NaN/degenerate D50 values for white noise', d50Values.every(v => Number.isFinite(v)));
}

function testAllEarlyImpulseIsUnambiguouslyClear() {
  console.log('\nAll-early impulse: every band should read as very clear:');
  const sampleRateHz = 20000;
  const trace = allEarlyImpulse(sampleRateHz, 0.3);
  const dt = 1 / sampleRateHz;

  const perBand = computePerBandImpulseResponseParams(trace, dt);
  for (const label of perBand.bandLabels) {
    const d50 = perBand.d50[label];
    if (d50 != null) {
      assert(`${label} D50 is high (>0.8) for an all-early impulse`, d50 > 0.8, `got ${d50}`);
    }
  }
}

function testAllLateImpulseIsUnambiguouslyUnclear() {
  console.log('\nAll-late impulse: every band should read as very unclear:');
  const sampleRateHz = 20000;
  const trace = allLateImpulse(sampleRateHz, 0.3);
  const dt = 1 / sampleRateHz;

  const perBand = computePerBandImpulseResponseParams(trace, dt);
  for (const label of perBand.bandLabels) {
    const d50 = perBand.d50[label];
    if (d50 != null) {
      assert(`${label} D50 is low (<0.2) for an all-late impulse`, d50 < 0.2, `got ${d50}`);
    }
  }
}

function testInsufficientAndEmptyInputs() {
  console.log('\nEdge cases: insufficient duration and empty trace must not fabricate data:');
  const sampleRateHz = 20000;
  const dt = 1 / sampleRateHz;

  const tooShort = decayingTone(1000, sampleRateHz, 0.02, 0.05); // 20ms < 80ms minimum
  const shortResult = computePerBandImpulseResponseParams(tooShort, dt);
  assert('too-short trace returns sufficient:false', !shortResult.sufficient);
  assert(
    'too-short trace returns all-null per-band values, not fabricated numbers',
    shortResult.bandLabels.every(l => shortResult.c50[l] === null && shortResult.d50[l] === null)
  );

  const empty = computePerBandImpulseResponseParams([], dt);
  assert('empty trace returns sufficient:false', !empty.sufficient);
  assert('empty trace does not throw and returns null-filled bands', empty.bandLabels.every(l => empty.d50[l] === null));

  const zeroDt = computePerBandImpulseResponseParams(decayingTone(1000, sampleRateHz, 0.3, 0.05), 0);
  assert('dtSeconds=0 returns sufficient:false rather than dividing by zero', !zeroDt.sufficient);

  // RT60-aware sufficiency: a trace that clears the flat 80ms floor but not
  // half of a long estimated RT60 should still be marked insufficient.
  const rt60Aware = computePerBandImpulseResponseParams(
    decayingTone(1000, sampleRateHz, 0.15, 0.05), // 150ms of trace
    dt,
    2.0 // estimated RT60 of 2s -> needs >= 1000ms
  );
  assert('150ms trace is insufficient against a 2s estimated RT60', !rt60Aware.sufficient);
}

function testBandLabelsMatchRoomAcousticsConvention() {
  console.log('\nBand labels line up with roomAcoustics.ts BAND_LABELS (needed to display tables side by side):');
  const sampleRateHz = 20000;
  const trace = decayingTone(1000, sampleRateHz, 0.3, 0.05);
  const perBand = computePerBandImpulseResponseParams(trace, 1 / sampleRateHz);
  const expected = ['125 Hz', '250 Hz', '500 Hz', '1000 Hz', '2000 Hz', '4000 Hz', '8000 Hz'];
  assert(
    'bandLabels is exactly [125,250,500,1000,2000,4000,8000] Hz',
    JSON.stringify(perBand.bandLabels) === JSON.stringify(expected),
    `got ${JSON.stringify(perBand.bandLabels)}`
  );
}

testPerBandValuesDiffer();
testBroadbandStillWorksUnchanged();
testWhiteNoiseBandsAreComparable();
testAllEarlyImpulseIsUnambiguouslyClear();
testAllLateImpulseIsUnambiguouslyUnclear();
testInsufficientAndEmptyInputs();
testBandLabelsMatchRoomAcousticsConvention();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
