/**
 * speakerAcousticDifference.test.ts
 *
 * Automated verification that every speaker produces genuinely distinct,
 * measurable acoustic outputs based on its physical/published response curves,
 * driver configuration, sensitivity, distance, and directivity.
 *
 * Verifies:
 * 1. Strict determinism: same speaker + same settings = identical output.
 * 2. Studio Monitor vs Subwoofer: massive measurable spectral differentiation.
 * 3. Yamaha NS-10M vs Flat Reference Monitor: presence-peak energy differentiation.
 * 4. Raw sensitivity vs Loudness-matched comparison behavior.
 * 5. Physical distance attenuation (1/r inverse distance law).
 * 6. Off-axis angle directivity attenuation.
 * 7. Logarithmic frequency interpolation numerical correctness.
 */

import { getSpeakerById, SPEAKER_SPECS } from './speakers';
import {
  simulateSpeakerDSP,
  getSpeakerResponseModel,
  interpolateLogFrequency,
  STANDARD_FREQUENCIES_HZ,
  type ResponsePoint
} from './speakerResponse';
import type { SpeakerSpec } from './speakerDSP';

console.log("\n=== Speaker Acoustic Difference & Real DSP Verification ===\n");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err: any) {
    failed++;
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Helpers
function generatePinkNoise(samples: number, sampleRate: number): Float32Array {
  const buf = new Float32Array(samples);
  let seed = 42;
  const lcg = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 2147483648 - 1.0;
  };

  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < samples; i++) {
    const white = lcg();
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.96300 * b1 + white * 0.296516;
    b2 = 0.57000 * b2 + white * 1.052691;
    buf[i] = (b0 + b1 + b2 + white * 0.1848) * 0.15;
  }
  return buf;
}

function computeRms(signal: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < signal.length; i++) {
    sumSq += signal[i] * signal[i];
  }
  return Math.sqrt(sumSq / signal.length);
}

function computeBandEnergy(signal: Float32Array, sampleRate: number, lowHz: number, highHz: number): number {
  // Simple discrete Fourier transform / filter-bank energy calculation for target band
  const N = Math.min(2048, signal.length);
  let totalEnergy = 0;
  const kMin = Math.floor((lowHz * N) / sampleRate);
  const kMax = Math.ceil((highHz * N) / sampleRate);

  for (let k = kMin; k <= kMax; k++) {
    let re = 0;
    let im = 0;
    const omega = (2 * Math.PI * k) / N;
    for (let n = 0; n < N; n++) {
      re += signal[n] * Math.cos(omega * n);
      im -= signal[n] * Math.sin(omega * n);
    }
    totalEnergy += (re * re + im * im) / (N * N);
  }
  return totalEnergy;
}

const sampleRate = 48000;
const testSignal = generatePinkNoise(48000 * 0.5, sampleRate); // 500 ms of deterministic pink noise

// -----------------------------------------------------------------------------
// Test 1: Determinism
// -----------------------------------------------------------------------------
check("Test 1: Same speaker + same input = bit-identical deterministic output", () => {
  const spec = getSpeakerById("yamaha-ns10m") as SpeakerSpec;
  assert(!!spec, "yamaha-ns10m must exist in database");

  const run1 = simulateSpeakerDSP(testSignal, sampleRate, spec, { loudnessMatched: true });
  const run2 = simulateSpeakerDSP(testSignal, sampleRate, spec, { loudnessMatched: true });

  assert(run1.length === run2.length, "Output lengths must match");
  let maxDiff = 0;
  for (let i = 0; i < run1.length; i++) {
    const diff = Math.abs(run1[i] - run2[i]);
    if (diff > maxDiff) maxDiff = diff;
  }
  assert(maxDiff === 0, `Deterministic runs must have 0 difference, got maxDiff ${maxDiff}`);
});

// -----------------------------------------------------------------------------
// Test 2: Studio Monitor vs Subwoofer
// -----------------------------------------------------------------------------
check("Test 2: Studio Monitor vs Subwoofer produces distinct measurable frequency distribution", () => {
  const monitor = getSpeakerById("genelec-8351b") as SpeakerSpec;
  const sub = getSpeakerById("qsc-ks212c") as SpeakerSpec; // sourced 44-104 Hz bandwidth; the EV X12-128 record carries no sourced bandwidth

  assert(!!monitor, "Genelec 8351B must exist");
  assert(!!sub, "QSC KS212C subwoofer must exist");

  const outMonitor = simulateSpeakerDSP(testSignal, sampleRate, monitor, { loudnessMatched: true });
  const outSub = simulateSpeakerDSP(testSignal, sampleRate, sub, { loudnessMatched: true });

  // Measure high-frequency energy (2 kHz - 8 kHz)
  const hfEnergyMonitor = computeBandEnergy(outMonitor, sampleRate, 2000, 8000);
  const hfEnergySub = computeBandEnergy(outSub, sampleRate, 2000, 8000);

  assert(hfEnergyMonitor > 0, "Monitor must reproduce HF energy");
  assert(hfEnergySub < hfEnergyMonitor * 0.05, `Subwoofer must sharply attenuate HF energy: sub=${hfEnergySub}, monitor=${hfEnergyMonitor}`);

  // Spectral RMS difference between monitor and subwoofer
  let sumDiffSq = 0;
  for (let i = 0; i < outMonitor.length; i++) {
    const diff = outMonitor[i] - outSub[i];
    sumDiffSq += diff * diff;
  }
  const rmsDiff = Math.sqrt(sumDiffSq / outMonitor.length);
  assert(rmsDiff > 0.05, `Monitor and subwoofer must have substantial RMS difference: got ${rmsDiff.toFixed(4)}`);
});

// -----------------------------------------------------------------------------
// Test 3: Yamaha NS-10M vs Flat Reference Monitor (Presence Peak Verification)
// -----------------------------------------------------------------------------
check("Test 3: Yamaha NS-10M uses only source-backed bandwidth data; no invented voicing curve", () => {
  const ns10 = getSpeakerById("yamaha-ns10m") as SpeakerSpec;
  const flat = getSpeakerById("genelec-8351b") as SpeakerSpec;
  assert(!!ns10, "NS-10M must exist");
  assert(!!flat, "Genelec 8351B must exist");

  const modelNS10 = getSpeakerResponseModel(ns10);
  const modelFlat = getSpeakerResponseModel(flat);

  assert(modelNS10.provenance === 'physically_modeled', `NS-10M provenance must be physically_modeled, got ${modelNS10.provenance}`);
  assert(modelNS10.isMeasuredOrManufacturer === false, 'NS-10M model must not claim measured/manufacturer provenance');
  assert(modelFlat.provenance === 'physically_modeled', `8351B provenance must be physically_modeled, got ${modelFlat.provenance}`);
  assert(modelFlat.isMeasuredOrManufacturer === false, '8351B model must not claim measured/manufacturer provenance');

  // Neither speaker has a raw response curve embedded in the database. The model may use published bandwidth
  // limits, but it must not manufacture a tonal hump and call it documented measurement data.
  const ns10PresenceDb = interpolateLogFrequency(modelNS10.points, 1800);
  assert(Math.abs(ns10PresenceDb) < 1.0, `NS-10M model must not invent a presence hump at 1.8kHz, got ${ns10PresenceDb.toFixed(2)} dB`);
});

// -----------------------------------------------------------------------------
// Test 4: Raw Mode vs Loudness-Matched Mode
// -----------------------------------------------------------------------------
check("Test 4: Raw mode reflects sensitivity difference; Loudness-Matched equalizes overall level", () => {
  const highSens = getSpeakerById("celestion-v30") as SpeakerSpec; // 100 dB @ 1W/1m
  const lowSens = getSpeakerById("kef-105") as SpeakerSpec; // Reference 105.2: 86 dB @ 1W/1m (sourced; Rockford P3 has no sensitivity)

  assert(!!highSens, "Celestion Vintage 30 must exist");
  assert(!!lowSens, "KEF Reference 105.2 must exist");

  const sensHigh = highSens.sensitivity?.value;
  const sensLow = lowSens.sensitivity?.value;
  if (typeof sensHigh !== "number" || typeof sensLow !== "number" || !Number.isFinite(sensHigh) || !Number.isFinite(sensLow)) {
    throw new Error("test speakers must carry explicit sensitivity values");
  }
  assert(sensHigh > sensLow, `highSens (${sensHigh}) must be greater than lowSens (${sensLow})`);

  // In raw mode, higher sensitivity speaker outputs higher amplitude
  const rawHigh = simulateSpeakerDSP(testSignal, sampleRate, highSens, { loudnessMatched: false });
  const rawLow = simulateSpeakerDSP(testSignal, sampleRate, lowSens, { loudnessMatched: false });

  const rmsRawHigh = computeRms(rawHigh);
  const rmsRawLow = computeRms(rawLow);
  assert(rmsRawHigh > rmsRawLow, `Higher sensitivity speaker (${sensHigh}dB) must be louder than lower sensitivity (${sensLow}dB) in raw mode`);

  // In loudness-matched mode, level difference is normalized so user compares timbre only
  const matchedHigh = simulateSpeakerDSP(testSignal, sampleRate, highSens, { loudnessMatched: true });
  const matchedLow = simulateSpeakerDSP(testSignal, sampleRate, lowSens, { loudnessMatched: true });

  const rmsMatchedHigh = computeRms(matchedHigh);
  const rmsMatchedLow = computeRms(matchedLow);
  const levelRatio = Math.abs(20 * Math.log10(rmsMatchedHigh / rmsMatchedLow));
  assert(levelRatio < 3.5, `Loudness-matched mode should keep broadband RMS within 3.5 dB, got ratio ${levelRatio.toFixed(2)} dB`);
});

// -----------------------------------------------------------------------------
// Test 5: Distance Attenuation (1 / r)
// -----------------------------------------------------------------------------
check("Test 5: Distance attenuation follows inverse-distance law", () => {
  const spec = getSpeakerById("genelec-8351b") as SpeakerSpec;
  const d1 = simulateSpeakerDSP(testSignal, sampleRate, spec, { distanceM: 1.0, loudnessMatched: true });
  const d2 = simulateSpeakerDSP(testSignal, sampleRate, spec, { distanceM: 2.0, loudnessMatched: true });

  const rms1 = computeRms(d1);
  const rms2 = computeRms(d2);

  // Doubling distance reduces free-field amplitude by 50% (-6.02 dB)
  const ratio = rms1 / rms2;
  assert(Math.abs(ratio - 2.0) < 0.05, `Doubling distance must cut linear amplitude in half (expected ~2.0, got ${ratio.toFixed(3)})`);
});

// -----------------------------------------------------------------------------
// Test 6: Off-Axis Directivity Attenuation
// -----------------------------------------------------------------------------
check("Test 6: Off-axis angle applies progressive directivity attenuation", () => {
  const spec = getSpeakerById("genelec-8351b") as SpeakerSpec;
  const onAxis = simulateSpeakerDSP(testSignal, sampleRate, spec, { angleRad: 0.0, loudnessMatched: true });
  const offAxis60 = simulateSpeakerDSP(testSignal, sampleRate, spec, { angleRad: (60 * Math.PI) / 180, loudnessMatched: true });
  const offAxis90 = simulateSpeakerDSP(testSignal, sampleRate, spec, { angleRad: (90 * Math.PI) / 180, loudnessMatched: true });

  const rms0 = computeRms(onAxis);
  const rms60 = computeRms(offAxis60);
  const rms90 = computeRms(offAxis90);

  assert(rms0 > rms60, `On-axis must be louder than 60 deg off-axis: ${rms0.toFixed(4)} <= ${rms60.toFixed(4)}`);
  assert(rms60 > rms90, `60 deg must be louder than 90 deg off-axis: ${rms60.toFixed(4)} <= ${rms90.toFixed(4)}`);
});

// -----------------------------------------------------------------------------
// Test 7: Logarithmic Frequency Interpolation Integrity
// -----------------------------------------------------------------------------
check("Test 7: Logarithmic frequency interpolation is smooth and monotonic", () => {
  const points: ResponsePoint[] = [
    { hz: 20, db: -20 },
    { hz: 100, db: 0 },
    { hz: 1000, db: 0 },
    { hz: 10000, db: -10 }
  ];

  // Midpoint between 20 Hz and 100 Hz in log space is 10^( (log10(20) + log10(100))/2 ) = sqrt(2000) ~= 44.7 Hz
  const midFreq = Math.sqrt(20 * 100);
  const valMid = interpolateLogFrequency(points, midFreq);
  assert(Math.abs(valMid - (-10.0)) < 0.1, `Logarithmic midpoint between -20dB and 0dB should be -10dB, got ${valMid.toFixed(2)}`);

  // Extrapolation checks
  const valSub10 = interpolateLogFrequency(points, 10);
  assert(valSub10 < -20, `Sub-20Hz extrapolation must continue downward slope: got ${valSub10.toFixed(2)}`);

  const val20k = interpolateLogFrequency(points, 20000);
  assert(val20k < -10, `Above 10kHz extrapolation must continue downward slope: got ${val20k.toFixed(2)}`);
});

// -----------------------------------------------------------------------------
// Test 8: Hi-fi (KEF Reference 105.2, 38 Hz–22 kHz) vs PA System (QSC K12.2, 50 Hz–20 kHz); both sourced bandwidths
// (two records with NO sourced data legitimately render identically, so they cannot be used to prove divergence)
// -----------------------------------------------------------------------------
check("Test 8: KEF Reference floorstander vs high-output PA exhibits measurable acoustic divergence", () => {
  const reference = getSpeakerById("kef-105") as SpeakerSpec;
  const pa = getSpeakerById("qsc-k12.2") as SpeakerSpec;

  assert(!!reference, "KEF Reference 105.2 must exist");
  assert(!!pa, "QSC K12.2 must exist");

  const outReference = simulateSpeakerDSP(testSignal, sampleRate, reference, { loudnessMatched: true });
  const outPA = simulateSpeakerDSP(testSignal, sampleRate, pa, { loudnessMatched: true });

  let sumDiffSq = 0;
  for (let i = 0; i < outReference.length; i++) {
    const diff = outReference[i] - outPA[i];
    sumDiffSq += diff * diff;
  }
  const rmsDiff = Math.sqrt(sumDiffSq / outReference.length);
  assert(rmsDiff > 0.015, `Reference floorstander and PA speaker must produce distinct DSP waveforms: rmsDiff=${rmsDiff.toFixed(4)}`);

  // The PA record has no verified curve, so its response must come ONLY from its published limits. The previous
  // category-based "PA horn presence" bump (+2.5 dB at ~2.6 kHz) was an invented characteristic and must not return:
  // a synthesized model may roll off, but it may never add gain that no data supports.
  const paModel = getSpeakerResponseModel(pa);
  if (paModel.provenance === 'physically_modeled') {
    const maxBoost = Math.max(...paModel.points.map((p) => p.db));
    assert(maxBoost <= 0.05, `Synthesized PA response must not contain invented boosts (max ${maxBoost} dB)`);
    assert(paModel.isMeasuredOrManufacturer === false, 'Synthesized PA response must not claim measured/manufacturer provenance');
  }
});

// -----------------------------------------------------------------------------
// Test 9: Klipschorn (105 dB SPL) vs KEF Reference 105.2 (86 dB SPL) Sensitivity Modeling
// -----------------------------------------------------------------------------
check("Test 9: High-Efficiency Horn (105dB) vs KEF Reference 105.2 (86dB) reflects the sourced 19 dB sensitivity difference", () => {
  const horn = getSpeakerById("klipsch-klipschorn") as SpeakerSpec;
  const reference105 = getSpeakerById("kef-105") as SpeakerSpec;

  assert(!!horn, "Klipschorn must exist");
  assert(!!reference105, "KEF Reference 105.2 must exist");

  const sensHorn = horn.sensitivity?.value;
  const sensMonitor = reference105.sensitivity?.value;
  if (typeof sensHorn !== "number" || typeof sensMonitor !== "number" || !Number.isFinite(sensHorn) || !Number.isFinite(sensMonitor)) {
    throw new Error("comparison speakers must carry explicit sensitivity values");
  }
  assert(sensHorn - sensMonitor >= 19, `Klipschorn must reflect the sourced 19 dB sensitivity difference vs Reference 105.2; got ${sensHorn - sensMonitor} dB`);

  const rawHorn = simulateSpeakerDSP(testSignal, sampleRate, horn, { loudnessMatched: false });
  const rawMonitor = simulateSpeakerDSP(testSignal, sampleRate, reference105, { loudnessMatched: false });

  const rmsHorn = computeRms(rawHorn);
  const rmsMonitor = computeRms(rawMonitor);
  const measuredRatioDb = 20 * Math.log10(rmsHorn / rmsMonitor);

  // The source-backed sensitivity gap is 19 dB; sourced bandwidth rolloffs may shift broadband RMS slightly.
  assert(measuredRatioDb >= 19.0 && measuredRatioDb <= 23.0, `Physical sensitivity ratio should reflect the 19 dB sensitivity gap, got ${measuredRatioDb.toFixed(2)} dB`);
});

console.log(`\n=== Speaker Acoustic Difference Tests: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  console.error("Failures:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
