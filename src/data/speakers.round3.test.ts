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
for (const id of ['electro-voice-zx3', 'electro-voice-zx5']) {
  const r = get(id);
  for (const k of ['sensitivity', 'impedance', 'power', 'woofer']) {
    assert.equal(r[k].status, 'UNAVAILABLE', `${id}: ${k} must be unavailable until the variant is identified`);
    assert.equal(r[k].value, null, `${id}: ${k} value must be null`);
  }
  assert.equal(r.frequencyResponse.status, 'UNAVAILABLE', `${id}: frequency response must be unavailable`);
  assert.equal(r.driverCount, 2, `${id}: driverCount is series-level and stays`);
  assert.equal(r.active, false, `${id}: passive design stays passive`);
}

// 4. EVF-1152D/96 already names its exact variant; it stays a secondary-source record.
const evf = get('electro-voice-evf-1152d-96');
assert.equal(evf.sensitivity.sourceType, 'REPUTABLE_DATABASE');
assert.match(evf.model, /\/96$/);

// 5. Focal Sopra No.2: 91 dB is stated at 2.83 V/1 m by the manufacturer-group product presentation.
const focal = get('focal-sopra2');
assert.equal(focal.sensitivity.value, 91);
assert.equal(focal.sensitivity.reference, '2.83V/1m');
// Round 4: the Focal-Naim portal was not accepted; the dealer copy is recorded as THIRD_PARTY, not manufacturer-verified.
assert.equal(focal.sensitivity.sourceType, 'THIRD_PARTY');
assert.equal(focal.sensitivity.status, 'THIRD_PARTY_VERIFIED');
// Owner decision 3 (Round 4): third-party Focal 91 dB is excluded from verified simulation inputs.
assert.equal(focal.sensitivity.simulationExcluded, true);
assert.match(focal.sensitivity.source, /^https:\/\/www\.audiovisionsf\.com\//);

// 6. ELX200-15: row-count conflict is held in disputedPoints and the simulator field is unavailable.
const elx = get('electro-voice-elx200-15').frequencyResponse;
assert.equal(elx.points, undefined, 'disputed table must not be used as response points');
assert.equal(elx.pointsStatus, 'UNAVAILABLE');
assert.equal(elx.disputedPoints.status, 'UNRESOLVED_ROW_COUNT');
assert.equal(elx.disputedPoints.points.length, 85, 'all 85 stored points are preserved for reconciliation');
assert.equal(elx.disputedPoints.simulationExcluded, true, 'the disputed table is excluded from simulation');
assert.ok(elx.disputedPoints.exclusionReason, 'the exclusion reason is documented');

console.log('speakers.round3: all checks passed');
