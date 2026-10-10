// Shared octave-band bandpass filtering for anything that needs to split a
// broadband impulse-response trace into per-band energy before computing a
// decay/clarity metric (RT60-from-IR, C50/C80/D50/Ts, STI). Extracted from
// sti.ts so there is exactly one bandpass implementation in the codebase —
// previously this logic was private to sti.ts and impulseResponseParams.ts
// computed its metrics on the raw broadband trace instead of per band.

export interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number; }

// Standard constant-skirt-gain bandpass biquad (RBJ Audio EQ Cookbook —
// public-domain DSP formula, not a standards-body coefficient table).
export function bandpassBiquad(centerHz: number, sampleRateHz: number, Q: number): Biquad {
  const w0 = 2 * Math.PI * centerHz / sampleRateHz;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function applyBiquad(signal: number[], f: Biquad): number[] {
  const out = new Array(signal.length).fill(0);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let n = 0; n < signal.length; n++) {
    const x0 = signal[n];
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    out[n] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  return out;
}

// Standard octave-band analysis set. A material may legitimately report
// `N/A` at 8 kHz when no sourced coefficient exists; callers preserve that
// missing-data state rather than silently copying 4 kHz.
export const OCTAVE_BANDS_HZ = [125, 250, 500, 1000, 2000, 4000, 8000];
export const OCTAVE_BAND_LABELS = OCTAVE_BANDS_HZ.map(hz => `${hz} Hz`);

// Bandpass-filter a broadband trace into per-band energy (squared, filtered
// pressure) for every octave band the sample rate can resolve. Bands above
// Nyquist are silently skipped (matches sti.ts's existing Nyquist guard) —
// callers should treat a missing key in the result as "not resolvable at
// this sample rate", not as zero energy.
export function filterIntoBands(
  trace: number[],
  sampleRateHz: number,
  bandsHz: number[] = OCTAVE_BANDS_HZ
): Record<number, number[]> {
  const result: Record<number, number[]> = {};
  for (const centerHz of bandsHz) {
    if (centerHz >= sampleRateHz / 2) continue; // Nyquist guard
    const filter = bandpassBiquad(centerHz, sampleRateHz, Math.SQRT1_2); // Q=1/sqrt(2): maximally flat (Butterworth-like) passband
    result[centerHz] = applyBiquad(trace, filter);
  }
  return result;
}
