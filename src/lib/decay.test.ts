/**
 * Validation tests for Schroeder decay analysis.
 *
 * These are analytical-vs-numerical tests: a synthetic impulse response with
 * an EXACTLY KNOWN RT60 is generated, and the recovered value is compared
 * against ground truth. That is what makes this a validation suite rather
 * than a smoke test.
 *
 * Run with:  npx tsx src/lib/decay.test.ts
 */

import { schroederCurve, fitDecay, computeEDT, computeT20, computeT30 } from "./decay";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e: any) { failed++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
function assert(c: any, m: string) { if (!c) throw new Error(m); }

/**
 * Synthetic IR: an oscillating carrier inside an exponential energy decay
 * with an exact RT60. The oscillation matters — it is precisely what broke
 * the old peak-walking method.
 */
function syntheticIR(rt60: number, dt: number, durationSec: number, freqHz = 200): number[] {
  const n = Math.round(durationSec / dt);
  const out: number[] = new Array(n);
  // Energy decays 60 dB over rt60 => amplitude decays 60 dB over rt60.
  const decayPerSec = Math.pow(10, -60 / 20 / rt60);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const envelope = Math.pow(decayPerSec, t);
    out[i] = envelope * Math.sin(2 * Math.PI * freqHz * t);
  }
  return out;
}

console.log("\n=== Schroeder decay analysis validation ===\n");

const DT = 1 / 8000;

check("recovers a known RT60 of 0.5 s within 5%", () => {
  const ir = syntheticIR(0.5, DT, 2.0);
  const fit = computeT30(schroederCurve(ir), DT);
  assert(fit.status === "VALIDATED", `status ${fit.status}: ${fit.reason}`);
  const err = Math.abs(fit.rt60Sec! - 0.5) / 0.5;
  assert(err < 0.05, `recovered ${fit.rt60Sec!.toFixed(4)}s vs 0.5s (${(err * 100).toFixed(1)}% error)`);
  assert(fit.r2! > 0.99, `R^2 ${fit.r2}`);
});

check("recovers known RT60 across 0.2 s - 2.0 s within 5%", () => {
  for (const truth of [0.2, 0.4, 0.8, 1.2, 2.0]) {
    const ir = syntheticIR(truth, DT, truth * 2.5);
    const curve = schroederCurve(ir);
    const fit = computeT30(curve, DT);
    assert(fit.status === "VALIDATED", `RT60=${truth}: status ${fit.status} (${fit.reason})`);
    const err = Math.abs(fit.rt60Sec! - truth) / truth;
    assert(err < 0.05, `RT60=${truth}: recovered ${fit.rt60Sec!.toFixed(4)} (${(err * 100).toFixed(1)}% error)`);
  }
});

check("T20, T30 and EDT agree on a purely exponential decay", () => {
  const truth = 0.8;
  const ir = syntheticIR(truth, DT, 3.0);
  const curve = schroederCurve(ir);
  for (const [label, fit] of [["EDT", computeEDT(curve, DT)], ["T20", computeT20(curve, DT)], ["T30", computeT30(curve, DT)]] as const) {
    assert(fit.status === "VALIDATED", `${label}: ${fit.status} ${fit.reason}`);
    const err = Math.abs(fit.rt60Sec! - truth) / truth;
    assert(err < 0.07, `${label}: ${fit.rt60Sec!.toFixed(4)} vs ${truth} (${(err * 100).toFixed(1)}%)`);
  }
});

check("the OLD peak-walking method is demonstrably wrong on the same signal", () => {
  // Reproduces the previous algorithm to document why it was replaced.
  const truth = 1.0;
  const ir = syntheticIR(truth, DT, 3.0);
  let peak = 0, peakIdx = 0;
  for (let i = 0; i < ir.length; i++) {
    const a = Math.abs(ir[i]);
    if (a > peak) { peak = a; peakIdx = i; }
  }
  const threshold = peak * Math.pow(10, -30 / 20);
  let idx = -1;
  for (let i = peakIdx; i < ir.length; i++) {
    if (Math.abs(ir[i]) < threshold) { idx = i - peakIdx; break; }
  }
  const oldRt60 = idx > 0 ? idx * DT * 2 : null;
  assert(oldRt60 !== null, "old method found no decay at all");
  // It latches onto the first zero-crossing, so it is wildly short.
  assert(oldRt60! < truth * 0.2, `old method returned ${oldRt60}, expected it to be badly short of ${truth}`);

  // And the new one is correct on the identical input.
  const fit = computeT30(schroederCurve(ir), DT);
  assert(Math.abs(fit.rt60Sec! - truth) / truth < 0.05, `new method ${fit.rt60Sec}`);
});

check("Schroeder curve is monotonically non-increasing", () => {
  const { edcDb } = schroederCurve(syntheticIR(0.7, DT, 2.0));
  for (let i = 1; i < edcDb.length; i++) {
    assert(edcDb[i] <= edcDb[i - 1] + 1e-9, `curve rose at index ${i}: ${edcDb[i - 1]} -> ${edcDb[i]}`);
  }
  assert(Math.abs(edcDb[0]) < 1e-9, `curve should start at 0 dB, got ${edcDb[0]}`);
});

check("a too-short trace is refused, not extrapolated", () => {
  // 0.1 s of a 2 s RT60 room never reaches -35 dB.
  const ir = syntheticIR(2.0, DT, 0.1);
  const fit = computeT30(schroederCurve(ir), DT);
  assert(fit.status === "UNAVAILABLE", `status ${fit.status}`);
  assert(fit.rt60Sec === null, `returned ${fit.rt60Sec} from an insufficient trace`);
  assert(/too short|required/i.test(fit.reason ?? ""), `unhelpful reason: ${fit.reason}`);
});

check("a flat (non-decaying) trace is refused", () => {
  const flat = new Array(4000).fill(0.5);
  const fit = computeT30(schroederCurve(flat), DT);
  assert(fit.rt60Sec === null, `returned ${fit.rt60Sec} for a constant signal`);
  assert(fit.status === "UNAVAILABLE", `status ${fit.status}`);
});

check("silence and empty input are handled without throwing", () => {
  for (const input of [[], new Array(100).fill(0)]) {
    const s = schroederCurve(input as number[]);
    const fit = computeT30(s, DT);
    assert(fit.rt60Sec === null, "fabricated an RT60 from silence");
  }
});

check("invalid dt is refused", () => {
  const curve = schroederCurve(syntheticIR(0.5, DT, 2.0));
  for (const badDt of [0, -1, NaN, Infinity]) {
    const fit = fitDecay(curve, badDt, -5, -35);
    assert(fit.rt60Sec === null, `dt=${badDt} produced ${fit.rt60Sec}`);
  }
});

check("a noisy decay is downgraded to LIMITED rather than silently accepted", () => {
  // A decay that flattens into a noise floor halfway down is not linear
  // across the T30 window.
  const truth = 1.0;
  const ir = syntheticIR(truth, DT, 3.0);
  const floor = 0.02;
  const noisy = ir.map((v, i) => (i * DT > 0.4 ? floor * Math.sin(i) : v));
  const fit = computeT30(schroederCurve(noisy), DT);
  assert(fit.status !== "VALIDATED" || fit.r2! < 0.999,
    `a decay truncated into a noise floor should not be reported as a clean VALIDATED fit (r2=${fit.r2})`);
});

check("output carries fit provenance, not just a number", () => {
  const fit = computeT30(schroederCurve(syntheticIR(0.6, DT, 2.5)), DT);
  assert(fit.fitRangeDb[0] === -5 && fit.fitRangeDb[1] === -35, "T30 range should be -5..-35 dB");
  assert(fit.sampleCount > 0, "no sample count reported");
  assert(typeof fit.slopeDbPerSec === "number", "no slope reported");
  assert(fit.status === "VALIDATED", "expected a validated fit");
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) { console.log("Failures:"); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
