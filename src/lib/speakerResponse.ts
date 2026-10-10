/**
 * speakerResponse.ts
 *
 * Authoritative response-envelope modeling, logarithmic interpolation,
 * and pure numerical DSP simulation for Cavity Audio speakers.
 *
 * Implements:
 * 1. Logarithmic frequency interpolation between response curve points.
 * 2. Deterministic analytical response-envelope synthesis when a published range exists; the envelope is not a measurement.
 * 3. Pure TypeScript Direct-Form-II Biquad filter chain for headless/test DSP simulation.
 * 4. Transparent distinction between measured, manufacturer, and physically-modeled data.
 */

import type { SpeakerSpec, SourceType } from './speakerDSP';

export interface ResponsePoint {
  hz: number;
  db: number;
}

export type ResponseProvenance = 'measurement' | 'manufacturer' | 'verified_database' | 'physically_modeled';

export interface SpeakerResponseModel {
  speakerId: string;
  provenance: ResponseProvenance;
  sourceDescription: string;
  isMeasuredOrManufacturer: boolean;
  low_hz: number;
  high_hz: number;
  points: ResponsePoint[];
  /**
   * True when the database lacked a published frequency limit and a documented GENERIC REFERENCE bound was used
   * instead. Such a curve is a neutral modeled reference, NOT the speaker's real response, and must never be shown
   * as the speaker's frequency range.
   */
  isGenericReference?: boolean;
  /** Which of the two bounds were NOT published and were replaced by the reference band edge. */
  referenceBounds?: Array<'low_hz' | 'high_hz'>;
}

/** Edges of the standard analysis band (STANDARD_FREQUENCIES_HZ). Used ONLY as neutral reference band edges when a
 *  speaker has no published limit on that side; they are not speaker specifications. */
export const REFERENCE_BAND_LOW_HZ = 20;
export const REFERENCE_BAND_HIGH_HZ = 20000;

const publishedHz = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

export const STANDARD_FREQUENCIES_HZ: readonly number[] = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000
];

/**
 * Logarithmic frequency interpolation.
 * Since human pitch perception and acoustic octave spacing are logarithmic,
 * interpolation between response anchor points must occur in log10(frequency) space.
 */
export function interpolateLogFrequency(points: ResponsePoint[], targetHz: number): number {
  if (!Array.isArray(points) || points.length === 0) return 0;
  const finitePoints = points.filter((p) => Number.isFinite(p?.hz) && p.hz > 0 && Number.isFinite(p?.db));
  if (finitePoints.length === 0) return 0;
  const ordered = [...finitePoints].sort((a, b) => a.hz - b.hz);
  const deduped: ResponsePoint[] = [];
  for (const point of ordered) {
    const last = deduped[deduped.length - 1];
    if (last?.hz === point.hz) deduped[deduped.length - 1] = point;
    else deduped.push(point);
  }
  if (deduped.length === 1) return deduped[0].db;

  const f = Number.isFinite(targetHz) ? Math.max(10, Math.min(48000, targetHz)) : deduped[0].hz;
  points = deduped;
  const logF = Math.log10(f);

  if (f <= points[0].hz) {
    // Extrapolate below lowest point using initial slope
    const p0 = points[0];
    const p1 = points[1];
    const slope = (p1.db - p0.db) / (Math.log10(p1.hz) - Math.log10(p0.hz));
    return p0.db + slope * (logF - Math.log10(p0.hz));
  }

  const last = points[points.length - 1];
  if (f >= last.hz) {
    // Extrapolate above highest point using terminal slope
    const prev = points[points.length - 2];
    const slope = (last.db - prev.db) / (Math.log10(last.hz) - Math.log10(prev.hz));
    return last.db + slope * (logF - Math.log10(last.hz));
  }

  // Binary search for surrounding anchor points
  let low = 0;
  let high = points.length - 2;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (points[mid].hz <= f && points[mid + 1].hz >= f) {
      const p1 = points[mid];
      const p2 = points[mid + 1];
      const t = (logF - Math.log10(p1.hz)) / (Math.log10(p2.hz) - Math.log10(p1.hz));
      return p1.db + t * (p2.db - p1.db);
    }
    if (points[mid].hz < f) low = mid + 1;
    else high = mid - 1;
  }

  return points[0].db;
}

/**
 * No hand-authored response curves are treated as manufacturer measurements. Published bandwidth is converted into a simplified analytical envelope.
 * Its roll-off shape is an explicit modeling assumption, not a measured speaker response.
 */
export const KNOWN_SPEAKER_CURVES: Record<string, { provenance: ResponseProvenance; source: string; points: ResponsePoint[] }> = {};

/**
 * Builds the authoritative response envelope for any speaker in the database.
 * Raw response points are used only when they are explicitly present and source-backed. Otherwise the model is
 * a transparent band-limited approximation from published limits; it is never presented as a measurement.
 */
export function getSpeakerResponseModel(spec: SpeakerSpec): SpeakerResponseModel {
  // Published point tables require their own source, status, source type, and measurement context. A record's
  // range-limit provenance alone is not enough to make an arbitrary point array a measurement.
  const response = spec.frequencyResponse;
  const rawPoints = response?.points;
  const pointType = response?.pointsSourceType;
  const expectedPointStatus = pointType === 'MANUFACTURER' ? 'MANUFACTURER_VERIFIED'
    : pointType === 'MEASUREMENT' ? 'MEASUREMENT_VERIFIED'
    : pointType === 'REPUTABLE_DATABASE' ? 'REPUTABLE_DATABASE_VERIFIED'
    : null;
  const pointsAreSourceBacked = Array.isArray(rawPoints) && rawPoints.length >= 2 &&
    expectedPointStatus !== null && response?.pointsStatus === expectedPointStatus &&
    typeof response?.pointsSource === 'string' && /^https:\/\//.test(response.pointsSource) &&
    typeof response?.pointsContext === 'string' && response.pointsContext.trim().length >= 20 &&
    rawPoints.every((point, i) => Number.isFinite(point?.hz) && point.hz > 0 && Number.isFinite(point?.db) &&
      (i === 0 || point.hz > rawPoints[i - 1].hz));
  if (pointsAreSourceBacked) {
    const orderedPoints = rawPoints as ResponsePoint[];
    // Response points carry curve shape; absolute loudness is handled separately by resolveSensitivity(). Normalize
    // a constant source offset at 1 kHz when available, or at the geometric center for a limited-band dataset.
    const firstHz = orderedPoints[0].hz;
    const lastHz = orderedPoints[orderedPoints.length - 1].hz;
    const anchorHz = firstHz <= 1000 && lastHz >= 1000 ? 1000 : Math.sqrt(firstHz * lastHz);
    const anchorDb = interpolateLogFrequency(orderedPoints, anchorHz);
    const normalizedPoints = orderedPoints.map((point) => ({ hz: point.hz, db: point.db - anchorDb }));
    const provenance: ResponseProvenance = pointType === 'MEASUREMENT' ? 'measurement'
      : pointType === 'MANUFACTURER' ? 'manufacturer' : 'verified_database';
    return {
      speakerId: spec.id,
      provenance,
      sourceDescription: `${response.pointsContext} Response shape normalized at ${anchorHz} Hz for sensitivity-separated DSP; absolute level comes from the verified sensitivity field. Source: ${response.pointsSource}`,
      isMeasuredOrManufacturer: pointType !== 'REPUTABLE_DATABASE',
      low_hz: firstHz,
      high_hz: lastHz,
      points: normalizedPoints
    };
  }

  // No verified curve exists. Synthesize a model ONLY from limits the record actually publishes.
  // Nothing about the speaker is guessed: no category-based frequency limits, no assumed woofer size, no assumed
  // subwoofer crossover, no category "character" (guitar-cab / PA horn / studio voicing). A side with no published
  // limit gets NO roll-off and the model is flagged as a generic reference (see SpeakerResponseModel).
  const publishedLow = publishedHz(spec.frequencyResponse?.low_hz);
  const publishedHigh = publishedHz(spec.frequencyResponse?.high_hz);
  const lowHz = publishedLow === null ? null : Math.max(16, publishedLow);
  const highHz = publishedHigh === null ? null : Math.min(48000, publishedHigh);
  // The roll-off slope is a documented analytical modeling assumption. It is NOT derived from active/passive status,
  // driver count, category, power rating, or any other unsourced speaker characteristic.
  const lowRolloffDbPerOct = 12;

  const synthesizedPoints: ResponsePoint[] = [];

  for (const f of STANDARD_FREQUENCIES_HZ) {
    let db = 0;

    // 1. Low-frequency roll-off below the PUBLISHED low limit
    if (lowHz !== null) {
      if (f < lowHz) {
        const octavesBelow = Math.log2(lowHz / f);
        db -= 3.0 + (octavesBelow * lowRolloffDbPerOct);
      } else if (f < lowHz * 1.5) {
        // Transition knee near f_low
        const ratio = (f - lowHz) / (lowHz * 0.5);
        db -= (1 - ratio) * 3.0;
      }
    }

    // 2. High-frequency roll-off above the PUBLISHED high limit
    if (highHz !== null) {
      if (f > highHz) {
        const octavesAbove = Math.log2(f / highHz);
        db -= 3.0 + (octavesAbove * 18);
      } else if (f > highHz * 0.8) {
        const ratio = (f - highHz * 0.8) / (highHz * 0.2);
        db -= ratio * 3.0;
      }
    }

    synthesizedPoints.push({ hz: f, db: Math.round(db * 10) / 10 });
  }

  const referenceBounds: Array<'low_hz' | 'high_hz'> = [];
  if (lowHz === null) referenceBounds.push('low_hz');
  if (highHz === null) referenceBounds.push('high_hz');
  const isGenericReference = referenceBounds.length > 0;
  const rangeText = lowHz !== null && highHz !== null ? `${lowHz}Hz–${highHz}Hz`
    : lowHz !== null ? `low limit ${lowHz}Hz; no published high limit`
    : highHz !== null ? `high limit ${highHz}Hz; no published low limit`
    : 'no published frequency limits';

  return {
    speakerId: spec.id,
    provenance: 'physically_modeled',
    sourceDescription: isGenericReference
      ? `Generic reference model (${rangeText}): flat, with no roll-off on any side that has no published limit. Modeled reference only — not this speaker's measured or manufacturer response.`
      : `Physically modeled from verified published range (${rangeText}) as a simple band-limited roll-off. Modeled, not a measurement.`,
    isMeasuredOrManufacturer: false,
    low_hz: lowHz ?? REFERENCE_BAND_LOW_HZ,
    high_hz: highHz ?? REFERENCE_BAND_HIGH_HZ,
    points: synthesizedPoints,
    isGenericReference,
    referenceBounds,
  };
}

/**
 * Evaluates the speaker's response curve across specified frequencies.
 */
export function computeResponseCurve(spec: SpeakerSpec, frequencies = STANDARD_FREQUENCIES_HZ): ResponsePoint[] {
  const model = getSpeakerResponseModel(spec);
  return frequencies.map(hz => ({
    hz,
    db: Math.round(interpolateLogFrequency(model.points, hz) * 100) / 100
  }));
}

/**
 * Pure Direct-Form II Transposed Biquad Filter implementation for headless DSP.
 */
class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0;
  private a1 = 0; private a2 = 0;
  private s1 = 0; private s2 = 0;

  setPeaking(f0: number, gainDb: number, Q: number, fs: number) {
    if (Math.abs(gainDb) < 0.05) {
      this.b0 = 1; this.b1 = 0; this.b2 = 0;
      this.a1 = 0; this.a2 = 0;
      return;
    }
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * Math.min(f0, fs * 0.49) / fs;
    const alpha = Math.sin(w0) / (2 * Math.max(0.1, Q));
    const cosw0 = Math.cos(w0);

    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0;
    this.b1 = (-2 * cosw0) / a0;
    this.b2 = (1 - alpha * A) / a0;
    this.a1 = (-2 * cosw0) / a0;
    this.a2 = (1 - alpha / A) / a0;
  }

  setLowShelf(f0: number, gainDb: number, fs: number) {
    if (Math.abs(gainDb) < 0.05) {
      this.b0 = 1; this.b1 = 0; this.b2 = 0;
      this.a1 = 0; this.a2 = 0;
      return;
    }
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * Math.min(f0, fs * 0.49) / fs;
    const alpha = Math.sin(w0) / 2 * Math.SQRT2;
    const cosw0 = Math.cos(w0);
    const a0 = (A + 1) + (A - 1) * cosw0 + 2 * Math.sqrt(A) * alpha;

    this.b0 = (A * ((A + 1) - (A - 1) * cosw0 + 2 * Math.sqrt(A) * alpha)) / a0;
    this.b1 = (2 * A * ((A - 1) - (A + 1) * cosw0)) / a0;
    this.b2 = (A * ((A + 1) - (A - 1) * cosw0 - 2 * Math.sqrt(A) * alpha)) / a0;
    this.a1 = (-2 * ((A - 1) + (A + 1) * cosw0)) / a0;
    this.a2 = ((A + 1) + (A - 1) * cosw0 - 2 * Math.sqrt(A) * alpha) / a0;
  }

  setHighShelf(f0: number, gainDb: number, fs: number) {
    if (Math.abs(gainDb) < 0.05) {
      this.b0 = 1; this.b1 = 0; this.b2 = 0;
      this.a1 = 0; this.a2 = 0;
      return;
    }
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * Math.min(f0, fs * 0.49) / fs;
    const alpha = Math.sin(w0) / 2 * Math.SQRT2;
    const cosw0 = Math.cos(w0);
    const a0 = (A + 1) - (A - 1) * cosw0 + 2 * Math.sqrt(A) * alpha;

    this.b0 = (A * ((A + 1) + (A - 1) * cosw0 + 2 * Math.sqrt(A) * alpha)) / a0;
    this.b1 = (-2 * A * ((A - 1) + (A + 1) * cosw0)) / a0;
    this.b2 = (A * ((A + 1) + (A - 1) * cosw0 - 2 * Math.sqrt(A) * alpha)) / a0;
    this.a1 = (2 * ((A - 1) - (A + 1) * cosw0)) / a0;
    this.a2 = ((A + 1) - (A - 1) * cosw0 - 2 * Math.sqrt(A) * alpha) / a0;
  }

  /** Magnitude response in dB at `f` Hz (exact transfer function of the coefficients above). */
  magnitudeDb(f: number, fs: number): number {
    const w = 2 * Math.PI * f / fs;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2, ni = -(this.b1 * s1 + this.b2 * s2);
    const dr = 1 + this.a1 * c1 + this.a2 * c2, di = -(this.a1 * s1 + this.a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }

  process(input: Float32Array): Float32Array {
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const y = this.b0 * x + this.s1;
      this.s1 = this.b1 * x - this.a1 * y + this.s2;
      this.s2 = this.b2 * x - this.a2 * y;
      out[i] = y;
    }
    return out;
  }
}

const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const DSP_BAND_CENTERS_HZ: readonly number[] = [125, 250, 500, 1000, 2000, 4000, 8000];
export const DSP_PEAK_Q = 1.4;
/** Max per-band cut. 40 dB is the Web Audio BiquadFilterNode nominal gain range, so live and offline chains agree. */
export const DSP_MAX_CUT_DB = 40;
/** A peaking filter whose gain is below this is omitted (identity). */
export const DSP_MIN_PEAK_GAIN_DB = 0.05;

export interface BandGainSolution {
  lowShelfGainDb: number; highShelfGainDb: number;
  /** Peaking gain (dB) for each of DSP_BAND_CENTERS_HZ, in order. */
  peakGainsDb: number[];
  /** Per-band |achieved - target| over DSP_BAND_CENTERS_HZ, in order (dB). */
  bandResidualsDb: number[];
  /** Largest |achieved - target| over the seven centers after solving (dB). */
  maxResidualDb: number;
}

/**
 * Peaking filters one octave apart at Q=1.4 overlap, so applying each band's target gain directly makes the
 * cascade overshoot wherever the curve is not flat (measured: NS-10M +2.4 dB at 4 kHz). This solves for the
 * per-band gains so the exact cascade response (low shelf + 7 peaks + high shelf) matches the model at the
 * seven centers. Pure and deterministic; shared by the offline DSP and the live Web Audio chain.
 */
export function solveBandGains(model: SpeakerResponseModel, fs: number): BandGainSolution {
  const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const lowShelfGainDb = clampTo(interpolateLogFrequency(model.points, 50), -24, 6);
  const highShelfGainDb = clampTo(interpolateLogFrequency(model.points, 15000), -24, 6);
  const lowF = clampTo(model.low_hz, 20, 300);
  const highF = clampTo(model.high_hz, 4000, 16000);
  const targets = DSP_BAND_CENTERS_HZ.map((f) => interpolateLogFrequency(model.points, f));

  const shelves = (f: number) => {
    const lo = new Biquad(); lo.setLowShelf(lowF, lowShelfGainDb, fs);
    const hi = new Biquad(); hi.setHighShelf(highF, highShelfGainDb, fs);
    return lo.magnitudeDb(f, fs) + hi.magnitudeDb(f, fs);
  };
  const achieved = (gains: number[]) => DSP_BAND_CENTERS_HZ.map((f) => {
    let db = shelves(f);
    for (let j = 0; j < gains.length; j++) {
      if (Math.abs(gains[j]) < DSP_MIN_PEAK_GAIN_DB) continue;
      const pk = new Biquad(); pk.setPeaking(DSP_BAND_CENTERS_HZ[j], gains[j], DSP_PEAK_Q, fs);
      db += pk.magnitudeDb(f, fs);
    }
    return db;
  });

  let gains = targets.map((t) => clampTo(t, -DSP_MAX_CUT_DB, 12));
  for (let it = 0; it < 40; it++) {
    const a = achieved(gains);
    let worst = 0;
    gains = gains.map((g, i) => { const e = targets[i] - a[i]; worst = Math.max(worst, Math.abs(e)); return clampTo(g + 0.7 * e, -DSP_MAX_CUT_DB, 12); });
    if (worst < 0.02) break;
  }
  const a = achieved(gains);
  const bandResidualsDb = targets.map((t, i) => Math.abs(t - a[i]));
  const maxResidualDb = Math.max(...bandResidualsDb);
  return { lowShelfGainDb, highShelfGainDb, peakGainsDb: gains, bandResidualsDb, maxResidualDb };
}

/** Reference sensitivity (dB SPL @ 1 W / 1 m) used as unity gain, and as the neutral level when a speaker has none (flagged isFallback; never a speaker spec). */
export const SENSITIVITY_REFERENCE_DB = 89;

export interface ResolvedSensitivity {
  valueDb: number;
  /** True when the speaker has no usable sensitivity and the reference value is being used instead. */
  isFallback: boolean;
  /** Where a non-fallback value came from; 'none' for fallback. Never 'manufacturer'/'measurement' for a fallback. */
  source: 'manufacturer' | 'measurement' | 'estimated' | 'none';
}

/** The ONE place that decides which sensitivity the DSP uses and whether it is a fallback. */
export function resolveSensitivity(spec: SpeakerSpec): ResolvedSensitivity {
  const raw = spec.sensitivity?.value;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return { valueDb: SENSITIVITY_REFERENCE_DB, isFallback: true, source: 'none' };
  }

  const t = spec.sensitivity?.sourceType;
  const source = spec.sensitivity?.status === 'LEGACY' ? 'estimated'
    : t === 'MANUFACTURER' ? 'manufacturer' : t === 'MEASUREMENT' ? 'measurement' : 'estimated';

  // The DSP reference is dB SPL @ 1 W / 1 m. Manufacturer sensitivity may be
  // published at 1 W / 1 m or at 2.83 V / 1 m. Convert the latter only when
  // a valid nominal impedance is explicitly known; never invent an impedance.
  const reference = spec.sensitivity?.reference;
  if (typeof reference === 'string' && /^2\.83(?:V|Vrms)\/1m$/i.test(reference)) {
    const r = spec.impedance?.value;
    if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0) {
      return { valueDb: SENSITIVITY_REFERENCE_DB, isFallback: true, source: 'none' };
    }
    const watts = (2.83 * 2.83) / r;
    if (!Number.isFinite(watts) || watts <= 0) {
      return { valueDb: SENSITIVITY_REFERENCE_DB, isFallback: true, source: 'none' };
    }
    return { valueDb: raw - 10 * Math.log10(watts), isFallback: false, source };
  }

  // A missing/blank reference or an explicit 1 W / 1 m reference is used verbatim. Any OTHER stated reference
  // (e.g. 2.83 V / 2 m, or free text) cannot be normalised to 1 W / 1 m, so it must not be reinterpreted as
  // 1 W / 1 m: fall back to the neutral reference instead (same rule as sourceSensitivityDb()).
  if (typeof reference === 'string' && reference.trim() !== '' && !/^1W\/1m$/i.test(reference.trim())) {
    return { valueDb: SENSITIVITY_REFERENCE_DB, isFallback: true, source: 'none' };
  }

  return { valueDb: raw, isFallback: false, source };
}

/**
 * Pure numerical DSP processing of an audio signal through a speaker model.
 * Used for automated verification, regression tests, and offline simulations.
 */
export function simulateSpeakerDSP(
  inputSignal: Float32Array,
  sampleRate: number,
  spec: SpeakerSpec,
  options?: {
    loudnessMatched?: boolean;
    distanceM?: number;
    angleRad?: number;
  }
): Float32Array {
  const model = getSpeakerResponseModel(spec);
  let signal = new Float32Array(inputSignal);

  // 1-3. Low shelf + peaking bank + high shelf, with band gains solved so the cascade hits the model curve
  const sol = solveBandGains(model, sampleRate);
  const lowShelf = new Biquad();
  lowShelf.setLowShelf(clampN(model.low_hz, 20, 300), sol.lowShelfGainDb, sampleRate);
  signal = lowShelf.process(signal);
  DSP_BAND_CENTERS_HZ.forEach((centerHz, j) => {
    if (Math.abs(sol.peakGainsDb[j]) < DSP_MIN_PEAK_GAIN_DB) return;
    const peak = new Biquad();
    peak.setPeaking(centerHz, sol.peakGainsDb[j], DSP_PEAK_Q, sampleRate);
    signal = peak.process(signal);
  });
  const highShelf = new Biquad();
  highShelf.setHighShelf(clampN(model.high_hz, 4000, 16000), sol.highShelfGainDb, sampleRate);
  signal = highShelf.process(signal);

  // 4. Sensitivity & SPL Scaling (or loudness-matched mode)
  let linearGain = 1.0;
  if (!options?.loudnessMatched) {
    // 89 dB SPL @ 1W/1m is reference unity (gain = 1.0). A missing value uses that reference and is
    // reported as a fallback by resolveSensitivity(); it is never manufacturer/measured data.
    const sens = resolveSensitivity(spec).valueDb;
    linearGain = Math.pow(10, (sens - SENSITIVITY_REFERENCE_DB) / 20);
  }

  // 5. Physical Distance Attenuation (1 / r free-field falloff, referenced to the 1 m sensitivity distance).
  // An omitted distance means the 1 m reference. A supplied but invalid distance is an error, not a silent
  // substitute: Math.max(0.5, NaN) is NaN and would poison every output sample.
  const rawDist = options?.distanceM;
  if (rawDist !== undefined && rawDist !== null && (typeof rawDist !== 'number' || !Number.isFinite(rawDist) || rawDist <= 0)) {
    throw new RangeError(`simulateSpeakerDSP: distanceM must be a finite number > 0 (got ${String(rawDist)}).`);
  }
  // 0.5 m is a documented near-field limit: a 1/r point-source law is not valid for a finite-size enclosure closer than this.
  const dist = rawDist == null ? 1.0 : Math.max(0.5, rawDist);
  linearGain /= dist;

  // 6. Directivity Attenuation based on off-axis angle
  if (options?.angleRad != null && !Number.isFinite(options.angleRad)) {
    throw new RangeError(`simulateSpeakerDSP: angleRad must be a finite number (got ${String(options.angleRad)}).`);
  }
  if (options?.angleRad != null) {
    const angleDeg = Math.abs(options.angleRad * 180 / Math.PI);
    // GENERIC, speaker-independent off-axis law (cosine of half-angle, floored at 0.1). This is NOT measured or
    // speaker-specific polar data; it exists for DSP regression tests only and must not be presented as such.
    const dirFactor = Math.max(0.1, Math.cos((angleDeg * Math.PI) / 360));
    linearGain *= dirFactor;
  }

  if (Math.abs(linearGain - 1.0) > 1e-4) {
    for (let i = 0; i < signal.length; i++) {
      signal[i] *= linearGain;
    }
  }

  return signal;
}
