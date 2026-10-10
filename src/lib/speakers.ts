// Adapter over the merged speaker library (src/data/speakers.json).
//
// This file contains the unified current speaker database. Unknown physical specifications remain null and are never invented.
// No entries are duplicated.

import speakerData from '../data/speakers.json';
import type { SpeakerSpec, VerificationStatus } from './speakerDSP';
import { resolveSensitivity } from './speakerResponse';

// Back-compat shape used by RightSidebar.tsx / useStore.ts
export interface SpeakerEntry {
  id: string;
  brand: string;
  model: string;
  /** null when the exact model year is not source-backed. */
  year: number | null;
  type: string;
  manufacturerSensitivityDb: number | null;
  estimatedSensitivityDb: number | null;
  sensitivitySource: 'manufacturer' | 'measurement' | 'estimated' | 'unavailable';
  sensitivityStatus: VerificationStatus;
  sensitivityReference: string | null;
  impedanceOhm: number | null;
  /** True when no sensitivity value exists and the DSP/SPL use the neutral 89 dB reference instead. */
  sensitivityIsFallback: boolean;
  /** True only when the complete record is explicitly FULLY_VERIFIED. PARTIALLY_VERIFIED and UNVERIFIED are intentionally not treated as fully verified. */
  verified: boolean;
  verificationStatus: string;
}

const CATEGORY_TO_TYPE: Record<string, string> = {
  'studio-monitor': 'Active Studio Monitor',
  'bookshelf': 'Passive Bookshelf',
  'floor-standing': 'Floorstanding',
  'pa': 'PA System',
  'ceiling': 'Ceiling Speaker',
  'in-wall': 'In-Wall',
  'subwoofer': 'Subwoofer',
  'portable': 'Portable',
  'soundbar': 'Soundbar',
  'car-audio': 'Car Audio',
  'guitar-cab': 'Guitar Cabinet',
  'smart-speaker': 'Smart Speaker',
};

export const SPEAKER_SPECS = speakerData as unknown as SpeakerSpec[];

export const SPEAKERS: SpeakerEntry[] = SPEAKER_SPECS.map(s => {
  // `|| null` would turn a legitimate 0 into null; only a genuinely absent
  // value should become null.
  const sens = s.sensitivity?.value ?? null;

  return {
    id: s.id,
    brand: s.brand,
    model: s.model,
    year: s.year ?? null,
    type: CATEGORY_TO_TYPE[s.category] ?? s.category,
    manufacturerSensitivityDb: sens,
    estimatedSensitivityDb: null,
    // sensitivitySource is derived from sourceType, but LEGACY-status
    // entries carry sourceType 'NONE' even when they do have a numeric
    // sensitivity value (the value came from the old flat legacy list, not
    // a re-verified source) — previously that fell through to 'unavailable'
    // here even while manufacturerSensitivityDb below was populated with a
    // real number, which is self-contradictory (a value with an
    // "unavailable" source). Check status === 'LEGACY' first so this stays
    // honest about where the number actually came from.
    sensitivitySource: !sens ? 'unavailable' :
      s.sensitivity?.status === 'LEGACY' ? 'estimated' :
      s.sensitivity?.sourceType === 'MANUFACTURER' ? 'manufacturer' :
      s.sensitivity?.sourceType === 'MEASUREMENT' ? 'measurement' :
      s.sensitivity?.sourceType === 'ESTIMATED' ? 'estimated' : 'unavailable',
    sensitivityStatus: s.sensitivity?.status || 'UNAVAILABLE',
    sensitivityReference: s.sensitivity?.reference ?? null,
    impedanceOhm: s.impedance?.value ?? null,
    sensitivityIsFallback: resolveSensitivity(s).isFallback,
    verified: s.overallStatus === 'FULLY_VERIFIED',
    verificationStatus: s.overallStatus || 'UNAVAILABLE',
  };
});

const BRANDS = Array.from(new Set(SPEAKERS.map(s => s.brand))).sort();
const TYPES = Array.from(new Set(SPEAKERS.map(s => s.type))).sort();

// O(1) lookup by id, computed once at module load rather than re-scanning
// the array on every lookup.
const SPEAKER_BY_ID = new Map(SPEAKER_SPECS.map(s => [s.id, s]));

export function getSpeakerById(id: string) {
  return SPEAKER_BY_ID.get(id);
}

export { BRANDS, TYPES };
