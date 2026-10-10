import fs from 'fs';
import path from 'path';

export interface DirectivityData {
  brand: string;
  model: string;
  frequencies: number[];
  // Record of "azimuth,elevation" (in degrees) to array of magnitudes (dB relative to on-axis)
  // Azimuth: 0 to 359. Elevation: -90 (down) to 90 (up). 0 is forward on-axis.
  points: Record<string, number[]>;
  angularResolution: number; // e.g. 5 or 10 degrees
}

export function parseDirectivityFile(filePath: string): DirectivityData {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.gll') {
    throw new Error('GLL files are proprietary compiled binaries that require manufacturer DLLs. Please use open formats (CLF text or JSON).');
  }

  if (ext === '.json') {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    
    if (!data.frequencies || !Array.isArray(data.frequencies)) {
      throw new Error('Invalid JSON directivity format: missing frequencies array.');
    }
    if (!data.points || !Array.isArray(data.points)) {
      throw new Error('Invalid JSON directivity format: missing points array.');
    }

    const pointsMap: Record<string, number[]> = {};
    for (const pt of data.points) {
      if (typeof pt.azimuth !== 'number' || typeof pt.elevation !== 'number' || !Array.isArray(pt.magnitude)) {
        throw new Error('Malformed angular point in directivity data.');
      }
      pointsMap[`${pt.azimuth},${pt.elevation}`] = pt.magnitude;
    }

    const rawFrequencies = data.frequencies as unknown[];
    if (rawFrequencies.some(v => typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 24_000)) {
      throw new Error('Invalid JSON directivity format: every frequency must be finite, positive, and <= 24000 Hz.');
    }
    const originalFreqs = rawFrequencies as number[];
    const frequencies = [...originalFreqs].sort((a, b) => a - b);
    if (new Set(frequencies).size !== frequencies.length) {
      throw new Error('Invalid JSON directivity format: duplicate frequency bins are not allowed.');
    }
    if (frequencies.length === 0 || frequencies.length > 16) {
      throw new Error('Invalid JSON directivity format: frequencies must contain 1 to 16 finite positive values.');
    }

    // Every angular sample must have exactly one magnitude per frequency.
    // Reject malformed rows instead of letting an undefined array entry
    // become a silent omnidirectional fallback later in the solver.
    for (const [key, mags] of Object.entries(pointsMap)) {
      if (mags.length !== frequencies.length || mags.some(v => !Number.isFinite(v))) {
        throw new Error(`Invalid directivity magnitude row at ${key}.`);
      }
    }

    // JSON object keys are unordered. Re-index each row to the sorted
    // frequency order so interpolation is deterministic regardless of how
    // the manufacturer/exporter ordered its frequency list.
    const order = frequencies.map(f => originalFreqs.findIndex(v => v === f));
    const normalizedPoints: Record<string, number[]> = {};
    for (const [key, mags] of Object.entries(pointsMap)) {
      normalizedPoints[key] = order.map(i => mags[i]);
    }

    return {
      brand: typeof data.brand === 'string' ? data.brand : 'Unknown',
      model: typeof data.model === 'string' ? data.model : 'Unknown',
      frequencies,
      points: normalizedPoints,
      angularResolution: (() => {
        const v = data.angularResolution;
        if (!Number.isFinite(v) || v <= 0 || v > 90) throw new Error('Invalid JSON directivity format: angularResolution must be a finite value between 0 and 90 degrees.');
        return v;
      })()
    };
  }

  throw new Error(`Unsupported directivity file format: ${ext}`);
}

/**
 * Interpolates the directivity magnitude for a given frequency and direction.
 * Azimuth (0-359), Elevation (-90 to 90).
 */
export function getInterpolatedMagnitude(data: DirectivityData, freq: number, az: number, el: number): number {
  let normAz = az % 360;
  if (normAz < 0) normAz += 360;
  let normEl = Math.max(-90, Math.min(90, el));

  // Resolve the target frequency with linear interpolation between the two
  // surrounding supplied bins. The caller's coverage gate prevents extrapolation
  // outside the supported half-octave window. This preserves real measured
  // frequency trends instead of snapping every requested band to the nearest
  // polar dataset.
  const freqs = data.frequencies;
  let lo = 0;
  let hi = 0;
  if (freq <= freqs[0]) { lo = hi = 0; }
  else if (freq >= freqs[freqs.length - 1]) { lo = hi = freqs.length - 1; }
  else {
    for (let i = 0; i < freqs.length - 1; i++) {
      if (freqs[i] <= freq && freq <= freqs[i + 1]) { lo = i; hi = i + 1; break; }
    }
  }
  const freqT = lo === hi ? 0 : (freq - freqs[lo]) / (freqs[hi] - freqs[lo]);
  const magnitudeAtFrequency = (mags: number[]) => {
    const a = mags[lo];
    const b = mags[hi];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return a + (b - a) * freqT;
  };

  // Convert target to Cartesian on unit sphere
  const radAz = normAz * Math.PI / 180;
  const radEl = normEl * Math.PI / 180;
  const tx = Math.cos(radEl) * Math.cos(radAz);
  const ty = Math.cos(radEl) * Math.sin(radAz);
  const tz = Math.sin(radEl);

  let sumWeight = 0;
  let sumValue = 0;
  let exactMatch = false;
  let exactValue = 0;

  for (const key of Object.keys(data.points)) {
    const [pAzStr, pElStr] = key.split(',');
    const pAz = parseFloat(pAzStr);
    const pEl = parseFloat(pElStr);
    const mags = data.points[key];
    const val = magnitudeAtFrequency(mags);

    // Ignore invalid/missing values in the dataset.
    if (val === null) continue;

    const pRadAz = pAz * Math.PI / 180;
    const pRadEl = pEl * Math.PI / 180;
    const px = Math.cos(pRadEl) * Math.cos(pRadAz);
    const py = Math.cos(pRadEl) * Math.sin(pRadAz);
    const pz = Math.sin(pRadEl);

    // Euclidean distance in 3D space
    const distSq = (tx - px)**2 + (ty - py)**2 + (tz - pz)**2;

    if (distSq < 1e-8) {
      exactMatch = true;
      exactValue = val;
      break;
    }

    const weight = 1.0 / distSq;
    sumWeight += weight;
    sumValue += val * weight;
  }

  if (exactMatch) return exactValue;
  
  if (sumWeight === 0) {
    // Completely missing directivity data - fallback to 0 but we shouldn't really reach here if data is well-formed
    return 0;
  }

  return sumValue / sumWeight;
}


