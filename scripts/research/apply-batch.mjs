// Applies a source-pinned research batch to src/data/speakers.json.
// Usage: node scripts/research/apply-batch.mjs scripts/research/batch-001.json
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const dsPath = path.join(root, 'src/data/speakers.json');
const data = JSON.parse(fs.readFileSync(dsPath, 'utf8'));
const batch = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const statusFor = (t) => t === 'MANUFACTURER' ? 'MANUFACTURER_VERIFIED' : t === 'MEASUREMENT' ? 'MEASUREMENT_VERIFIED' : t === 'REPUTABLE_DATABASE' ? 'REPUTABLE_DATABASE_VERIFIED' : t === 'THIRD_PARTY' ? 'THIRD_PARTY_VERIFIED' : null;
const validCurveSources = new Set(['MANUFACTURER', 'MEASUREMENT', 'REPUTABLE_DATABASE']);
const acousticFields = ['sensitivity', 'power', 'impedance', 'resonantFreq', 'voiceCoil', 'woofer'];
const hasSourceBackedAcousticField = (s) =>
  acousticFields.some((f) => s[f]?.value !== null && s[f]?.value !== undefined) ||
  Number.isFinite(s.frequencyResponse?.low_hz) || Number.isFinite(s.frequencyResponse?.high_hz);
function validatePublishedPoints(id, response) {
  if (!Array.isArray(response.points) || response.points.length < 2) throw new Error(`${id}: response points need at least two published points`);
  if (!validCurveSources.has(response.pointsSourceType)) throw new Error(`${id}: response points need MANUFACTURER, MEASUREMENT, or REPUTABLE_DATABASE provenance`);
  if (statusFor(response.pointsSourceType) !== response.pointsStatus) throw new Error(`${id}: response-point status does not match its source type`);
  if (!/^https:\/\//.test(response.pointsSource || '')) throw new Error(`${id}: response points need their own HTTPS source`);
  if (typeof response.pointsContext !== 'string' || response.pointsContext.trim().length < 20) throw new Error(`${id}: response points need measurement/publication context`);
  let previousHz = 0;
  for (const [i, point] of response.points.entries()) {
    if (!Number.isFinite(point?.hz) || point.hz <= previousHz || !Number.isFinite(point?.db)) {
      throw new Error(`${id}: response point ${i} must have a finite, strictly increasing positive frequency and finite dB`);
    }
    previousHz = point.hz;
  }
}
for (const e of batch) {
  const s = data.find((x) => x.id === e.id);
  if (!s) throw new Error(`unknown id ${e.id}`);
  if (!String(s.model).includes(e.model_check)) throw new Error(`${e.id}: model mismatch`);
  if (!statusFor(e.sourceType)) throw new Error(`${e.id}: invalid batch source type ${e.sourceType}`);
  if (!/^https:\/\//.test(e.source)) throw new Error(`${e.id}: source must be URL`);
  for (const [f, v] of Object.entries(e.fields)) {
    if (f === 'frequencyResponse' && Array.isArray(v?.points)) validatePublishedPoints(e.id, v);
    else if (f === 'frequencyResponse' && ['pointsStatus', 'pointsSource', 'pointsSourceType', 'pointsContext'].some((key) => key in (v || {}))) {
      throw new Error(`${e.id}: response-point provenance exists without a point table`);
    }
    if (f === 'power' && v?.role === 'recommended_amplifier' && /\b\d+(?:\.\d+)?\s*(?:-|–|—|to)\s*\d+(?:\.\d+)?\s*W\b/i.test(e.notes || '')) {
      throw new Error(`${e.id}: power.value is scalar; do not store an endpoint of a recommended-amplifier range`);
    }
    s[f] = { ...(s[f] || {}), ...v, status: statusFor(e.sourceType), source: e.source, sourceType: e.sourceType };
  }
  // Optional top-level structural facts (driverCount / active / panel). Only these keys are accepted, and only
  // alongside a source-pinned entry; their provenance is the entry's `source`, quoted in `notes`.
  for (const [k, v] of Object.entries(e.scalars || {})) {
    if (!['driverCount', 'active', 'panel'].includes(k)) throw new Error(`${e.id}: scalar ${k} not allowed`);
    s[k] = v;
  }
  if (e.category !== undefined) {
    if (typeof e.category !== 'string' || !e.category.trim()) throw new Error(`${e.id}: category must be a non-empty string`);
    s.category = e.category;
  }
  if (e.notes) s.notes = e.notes;
  if (e.overallStatus !== undefined && e.overallStatus !== 'UNAVAILABLE') {
    throw new Error(`${e.id}: batch may explicitly set only UNAVAILABLE; other statuses are derived from sourced acoustic fields`);
  }
  if (e.overallStatus === 'UNAVAILABLE') {
    if (hasSourceBackedAcousticField(s)) throw new Error(`${e.id}: cannot mark a record with sourced acoustic data UNAVAILABLE`);
    s.overallStatus = 'UNAVAILABLE';
  } else if (hasSourceBackedAcousticField(s)) {
    s.overallStatus = 'PARTIALLY_VERIFIED';
  } else if (s.overallStatus !== 'UNAVAILABLE') {
    // Structural facts such as driver count or active/passive status are useful,
    // but alone do not provide an acoustic specification for simulation.
    s.overallStatus = 'UNVERIFIED';
  }
}
fs.writeFileSync(dsPath, JSON.stringify(data, null, 2) + '\n');
console.log(`applied ${batch.length} entries`);
