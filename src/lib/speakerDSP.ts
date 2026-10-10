// speakerDSP.ts
// Derives a Web Audio filter chain from published speaker response limits and
// verified sensitivity where available. This is a physically-motivated approximation,
// not a lab-measured impulse response. Driver size, power, era, and active/passive
// status are not used to invent nonlinear or spectral coloration.

import { getSpeakerResponseModel, interpolateLogFrequency, solveBandGains, resolveSensitivity, SENSITIVITY_REFERENCE_DB, type ResolvedSensitivity, DSP_BAND_CENTERS_HZ, DSP_PEAK_Q, DSP_MIN_PEAK_GAIN_DB, type ResponsePoint } from './speakerResponse';

export type VerificationStatus = 'MANUFACTURER_VERIFIED' | 'MEASUREMENT_VERIFIED' | 'REPUTABLE_DATABASE_VERIFIED' | 'ESTIMATED' | 'UNAVAILABLE' | 'LEGACY';
export type SourceType = 'MANUFACTURER' | 'MEASUREMENT' | 'REPUTABLE_DATABASE' | 'RETAILER' | 'ESTIMATED' | 'UNKNOWN' | 'NONE';

export interface SpecField<T> {
  value: T | null;
  unit: string;
  status: VerificationStatus;
  source: string | null;
  sourceType: SourceType;
  /** Measurement reference for sensitivity, e.g. '1W/1m' or '2.83V/1m'. */
  reference?: string;
  /** Semantic meaning of a power value; prevents recommended-amplifier/internal-amplifier values from being used as speaker power handling. */
  role?: 'speaker_power_handling' | 'program_rating' | 'allowable_input' | 'amplifier_output' | 'recommended_amplifier' | 'unknown';
}

export type OverallStatus = 'FULLY_VERIFIED' | 'PARTIALLY_VERIFIED' | 'UNVERIFIED' | 'MEASUREMENT_VERIFIED' | 'LEGACY' | 'UNAVAILABLE';

export interface SpeakerSpec {
  id: string;
  brand: string;
  model: string;
  category: string;
  year: number | null;
  overallStatus: OverallStatus;
  /** null = unknown (legacy records). Never a guessed count. */
  driverCount: number | null;
  /** null = unknown whether the speaker has onboard amplification/DSP. */
  active: boolean | null;
  /** null = unknown whether the radiator is a planar/panel design. */
  panel: boolean | null;
  notes: string | null;

  frequencyResponse: {
    low_hz: number | null;
    high_hz: number | null;
    status: VerificationStatus;
    source: string | null;
    sourceType: SourceType;
    points?: ResponsePoint[];
    /** Provenance for an explicitly published/measured response point table; separate from range-limit provenance. */
    pointsStatus?: VerificationStatus;
    pointsSource?: string | null;
    pointsSourceType?: SourceType;
    pointsContext?: string;
  };
  sensitivity: SpecField<number>;
  power: SpecField<number>;
  impedance: SpecField<number>;
  resonantFreq: SpecField<number>;
  voiceCoil: SpecField<number>;
  woofer: SpecField<number>;
}

export interface SpeakerAudioChain {
  input: GainNode;
  output: GainNode;
  nodes: AudioNode[];
  /** Sensitivity actually applied: value, source, and whether the 89 dB reference fallback was used (never manufacturer data). */
  sensitivity: ResolvedSensitivity;
  dispose: () => void;
}

export interface SpeakerChainOptions {
  loudnessMatched?: boolean;
  distanceM?: number;
  angleRad?: number;
}

// Some historical callers still pass pre-schema records; this function performs structural normalization only and
// does not create or infer physical speaker specifications.
//
// This function does SCHEMA normalization only: it makes a record structurally complete so downstream code does
// not crash on missing fields. It must NOT create physical speaker specifications. Every physical property the
// legacy record does not contain stays unknown (null) and consumers must handle that state:
//   - driverCount / active / panel  -> null (unknown), not 2 / false / false
//   - frequency limits, power, impedance, Fs, voice coil, woofer size -> value null, status UNAVAILABLE
// The sensitivity value (if the legacy list has one) is carried over unchanged; its provenance handling is
// resolveSensitivity()'s job and is not altered here.
export function normalizeSpeakerSpec(raw: LegacySpeakerRecord | SpeakerSpec): SpeakerSpec {
  if (raw.overallStatus !== "LEGACY") return raw as SpeakerSpec;
  const legacy = raw as LegacySpeakerRecord;

  const sensValue = legacy.sensitivity?.value ?? legacy.sens_db ?? null;
  const unavailable = <T,>(unit: string): SpecField<T> => ({ value: null, unit, status: 'UNAVAILABLE', source: null, sourceType: 'NONE' });

  return {
    id: legacy.id || 'unknown',
    brand: legacy.brand || 'Unknown',
    model: legacy.model || 'Unknown',
    category: legacy.category || 'unknown',
    year: legacy.year || null,
    overallStatus: 'LEGACY',
    driverCount: null,
    active: null,
    panel: null,
    notes: [legacy.notes, 'Legacy entry: only brand, model, year, category and sensitivity are recorded. Driver, frequency, power and impedance specifications are unavailable.'].filter(Boolean).join(' '),
    frequencyResponse: { low_hz: null, high_hz: null, status: 'UNAVAILABLE', source: null, sourceType: 'NONE' },
    sensitivity: { value: sensValue, unit: 'dB', status: 'UNAVAILABLE', source: null, sourceType: 'NONE', reference: sensValue == null ? undefined : '1W/1m' },
    power: unavailable<number>('W'),
    impedance: unavailable<number>('ohm'),
    resonantFreq: unavailable<number>('Hz'),
    voiceCoil: unavailable<number>('in'),
    woofer: unavailable<number>('in'),
  };
}

/** Shape of a pre-schema entry from the legacy speakers.ts list (only these fields are ever present). */
export interface LegacySpeakerRecord {
  id?: string;
  brand?: string;
  model?: string;
  category?: string;
  year?: number | null;
  notes?: string | null;
  sens_db?: number | null;
  sensitivity?: { value?: number | null } | null;
  overallStatus: string;
}

/**
 * Build an auditable speaker-audition chain from explicit response-envelope and sensitivity data.
 * No speaker coloration is inferred from category, era, driver count, power handling, or active/passive state.
 * Nonlinear behavior and directivity require explicit measured/manufacturer datasets and are not fabricated here.
 */
export function buildSpeakerChain(
  ctx: AudioContext,
  rawSpec: SpeakerSpec,
  options?: SpeakerChainOptions
): SpeakerAudioChain {
  const spec = normalizeSpeakerSpec(rawSpec);
  const responseModel = getSpeakerResponseModel(spec);
  const input = ctx.createGain();
  const output = ctx.createGain();
  const nodes: AudioNode[] = [];

  // Gain staging: physical sensitivity, distance, and generic preview angle.
  const gainNode = ctx.createGain();
  let linearGain = 1.0;
  if (!options?.loudnessMatched) {
    // Single authoritative resolver: rejects 0 / negative / NaN / Infinity / non-numeric and flags fallback use.
    const sens = resolveSensitivity(spec).valueDb;
    linearGain = Math.pow(10, (sens - SENSITIVITY_REFERENCE_DB) / 20);
  }
  if (options?.distanceM != null) {
    if (typeof options.distanceM !== 'number' || !Number.isFinite(options.distanceM) || options.distanceM <= 0) {
      throw new RangeError(`buildSpeakerChain: distanceM must be a finite number > 0 (got ${String(options.distanceM)}).`);
    }
    const d = Math.max(0.5, options.distanceM);
    linearGain /= d;
  }
  if (options?.angleRad != null) {
    if (typeof options.angleRad !== 'number' || !Number.isFinite(options.angleRad)) {
      throw new RangeError(`buildSpeakerChain: angleRad must be a finite number (got ${String(options.angleRad)}).`);
    }
    const deg = Math.abs((options.angleRad * 180) / Math.PI);
    const dirFactor = Math.max(0.1, Math.cos((deg * Math.PI) / 360));
    linearGain *= dirFactor;
  }
  gainNode.gain.value = linearGain;
  nodes.push(gainNode);

  // The audition path uses only the speaker response envelope and documented sensitivity/distance scaling.
  // It deliberately does not invent nonlinear saturation, compression, guitar-cab resonance, or other speaker
  // character from category/power/era metadata. Those effects require measured or manufacturer response data.

  // ---- 1-3. Low shelf + peaking bank + high shelf. Band gains are SOLVED (shared with the offline DSP) so the
  // cascade matches the response model at the seven octave centers instead of overshooting from filter overlap. ----
  const sol = solveBandGains(responseModel, ctx.sampleRate);
  const lowShelf = ctx.createBiquadFilter();
  lowShelf.type = "lowshelf";
  lowShelf.frequency.value = clamp(responseModel.low_hz, 20, 300);
  lowShelf.gain.value = sol.lowShelfGainDb;
  nodes.push(lowShelf);

  const peakFilters: BiquadFilterNode[] = [];
  DSP_BAND_CENTERS_HZ.forEach((centerHz, j) => {
    if (Math.abs(sol.peakGainsDb[j]) < DSP_MIN_PEAK_GAIN_DB) return;
    const peak = ctx.createBiquadFilter();
    peak.type = "peaking";
    peak.frequency.value = centerHz;
    peak.Q.value = DSP_PEAK_Q;
    peak.gain.value = sol.peakGainsDb[j];
    peakFilters.push(peak);
    nodes.push(peak);
  });

  const highShelf = ctx.createBiquadFilter();
  highShelf.type = "highshelf";
  highShelf.frequency.value = clamp(responseModel.high_hz, 4000, 16000);
  highShelf.gain.value = sol.highShelfGainDb;
  nodes.push(highShelf);

  // No synthetic saturation or dynamics are added: power handling and active/passive status are not enough to
  // derive a physically correct nonlinear transfer function.

  // Wire the chain: input -> lowShelf -> [peakFilters] -> highShelf -> gainNode -> output
  let prev: AudioNode = input;
  prev.connect(lowShelf);
  prev = lowShelf;

  for (const pf of peakFilters) {
    prev.connect(pf);
    prev = pf;
  }

  prev.connect(highShelf);
  highShelf.connect(gainNode);
  gainNode.connect(output);

  return {
    input,
    output,
    nodes: [gainNode, lowShelf, ...peakFilters, highShelf],
    sensitivity: resolveSensitivity(spec),
    dispose: () => {
      nodes.forEach((n) => {
        try {
          n.disconnect();
        } catch {
          /* already disconnected */
        }
      });
    },
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
