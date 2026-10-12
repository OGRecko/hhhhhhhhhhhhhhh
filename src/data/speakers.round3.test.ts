/**
 * Round 3 data rules: field-level provenance, exact-variant matching, the disputed ELX200-15 table,
 * the Focal sensitivity reference, and the absence of unverified directivity datasets.
 *
 * Run with:  npx tsx src/data/speakers.round3.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUsableDirectivity } from '../lib/speakerDirectivity';

const here = path.dirname(fileURLToPath(import.meta.url));
const records: any[] = JSON.parse(fs.readFileSync(path.join(here, 'speakers.json'), 'utf8'));
const byId = new Map(records.map((r) => [r.id, r]));
const get = (id: string) => {
  const r = byId.get(id);
  assert.ok(r, `record ${id} must exist`);
  return r;
};

// 1. driverCount and active carry provenance whenever they are set.
for (const r of records) {
  if (r.driverCount != null) {
    assert.ok(r.driverCountProvenance, `${r.id}: driverCount has no provenance`);
    assert.ok(['CITED_IN_NOTES_UNCHECKED', 'UNSOURCED', 'MANUFACTURER_VERIFIED'].includes(r.driverCountProvenance.status), `${r.id}: bad driverCount provenance status`);
    if (r.driverCountProvenance.status === 'MANUFACTURER_VERIFIED') assert.match(r.driverCountProvenance.source, /^https:\/\//, `${r.id}: verified driverCount needs an https source`);
  }
  if (r.active != null) {
    assert.ok(r.activeProvenance, `${r.id}: active has no provenance`);
    assert.ok(['CITED_IN_NOTES_UNCHECKED', 'UNSOURCED', 'MANUFACTURER_VERIFIED'].includes(r.activeProvenance.status), `${r.id}: bad active provenance status`);
    if (r.activeProvenance.status === 'MANUFACTURER_VERIFIED') assert.match(r.activeProvenance.source, /^https:\/\//, `${r.id}: verified active needs an https source`);
  }
}

// 1b. Unsourced driverCount / active values are withdrawn to null (Round 4).
for (const r of records) {
  if (r.driverCountProvenance?.status === 'UNSOURCED') assert.equal(r.driverCount, null, `${r.id}: unsourced driverCount must be null`);
  if (r.activeProvenance?.status === 'UNSOURCED') assert.equal(r.active, null, `${r.id}: unsourced active must be null`);
}

// 2. No directivity dataset is stored unless it passes every check.
for (const r of records) {
  if (r.directivity != null) assert.ok(isUsableDirectivity(r.directivity), `${r.id}: stored directivity fails validation`);
}

// 3. Generic EV records that do not identify the variant keep affected specifications unavailable.
// Round 5 owner decision: the generic Zx3 record is archived and replaced by exact variants (see below).
assert.equal(records.some((x) => x.id === 'electro-voice-zx3'), false, 'generic electro-voice-zx3 must be replaced by variants');
for (const id of ['electro-voice-zx5']) {
  const r = get(id);
  for (const k of ['sensitivity', 'impedance', 'power', 'woofer']) {
    assert.equal(r[k].status, 'UNAVAILABLE', `${id}: ${k} must be unavailable until the variant is identified`);
    assert.equal(r[k].value, null, `${id}: ${k} value must be null`);
  }
  assert.equal(r.frequencyResponse.status, 'UNAVAILABLE', `${id}: frequency response must be unavailable`);
  assert.equal(r.driverCount, 2, `${id}: driverCount is series-level and stays`);
  assert.equal(r.active, false, `${id}: passive design stays passive`);
}

// 3b. Exact Zx3 variants (round 5): acoustic values are attached only with a manufacturer source and the variant name.
for (const [id, model] of [['electro-voice-zx3-60', 'Zx3-60'], ['electro-voice-zx3-90', 'Zx3-90']] as const) {
  const r = get(id);
  assert.equal(r.model, model, `${id}: exact variant model`);
  assert.equal(r.overallStatus, 'PARTIALLY_VERIFIED', `${id}: sourced acoustic fields present`);
  assert.equal(r.sensitivity.value, 97, `${id}: sensitivity from the manual's series table`);
  assert.equal(r.impedance.value, 8, `${id}: nominal impedance`);
  assert.equal(r.power.value, 600, `${id}: continuous passive power`);
  assert.equal(r.woofer.value, 12, `${id}: LF driver size`);
  assert.equal(r.frequencyResponse.low_hz, 58, `${id}: -3 dB low limit`);
  assert.equal(r.frequencyResponse.high_hz, 15000, `${id}: -3 dB high limit`);
  assert.equal(r.driverCount, 2, `${id}: driverCount`);
  assert.equal(r.active, false, `${id}: passive`);
  assert.match(r.sensitivity.source, /eviaudio\.fr/, `${id}: manufacturer source`);
}
assert.equal(get('electro-voice-zx3-60').frequencyResponse.source, get('electro-voice-zx3-90').frequencyResponse.source);

// 4. EVF-1152D/96 already names its exact variant; it stays a secondary-source record.
const evf = get('electro-voice-evf-1152d-96');
assert.equal(evf.sensitivity.sourceType, 'REPUTABLE_DATABASE');
assert.match(evf.model, /\/96$/);

// 5. Focal Sopra N°2: the duplicate dealer record 'focal-sopra2' was archived by owner decision (2026-10-12).
//    The surviving record focal-sopra-n-2 is MANUFACTURER_VERIFIED from the Focal product sheet (91 dB at 2.83 V/1 m).
const focal = get('focal-sopra-n-2');
assert.equal(focal.sensitivity.value, 91);
assert.equal(focal.sensitivity.reference, '2.83V/1m');
assert.equal(focal.sensitivity.sourceType, 'MANUFACTURER');
assert.equal(focal.sensitivity.status, 'MANUFACTURER_VERIFIED');
assert.match(focal.sensitivity.source, /^https:\/\/media\.focal-naim\.com\/dam\/sopra-n-2\//);
assert.equal(records.some((r) => r.id === 'focal-sopra2'), false, 'duplicate focal-sopra2 must not be live');
const archivedRound5: any = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'scripts', 'research', 'removed-owner-round5-records.json'), 'utf8'));
const archivedFocal = archivedRound5.records.find((r: any) => r.id === 'focal-sopra2');
assert.ok(archivedFocal, 'focal-sopra2 must be archived unchanged, not deleted');
assert.equal(archivedFocal.sensitivity.simulationExcluded, true);

// 6. ELX200-15: stored 85 points match the primary sheet (row count resolved); the table stays excluded from simulation.
const elx = get('electro-voice-elx200-15').frequencyResponse;
assert.equal(elx.points, undefined, 'disputed table must not be used as response points');
assert.equal(elx.pointsStatus, 'UNAVAILABLE');
assert.equal(elx.disputedPoints.status, 'ROW_COUNT_RESOLVED_STORED_MATCHES_PRIMARY');
assert.equal(elx.disputedPoints.primarySourceReconciliation.comparisonWithStoredPoints.valueDifferences.length, 0, 'stored points match the primary sheet');
assert.equal(elx.disputedPoints.points.length, 85, 'all 85 stored points are preserved for reconciliation');
assert.equal(elx.disputedPoints.simulationExcluded, true, 'the disputed table is excluded from simulation');
assert.ok(elx.disputedPoints.exclusionReason, 'the exclusion reason is documented');

console.log('speakers.round3: all checks passed');
