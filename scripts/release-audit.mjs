import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import { checkRelease } from './lib/releaseCheck.mjs';
const root=process.cwd(); const problems=[]; const warnings=[];
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const lim=read('src/lib/publicLimits.ts');
if(!/MAX_GRID_CELLS:\s*50_000_000/.test(lim)) problems.push('50M public grid cap missing');
const data=JSON.parse(read('src/data/speakers.json')); const ids=new Set(); const names=new Set();
if (!Array.isArray(data) || data.length === 0) problems.push('authoritative speaker dataset is missing or empty');
const legacyCount=data.filter(s=>s?.overallStatus==='LEGACY').length;
if(legacyCount!==0) problems.push(`legacy speaker count must be 0, found ${legacyCount}`);
const nonLegacyCount=data.filter(s=>s?.overallStatus!=='LEGACY').length;
if(nonLegacyCount!==data.length) problems.push(`not all authoritative speaker records have a non-legacy status: ${nonLegacyCount} of ${data.length}`);
for(const s of data){
  if(!s?.id||ids.has(s.id)) problems.push(`duplicate/missing speaker id: ${s?.id}`);
  ids.add(s.id);
  const k=`${s.brand}::${s.model}`.toLowerCase();
  if(names.has(k)) problems.push(`duplicate brand/model: ${s.brand} ${s.model}`);
  names.add(k);
  if(!['LEGACY','FULLY_VERIFIED','PARTIALLY_VERIFIED','UNVERIFIED','MEASUREMENT_VERIFIED','UNAVAILABLE'].includes(s?.overallStatus)) problems.push(`invalid overallStatus: ${s?.id}`);
  for(const field of ['sensitivity','power','impedance','resonantFreq','voiceCoil','woofer']){
    const obj=s?.[field]; const v=obj?.value;
    if(v!==null && v!==undefined && (typeof v!=='number' || !Number.isFinite(v) || v<=0)) problems.push(`invalid ${field} for ${s?.id}`);
    if(v!==null && v!==undefined && (!/^https?:\/\//i.test(String(obj?.source||'')) || !['MANUFACTURER_VERIFIED','MEASUREMENT_VERIFIED','REPUTABLE_DATABASE_VERIFIED','THIRD_PARTY_VERIFIED'].includes(obj?.status))) problems.push(`populated ${field} lacks auditable source provenance: ${s?.id}`);
    if(field==='sensitivity' && v!==null && v!==undefined && !obj?.reference) problems.push(`populated sensitivity lacks measurement reference: ${s?.id}`);
  }
  if(s.sensitivity?.status==='MANUFACTURER_VERIFIED' && (!s.sensitivity.source || s.sensitivity.sourceType!=='MANUFACTURER')) warnings.push(`speaker sensitivity claims manufacturer verification without reproducible URL: ${s.brand} ${s.model}`);
  const fr=s.frequencyResponse;
  if(fr?.low_hz!==null || fr?.high_hz!==null){
    if((fr.low_hz!==null && (!Number.isFinite(fr.low_hz)||fr.low_hz<=0)) || (fr.high_hz!==null && (!Number.isFinite(fr.high_hz)||fr.high_hz<=0))) problems.push(`invalid frequencyResponse for ${s?.id}`);
    if(!/^https?:\/\//i.test(String(fr.source||'')) || !['MANUFACTURER_VERIFIED','MEASUREMENT_VERIFIED','REPUTABLE_DATABASE_VERIFIED','THIRD_PARTY_VERIFIED'].includes(fr.status)) problems.push(`populated frequencyResponse lacks auditable source provenance: ${s?.id}`);
  }
}
// Windows EXE artifact (replaces the old release-ZIP check). Missing is a warning unless REQUIRE_EXE=1 (set in the Windows release workflow).
const sourceManifest = path.join(root, 'source-release', 'manifest.json');
if (fs.existsSync(sourceManifest)) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify-source-release.mjs')], { encoding: 'utf8', env: process.env });
  if (r.status !== 0) problems.push(`source release manifest invalid: ${(r.stderr || r.stdout || '').trim()}`);
}
const relDir=path.resolve(process.env.RELEASES_DIR||path.join(root,'releases'));
if (fs.existsSync(relDir)) {
  const exe=checkRelease(relDir);
  if(exe.ok) console.log(`EXE artifact OK: ${exe.manifest.file} (${exe.manifest.size} bytes)`);
  else for(const p of exe.problems) (process.env.REQUIRE_EXE==='1'?problems:warnings).push(`EXE artifact: ${p}`);
}
console.log(JSON.stringify({ok:problems.length===0, filesChecked:data.length, duplicateIds:data.length-ids.size, duplicateBrandModels:data.length-names.size, problems, warnings:warnings.slice(0,25), warningCount:warnings.length},null,2));
process.exitCode=problems.length?1:0;
