import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'src/data/speakers.json'), 'utf8'));
const physical = ['sensitivity','power','impedance','resonantFreq','voiceCoil','woofer'];
const problems=[];
const rawVoltageSensitivityWithoutNominalImpedance=[];
const seenId=new Set(), seenPair=new Set();
for (const s of data) {
  if (seenId.has(s.id)) problems.push(`${s.id}: duplicate id`); seenId.add(s.id);
  const pair=`${String(s.brand).trim().toLowerCase()}|${String(s.model).trim().toLowerCase()}`;
  if (seenPair.has(pair)) problems.push(`${s.id}: duplicate brand/model`); seenPair.add(pair);
  const hasSourceBackedField=physical.some((f)=>s?.[f]?.value!==null && s?.[f]?.value!==undefined) || Number.isFinite(s?.frequencyResponse?.low_hz) || Number.isFinite(s?.frequencyResponse?.high_hz);
  if (s?.overallStatus==='UNVERIFIED' && hasSourceBackedField) problems.push(`${s.id}: UNVERIFIED despite source-backed data`);
  if (s?.overallStatus==='PARTIALLY_VERIFIED' && !hasSourceBackedField && s?.overallStatus!=='UNAVAILABLE') problems.push(`${s.id}: PARTIALLY_VERIFIED without source-backed data`);
  for (const f of physical) {
    const v=s[f];
    if (!v || typeof v!=='object') { problems.push(`${s.id}: missing ${f}`); continue; }
    if (v.value!==null) {
      if (typeof v.value!=='number' || !Number.isFinite(v.value)) problems.push(`${s.id}: ${f}.value invalid`);
      if (!/^https?:\/\//i.test(String(v.source||''))) problems.push(`${s.id}: ${f} populated without URL provenance`);
      if (!['MANUFACTURER_VERIFIED','MEASUREMENT_VERIFIED','REPUTABLE_DATABASE_VERIFIED','THIRD_PARTY_VERIFIED'].includes(v.status)) problems.push(`${s.id}: ${f} populated with invalid status ${v.status}`);
      if (f === 'sensitivity' && !v.reference) problems.push(`${s.id}: populated sensitivity is missing its measurement reference`);
      if (f === 'sensitivity' && v.reference === '2.83V/1m' && (s.impedance?.value == null || !Number.isFinite(s.impedance.value) || s.impedance.value <= 0)) {
        // Preserve the manufacturer's voltage-referenced sensitivity as published. Without an exact nominal
        // impedance it cannot be normalized to 1 W / 1 m; the shared resolver must use its explicit fallback.
        rawVoltageSensitivityWithoutNominalImpedance.push(s.id);
      }
    }
  }
  const fr=s.frequencyResponse;
  if (!fr || typeof fr!=='object') problems.push(`${s.id}: missing frequencyResponse`);
  else {
    const populated=Number.isFinite(fr.low_hz) || Number.isFinite(fr.high_hz);
    if (populated) {
      if ((fr.low_hz!==null && (!Number.isFinite(fr.low_hz) || fr.low_hz<=0)) || (fr.high_hz!==null && (!Number.isFinite(fr.high_hz) || fr.high_hz<=0))) problems.push(`${s.id}: invalid frequency bound`);
      if (!/^https?:\/\//i.test(String(fr.source||''))) problems.push(`${s.id}: frequency response populated without URL provenance`);
      if (!['MANUFACTURER_VERIFIED','MEASUREMENT_VERIFIED','REPUTABLE_DATABASE_VERIFIED','THIRD_PARTY_VERIFIED'].includes(fr.status)) problems.push(`${s.id}: frequency response populated with invalid status ${fr.status}`);
    }
  }
}
const count=(f)=>data.filter(s=>s[f]?.value!==null && s[f]?.value!==undefined).length;
const frCount=data.filter(s=>Number.isFinite(s.frequencyResponse?.low_hz)||Number.isFinite(s.frequencyResponse?.high_hz)).length;
const { auditWithdrawalAndExclusionRules } = await import('./lib/speakerAuditCore.mjs');
problems.push(...auditWithdrawalAndExclusionRules(data));
const out={records:data.length,uniqueIds:seenId.size,uniqueBrandModel:seenPair.size,populated:{sensitivity:count('sensitivity'),power:count('power'),impedance:count('impedance'),resonantFreq:count('resonantFreq'),voiceCoil:count('voiceCoil'),woofer:count('woofer'),frequencyResponse:frCount},sensitivityNormalization:{raw2_83VPer1mWithoutNominalImpedance:rawVoltageSensitivityWithoutNominalImpedance,policy:'Retain exact voltage-referenced manufacturer sensitivity as published; do not normalize without a sourced nominal impedance, and use the explicit neutral simulator fallback.'},problems};
console.log(JSON.stringify(out,null,2));
process.exitCode=problems.length?1:0;
