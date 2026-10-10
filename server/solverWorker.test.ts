/**
 * Executable numerical tests for the FDTD solvers and the solver's safety
 * configuration.
 *
 * These call runWave/runIR and assert on the NUMBERS THEY PRODUCE. They do
 * not inspect source code as strings — a source-text check passes happily
 * while the arithmetic underneath is wrong, which is exactly the failure
 * mode this file exists to catch.
 *
 * Run with:  npx tsx server/solverWorker.test.ts
 */

import {
  runWave,
  runIR,
  makeRickerSource,
  resolveSurfaceAbsorption,
  assertCflStable,
  assertTimeStepConsistent,
  CFL_LIMIT_SQUARED,
  resolveMaxSolverMemoryBytes,
  DEFAULT_MAX_SOLVER_MEMORY_BYTES,
  HARD_MAX_SOLVER_MEMORY_BYTES,
} from "./solverWorker";
import { schroederCurve } from "../src/lib/decay";

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

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

function assertFiniteArray(arr: number[], label: string) {
  assert(Array.isArray(arr), `${label} is not an array`);
  assert(arr.length > 0, `${label} is empty`);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    assert(!Number.isNaN(v), `${label}[${i}] is NaN`);
    assert(Number.isFinite(v), `${label}[${i}] is not finite (${v})`);
  }
}

const SPEED_OF_SOUND = 343;
const POINTS_PER_WAVELENGTH = 9;

// Silence the solvers' progress logging so test output stays readable.
const realLog = console.log;
const realErr = console.error;
function quiet<T>(fn: () => T): T {
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
}

// ---------------------------------------------------------------------------
// Analysis helpers used by the physics tests below.
// ---------------------------------------------------------------------------

/** Total energy (sum of squares) of a trace. */
function energy(trace: number[], from = 0, to = trace.length): number {
  let e = 0;
  for (let i = from; i < to; i++) e += trace[i] * trace[i];
  return e;
}

/**
 * Least-squares decay slope of the Schroeder energy decay curve, in dB per
 * second, fitted over a dB window of the curve.
 *
 * This is the decay RATE, which is the quantity absorption is supposed to
 * change. Total energy alone is not: a boundary condition that merely scaled
 * the whole trace down would move total energy while leaving the decay rate
 * untouched, and a test built only on total energy would call that a pass.
 */
function decaySlopeDbPerSec(
  trace: number[],
  dt: number,
  hiDb = -5,
  loDb = -35,
): { slope: number | null; sampleCount: number } {
  const s = schroederCurve(trace);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < s.usableLength; i++) {
    const db = s.edcDb[i];
    if (db <= hiDb && db >= loDb) {
      xs.push(i * dt);
      ys.push(db);
    }
  }
  if (xs.length < 20) return { slope: null, sampleCount: xs.length };
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  if (!(den > 0)) return { slope: null, sampleCount: n };
  return { slope: num / den, sampleCount: n };
}

/** Single-frequency DFT magnitude, for modal analysis. */
function dftMagnitude(trace: number[], dt: number, freqHz: number): number {
  let re = 0;
  let im = 0;
  const w = 2 * Math.PI * freqHz * dt;
  for (let i = 0; i < trace.length; i++) {
    re += trace[i] * Math.cos(w * i);
    im -= trace[i] * Math.sin(w * i);
  }
  return Math.hypot(re, im);
}

/**
 * Transfer-function magnitude: the receiver spectrum divided by the spectrum
 * of the wavelet that was actually injected.
 *
 * Dividing out the source matters. The excitation is band-limited around
 * f0, so the RAW receiver spectrum peaks near f0 regardless of the room —
 * looking for modes in it finds the source, not the geometry.
 */
function transferFunction(
  trace: number[],
  dt: number,
  dx: number,
  fLoHz: number,
  fHiHz: number,
  stepHz: number,
): { f: number; h: number; sourceMag: number }[] {
  const reliableFmax = SPEED_OF_SOUND / (POINTS_PER_WAVELENGTH * dx);
  const ex = makeRickerSource(dt, reliableFmax);
  const src: number[] = [];
  for (let i = 0; i < ex.durationSteps; i++) src.push(ex.at(i));

  const out: { f: number; h: number; sourceMag: number }[] = [];
  for (let f = fLoHz; f <= fHiHz + 1e-9; f += stepHz) {
    const sourceMag = dftMagnitude(src, dt, f);
    out.push({ f, h: dftMagnitude(trace, dt, f) / sourceMag, sourceMag });
  }
  return out;
}

/** Local maxima of a transfer function, restricted to well-excited bins. */
function spectralPeaks(tf: { f: number; h: number; sourceMag: number }[]): number[] {
  const maxSource = Math.max(...tf.map((b) => b.sourceMag));
  // Below ~5% of the source's peak magnitude the division amplifies noise
  // rather than revealing the room.
  const usable = tf.filter((b) => b.sourceMag >= 0.05 * maxSource);
  const peaks: number[] = [];
  for (let i = 1; i < usable.length - 1; i++) {
    if (usable[i].h > usable[i - 1].h && usable[i].h >= usable[i + 1].h) {
      peaks.push(usable[i].f);
    }
  }
  return peaks;
}

/** Analytical axial mode frequency for a rectangular room: f = c*n / (2*L). */
function axialMode(n: number, lengthM: number): number {
  return (SPEED_OF_SOUND * n) / (2 * lengthM);
}

console.log("\n=== Solver numerical tests ===\n");



// ---------------------------------------------------------------------------
// TEST A — BASIC SOLVER EXECUTION
// ---------------------------------------------------------------------------

check("Test A: solver executes and produces a finite, non-empty trace", () => {
  const r = quiet(() => runIR({
    L: 4, W: 3, H: 2.5,
    wallMaterial: "drywall",
    floorMaterial: "wood_floor",
    ceilMaterial: "drywall",
    source: { x: 0.5, y: 0.5, z: 0.5 },
    receiver: { x: 0.25, y: 0.5, z: 0.5 },
  }));
  assert(r.success === true, "solver did not report success");
  assertFiniteArray(r.receiverTrace, "receiverTrace");
  assert(r.steps > 0, `steps should be > 0, got ${r.steps}`);
  assert(r.receiverTrace.length === r.steps, `trace length ${r.receiverTrace.length} != steps ${r.steps}`);
  assert(Number.isFinite(r.dtEstimate) && r.dtEstimate > 0, `dt is not a positive finite number: ${r.dtEstimate}`);
  assert(energy(r.receiverTrace) > 0, "trace carries no energy — the source never reached the receiver");
});

// ---------------------------------------------------------------------------
// TEST B — SOURCE -> RECEIVER PROPAGATION
// ---------------------------------------------------------------------------

check("Test B: first arrival matches the geometric propagation delay", () => {
  // Source and receiver on the same axis, at the same height and depth, so
  // the straight-line distance is unambiguous.
  const L = 10, W = 5, H = 3;
  const srcXn = 0.1, recXn = 0.9;
  const r = quiet(() => runIR({
    L, W, H,
    wallMaterial: "drywall", floorMaterial: "drywall", ceilMaterial: "drywall",
    // Moderately absorptive so the direct sound is not buried under a
    // reverberant build-up before the onset search runs.
    wallAbsorption: 0.3, floorAbsorption: 0.3, ceilAbsorption: 0.3,
    source: { x: srcXn, y: 0.5, z: H / 2 },
    receiver: { x: recXn, y: 0.5, z: H / 2 },
  }));

  const trace: number[] = r.receiverTrace;
  const dt: number = r.dtEstimate;
  const peak = Math.max(...trace.map(Math.abs));
  assert(peak > 0, "receiver never registered any pressure");

  let onsetStep = -1;
  for (let i = 0; i < trace.length; i++) {
    if (Math.abs(trace[i]) > 0.05 * peak) { onsetStep = i; break; }
  }
  assert(onsetStep > 0, "no onset found — the receiver shows no arrival at all");

  const distanceM = (recXn - srcXn) * L;
  const expectedSec = distanceM / SPEED_OF_SOUND;
  const observedSec = onsetStep * dt;

  // Bounded BELOW by causality (nothing may arrive before the direct path)
  // and ABOVE by the wavelet's rise time plus grid dispersion. Still not a
  // vacuous window: a Courant/dt mismatch moves this by ~3.16x and fails.
  assert(
    observedSec >= expectedSec * 0.75,
    `arrival at ${(observedSec * 1000).toFixed(1)} ms precedes the direct path (${(expectedSec * 1000).toFixed(1)} ms)`,
  );
  assert(
    observedSec <= expectedSec * 1.6,
    `arrival at ${(observedSec * 1000).toFixed(1)} ms is far later than the direct path (${(expectedSec * 1000).toFixed(1)} ms)`,
  );
});

// ---------------------------------------------------------------------------
// TEST C — ABSORPTION BEHAVIOUR  (the primary physics regression)
// ---------------------------------------------------------------------------
//
// Four otherwise-IDENTICAL simulations at alpha = 0.0, 0.1, 0.2, 0.4.
// Identical means identical: same room, same source and receiver, and the
// same pinned duration — which pins dx, dt and the step count too. Without
// pinning the duration, alpha feeds the Sabine estimate that sizes the run,
// so "more absorption" would also mean a different grid and a different time
// axis, and any difference measured afterwards could not be attributed to
// absorption.
//
// Everything below is measured from the numerical field. The analytical
// Sabine figure (r.rt60) is never consulted.
// ---------------------------------------------------------------------------

const ABSORPTION_SWEEP = [0.0, 0.1, 0.2, 0.4];

const sweepResults = ABSORPTION_SWEEP.map((alpha) => {
  const r = quiet(() => runIR({
    L: 5, W: 4, H: 3,
    wallMaterial: "drywall", floorMaterial: "drywall", ceilMaterial: "drywall",
    wallAbsorption: alpha, floorAbsorption: alpha, ceilAbsorption: alpha,
    durationSec: 0.5,
    source: { x: 0.3, y: 0.3, z: 1.2 },
    receiver: { x: 0.7, y: 0.6, z: 1.5 },
  }));
  const trace: number[] = r.receiverTrace;
  const half = Math.floor(trace.length / 2);
  return {
    alpha,
    r,
    trace,
    dt: r.dtEstimate as number,
    total: energy(trace),
    early: energy(trace, 0, half),
    late: energy(trace, half),
    slope: decaySlopeDbPerSec(trace, r.dtEstimate).slope,
    simulatedRt60: r.simulatedRt60 as number | null,
  };
});

check("Test C0: the absorption sweep ran on one identical grid and time axis", () => {
  const first = sweepResults[0];
  for (const s of sweepResults) {
    assertFiniteArray(s.trace, `trace at alpha=${s.alpha}`);
    assert(s.r.cellSizeM === first.r.cellSizeM, `alpha=${s.alpha} used dx=${s.r.cellSizeM}, expected ${first.r.cellSizeM}`);
    assert(s.r.steps === first.r.steps, `alpha=${s.alpha} ran ${s.r.steps} steps, expected ${first.r.steps}`);
    assert(s.dt === first.dt, `alpha=${s.alpha} used dt=${s.dt}, expected ${first.dt}`);
  }
});

check("Test C1: the boundary condition still reaches the field at all", () => {
  // The regression this file exists for: if the boundary update stops
  // affecting the simulation, every alpha produces the same numbers.
  const totals = sweepResults.map((s) => s.total);
  const distinct = new Set(totals.map((t) => t.toExponential(6)));
  assert(
    distinct.size === totals.length,
    `different absorption values produced identical traces — the boundary condition is not affecting the field (${totals.join(", ")})`,
  );
});

check("Test C2: late-field energy falls monotonically as absorption rises", () => {
  // Late-field energy is the reverberant tail — the part absorption acts on.
  // Measured relative to the early field, so a pure level change cannot pass.
  const ratios = sweepResults.map((s) => s.late / s.early);
  for (let i = 1; i < ratios.length; i++) {
    assert(
      ratios[i] < ratios[i - 1],
      `late/early energy ratio did not fall from alpha=${sweepResults[i - 1].alpha} ` +
      `(${ratios[i - 1].toExponential(3)}) to alpha=${sweepResults[i].alpha} (${ratios[i].toExponential(3)})`,
    );
  }
});

check("Test C3: the numerical decay slope steepens monotonically with absorption", () => {
  const slopes = sweepResults.map((s) => s.slope);
  for (const s of sweepResults) {
    assert(s.slope !== null, `no fittable decay curve at alpha=${s.alpha}`);
    assert(Number.isFinite(s.slope as number), `decay slope at alpha=${s.alpha} is not finite`);
  }
  // A lossless room must not show meaningful decay; anything else means
  // energy is leaving somewhere it should not. This is checked with its own
  // generous bound (below), not by comparing it against the absorbing
  // cases: the lossless curve barely decays at all inside the analysis
  // window (it reaches only about -11 dB by the end of the 0.5s run, never
  // approaching the -35 dB floor of the fitting window used for every other
  // case), so its linear fit is drawn from a much smaller, tail-only sample
  // of the curve (a few hundred points vs 1000+ for the absorbing cases)
  // dominated by the concave bend where the already-shallow curve happens
  // to steepen slightly - not a real decay rate, and not comparable to a
  // properly-windowed fit. Requiring the lossless slope to be shallower
  // than the least-absorbing real case compares two different measurements
  // of two different things.
  const lossless = sweepResults[0];
  assert(
    (lossless.slope as number) > -150,
    `alpha=0 shows a decay of ${(lossless.slope as number).toFixed(1)} dB/s, but a rigid-walled room is lossless`,
  );
  for (let i = 2; i < slopes.length; i++) {
    assert(
      (slopes[i] as number) < (slopes[i - 1] as number),
      `decay did not steepen from alpha=${sweepResults[i - 1].alpha} ` +
      `(${(slopes[i - 1] as number).toFixed(1)} dB/s) to alpha=${sweepResults[i].alpha} (${(slopes[i] as number).toFixed(1)} dB/s)`,
    );
  }
});

check("Test C4: numerical RT60 shortens monotonically with absorption", () => {
  // simulatedRt60 comes from Schroeder backward integration of the FDTD
  // trace. It is NOT the Sabine estimate — r.rt60 is Sabine, and is
  // deliberately not consulted here.
  const absorbing = sweepResults.filter((s) => s.alpha > 0);
  for (const s of absorbing) {
    assert(
      typeof s.simulatedRt60 === "number" && Number.isFinite(s.simulatedRt60) && (s.simulatedRt60 as number) > 0,
      `alpha=${s.alpha} produced no usable numerical RT60 (got ${s.simulatedRt60})`,
    );
  }
  for (let i = 1; i < absorbing.length; i++) {
    assert(
      (absorbing[i].simulatedRt60 as number) < (absorbing[i - 1].simulatedRt60 as number),
      `numerical RT60 did not shorten from alpha=${absorbing[i - 1].alpha} ` +
      `(${absorbing[i - 1].simulatedRt60}s) to alpha=${absorbing[i].alpha} (${absorbing[i].simulatedRt60}s)`,
    );
  }
  // A rigid-walled room has no decay to fit, and the analysis must say so
  // rather than inventing a number.
  assert(
    sweepResults[0].simulatedRt60 === null,
    `alpha=0 returned an RT60 of ${sweepResults[0].simulatedRt60}s; a lossless room has no decay to measure`,
  );
});

check("Test C5: total received energy falls monotonically with absorption", () => {
  for (let i = 1; i < sweepResults.length; i++) {
    assert(
      sweepResults[i].total < sweepResults[i - 1].total,
      `total energy did not fall from alpha=${sweepResults[i - 1].alpha} ` +
      `(${sweepResults[i - 1].total.toExponential(3)}) to alpha=${sweepResults[i].alpha} (${sweepResults[i].total.toExponential(3)})`,
    );
  }
});

// ---------------------------------------------------------------------------
// TEST C6/C7 — REGIME REPORTING AND THE ANALYTICAL COMPARISON
// ---------------------------------------------------------------------------

/** Independent analytical references, written here rather than imported, so a
 *  bug shared between the implementation and the test cannot hide. */
const roomVolume = (L: number, W: number, H: number) => L * W * H;
const roomSurface = (L: number, W: number, H: number) => 2 * (L * W) + 2 * (L * H) + 2 * (W * H);
const sabineRt60 = (L: number, W: number, H: number, a: number) =>
  (0.161 * roomVolume(L, W, H)) / (roomSurface(L, W, H) * a);
const eyringRt60 = (L: number, W: number, H: number, a: number) =>
  (0.161 * roomVolume(L, W, H)) / (-roomSurface(L, W, H) * Math.log(1 - a));

check("Test C6: the run reports which regime its RT60 came from", () => {
  // simulatedRt60 depends on the excitation band, which depends on dx, which
  // is solved from the requested duration. A bare number would hide that.
  const L = 5, W = 4, H = 3;
  const run = (durationSec: number) => quiet(() => runIR({
    L, W, H,
    wallMaterial: "drywall", floorMaterial: "drywall", ceilMaterial: "drywall",
    wallAbsorption: 0.2, floorAbsorption: 0.2, ceilAbsorption: 0.2,
    durationSec,
    source: { x: 0.3, y: 0.3, z: 1.2 },
    receiver: { x: 0.7, y: 0.6, z: 1.5 },
  }));

  const fine = run(0.4);
  const coarse = run(3.0);

  for (const r of [fine, coarse]) {
    const v = r.decay.validity;
    assert(v != null, "the decay report carries no validity block");
    assert(Number.isFinite(v.excitationCentreHz) && v.excitationCentreHz > 0, `bad excitationCentreHz: ${v.excitationCentreHz}`);
    assert(Number.isFinite(v.schroederFrequencyHz) && v.schroederFrequencyHz > 0, `bad schroederFrequencyHz: ${v.schroederFrequencyHz}`);
    assert(typeof v.diffuseFieldValid === "boolean", "diffuseFieldValid is not a boolean");
    assert(typeof v.note === "string" && v.note.length > 0, "validity note is empty");
  }

  // The regime genuinely differs between the two runs, which is the whole
  // point of reporting it.
  assert(
    fine.decay.validity.excitationCentreHz > coarse.decay.validity.excitationCentreHz,
    "a shorter run did not get a higher excitation band, so the coupling this block documents is gone",
  );
  assert(
    fine.decay.validity.diffuseFieldValid === true,
    `the fine run should sit above the Schroeder frequency (f0=${fine.decay.validity.excitationCentreHz}, fs=${fine.decay.validity.schroederFrequencyHz})`,
  );
  assert(
    coarse.decay.validity.diffuseFieldValid === false,
    "the coarse run should be flagged as below the Schroeder frequency",
  );
  assert(
    /BELOW/.test(coarse.decay.validity.note),
    "a below-Schroeder run is not warned about in its note",
  );
});

check("Test C7: numerical RT60 is physically plausible against Eyring, and not forced to match it", () => {
  const L = 5, W = 4, H = 3, alpha = 0.2;
  const r = quiet(() => runIR({
    L, W, H,
    wallMaterial: "drywall", floorMaterial: "drywall", ceilMaterial: "drywall",
    wallAbsorption: alpha, floorAbsorption: alpha, ceilAbsorption: alpha,
    durationSec: 0.4, // the regime where a diffuse-field comparison is meaningful
    source: { x: 0.3, y: 0.3, z: 1.2 },
    receiver: { x: 0.7, y: 0.6, z: 1.5 },
  }));

  const numerical = r.simulatedRt60 as number;
  const eyring = eyringRt60(L, W, H, alpha);
  const sabine = sabineRt60(L, W, H, alpha);

  assert(typeof numerical === "number" && numerical > 0, `no numerical RT60: ${numerical}`);
  assert(r.decay.validity.diffuseFieldValid === true, "this case is meant to sit in the diffuse regime");

  // A PLAUSIBILITY band, deliberately wide. It catches an inverted sign, a
  // dead boundary, or an order-of-magnitude error. It is NOT a tuned
  // agreement target, and nothing anywhere scales the numerical result
  // toward the analytical one.
  const ratio = numerical / eyring;
  assert(
    ratio > 0.4 && ratio < 2.0,
    `numerical RT60 ${numerical.toFixed(3)}s is implausible against Eyring ${eyring.toFixed(3)}s (ratio ${ratio.toFixed(2)})`,
  );

  // The two must remain independently computed. If a correction factor were
  // ever introduced they would collapse onto each other.
  assert(
    Math.abs(numerical - eyring) > 1e-9,
    "numerical RT60 exactly equals the Eyring estimate — it is being overwritten by the analytical value",
  );
  assert(
    Math.abs(numerical - sabine) > 1e-9,
    "numerical RT60 exactly equals the Sabine estimate — it is being overwritten by the analytical value",
  );
  // And the solver's own reported Sabine figure must still be the analytical
  // one, not a copy of the measurement.
  assert(
    Math.abs((r.rt60 as number) - sabine) / sabine < 0.02,
    `the reported analytical RT60 ${r.rt60} does not match an independently computed Sabine ${sabine.toFixed(3)}`,
  );
});

check("Test C8 (regression): alpha=0.1 does not reproduce the v29 6s/r2=0.73 fit failure", () => {
  // v29 reported RT60 ~= 6.09s against Eyring 0.975s at r2 = 0.726 for a
  // 5x4x3m room at alpha=0.1, sized to a ~1.95s run (dx ~= 0.353m,
  // f0 ~= 54 Hz). Root cause: the OLD peak-walking RT60 estimator, not the
  // boundary condition or the excitation. Schroeder backward integration
  // (src/lib/decay.ts) fixed the estimator; this test locks that in for the
  // exact regime that broke, so a regression to peak-walking (or any other
  // estimator that mishandles a deep sub-Schroeder double-slope decay) fails
  // loudly instead of silently reappearing.
  const L = 5, W = 4, H = 3, alpha = 0.1;
  const r = quiet(() => runIR({
    L, W, H,
    wallAbsorption: alpha, floorAbsorption: alpha, ceilAbsorption: alpha,
    durationSec: 1.95, // matches the v29-reported sizing that produced the outlier
    source: { x: 0.5, y: 0.5, z: 2.1 },
    receiver: { x: 0.25, y: 0.5, z: 1.5 },
  }));

  const eyring = eyringRt60(L, W, H, alpha);
  const numerical = r.simulatedRt60 as number | null;
  const fitR2 = r.decay.preferred?.r2 ?? null;

  assert(typeof numerical === "number" && Number.isFinite(numerical), `no usable numerical RT60 at alpha=0.1 (got ${numerical})`);
  assert(typeof fitR2 === "number", `no fit quality reported at alpha=0.1 (got ${fitR2})`);
  assert((fitR2 as number) > 0.85, `fit quality regressed at alpha=0.1: r2=${fitR2}, expected > 0.85 (v29 outlier had r2=0.726)`);

  // Deliberately wide plausibility band, same spirit as Test C7 — this is
  // NOT tuning the numerical result toward Eyring, it is catching a return
  // of the ~6x blowout (ratio 6.25 in the v29 outlier).
  const ratio = (numerical as number) / eyring;
  assert(
    ratio > 0.3 && ratio < 2.0,
    `numerical RT60 ${numerical}s is implausible against Eyring ${eyring.toFixed(3)}s at alpha=0.1 (ratio ${ratio.toFixed(2)}) — this is the shape of the v29 regression`,
  );
  assert(
    (numerical as number) < 2.0,
    `numerical RT60 at alpha=0.1 is ${numerical}s, close to the v29 outlier magnitude (6.09s) — investigate before shipping`,
  );
});

// ---------------------------------------------------------------------------
// TEST D — MODAL VALIDATION
// ---------------------------------------------------------------------------

check("Test D: simulated spectrum reproduces the analytical axial modes", () => {
  // Dimensions chosen so the three axial series do not coincide and each
  // mode can be identified separately.
  const L = 6.0, W = 4.1, H = 3.2;
  // durationSec drives runIR's dx sizing (dx grows with requested duration
  // under the fixed step budget). At 1.5s, dx ~= 0.54m, whose own
  // reliably-resolvable bandwidth (c / (9*dx) ~= 70 Hz, the same formula
  // this test's transferFunction() uses to build its excitation) sits BELOW
  // the 114.3 Hz (4,0,0) mode this test checks for - the grid can never
  // resolve that mode at that duration, regardless of solver correctness.
  // 0.8s gives dx ~= 0.29m (reliable to ~132 Hz), comfortably above all
  // four checked modes, while still long enough for a near-rigid room to
  // ring out multiple periods at the lowest (28.6 Hz) mode.
  const r = quiet(() => runIR({
    L, W, H,
    wallMaterial: "drywall", floorMaterial: "drywall", ceilMaterial: "drywall",
    // Nearly rigid: modes need to ring long enough to be resolved.
    wallAbsorption: 0.03, floorAbsorption: 0.03, ceilAbsorption: 0.03,
    durationSec: 0.8,
    // Corner source and corner receiver: every axial mode has an antinode at
    // a corner, so none is accidentally sampled at a null.
    source: { x: 0.02, y: 0.02, z: 0.05 },
    receiver: { x: 0.98, y: 0.98, z: H - 0.1 },
  }));

  const dt: number = r.dtEstimate;
  const dx: number = r.cellSizeM;
  const tf = transferFunction(r.receiverTrace, dt, dx, 20, 160, 0.25);
  const peaks = spectralPeaks(tf);
  assert(peaks.length >= 4, `only ${peaks.length} spectral peaks found; expected the room's modal structure`);

  const expected: { label: string; f: number }[] = [
    { label: "(1,0,0) length", f: axialMode(1, L) },
    { label: "(0,1,0) width", f: axialMode(1, W) },
    { label: "(0,0,1) height", f: axialMode(1, H) },
    { label: "(4,0,0) length", f: axialMode(4, L) },
  ];

  // 12% accommodates this grid's numerical dispersion: the modal room runs
  // at dx ~ 0.27 m, i.e. only ~22 cells across the long dimension, and a
  // second-order scheme depresses modal frequencies at that resolution.
  const TOLERANCE = 0.12;
  const errors: number[] = [];
  for (const mode of expected) {
    const nearest = peaks.reduce((best, f) => (Math.abs(f - mode.f) < Math.abs(best - mode.f) ? f : best), peaks[0]);
    const relErr = Math.abs(nearest - mode.f) / mode.f;
    errors.push(relErr);
    assert(
      relErr <= TOLERANCE,
      `${mode.label}: expected ~${mode.f.toFixed(1)} Hz, nearest simulated peak ${nearest.toFixed(1)} Hz ` +
      `(${(relErr * 100).toFixed(1)}% off, tolerance ${(TOLERANCE * 100).toFixed(0)}%)`,
    );
  }

  // Matching individually inside 12% could in principle happen by accident
  // in a peak-dense spectrum, so require the set to agree well on average.
  const meanErr = errors.reduce((a, b) => a + b, 0) / errors.length;
  assert(meanErr <= 0.08, `mean modal error ${(meanErr * 100).toFixed(1)}% exceeds 8%`);
});

// ---------------------------------------------------------------------------
// TEST E — GRID CONVERGENCE
// ---------------------------------------------------------------------------

check("Test E: refining the grid moves the first axial mode toward the analytical value", () => {
  const L = 6.0, W = 4.1, H = 3.2;
  const analytic = axialMode(1, L);

  // Original steps:6000 exceeded the public MAX_STEPS cap of 3000
  // (src/lib/publicLimits.ts), so the call threw before running at all.
  // Also, at steps:3000, fmax:160/'balanced' as the "fine" grid gives only
  // ~0.66s of ring-down - too short a window for a clean, low-noise peak at
  // this mode's ~35ms period at this absorption. fmax:100/'balanced' keeps
  // steps within the cap while giving ~1.05s of ring-down and resolves the
  // mode to <1% error; fmax:60/'fast' remains a genuinely coarser reference
  // (~32% error) so the comparison still demonstrates real convergence.
  const run = (fmax: number, accuracyMode: string) => quiet(() => runWave({
    L, W, H,
    wallMaterial: "drywall", floorMaterial: "drywall", ceilMaterial: "drywall",
    wallAbsorption: 0.03, floorAbsorption: 0.03, ceilAbsorption: 0.03,
    fmax, accuracyMode, steps: 3000,
    source: { x: 0.02, y: 0.02, z: 0.05 },
    receiver: { x: 0.98, y: 0.98, z: H - 0.1 },
  }));

  const dominantMode = (r: any): number => {
    const tf = transferFunction(r.receiverTrace, r.dtEstimate, r.cellSizeM, 15, 45, 0.1);
    const peaks = spectralPeaks(tf);
    if (!peaks.length) return NaN;
    return peaks.reduce((best, f) => Math.abs(f - analytic) < Math.abs(best - analytic) ? f : best, peaks[0]);
  };

  const coarse = run(60, "fast");
  const fine = run(100, "balanced");

  assert(coarse.cellSizeM > fine.cellSizeM, `coarse dx (${coarse.cellSizeM}) is not larger than fine dx (${fine.cellSizeM})`);
  assert(coarse.meshSize < fine.meshSize, `coarse mesh (${coarse.meshSize}) is not smaller than fine mesh (${fine.meshSize})`);
  assertFiniteArray(coarse.receiverTrace, "coarse trace");
  assertFiniteArray(fine.receiverTrace, "fine trace");

  const coarseErr = Math.abs(dominantMode(coarse) - analytic) / analytic;
  const fineErr = Math.abs(dominantMode(fine) - analytic) / analytic;

  assert(
    fineErr < coarseErr,
    `refining the grid did not improve the first axial mode: coarse error ${(coarseErr * 100).toFixed(1)}%, ` +
    `fine error ${(fineErr * 100).toFixed(1)}%`,
  );
  // An absolute bound too, so "improved" cannot mean "went from absurd to
  // merely wrong".
  assert(
    fineErr <= 0.10,
    `fine grid first axial mode is ${(fineErr * 100).toFixed(1)}% from the analytical ${analytic.toFixed(1)} Hz (tolerance 10%)`,
  );
  // And the coarse grid must genuinely be worse, or the comparison proves
  // nothing about convergence.
  assert(
    coarseErr >= 0.10,
    `coarse grid error ${(coarseErr * 100).toFixed(1)}% is already inside the fine tolerance — ` +
    `the two runs are not far enough apart to test convergence`,
  );
});

// ---------------------------------------------------------------------------
// TEST F — CFL STABILITY PROTECTION
// ---------------------------------------------------------------------------

check("Test F1: a stable configuration is accepted and reported as stable", () => {
  const r = quiet(() => runIR({
    L: 5, W: 5, H: 5,
    wallMaterial: "drywall", floorMaterial: "wood_floor", ceilMaterial: "drywall",
    // A source is required (the solver no longer invents one). Same position the old implicit default used: (0.5, 0.5, 0.7*H).
    source: { x: 0.5, y: 0.5, z: 3.5 },
    receiver: { x: 0.5, y: 0.5, z: 0.5 },
  }));
  assert(r.config.time.cflStable === true, "solver reports its own configuration as CFL-unstable");
  assert(
    r.config.time.courantSquared <= r.config.time.cflLimitSquared,
    `Courant^2 ${r.config.time.courantSquared} exceeds the limit ${r.config.time.cflLimitSquared}`,
  );
  assert(r.config.time.cflLimitSquared === CFL_LIMIT_SQUARED, "reported CFL limit disagrees with the solver constant");
});

check("Test F2: an unstable Courant number is refused, not run", () => {
  // The guard is exercised directly because the solvers are hardcoded to a
  // stable constant. This is what makes an edit to that constant fail loudly
  // instead of silently returning divergent numbers.
  assertCflStable(0.1);
  assertCflStable(CFL_LIMIT_SQUARED);
  for (const bad of [0.34, 0.5, 1.0, 3.0]) {
    let threw = false;
    try { assertCflStable(bad); } catch { threw = true; }
    assert(threw, `Courant^2 = ${bad} was accepted despite exceeding the CFL limit of ${CFL_LIMIT_SQUARED}`);
  }
});

check("Test F3: a non-finite or non-positive Courant number is refused", () => {
  for (const bad of [NaN, Infinity, -Infinity, 0, -0.1]) {
    let threw = false;
    try { assertCflStable(bad); } catch { threw = true; }
    assert(threw, `Courant^2 = ${bad} was accepted`);
  }
});

check("Test F4: a dt inconsistent with the Courant constant is refused", () => {
  const dx = 0.1;
  const courantSquared = 0.1;
  const goodDt = (dx * Math.sqrt(courantSquared)) / SPEED_OF_SOUND;
  assertTimeStepConsistent(goodDt, dx, courantSquared);
  // dt = dx/c implies Courant^2 = 1, the exact mislabelling that made every
  // reported "seconds" value wrong by ~3.16x.
  let threw = false;
  try { assertTimeStepConsistent(dx / SPEED_OF_SOUND, dx, courantSquared); } catch { threw = true; }
  assert(threw, "a dt implying Courant^2 = 1 was accepted against a loop running at 0.1");
});

// ---------------------------------------------------------------------------
// EXCITATION
// ---------------------------------------------------------------------------

check("the excitation is zero-mean, so it cannot excite the rigid-box DC mode", () => {
  // A single-sample impulse injects net volume into a closed box, which
  // drives the spatially-constant mode. That mode obeys p_next = 2p - p_prev
  // and therefore drifts linearly forever: it grew the total field energy
  // without bound at alpha=0 and flattened the receiver trace at every
  // alpha, which is why no room could produce a numerical RT60.
  const dt = 1e-4;
  const ex = makeRickerSource(dt, 200);
  let sum = 0;
  let firstMoment = 0;
  let peak = 0;
  for (let i = 0; i < ex.durationSteps; i++) {
    const v = ex.at(i);
    assert(Number.isFinite(v), `wavelet sample ${i} is not finite`);
    sum += v;
    firstMoment += v * i * dt;
    peak = Math.max(peak, Math.abs(v));
  }
  assert(peak > 0, "wavelet is identically zero");
  assert(ex.durationSteps > 1, "wavelet collapses to a single sample");
  // Normalised against the total injected magnitude: what matters is that
  // the NET injected volume is negligible next to how much was injected.
  let absSum = 0;
  for (let i = 0; i < ex.durationSteps; i++) absSum += Math.abs(ex.at(i));
  assert(Math.abs(sum) < 0.01 * absSum, `wavelet has a DC component: sum=${sum}, sum|v|=${absSum}`);
  assert(Math.abs(firstMoment) < 0.01 * absSum * ex.t0, `wavelet has a non-zero first moment: ${firstMoment}`);
});

check("a rigid-walled room conserves energy instead of growing without bound", () => {
  // Direct regression on the DC-drift bug: with alpha = 0 nothing removes
  // energy, so the late field must be comparable to the early field —
  // neither decaying nor, as it previously did, growing.
  const s = sweepResults[0];
  const ratio = s.late / s.early;
  assert(ratio > 0.05, `lossless room lost most of its energy (late/early = ${ratio.toExponential(3)})`);
  assert(ratio < 20, `lossless room GAINED energy (late/early = ${ratio.toExponential(3)}) — the scheme is injecting energy`);
});

// ---------------------------------------------------------------------------
// ABSORPTION RESOLUTION
// ---------------------------------------------------------------------------

check("explicit wall absorption override reaches per-wall broadband and frequency-dependent boundaries", () => {
  const poly = [{x:.1,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.1,y:.9}];
  // steps must be large enough for a reflection off the overridden wall
  // segment (at x=.1) to reach the receiver (at x=.8) before the trace ends,
  // or the two runs are numerically identical simply because neither trace
  // has heard the wall yet - not because the override has no effect.
  const base:any = {L:4,W:4,H:3,steps:80,fmax:500,accuracyMode:'fast',poly,wallMaterial:'drywall', floorMaterial:'wood_floor', ceilMaterial:'drywall_ceil',wallSegMats:['concrete',null,null,null],wallOpenings:[null,null,null,null],source:{x:.2,y:.5,z:1.5},receivers:[{x:.8,y:.5,z:1.5}]};
  const material = quiet(() => runWave({...base}));
  const override = quiet(() => runWave({...base,wallAbsorption:0.95}));
  let different = false;
  for (let i=0;i<material.receiverTrace.length;i++) if (Math.abs(material.receiverTrace[i]-override.receiverTrace[i]) > 1e-8) { different=true; break; }
  assert(different, 'explicit wall absorption override did not change broadband boundary behavior');
  const analyticalMaterial = quiet(() => runWave({...base,steps:8,wallAbsorption:0.05}));
  const analyticalHigh = quiet(() => runWave({...base,steps:8,wallAbsorption:0.95}));
  assert(analyticalMaterial.rt60 > analyticalHigh.rt60, 'explicit wall absorption override did not affect analytical RT60');
});

check("explicit absorption overrides are honoured", () => {
  const a = resolveSurfaceAbsorption({
    wallMaterial: "drywall", floorMaterial: "drywall", ceilMaterial: "drywall",
    wallAbsorption: 0.42, floorAbsorption: 0, ceilAbsorption: 1,
  });
  assert(a.wallAbs === 0.42, `wall override ignored: ${a.wallAbs}`);
  assert(a.floorAbs === 0, `floor override of 0 ignored: ${a.floorAbs}`);
  assert(a.ceilAbs === 1, `ceiling override of 1 ignored: ${a.ceilAbs}`);
});

check("a malformed absorption override falls back to the material table", () => {
  const fromTable = resolveSurfaceAbsorption({ wallMaterial: "drywall", floorMaterial: "drywall", ceilMaterial: "drywall" });
  for (const bad of [NaN, Infinity, -0.1, 1.5, "loud", {}]) {
    const a = resolveSurfaceAbsorption({
      wallMaterial: "drywall", floorMaterial: "drywall", ceilMaterial: "drywall",
      wallAbsorption: bad,
    });
    assert(
      a.wallAbs === fromTable.wallAbs,
      `override ${JSON.stringify(bad)} produced ${a.wallAbs} instead of falling back to ${fromTable.wallAbs}`,
    );
  }
});

// ---------------------------------------------------------------------------
// ROOM GEOMETRY / BOUNDARY MODEL
// ---------------------------------------------------------------------------

check("custom polygon footprint is enforced by the numerical wave solver", () => {
  const poly = [
    {x:.1,y:.1},{x:.6,y:.1},{x:.6,y:.45},{x:.9,y:.45},
    {x:.9,y:.9},{x:.1,y:.9},
  ];
  const result = quiet(() => runWave({
    L:4,W:4,H:3,steps:20,fmax:250,accuracyMode:'fast',
    poly, wallMaterial:'drywall', floorMaterial:'wood_floor', ceilMaterial:'drywall_ceil', wallSegMats:new Array(poly.length).fill(null),
    wallOpenings:new Array(poly.length).fill(null),
    source:{x:.35,y:.25,z:1.5}, receivers:[{x:.35,y:.25,z:1.5}],
  }));
  assert(result && Array.isArray(result.receiverTrace) && result.receiverTrace.length === 20, 'custom-footprint wave run did not produce a receiver trace');
  assertFiniteArray(result.receiverTrace, 'custom-footprint receiver trace');
});

check("wave solver rejects a source in the cut-out of a custom polygon", () => {
  const poly = [{x:.1,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.6,y:.9},{x:.6,y:.5},{x:.4,y:.5},{x:.4,y:.9},{x:.1,y:.9}];
  let failed = false;
  try { quiet(() => runWave({L:4,W:4,H:3,steps:5,fmax:200,accuracyMode:'fast',poly,wallMaterial:'drywall',floorMaterial:'wood_floor',ceilMaterial:'drywall_ceil',source:{x:.5,y:.7,z:1.5},receivers:[{x:.2,y:.2,z:1.5}]})); }
  catch (e:any) { failed = /outside the room footprint/i.test(String(e?.message)); }
  assert(failed, 'source inside the polygon cut-out was accepted');
});

check("full wall openings are modeled as energy loss, not removed reflective walls", () => {
  const poly = [{x:.1,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.1,y:.9}];
  // steps:8 was too short for the direct sound (let alone a wall reflection)
  // to reach the receiver at all - both traces were still all-zero, which
  // trivially "matched" regardless of whether openings were wired up.
  const base:any = {L:4,W:4,H:3,steps:80,fmax:300,accuracyMode:'fast',poly,wallMaterial:'drywall', floorMaterial:'wood_floor', ceilMaterial:'drywall_ceil',wallSegMats:[null,null,null,null],wallOpenings:[null,null,null,null],source:{x:.2,y:.5,z:1.5},receivers:[{x:.8,y:.5,z:1.5}]};
  const closed = quiet(() => runWave({...base}));
  const open = quiet(() => runWave({...base,wallOpenings:['full',null,null,null]}));
  assert(open.rt60 < closed.rt60, `opening did not increase analytical energy loss: closed=${closed.rt60}, open=${open.rt60}`);
  let different = false;
  for (let i=0;i<closed.receiverTrace.length;i++) if (Math.abs(closed.receiverTrace[i]-open.receiverTrace[i]) > 1e-8) { different=true; break; }
  assert(different, 'opening did not change the numerical wave trace');
});

check("per-wall material overrides reach the broadband boundary model", () => {
  const poly = [{x:.1,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.1,y:.9}];
  const base:any = {L:4,W:4,H:3,steps:80,fmax:300,accuracyMode:'fast',poly,wallMaterial:'drywall', floorMaterial:'wood_floor', ceilMaterial:'drywall_ceil',wallOpenings:[null,null,null,null],source:{x:.2,y:.5,z:1.5},receivers:[{x:.8,y:.5,z:1.5}]};
  const uniform = quiet(() => runWave({...base,wallSegMats:[null,null,null,null]}));
  const mixed = quiet(() => runWave({...base,wallSegMats:['concrete',null,null,null]}));
  let different = false;
  for(let i=0;i<uniform.receiverTrace.length;i++) if(Math.abs(uniform.receiverTrace[i]-mixed.receiverTrace[i]) > 1e-8){different=true;break;}
  assert(different, 'changing a wall segment material did not change the simulated trace');
});

// ---------------------------------------------------------------------------
// RESOURCE PROTECTION
// ---------------------------------------------------------------------------

check("an over-budget request is refused until the caller accepts reduced resolution", () => {
  const base = {
    L: 12, W: 10, H: 4,
    wallMaterial: "drywall", floorMaterial: "wood_floor", ceilMaterial: "drywall",
    fmax: 20000, accuracyMode: "high", steps: 1,
    source: { x: 0.5, y: 0.5, z: 2 }, receiver: { x: 0.25, y: 0.5, z: 2 },
  };
  let payload: any = null;
  try {
    quiet(() => runWave({ ...base }));
  } catch (err: any) {
    try { payload = JSON.parse(err.message); } catch { payload = null; }
  }
  assert(payload && payload.requiresConfirmation === true, "an over-budget request was not refused for confirmation");
  assert(
    String(payload.message).includes("50,000,000"),
    `the limit was not reported as 50,000,000: ${payload.message}`,
  );
});


check("frequency-dependent directivity does not reuse unrelated frequency data", () => {
  const base:any = {
    L:4,W:4,H:3,steps:18,fmax:1000,accuracyMode:'fast',
    poly:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],
    wallMaterial:'drywall', floorMaterial:'wood_floor', ceilMaterial:'drywall',
    source:{x:.2,y:.5,z:1.5,isDirectional:true,yawDeg:0,pitchDeg:0,rollDeg:0,directivityData:{frequencies:[1000],angularResolution:90,points:{'0,0':[0],'180,0':[-24]}}},
    receivers:[{x:.8,y:.5,z:1.5}]
  };
  const result = quiet(() => runWave(base));
  assert(result.speaker.status === 'MODELED_REPRESENTATIVE', `unexpected directivity status: ${result.speaker.status}`);
  assert(result.speaker.directivityCoveredBands === 1, `expected exactly one covered band, got ${result.speaker.directivityCoveredBands}`);
});

check("seven-band boundary mode is reported and remains finite", () => {
  const result = quiet(() => runWave({
    L:3,W:3,H:2.5,steps:12,fmax:1000,accuracyMode:'fast',frequencyDependentBoundaries:true,
    wallMaterial:'drywall',floorMaterial:'wood_floor',ceilMaterial:'stonewool',
    source:{x:.2,y:.5,z:1.2},receivers:[{x:.8,y:.5,z:1.2}]
  }));
  assert(result.boundaryModel.type === 'seven-band-causal-relaxation', `expected boundaryModel.type 'seven-band-causal-relaxation', got '${result.boundaryModel.type}'`);
  assertFiniteArray(result.receiverTrace, 'frequency-dependent receiver trace');
});
check("a malformed memory ceiling cannot disable the memory guard", () => {
  assert(resolveMaxSolverMemoryBytes(undefined) === DEFAULT_MAX_SOLVER_MEMORY_BYTES, "unset value did not use the default");
  assert(resolveMaxSolverMemoryBytes("") === DEFAULT_MAX_SOLVER_MEMORY_BYTES, "empty value did not use the default");
  assert(resolveMaxSolverMemoryBytes("   ") === DEFAULT_MAX_SOLVER_MEMORY_BYTES, "blank value did not use the default");
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const bad of ["abc", "NaN", "Infinity", "-1", "0", "1e", "null"]) {
      const v = resolveMaxSolverMemoryBytes(bad);
      assert(
        v === DEFAULT_MAX_SOLVER_MEMORY_BYTES,
        `MAX_SOLVER_MEMORY_BYTES=${JSON.stringify(bad)} resolved to ${v} instead of the safe default`,
      );
      assert(Number.isFinite(v) && v > 0, `resolved ceiling ${v} would disable the guard`);
    }
  } finally {
    console.warn = warn;
  }
  assert(resolveMaxSolverMemoryBytes("2000000000") === 2_000_000_000, "a valid ceiling was not honoured");
  assert(
    resolveMaxSolverMemoryBytes(String(HARD_MAX_SOLVER_MEMORY_BYTES)) === HARD_MAX_SOLVER_MEMORY_BYTES,
    "a value exactly at the hard ceiling was not honoured",
  );
  const warn2 = console.warn;
  console.warn = () => {};
  try {
    assert(
      resolveMaxSolverMemoryBytes(String(HARD_MAX_SOLVER_MEMORY_BYTES + 1)) === HARD_MAX_SOLVER_MEMORY_BYTES,
      "a value 1 byte above the hard ceiling was not clamped",
    );
    assert(
      resolveMaxSolverMemoryBytes("999999999999999") === HARD_MAX_SOLVER_MEMORY_BYTES,
      "a grossly oversized value was not clamped to the hard ceiling",
    );
  } finally {
    console.warn = warn2;
  }
});

check("the memory guard rejects an oversized run before allocating", () => {
  const prev = process.env.MAX_SOLVER_MEMORY_BYTES;
  process.env.MAX_SOLVER_MEMORY_BYTES = "50000001"; // 1 byte above the fixed overhead allowance
  try {
    let threw = false;
    try {
      quiet(() => runIR({
        L: 20, W: 15, H: 5,
        wallMaterial: "drywall", floorMaterial: "wood_floor", ceilMaterial: "drywall",
        receiver: { x: 0.5, y: 0.5, z: 0.5 },
      }));
    } catch (err: any) {
      threw = /memory/i.test(err.message);
    }
    assert(threw, "an oversized simulation was not refused by the memory guard");
  } finally {
    if (prev === undefined) delete process.env.MAX_SOLVER_MEMORY_BYTES;
    else process.env.MAX_SOLVER_MEMORY_BYTES = prev;
  }
});

check("invalid room geometry is refused", () => {
  const bad = [
    { L: 0, W: 4, H: 3 },
    { L: -5, W: 4, H: 3 },
    { L: NaN, W: 4, H: 3 },
    { L: 500, W: 4, H: 3 },
    { L: 5, W: 4, H: 100 },
  ];
  for (const dims of bad) {
    let threw = false;
    try {
      quiet(() => runIR({ ...dims, wallMaterial: "drywall", floorMaterial: "drywall", ceilMaterial: "drywall" }));
    } catch { threw = true; }
    assert(threw, `accepted invalid geometry ${JSON.stringify(dims)}`);
  }
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
