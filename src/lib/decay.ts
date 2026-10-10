/**
 * Shared energy-decay analysis: Schroeder backward integration plus
 * validated linear decay fitting (EDT / T20 / T30).
 *
 * WHY THIS EXISTS
 * ---------------
 * The FDTD solver previously estimated RT60 by walking the raw |p| receiver
 * trace forward from its peak and taking the first sample that fell 30 dB
 * below it, then doubling that time.
 *
 * That is not a decay measurement. |p| is an oscillating pressure magnitude:
 * it passes through ~zero twice per cycle regardless of how much energy is
 * in the room. The "first sample 30 dB down" is therefore almost always a
 * zero-crossing of the very first oscillation, a handful of samples after
 * the peak — not the room decaying. Measured on a 10x8x3 m room with a
 * 2.72 s Sabine RT60, the old method returned 0.010 s: wrong by a factor of
 * ~270, and wrong in the flattering direction (it makes every room look
 * controlled).
 *
 * The correct approach is Schroeder backward integration (Schroeder 1965):
 * integrate the squared IR from the end backwards, which yields a
 * monotonically decreasing energy decay curve free of that oscillation, then
 * fit a straight line to a defined dB range of it.
 *
 * Nothing here fabricates a value. Every fit reports its own quality and
 * refuses to return a number it cannot support.
 */

export interface DecayFit {
  /** Extrapolated full RT60 in seconds, or null when no valid fit exists. */
  rt60Sec: number | null;
  /** Coefficient of determination of the straight-line fit, or null. */
  r2: number | null;
  /** Decay rate in dB/second (negative for a decaying room), or null. */
  slopeDbPerSec: number | null;
  /** dB range actually used for the fit, e.g. [-5, -35]. */
  fitRangeDb: [number, number];
  /** Number of samples the fit used. */
  sampleCount: number;
  /** VALIDATED | LIMITED | UNAVAILABLE */
  status: "VALIDATED" | "LIMITED" | "UNAVAILABLE";
  /** Human-readable reason when the status is not VALIDATED. */
  reason: string | null;
}

export interface SchroederResult {
  /** Energy decay curve in dB, normalized so its maximum is 0 dB. */
  edcDb: number[];
  /** Index of the direct-sound peak in the original trace. */
  peakIndex: number;
  /** Usable dynamic range of the decay curve, in dB. */
  dynamicRangeDb: number;
  /**
   * How far the RAW trace's energy actually fell, early window vs late
   * window, in dB. This is the guard against the finite-window truncation
   * artifact described below.
   */
  rawDecayDb: number;
  /**
   * Number of leading EDC samples that are trustworthy. The tail of a
   * backward integral is dominated by the arbitrary end of the window
   * rather than by room decay, so it is excluded from fitting.
   */
  usableLength: number;
}

/**
 * THE FINITE-WINDOW TRUNCATION ARTIFACT
 * -------------------------------------
 * Schroeder integration of ANY signal produces a curve that falls to
 * -infinity at the end of the window, because the backward integral runs
 * out of samples. For a CONSTANT signal of amplitude a over N samples,
 *
 *     EDC(i) = a^2 * (N - i)      =>      EDC_dB(i) = 10*log10(1 - i/N)
 *
 * which passes through -5 dB, -25 dB and -35 dB on its way down and will
 * happily yield a confident-looking straight-line fit and a plausible RT60
 * — from a signal that never decayed at all. The same artifact lets a trace
 * that is far too short for its room produce a number instead of an honest
 * refusal.
 *
 * Two defences, both applied below:
 *   1. Require the RAW trace to show real energy decay (early vs late
 *      window) before any fit is attempted.
 *   2. Exclude the final portion of the EDC from the fit window, since that
 *      region is dominated by truncation rather than by the room.
 */
/** Fraction of the decay curve discarded as truncation-dominated. */
const TRUNCATION_TAIL_FRACTION = 0.1;
/** Minimum real decay (dB) the raw trace must show before a fit is allowed. */
const MIN_RAW_DECAY_DB = 15;

/**
 * Schroeder backward integration of a pressure trace.
 *
 * EDC(t) = integral from t to infinity of p^2(tau) dtau
 *
 * Integration starts at the direct-sound peak: samples before the direct
 * sound arrives carry no decay information, and including them flattens the
 * top of the curve.
 */
export function schroederCurve(trace: number[] | Float32Array, opts: { startAtPeak?: boolean } = {}): SchroederResult {
  const startAtPeak = opts.startAtPeak !== false;
  const n = trace.length;
  if (n === 0) {
    return { edcDb: [], peakIndex: 0, dynamicRangeDb: 0, rawDecayDb: 0, usableLength: 0 };
  }

  let peak = -Infinity;
  let peakIndex = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(trace[i]);
    if (a > peak) {
      peak = a;
      peakIndex = i;
    }
  }
  const start = startAtPeak ? peakIndex : 0;

  // Backward cumulative sum of energy.
  const len = n - start;
  const edc = new Float64Array(len);
  let running = 0;
  for (let i = len - 1; i >= 0; i--) {
    const v = trace[start + i];
    running += v * v;
    edc[i] = running;
  }

  const total = edc[0];
  if (!(total > 0) || !Number.isFinite(total)) {
    return { edcDb: [], peakIndex, dynamicRangeDb: 0, rawDecayDb: 0, usableLength: 0 };
  }

  // Defence 1: does the RAW trace actually decay? Compare mean energy in the
  // first 10% after the direct sound against the last 10% of the window.
  const winLen = Math.max(1, Math.floor(len * 0.1));
  let earlyE = 0, lateE = 0;
  for (let i = 0; i < winLen; i++) {
    const a = trace[start + i];
    earlyE += a * a;
  }
  for (let i = len - winLen; i < len; i++) {
    const a = trace[start + i];
    lateE += a * a;
  }
  earlyE /= winLen;
  lateE /= winLen;
  const rawDecayDb = lateE > 0 && earlyE > 0
    ? 10 * Math.log10(earlyE / lateE)
    : (earlyE > 0 ? Infinity : 0);

  const edcDb: number[] = new Array(len);
  for (let i = 0; i < len; i++) {
    // Floor at -200 dB so the tail (which reaches exactly 0 energy at the
    // last sample) yields -Infinity-free values.
    const ratio = edc[i] / total;
    edcDb[i] = ratio > 0 ? 10 * Math.log10(ratio) : -200;
  }

  // Usable range: how far down the curve actually gets before it flattens
  // into the integration floor.
  let lowest = 0;
  for (let i = 0; i < len; i++) {
    if (edcDb[i] > -200 && edcDb[i] < lowest) lowest = edcDb[i];
  }

  // Defence 2: drop the truncation-dominated tail from the usable range.
  const usableLength = Math.max(0, Math.floor(len * (1 - TRUNCATION_TAIL_FRACTION)));

  return { edcDb, peakIndex, dynamicRangeDb: Math.abs(lowest), rawDecayDb, usableLength };
}

/**
 * Least-squares fit of a straight line to a dB range of the decay curve,
 * extrapolated to a full 60 dB decay.
 *
 * Rejects fits that cannot be justified rather than returning a number:
 *  - too few samples in range
 *  - insufficient dynamic range to contain the requested window
 *  - non-decaying (flat or rising) curves
 *  - poor linearity (low R^2)
 */
export function fitDecay(
  curve: SchroederResult,
  dtSec: number,
  fromDb: number,
  toDb: number,
  opts: { minR2?: number; minSamples?: number } = {},
): DecayFit {
  const minR2 = opts.minR2 ?? 0.9;
  const minSamples = opts.minSamples ?? 10;
  const fitRangeDb: [number, number] = [fromDb, toDb];
  const edcDb = curve.edcDb;

  const fail = (reason: string, status: "LIMITED" | "UNAVAILABLE" = "UNAVAILABLE"): DecayFit => ({
    rt60Sec: null, r2: null, slopeDbPerSec: null, fitRangeDb, sampleCount: 0, status, reason,
  });

  if (!Number.isFinite(dtSec) || dtSec <= 0) return fail("Invalid time step.");
  if (!edcDb || edcDb.length < minSamples) return fail("Decay curve too short to fit.");

  // Defence 1: refuse to fit a trace that never really decayed. Without this
  // a constant signal yields a confident straight line and a fabricated
  // RT60, purely from the backward integral running out of window.
  if (!(curve.rawDecayDb >= MIN_RAW_DECAY_DB)) {
    return fail(
      `Trace shows only ${Number.isFinite(curve.rawDecayDb) ? curve.rawDecayDb.toFixed(1) : "0.0"} dB of real energy decay ` +
      `(${MIN_RAW_DECAY_DB} dB required). The simulated duration is too short for this room, ` +
      `or the signal is not decaying.`,
    );
  }

  // Defence 2: never fit into the truncation-dominated tail.
  const limit = Math.min(edcDb.length, Math.max(minSamples, curve.usableLength));

  // The curve is monotonically decreasing by construction, so the window is
  // a contiguous index range.
  let startIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < limit; i++) {
    if (startIdx === -1 && edcDb[i] <= fromDb) startIdx = i;
    if (edcDb[i] <= toDb) { endIdx = i; break; }
  }

  if (startIdx === -1) return fail(`Decay never reached ${fromDb} dB.`);
  if (endIdx === -1) {
    const reached = edcDb[limit - 1];
    return fail(
      `Decay only reached ${reached.toFixed(1)} dB; ${toDb} dB required for this fit. ` +
      `Simulated duration is too short for this room.`,
    );
  }
  const count = endIdx - startIdx + 1;
  if (count < minSamples) return fail(`Only ${count} samples in the fit window (need ${minSamples}).`);

  // Least squares on (time, dB).
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    const x = i * dtSec;
    const y = edcDb[i];
    sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
  }
  const denom = count * sxx - sx * sx;
  if (denom === 0) return fail("Degenerate fit window.");
  const slope = (count * sxy - sx * sy) / denom;

  if (!Number.isFinite(slope)) return fail("Fit produced a non-finite slope.");
  if (slope >= 0) return fail("Energy is not decaying over the fit window.");

  // R^2
  const meanY = sy / count;
  let ssTot = 0, ssRes = 0;
  const intercept = (sy - slope * sx) / count;
  for (let i = startIdx; i <= endIdx; i++) {
    const x = i * dtSec;
    const y = edcDb[i];
    const pred = slope * x + intercept;
    ssTot += (y - meanY) * (y - meanY);
    ssRes += (y - pred) * (y - pred);
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  const rt60Sec = -60 / slope;
  if (!Number.isFinite(rt60Sec) || rt60Sec <= 0) return fail("Extrapolated RT60 is not a usable value.");

  if (r2 < minR2) {
    return {
      rt60Sec, r2, slopeDbPerSec: slope, fitRangeDb, sampleCount: count,
      status: "LIMITED",
      reason: `Fit linearity is poor (R^2 = ${r2.toFixed(3)}, threshold ${minR2}). Treat this value as approximate.`,
    };
  }

  return {
    rt60Sec, r2, slopeDbPerSec: slope, fitRangeDb, sampleCount: count,
    status: "VALIDATED", reason: null,
  };
}

/** EDT: fit over 0 to -10 dB, extrapolated to 60 dB. */
export function computeEDT(curve: SchroederResult, dtSec: number): DecayFit {
  return fitDecay(curve, dtSec, 0, -10, { minSamples: 5 });
}

/** T20: fit over -5 to -25 dB. */
export function computeT20(curve: SchroederResult, dtSec: number): DecayFit {
  return fitDecay(curve, dtSec, -5, -25);
}

/** T30: fit over -5 to -35 dB. The ISO 3382 default for RT60. */
export function computeT30(curve: SchroederResult, dtSec: number): DecayFit {
  return fitDecay(curve, dtSec, -5, -35);
}
