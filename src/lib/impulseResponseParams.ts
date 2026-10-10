// Room acoustic parameters derived from an actual impulse response (the
// FDTD solver's receiver pressure trace), not fabricated/placeholder data.
//
// Formulas (standard, published — see e.g. ISO 3382-1, and cross-referenced
// against multiple independent acoustics references):
//   C_te = 10 * log10( E_early / E_late ), te = 50ms (C50) or 80ms (C80)
//   D50  = E_early(50ms) / E_total
//   Ts   = integral( t * p^2(t) dt ) / integral( p^2(t) dt )   (center time,
//          the energy-weighted mean arrival time of the impulse response)
//
// PER-BAND (computePerBandImpulseResponseParams): ISO 3382-1 specifies these
// as octave-band values, not a single broadband number. This module
// octave-filters the trace (same biquad bandpass as sti.ts, via
// octaveFilter.ts) before computing each parameter, band by band, using
// each band's own energy envelope — so C50 at 125 Hz and C50 at 4000 Hz are
// genuinely different numbers computed from that band's filtered signal,
// not the same broadband value repeated across columns.
//
// The broadband computeImpulseResponseParams() below is kept for callers
// that only need a single overall number (e.g. a quick summary badge) — it
// is NOT a substitute for the per-band table and should not be labeled as
// per-band data anywhere it's displayed.
//
// KNOWN LIMITATIONS — be explicit about these wherever these numbers are
// shown:
// - The solver's receiverTrace is a short run (default ~20-40 steps) at a
//   single source/receiver pair, not a full-length converged impulse
//   response — real C50/C80/Ts calculations normally use a much longer,
//   fully-decayed IR. Values here are directional, not measurement-grade.
// - No 8000 Hz band: absorption.ts has no 8kHz material coefficients, and
//   fabricating one to complete the table would be worse than omitting it
//   (see octaveFilter.ts). Only 125Hz-4kHz are available.
// - G (Strength) and LF (Lateral Fraction) are NOT computed here: G needs a
//   calibrated free-field reference measurement at 10m, and LF needs a
//   figure-of-eight/lateral microphone signal — neither exists in this
//   single-channel, non-calibrated solver output. Do not fabricate these;
//   surface them as "not yet available" in any UI that lists them.

import { filterIntoBands, OCTAVE_BANDS_HZ, OCTAVE_BAND_LABELS } from './octaveFilter';

export interface ImpulseResponseParams {
  c50: number | null; // dB
  c80: number | null; // dB
  d50: number | null; // 0-1 fraction
  centerTimeMs: number | null; // Ts, milliseconds
  sampleCount: number;
  durationMs: number;
  sufficient: boolean; // false if the trace is too short for these numbers to be physically meaningful
  limitations: string;
}

// Same four metrics, but one value per octave band (125Hz-4kHz — see "no
// 8000 Hz band" above). Keyed by band label, e.g. "500 Hz", matching
// roomAcoustics.ts's BAND_LABELS convention so callers can line this table
// up against the RT60 table directly.
export interface PerBandImpulseResponseParams {
  c50: Record<string, number | null>;
  c80: Record<string, number | null>;
  d50: Record<string, number | null>;
  centerTimeMs: Record<string, number | null>;
  bandLabels: string[]; // the bands actually present in the records above
  sampleCount: number;
  durationMs: number;
  sufficient: boolean;
  limitations: string;
}

const LIMITATIONS_NOTE =
  'Derived from the coarse-grid, long-duration impulse response run, not a full-length measured impulse response. Treat as a directional estimate, not a measurement-grade result.';

const PER_BAND_LIMITATIONS_NOTE =
  'Derived from the coarse-grid, long-duration impulse response run, not a full-length measured impulse response. Each reported band is genuinely octave-filtered; bands that cannot be resolved by the trace sample rate or lack required source data remain unavailable rather than being fabricated. Treat as a directional estimate, not a measurement-grade result.';

const INSUFFICIENT_NOTE =
  'This simulation run was too short to produce meaningful C50/C80/D50/Ts — these metrics require at least 80ms of simulated decay, and ideally 2x the room\'s estimated RT60. Run the Impulse Response solver (not the quick preview) to get real values.';

function computeMinRequiredMs(estimatedRt60Seconds?: number): number {
  // Sufficiency check: the trace must cover at least 80ms (the longer of
  // the two C50/C80 windows) AND, if we know the room's expected RT60,
  // at least half of that RT60 — otherwise C50/C80/Ts are being computed
  // over a window that ends well before the room has actually finished
  // decaying, which understates reverberance and should not be presented
  // as a real result.
  return Math.max(80, estimatedRt60Seconds ? estimatedRt60Seconds * 500 : 80);
}

// Core C50/C80/D50/Ts math for a single (already-filtered-or-not) energy
// series. Shared by both the broadband and per-band paths so the two never
// drift apart into subtly different formulas.
export function paramsFromEnergy(
  energy: number[],
  dtSeconds: number
): { c50: number | null; c80: number | null; d50: number | null; centerTimeMs: number | null } {
  const n = energy.length;
  const totalEnergy = energy.reduce((a, b) => a + b, 0);

  const idxAt = (ms: number) => Math.min(n, Math.max(0, Math.round((ms / 1000) / dtSeconds)));
  const idx50 = idxAt(50);
  const idx80 = idxAt(80);

  const sumUpTo = (idx: number) => {
    let s = 0;
    for (let i = 0; i < idx; i++) s += energy[i];
    return s;
  };

  const early50 = sumUpTo(idx50);
  const late50 = totalEnergy - early50;
  const early80 = sumUpTo(idx80);
  const late80 = totalEnergy - early80;

  const c50 = late50 > 0 && early50 > 0 ? 10 * Math.log10(early50 / late50) : null;
  const c80 = late80 > 0 && early80 > 0 ? 10 * Math.log10(early80 / late80) : null;
  const d50 = totalEnergy > 0 ? early50 / totalEnergy : null;

  let centerTimeMs: number | null = null;
  if (totalEnergy > 0) {
    let weightedSum = 0;
    for (let i = 0; i < n; i++) {
      weightedSum += (i * dtSeconds) * energy[i];
    }
    centerTimeMs = (weightedSum / totalEnergy) * 1000;
  }

  return {
    c50: c50 != null ? Math.round(c50 * 10) / 10 : null,
    c80: c80 != null ? Math.round(c80 * 10) / 10 : null,
    d50: d50 != null ? Math.round(d50 * 1000) / 1000 : null,
    centerTimeMs: centerTimeMs != null ? Math.round(centerTimeMs * 10) / 10 : null,
  };
}

// receiverTrace: array of |pressure| values at each simulation step (as
// returned by /api/solver/impulse-response). dtSeconds: time per step.
// estimatedRt60Seconds (optional): the room's Sabine RT60 estimate, used to
// judge whether the trace is actually long enough to be meaningful, not
// just long enough to avoid a divide-by-zero.
//
// Broadband summary. For band-resolved values, use
// computePerBandImpulseResponseParams below.
export function computeImpulseResponseParams(
  receiverTrace: number[],
  dtSeconds: number,
  estimatedRt60Seconds?: number
): ImpulseResponseParams {
  const n = receiverTrace.length;
  const durationMs = n * dtSeconds * 1000;
  const sufficient = durationMs >= computeMinRequiredMs(estimatedRt60Seconds);

  if (n === 0 || dtSeconds <= 0 || !sufficient) {
    return {
      c50: null, c80: null, d50: null, centerTimeMs: null,
      sampleCount: n, durationMs, sufficient: false,
      limitations: n === 0 || dtSeconds <= 0 ? LIMITATIONS_NOTE : INSUFFICIENT_NOTE,
    };
  }

  const energy = receiverTrace.map(p => p * p);
  const params = paramsFromEnergy(energy, dtSeconds);

  return {
    ...params,
    sampleCount: n,
    durationMs,
    sufficient: true,
    limitations: LIMITATIONS_NOTE,
  };
}

// Real per-band C50/C80/D50/Ts: octave-filters the broadband trace (same
// bandpass filter as sti.ts) into the standard 125Hz-8kHz octave bands, then computes each
// metric independently on that band's own filtered energy — this is what
// actually fixes the "broadband value repeated across every band column"
// issue in the UI.
export function computePerBandImpulseResponseParams(
  receiverTrace: number[],
  dtSeconds: number,
  estimatedRt60Seconds?: number,
  /** Highest frequency the solver grid resolves; octave bands centred above it are N/A (numerical noise). */
  reliableFmaxHz?: number
): PerBandImpulseResponseParams {
  const n = receiverTrace.length;
  const durationMs = n * dtSeconds * 1000;
  const sufficient = durationMs >= computeMinRequiredMs(estimatedRt60Seconds);

  const empty = () => Object.fromEntries(OCTAVE_BAND_LABELS.map(l => [l, null])) as Record<string, number | null>;

  if (n === 0 || dtSeconds <= 0 || !sufficient) {
    return {
      c50: empty(), c80: empty(), d50: empty(), centerTimeMs: empty(),
      bandLabels: OCTAVE_BAND_LABELS,
      sampleCount: n, durationMs, sufficient: false,
      limitations: n === 0 || dtSeconds <= 0 ? PER_BAND_LIMITATIONS_NOTE : INSUFFICIENT_NOTE,
    };
  }

  const sampleRateHz = 1 / dtSeconds;
  const bands = filterIntoBands(receiverTrace, sampleRateHz, OCTAVE_BANDS_HZ);

  const c50: Record<string, number | null> = {};
  const c80: Record<string, number | null> = {};
  const d50: Record<string, number | null> = {};
  const centerTimeMs: Record<string, number | null> = {};
  const presentLabels: string[] = [];

  OCTAVE_BANDS_HZ.forEach((hz, i) => {
    const label = OCTAVE_BAND_LABELS[i];
    const filtered = bands[hz];
    const beyondSolver = typeof reliableFmaxHz === 'number' && Number.isFinite(reliableFmaxHz) && hz > reliableFmaxHz;
    if (!filtered || beyondSolver) {
      // Band skipped upstream (above Nyquist for this trace's sample rate)
      // — leave as null rather than silently omitting the column, so the
      // UI can show "N/A" instead of a missing row.
      c50[label] = null; c80[label] = null; d50[label] = null; centerTimeMs[label] = null;
      return;
    }
    const energy = filtered.map(v => v * v);
    const result = paramsFromEnergy(energy, dtSeconds);
    c50[label] = result.c50;
    c80[label] = result.c80;
    d50[label] = result.d50;
    centerTimeMs[label] = result.centerTimeMs;
    presentLabels.push(label);
  });

  return {
    c50, c80, d50, centerTimeMs,
    bandLabels: OCTAVE_BAND_LABELS,
    sampleCount: n,
    durationMs,
    sufficient: true,
    limitations: presentLabels.length < OCTAVE_BAND_LABELS.length
      ? PER_BAND_LIMITATIONS_NOTE + ' Some high bands are N/A: they lie above the solver\'s reliable bandwidth or the trace\'s sample rate.'
      : PER_BAND_LIMITATIONS_NOTE,
  };
}
