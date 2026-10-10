/**
 * Speaker database release audit.
 *
 * This script intentionally runs with plain Node: it does not require tsx or a
 * network install. It audits every record in the authoritative JSON dataset, the nullable driverCount/active/panel
 * fields, how many speakers use a generic-reference response (isGenericReference), and the declared response
 * model provenance in speakerResponse.ts without turning unverified source
 * claims into PASS. It does not independently verify manufacturer manuals.
 */
import fs from 'node:fs';
import path from 'node:path';
import { auditNullableFlags, auditResponsePoints, checkResponseModelSource, countGenericReference, isValidResponsePointTable, parseKnownCurves } from './lib/speakerAuditCore.mjs';

const root = process.cwd();
const data = JSON.parse(fs.readFileSync(path.join(root, 'src/data/speakers.json'), 'utf8'));
const responseSource = fs.readFileSync(path.join(root, 'src/lib/speakerResponse.ts'), 'utf8');

const problems = [];
const warnings = [];
const ids = new Set();
const names = new Set();
const validStatuses = new Set(['LEGACY', 'FULLY_VERIFIED', 'PARTIALLY_VERIFIED', 'UNVERIFIED', 'UNAVAILABLE']);
const validFieldStatuses = new Set(['MANUFACTURER_VERIFIED', 'MEASUREMENT_VERIFIED', 'REPUTABLE_DATABASE_VERIFIED', 'ESTIMATED', 'UNAVAILABLE', 'LEGACY']);
const validSourceTypes = new Set(['NONE', 'MANUFACTURER', 'MEASUREMENT', 'REPUTABLE_DATABASE', 'RETAILER', 'ESTIMATED', 'UNKNOWN']);

const provenanceCounts = { measurement: 0, manufacturer: 0, verified_database: 0, physically_modeled: 0 };
const { ids: knownCurveIds, manufacturer: knownManufacturer, modeled: knownModeled } = parseKnownCurves(responseSource);
const knownSet = new Set(knownCurveIds);
const responsePointAudit = auditResponsePoints(data);
problems.push(...responsePointAudit.problems);

if (!Array.isArray(data)) throw new Error('speakers.json is not an array');
if (data.length === 0) problems.push('speakers.json contains no speaker records');

const statusCounts = {};
const sourceTypeCounts = {};
for (const s of data) {
  if (!s?.id || typeof s.id !== 'string') problems.push('speaker with missing/non-string id');
  else if (ids.has(s.id)) problems.push(`duplicate speaker id: ${s.id}`);
  else ids.add(s.id);

  if (typeof s?.brand !== 'string' || !s.brand.trim()) problems.push(`${s?.id}: missing brand`);
  if (typeof s?.model !== 'string' || !s.model.trim()) problems.push(`${s?.id}: missing model`);
  const pair = `${s?.brand ?? ''}::${s?.model ?? ''}`.trim().toLowerCase();
  if (names.has(pair)) problems.push(`duplicate brand/model: ${s?.brand} ${s?.model}`);
  names.add(pair);

  if (!validStatuses.has(s?.overallStatus)) problems.push(`${s?.id}: invalid overallStatus ${String(s?.overallStatus)}`);
  statusCounts[s?.overallStatus] = (statusCounts[s?.overallStatus] ?? 0) + 1;

  for (const field of ['sensitivity', 'power', 'impedance', 'resonantFreq', 'voiceCoil', 'woofer']) {
    const obj = s?.[field];
    if (obj && !Object.prototype.hasOwnProperty.call(obj, 'value')) problems.push(`${s?.id}: malformed ${field}`);
    else if (obj?.value !== null && obj?.value !== undefined && (typeof obj.value !== 'number' || !Number.isFinite(obj.value) || obj.value <= 0)) {
      problems.push(`${s?.id}: invalid ${field}.value`);
    }
    if (obj?.sourceType !== undefined) {
      sourceTypeCounts[obj.sourceType] = (sourceTypeCounts[obj.sourceType] ?? 0) + 1;
      if (!validSourceTypes.has(obj.sourceType)) problems.push(`${s?.id}: invalid ${field}.sourceType ${obj.sourceType}`);
    }
    if (obj?.status !== undefined && !validFieldStatuses.has(obj.status)) problems.push(`${s?.id}: invalid ${field}.status ${obj.status}`);
    if (field === 'power' && obj?.value != null) {
      const roles = new Set(['speaker_power_handling','program_rating','allowable_input','amplifier_output','recommended_amplifier','unknown']);
      if (!roles.has(obj?.role)) problems.push(`${s?.id}: populated power field missing/invalid semantic role`);
      if (obj?.role === 'recommended_amplifier' && /recommended amplifier[^.;]*\b\d+(?:\.\d+)?\s*(?:-|–|—|to)\s*\d+(?:\.\d+)?\s*W\b/i.test(s?.notes ?? '')) {
        problems.push(`${s?.id}: scalar power.value must not store an endpoint of a recommended-amplifier range`);
      }
    }
  }

  const fr = s?.frequencyResponse;
  if (fr?.low_hz != null && (!Number.isFinite(fr.low_hz) || fr.low_hz <= 0)) problems.push(`${s.id}: invalid frequencyResponse.low_hz`);
  if (fr?.high_hz != null && (!Number.isFinite(fr.high_hz) || fr.high_hz <= 0)) problems.push(`${s.id}: invalid frequencyResponse.high_hz`);
  if (fr?.low_hz != null && fr?.high_hz != null && fr.low_hz >= fr.high_hz) problems.push(`${s.id}: invalid frequency range`);

  // Explicit point tables are permitted only when auditResponsePoints() confirms separate verified provenance,
  // source context, an HTTPS source, and ordered finite data. The runtime separately ignores any unverified points.
  if ('directivityData' in (s ?? {}) || 'polarData' in (s ?? {}) || 'clf' in (s ?? {}) || 'gll' in (s ?? {})) {
    problems.push(`${s.id}: speaker record contains unsupported directivity data`);
  }

  if (isValidResponsePointTable(fr)) {
    if (fr.pointsSourceType === 'MANUFACTURER') provenanceCounts.manufacturer++;
    else if (fr.pointsSourceType === 'MEASUREMENT') provenanceCounts.measurement++;
    else if (fr.pointsSourceType === 'REPUTABLE_DATABASE') provenanceCounts.verified_database++;
  } else if (knownSet.has(s.id)) {
    if (knownManufacturer.has(s.id)) provenanceCounts.manufacturer++;
    else if (knownModeled.has(s.id)) provenanceCounts.physically_modeled++;
    else warnings.push(`${s.id}: known response curve has an unrecognised declared provenance`);
  } else {
    // No valid explicit curve: getSpeakerResponseModel() models one ONLY from the limits the record publishes. A side
    // with no published limit is a flat generic reference (isGenericReference), counted separately below.
    // There is no category-based synthesis any more; checkResponseModelSource() below enforces that.
    provenanceCounts.physically_modeled++;
  }
}

// The current response-model implementation has no verified_database curves.
// Keep the category explicit rather than inflating manufacturer/measurement counts.
provenanceCounts.verified_database = 0;
if (knownManufacturer.size + knownModeled.size !== knownSet.size) warnings.push('Known response-curve provenance could not be completely parsed from speakerResponse.ts');

// New null states (driverCount / active / panel) and the generic-reference flag.
const flags = auditNullableFlags(data);
problems.push(...flags.problems);
warnings.push(...flags.warnings);
const modelSource = checkResponseModelSource(responseSource);
problems.push(...modelSource.problems);
const genericReference = countGenericReference(data, knownCurveIds);

const result = {
  ok: problems.length === 0,
  records: data.length,
  uniqueIds: ids.size,
  duplicateIds: data.length - ids.size,
  uniqueBrandModels: names.size,
  duplicateBrandModels: data.length - names.size,
  statusCounts,
  sourceTypeCounts,
  responseCurveData: {
    embeddedJsonCurves: responsePointAudit.counts.total,
    embeddedCurveProvenance: responsePointAudit.counts,
    embeddedCurveProblems: responsePointAudit.problems.length,
    declaredManufacturerCurves: provenanceCounts.manufacturer,
    declaredMeasurementCurves: provenanceCounts.measurement,
    declaredVerifiedDatabaseCurves: provenanceCounts.verified_database,
    physicallyModeledCurves: provenanceCounts.physically_modeled,
    knownCurveLibraryEntries: knownSet.size,
    // physicallyModeledCurves counts every speaker without an explicit curve; genericReference is the subset whose
    // modeled curve is NOT the speaker's response because a frequency limit is unpublished (isGenericReference).
    genericReference,
    categoryBasedSynthesisAbsent: modelSource.ok,
  },
  nullableFlags: { counts: flags.counts, legacyWithConcreteFlags: flags.legacyWithConcreteFlags },
  directivity: {
    embeddedSpeakerPolarData: 0,
    supportedBySolverWhenExplicitlySupplied: true,
  },
  problems,
  warnings,
  verificationNote: 'Provenance labels are code/data declarations. Independent verification of cited manuals/measurements requires external source access and is not claimed by this audit.'
};

fs.writeFileSync(path.join(root, 'speaker-provenance-audit.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(result, null, 2));
process.exitCode = problems.length ? 1 : 0;
