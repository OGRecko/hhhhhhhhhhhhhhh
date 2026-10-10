// Modulation Transfer Function (MTF) based Speech Transmission Index,
// computed from a REAL impulse response (the long-duration solver's
// receiverTrace) using Schroeder's indirect method — not the RT60/SNR
// curve-fit proxy in roomAcoustics.ts's computeSTIProxy.
//
// WHAT THIS IS: for each octave band, the impulse response is bandpass
// filtered, squared (energy), and its modulation spectrum is evaluated at
// the 14 standard STI modulation frequencies (0.63-12.5 Hz) via direct
// summation — the same core computation described in the published
// indirect/Schroeder method (see e.g. arXiv:1805.11533, eq. 1). Each
// modulation index is converted to an apparent SNR and combined into a
// per-band transmission index. This is genuine signal processing on the
// room's actual simulated impulse response, not an empirical formula.
//
// WHAT THIS IS NOT — read before using this anywhere near a "certified" or
// "IEC-compliant" claim:
// - The official IEC 60268-16 combination step also applies auditory
//   masking corrections (how energy in one band suppresses perceived
//   modulation in adjacent bands) and absolute hearing-threshold
//   corrections, using numeric tables published in the standard's annexes.
//   Those exact tables could not be reliably sourced for this
//   implementation and are NOT applied here — implementing them from
//   incomplete or misremembered figures would be worse than omitting them.
// - The official per-band importance weights (how much each octave band
//   contributes to the final STI) are also a published numeric table this
//   implementation does not have complete access to. The one verifiable,
//   published fact used here (Steeneken & Houtgast; cited in Kreisman &
//   Ronsse's response re: Shalkouhi 2010) is that the 125 Hz band's
//   real-world importance weight is approximately zero — so 125 Hz is
//   excluded from the combination. The remaining five bands (250-4000 Hz)
//   are weighted EQUALLY, which is a disclosed simplification, not the
//   official non-uniform weighting.
// - Ambient noise / signal level correction (the "effective SNR" the
//   standard applies when background noise is present) is not modelled —
//   this assumes a noise-free impulse response, which is what the solver
//   actually produces.
//
// Net effect: this is a materially more real computation than a curve-fit
// proxy, grounded in the room's actual simulated impulse response — but it
// is NOT the certified IEC 60268-16 number. Always show it with the
// disclaimer this module returns, and never describe it as "IEC-compliant"
// or "certified" anywhere in the app.

import { bandpassBiquad, applyBiquad, OCTAVE_BANDS_HZ } from './octaveFilter';

const MODULATION_FREQUENCIES = [0.63, 0.80, 1.00, 1.25, 1.60, 2.00, 2.50, 3.15, 4.00, 5.00, 6.30, 8.00, 10.00, 12.50];

// 125 Hz excluded per the one verifiable published fact available (see
// module comment above) — not because it's technically infeasible to
// filter, but because its real contribution to intelligibility is
// negligible and we don't want to give it equal (and therefore
// overstated) weight against the mid/high bands that actually matter for
// speech.
const BANDS_USED_IN_COMBINATION = OCTAVE_BANDS_HZ.filter(f => f !== 125);

// Modulation index at frequency F for an energy envelope e(t), via direct
// evaluation of the Fourier integral (the indirect/Schroeder method):
// m(F) = 2*|sum(e[n] * exp(-j*2*pi*F*n*dt))| / sum(e[n])
//
// The factor of 2 matters: e(t) = DC + m0*cos(2*pi*F*t) decomposes via
// Euler's formula into two complex exponentials at +F and -F, each with
// coefficient m0/2. Correlating against exp(-j*2*pi*F*t) (a single-sided
// probe) only picks up the +F half, so the raw correlation magnitude comes
// out to m0/2, not m0, for a fully-modulated (depth=1) signal — verified
// against a synthetic 100%-modulated test signal, which returned 0.5
// without this factor. Doubling recovers the true modulation depth.
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

export interface RealSTIResult {
  value: number; // 0-1
  qualityLabel: string;
  perBandTransmissionIndex: Record<string, number>; // keyed by "125 Hz" etc, for the bands actually used
  disclaimer: string;
  sufficient: boolean; // false if the trace is too short to evaluate the lowest modulation frequency meaningfully
}

function qualityLabel(sti: number): string {
  if (sti < 0.3) return 'Bad';
  if (sti < 0.45) return 'Poor';
  if (sti < 0.6) return 'Fair';
  if (sti < 0.75) return 'Good';
  return 'Excellent';
}

const DISCLAIMER =
  'Computed from this room\'s actual simulated impulse response using the modulation transfer function (indirect/Schroeder) method, but WITHOUT the official IEC 60268-16 auditory masking correction, absolute threshold correction, or published band-importance weights (those exact tables were not reliably available). This is a more direct physical estimate than a formula-based proxy, but it is not a certified or IEC-compliant STI value.';

const INSUFFICIENT_DISCLAIMER =
  'This impulse response is too short to evaluate the lowest required modulation frequency (0.63 Hz needs at least ~1.6s of signal to resolve one full cycle). Run a longer impulse response computation for this room, or treat this result as unreliable.';

export function computeRealSTI(receiverTrace: number[], dtSeconds: number): RealSTIResult {
  const durationSec = receiverTrace.length * dtSeconds;
  const minModFreq = MODULATION_FREQUENCIES[0]; // 0.63 Hz
  const sufficient = durationSec >= 1 / minModFreq; // need at least one full cycle of the slowest modulation frequency

  if (!sufficient || receiverTrace.length < 8) {
    return {
      value: 0, qualityLabel: 'Unavailable',
      perBandTransmissionIndex: {},
      disclaimer: INSUFFICIENT_DISCLAIMER,
      sufficient: false,
    };
  }

  const sampleRateHz = 1 / dtSeconds;
  const perBandTI: Record<string, number> = {};
  let sumTI = 0;
  // Tracks how many bands were actually resolvable at this sample rate, so
  // the final average (below) divides by the bands actually summed into
  // sumTI, not the full nominal band list. Previously this always divided
  // by BANDS_USED_IN_COMBINATION.length even when the Nyquist guard below
  // skipped one or more high bands (low sample rate -> low Nyquist limit),
  // which silently understated the combined STI value whenever any band
  // was skipped — the missing band's zero contribution was averaged in as
  // if it had a real (near-zero) transmission index, instead of being
  // excluded the way filterIntoBands's own contract says callers should
  // treat an unresolved band.
  let presentBandCount = 0;

  for (const centerHz of BANDS_USED_IN_COMBINATION) {
    // Nyquist guard: skip bands the sample rate can't resolve (shouldn't
    // happen given the solver's dt, but fail safely rather than produce a
    // meaningless filtered signal).
    if (centerHz >= sampleRateHz / 2) continue;

    const filter = bandpassBiquad(centerHz, sampleRateHz, Math.SQRT1_2); // Q=1/sqrt(2): maximally flat (Butterworth-like) passband
    const filtered = applyBiquad(receiverTrace, filter);
    const energy = filtered.map(v => v * v);

    let sumSNR = 0;
    for (const F of MODULATION_FREQUENCIES) {
      const m = Math.min(Math.max(modulationIndex(energy, F, dtSeconds), 1e-6), 1 - 1e-6);
      const snr = 10 * Math.log10(m / (1 - m));
      sumSNR += Math.max(-15, Math.min(15, snr)); // clip to the standard's +/-15dB perceptual range
    }
    const avgSNR = sumSNR / MODULATION_FREQUENCIES.length;
    const ti = Math.max(0, Math.min(1, (avgSNR + 15) / 30));

    perBandTI[`${centerHz} Hz`] = Math.round(ti * 1000) / 1000;
    sumTI += ti;
    presentBandCount++;
  }

  const sti = presentBandCount > 0 ? sumTI / presentBandCount : 0; // equal weighting across bands actually resolved — see disclaimer

  return {
    value: Math.round(sti * 100) / 100,
    qualityLabel: qualityLabel(sti),
    perBandTransmissionIndex: perBandTI,
    disclaimer: DISCLAIMER,
    sufficient: true,
  };
}
