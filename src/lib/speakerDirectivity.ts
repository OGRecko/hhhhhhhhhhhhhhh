/**
 * Dedicated directivity dataset structure for speaker records.
 *
 * A dataset is stored only when it can be tied to an exact model and revision, its source URL and file checksum are
 * recorded, its licence is stated, and its measurement conditions and coordinate convention are documented.
 * status VERIFIED is accepted only when validateSpeakerDirectivity() returns no problems. Records must never be
 * marked VERIFIED to make counts look better; a dataset that cannot pass every check stays out of the record.
 */

export type DirectivitySourceType = 'MANUFACTURER' | 'MEASUREMENT' | 'REPUTABLE_DATABASE' | 'THIRD_PARTY';

/** One angular cut. levelsDb[i][j] is the level at frequenciesHz[i] and angles[j], relative to the stated reference. */
export interface DirectivityCut {
  angles: number[];
  frequenciesHz: number[];
  levelsDb: number[][];
}

export interface SpeakerDirectivityDataset {
  status: 'UNVERIFIED' | 'VERIFIED';
  sourceUrl: string;
  sourceType: DirectivitySourceType;
  doi: string | null;
  licence: string;
  fileName: string;
  fileChecksum: { algorithm: 'md5' | 'sha256'; value: string } | null;
  /** Exact model name as published by the source, including suffix. */
  model: string;
  /** Revision, variant or region designation documented by the source. null only when the source states none. */
  revision: string | null;
  measurementConditions: string;
  /** Angle origin and sense of rotation, e.g. azimuth clockwise from the loudspeaker axis. */
  coordinateConvention: string;
  frequencyCoverageHz: { min: number; max: number } | null;
  horizontal: DirectivityCut | null;
  vertical: DirectivityCut | null;
}

const SOURCE_TYPES: readonly DirectivitySourceType[] = ['MANUFACTURER', 'MEASUREMENT', 'REPUTABLE_DATABASE', 'THIRD_PARTY'];
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function validateCut(name: 'horizontal' | 'vertical', cut: unknown, problems: string[]): void {
  if (cut === null || cut === undefined) return;
  const c = cut as Partial<DirectivityCut>;
  if (!Array.isArray(c.angles) || c.angles.length < 2 || !c.angles.every(Number.isFinite)) {
    problems.push(`${name}.angles must be at least two finite numbers`);
    return;
  }
  if (!c.angles.every((a, i) => i === 0 || a > (c.angles as number[])[i - 1])) problems.push(`${name}.angles must be strictly ascending`);
  if (!Array.isArray(c.frequenciesHz) || c.frequenciesHz.length < 1 || !c.frequenciesHz.every((f) => Number.isFinite(f) && f > 0)) {
    problems.push(`${name}.frequenciesHz must be positive finite numbers`);
    return;
  }
  if (!c.frequenciesHz.every((f, i) => i === 0 || f > (c.frequenciesHz as number[])[i - 1])) problems.push(`${name}.frequenciesHz must be strictly ascending`);
  if (!Array.isArray(c.levelsDb) || c.levelsDb.length !== c.frequenciesHz.length) {
    problems.push(`${name}.levelsDb must have one row per frequency`);
    return;
  }
  c.levelsDb.forEach((row, i) => {
    if (!Array.isArray(row) || row.length !== c.angles!.length || !row.every(Number.isFinite)) {
      problems.push(`${name}.levelsDb row ${i} must have one finite level per angle`);
    }
  });
}

/** Returns every problem found. An empty array means the structure is complete and internally consistent. */
export function validateSpeakerDirectivity(d: unknown): string[] {
  const problems: string[] = [];
  if (!d || typeof d !== 'object') return ['directivity dataset must be an object'];
  const x = d as Partial<SpeakerDirectivityDataset>;
  if (x.status !== 'UNVERIFIED' && x.status !== 'VERIFIED') problems.push('status must be UNVERIFIED or VERIFIED');
  if (!isNonEmptyString(x.sourceUrl) || !/^https:\/\//.test(x.sourceUrl)) problems.push('sourceUrl must be an https URL');
  if (!SOURCE_TYPES.includes(x.sourceType as DirectivitySourceType)) problems.push('sourceType is not recognised');
  if (!isNonEmptyString(x.licence)) problems.push('licence must be stated');
  if (!isNonEmptyString(x.fileName)) problems.push('fileName must be stated');
  if (x.fileChecksum !== null && x.fileChecksum !== undefined) {
    const cs = x.fileChecksum as { algorithm?: unknown; value?: unknown };
    if (!['md5', 'sha256'].includes(cs.algorithm as string) || !isNonEmptyString(cs.value)) problems.push('fileChecksum must name md5 or sha256 and give its value');
  }
  if (!isNonEmptyString(x.model)) problems.push('model must name the exact model');
  if (x.revision !== null && !isNonEmptyString(x.revision)) problems.push('revision must be a non-empty string or null');
  if (!isNonEmptyString(x.measurementConditions)) problems.push('measurementConditions must be stated');
  if (!isNonEmptyString(x.coordinateConvention)) problems.push('coordinateConvention must be stated');
  if (x.frequencyCoverageHz !== null && x.frequencyCoverageHz !== undefined) {
    const fc = x.frequencyCoverageHz as { min?: unknown; max?: unknown };
    if (!(Number.isFinite(fc.min) && Number.isFinite(fc.max) && (fc.min as number) > 0 && (fc.max as number) > (fc.min as number))) problems.push('frequencyCoverageHz must have 0 < min < max');
  }
  validateCut('horizontal', x.horizontal, problems);
  validateCut('vertical', x.vertical, problems);
  if (x.horizontal == null && x.vertical == null) problems.push('at least one of horizontal or vertical data is required');
  if (x.status === 'VERIFIED' && (x.fileChecksum == null)) problems.push('a VERIFIED dataset requires a file checksum');
  return problems;
}

/** Only a dataset with status VERIFIED and no validation problems may feed the simulator. */
export function isUsableDirectivity(d: unknown): d is SpeakerDirectivityDataset {
  return !!d && (d as { status?: unknown }).status === 'VERIFIED' && validateSpeakerDirectivity(d).length === 0;
}
