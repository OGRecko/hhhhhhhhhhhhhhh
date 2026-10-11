/**
 * Shared speaker-database audit logic for scripts/speaker-quality-audit.mjs and scripts/final-audit.mjs.
 * Plain Node, no tsx and no network. It MIRRORS two rules from src/lib/speakerResponse.ts (it cannot import the
 * TypeScript) and then checks that the source still contains the rule it mirrors, so a drift fails the audit
 * instead of silently making the numbers here wrong.
 */

/** Same predicate as `publishedHz` in speakerResponse.ts: a published limit is a finite number > 0. */
export const isPublishedHz = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Classify one nullable field. `null` is the explicit "unknown" state; a missing key is reported separately
 * (raw JSON rows may predate the field; the app treats it as unknown too); anything else must be the right type.
 */
function classify(value, isValid) {
  if (value === undefined) return 'absent';
  if (value === null) return 'unknown';
  return isValid(value) ? 'known' : 'invalid';
}
const validDriverCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const validBool = (v) => typeof v === 'boolean';

/** driverCount / active / panel null-state accounting over the raw database records. */
export function auditNullableFlags(data) {
  const fields = { driverCount: validDriverCount, active: validBool, panel: validBool };
  const counts = Object.fromEntries(Object.keys(fields).map((f) => [f, { known: 0, unknown: 0, absent: 0, invalid: 0 }]));
  const problems = [];
  const warnings = [];
  let legacyWithConcreteFlags = 0;
  let recordsWithoutDriverCountOrPanelButWithActive = 0;
  for (const s of data) {
    for (const [f, ok] of Object.entries(fields)) {
      const state = classify(s?.[f], ok);
      counts[f][state]++;
      if (state === 'invalid') problems.push(`${s?.id}: ${f} must be ${f === 'driverCount' ? 'a positive integer' : 'a boolean'} or null (unknown), got ${JSON.stringify(s[f])}`);
    }
    // normalizeSpeakerSpec() documents that LEGACY rows carry NO driver/active/panel knowledge (all null).
    if (s?.overallStatus === 'LEGACY' && (s.driverCount != null || s.active != null || s.panel != null)) legacyWithConcreteFlags++;
    if (s?.driverCount === undefined && s?.panel === undefined && typeof s?.active === 'boolean') recordsWithoutDriverCountOrPanelButWithActive++;
  }
  if (legacyWithConcreteFlags > 0) {
    warnings.push(`${legacyWithConcreteFlags} LEGACY record(s) store concrete driverCount/active/panel values although the legacy source recorded none (normalizeSpeakerSpec documents these as null/unknown). The raw data asserts facts that were never recorded.`);
  }
  if (recordsWithoutDriverCountOrPanelButWithActive > 0) {
    warnings.push(`${recordsWithoutDriverCountOrPanelButWithActive} record(s) have a boolean "active" but no driverCount or panel key; this audit cannot confirm where that boolean came from.`);
  }
  return { counts, legacyWithConcreteFlags, recordsWithoutDriverCountOrPanelButWithActive, problems, warnings };
}

const responsePointStatus = (type) => type === 'MANUFACTURER' ? 'MANUFACTURER_VERIFIED'
  : type === 'MEASUREMENT' ? 'MEASUREMENT_VERIFIED'
  : type === 'REPUTABLE_DATABASE' ? 'REPUTABLE_DATABASE_VERIFIED' : null;

/** Structural/provenance checks for published point tables embedded in a speaker response field. */
export function isValidResponsePointTable(response) {
  const points = response?.points;
  const expectedStatus = responsePointStatus(response?.pointsSourceType);
  return Array.isArray(points) && points.length >= 2 && expectedStatus !== null &&
    response?.pointsStatus === expectedStatus && typeof response?.pointsSource === 'string' &&
    /^https:\/\//.test(response.pointsSource) && typeof response?.pointsContext === 'string' &&
    response.pointsContext.trim().length >= 20 && points.every((point, i) =>
      Number.isFinite(point?.hz) && point.hz > 0 && Number.isFinite(point?.db) &&
      (i === 0 || point.hz > points[i - 1].hz));
}

/** Report source/provenance/shape problems without claiming that this static audit fetches or verifies the URL. */
export function auditResponsePoints(data) {
  const problems = [];
  const counts = { total: 0, manufacturer: 0, measurement: 0, reputable_database: 0 };
  const metadataKeys = ['pointsStatus', 'pointsSource', 'pointsSourceType', 'pointsContext'];
  for (const s of data) {
    const response = s?.frequencyResponse;
    // An explicit UNAVAILABLE/NONE state is the documented "no point table" value, not provenance.
    const hasMetadata = metadataKeys.some((key) => Object.prototype.hasOwnProperty.call(response ?? {}, key) && ![undefined, null, 'UNAVAILABLE', 'NONE'].includes(response[key]));
    if (!Array.isArray(response?.points) || response.points.length === 0) {
      if (hasMetadata) problems.push(`${s?.id}: response-point provenance exists without a non-empty point table`);
      if (response?.points != null && !Array.isArray(response.points)) problems.push(`${s?.id}: frequencyResponse.points must be an array`);
      continue;
    }
    counts.total++;
    if (response.pointsSourceType === 'MANUFACTURER') counts.manufacturer++;
    else if (response.pointsSourceType === 'MEASUREMENT') counts.measurement++;
    else if (response.pointsSourceType === 'REPUTABLE_DATABASE') counts.reputable_database++;
    if (!isValidResponsePointTable(response)) {
      problems.push(`${s?.id}: response points require >=2 finite, strictly frequency-ordered points, HTTPS source, matching verified status, recognized source type, and context`);
    }
  }
  return { counts, problems };
}

/**
 * How many speakers' modeled response is a GENERIC REFERENCE (isGenericReference === true), i.e. at least one
 * frequency limit is not published and getSpeakerResponseModel() used the neutral reference edge for that side.
 * Speakers with an explicit curve in KNOWN_SPEAKER_CURVES or a structurally source-backed point table are never generic.
 */
export function countGenericReference(data, knownCurveIds) {
  const known = new Set(knownCurveIds);
  const out = { total: 0, missingBothLimits: 0, missingLowOnly: 0, missingHighOnly: 0, modeledFromPublishedLimits: 0, explicitCurves: 0, speakers: data.length };
  for (const s of data) {
    if (known.has(s?.id) || isValidResponsePointTable(s?.frequencyResponse)) { out.explicitCurves++; continue; }
    const lowOk = isPublishedHz(s?.frequencyResponse?.low_hz);
    const highOk = isPublishedHz(s?.frequencyResponse?.high_hz);
    if (lowOk && highOk) { out.modeledFromPublishedLimits++; continue; }
    out.total++;
    if (!lowOk && !highOk) out.missingBothLimits++;
    else if (!lowOk) out.missingLowOnly++;
    else out.missingHighOnly++;
  }
  return out;
}

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/**
 * Confirms the response model really is the published-limits model: the mirrored rule is still present, the
 * isGenericReference flag is still produced, and getSpeakerResponseModel() contains no category-based logic
 * (the removed category synthesis). Comments are ignored, so explanatory text cannot trip or hide it.
 */
export function checkResponseModelSource(responseSource) {
  const problems = [];
  if (!/const publishedHz = \(v: unknown\): number \| null => \(typeof v === 'number' && Number\.isFinite\(v\) && v > 0 \? v : null\)/.test(responseSource)) {
    problems.push('speakerResponse.ts: publishedHz() no longer matches the rule mirrored by scripts/lib/speakerAuditCore.mjs (finite number > 0); update the audit');
  }
  if (!/isGenericReference\s*=\s*referenceBounds\.length\s*>\s*0/.test(responseSource)) {
    problems.push('speakerResponse.ts: isGenericReference is no longer derived from unpublished limits (referenceBounds.length > 0); update the audit');
  }
  const start = responseSource.indexOf('export function getSpeakerResponseModel');
  if (start === -1) {
    problems.push('speakerResponse.ts: getSpeakerResponseModel not found');
  } else {
    const next = responseSource.indexOf('\nexport ', start + 10);
    const body = stripComments(responseSource.slice(start, next === -1 ? undefined : next));
    const sourcedPointGatePresent = /pointsAreSourceBacked\s*=\s*Array\.isArray\(rawPoints\)/.test(body) &&
      /response\?\.pointsStatus\s*===\s*expectedPointStatus/.test(body) &&
      /response\?\.pointsSource/.test(body) && /https:/.test(body) &&
      /response\?\.pointsContext/.test(body) && /point\.hz\s*>\s*rawPoints\[i - 1\]\.hz/.test(body);
    if (!sourcedPointGatePresent) {
      problems.push('speakerResponse.ts: explicit response points are not gated by separate verified source, status, context, HTTPS URL, and strictly increasing frequencies; update the audit');
    }
    const hits = [...body.matchAll(/\b(category|guitar-cab|car-audio|subwoofer|CATEGORY_[A-Z_]+)\b/g)].map((m) => m[1]);
    if (hits.length) problems.push(`speakerResponse.ts: getSpeakerResponseModel() references category-based synthesis (${[...new Set(hits)].join(', ')})`);
  }
  return { ok: problems.length === 0, problems };
}

/** Ids of explicit curves declared in KNOWN_SPEAKER_CURVES with their declared provenance. */
export function parseKnownCurves(responseSource) {
  const ids = [...responseSource.matchAll(/^\s*'([^']+)':\s*\{/gm)].map((m) => m[1]);
  const manufacturer = new Set();
  const modeled = new Set();
  for (const m of responseSource.matchAll(/^\s*'([^']+)':\s*\{([\s\S]*?)^\s*\},?$/gm)) {
    if (/provenance:\s*'manufacturer'/.test(m[2])) manufacturer.add(m[1]);
    if (/provenance:\s*'physically_modeled'/.test(m[2])) modeled.add(m[1]);
  }
  return { ids, manufacturer, modeled };
}

/**
 * Round 4 withdrawal and exclusion rules (static, no network):
 *  - a driverCount/active value must be null when its provenance status is UNSOURCED (withdrawn, not inferred);
 *  - a third-party sensitivity must be marked simulationExcluded (dealer evidence is not a simulation input);
 *  - any disputed response-point table must be marked simulationExcluded with a reason (quarantine, not deletion);
 *  - a value's provenance must carry a URL whenever it is not UNSOURCED.
 */
export function auditWithdrawalAndExclusionRules(data) {
  const problems = [];
  for (const s of data) {
    for (const [f, pk] of [['driverCount', 'driverCountProvenance'], ['active', 'activeProvenance']]) {
      const status = s?.[pk]?.status;
      if (status === 'UNSOURCED' && s?.[f] !== null) problems.push(`${s?.id}: ${f} is set but its provenance is UNSOURCED (must be null)`);
      if (status && status !== 'UNSOURCED' && !/^https?:\/\//i.test(String(s?.[pk]?.source || ''))) problems.push(`${s?.id}: ${f} provenance ${status} has no URL`);
    }
    const dp = s?.frequencyResponse?.disputedPoints;
    if (dp && (dp.simulationExcluded !== true || typeof dp.exclusionReason !== 'string' || dp.exclusionReason.trim().length < 20)) problems.push(`${s?.id}: disputedPoints must be simulationExcluded with an exclusionReason`);
  }
  return problems;
}
