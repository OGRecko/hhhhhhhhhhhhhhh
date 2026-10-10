export interface AcousticComparison {
  sampleCount: number;
  mae: number | null;
  rmse: number | null;
  correlation: number | null;
  peakDelaySamples: number | null;
  simulatedPeak: number | null;
  measuredPeak: number | null;
}

function finiteSamples(values: number[]): boolean {
  return Array.isArray(values) && values.every(v => typeof v === 'number' && Number.isFinite(v));
}

function peakIndex(values: number[]): { index: number; value: number; magnitude: number } | null {
  let index = -1;
  let magnitude = 0;
  for (let i = 0; i < values.length; i++) {
    const m = Math.abs(values[i]);
    if (m > magnitude) {
      magnitude = m;
      index = i;
    }
  }
  return index >= 0 && magnitude > 0 ? { index, value: values[index], magnitude } : null;
}

/**
 * Compare two impulse-response traces without allowing pathological input to
 * produce NaN/Infinity. The traces are compared over their common prefix;
 * this is intentional because the caller may have different capture lengths.
 * Peak timing is reported only when both traces contain a non-zero finite peak.
 */
export function compareImpulseResponses(measured: number[], simulated: number[]): AcousticComparison {
  const n = Math.min(measured?.length ?? 0, simulated?.length ?? 0);
  const empty: AcousticComparison = {
    sampleCount: n,
    mae: null,
    rmse: null,
    correlation: null,
    peakDelaySamples: null,
    simulatedPeak: null,
    measuredPeak: null,
  };
  if (n < 2 || !finiteSamples(measured) || !finiteSamples(simulated)) return empty;

  let abs = 0;
  let sq = 0;
  let am = 0;
  let as = 0;
  for (let i = 0; i < n; i++) {
    const m = measured[i];
    const s = simulated[i];
    const d = s - m;
    abs += Math.abs(d);
    sq += d * d;
    am += m;
    as += s;
  }
  const mae = abs / n;
  const rmse = Math.sqrt(sq / n);
  if (!Number.isFinite(mae) || !Number.isFinite(rmse)) return empty;

  am /= n;
  as /= n;
  let numerator = 0;
  let measuredEnergy = 0;
  let simulatedEnergy = 0;
  for (let i = 0; i < n; i++) {
    const a = measured[i] - am;
    const b = simulated[i] - as;
    numerator += a * b;
    measuredEnergy += a * a;
    simulatedEnergy += b * b;
  }
  const denominator = Math.sqrt(measuredEnergy * simulatedEnergy);
  const correlation = denominator > 0 ? numerator / denominator : null;
  const safeCorrelation = correlation !== null && Number.isFinite(correlation)
    ? Math.max(-1, Math.min(1, correlation))
    : null;

  const mp = peakIndex(measured.slice(0, n));
  const sp = peakIndex(simulated.slice(0, n));
  const peakDelaySamples = mp && sp ? sp.index - mp.index : null;
  return {
    sampleCount: n,
    mae,
    rmse,
    correlation: safeCorrelation,
    peakDelaySamples,
    simulatedPeak: sp?.value ?? null,
    measuredPeak: mp?.value ?? null,
  };
}
