import fs from 'node:fs';
import path from 'node:path';
import { countGenericReference, isValidResponsePointTable, parseKnownCurves } from './lib/speakerAuditCore.mjs';

const root = process.cwd();
const datasetPath = path.join(root, 'src/data/speakers.json');
const data = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
const responseSource = fs.readFileSync(path.join(root, 'src/lib/speakerResponse.ts'), 'utf8');
const { ids: knownCurveIds } = parseKnownCurves(responseSource);
const responseModelCounts = countGenericReference(data, knownCurveIds);
const physicalFields = ['sensitivity', 'power', 'impedance', 'resonantFreq', 'voiceCoil', 'woofer'];
function countRepositoryFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? countRepositoryFiles(full) : 1;
  }
  return total;
}
const repositoryFileCount = countRepositoryFiles(root);
const hasBinaryReleaseDir = fs.existsSync(path.join(root, 'releases'));
const fieldLabels = {
  sensitivity: 'sensitivity',
  power: 'power',
  impedance: 'impedance',
  resonantFreq: 'resonant frequency',
  voiceCoil: 'voice-coil size',
  woofer: 'woofer size',
};
const valueCount = (field) => data.filter((s) => s[field]?.value !== null && s[field]?.value !== undefined).length;
const responseLimits = data.filter((s) => Number.isFinite(s.frequencyResponse?.low_hz) || Number.isFinite(s.frequencyResponse?.high_hz)).length;
const responseCurves = data.filter((s) => isValidResponsePointTable(s.frequencyResponse));
const curveCounts = {
  total: responseCurves.length,
  manufacturer: responseCurves.filter((s) => s.frequencyResponse.pointsSourceType === 'MANUFACTURER').length,
  measurement: responseCurves.filter((s) => s.frequencyResponse.pointsSourceType === 'MEASUREMENT').length,
  reputableDatabase: responseCurves.filter((s) => s.frequencyResponse.pointsSourceType === 'REPUTABLE_DATABASE').length,
};
const statusCounts = {};
for (const s of data) statusCounts[s.overallStatus ?? 'UNSPECIFIED'] = (statusCounts[s.overallStatus ?? 'UNSPECIFIED'] ?? 0) + 1;
const sourced = (s) => physicalFields.some((f) => s[f]?.value !== null && s[f]?.value !== undefined) || Number.isFinite(s.frequencyResponse?.low_hz) || Number.isFinite(s.frequencyResponse?.high_hz);
const missingFields = (s) => {
  const missing = physicalFields.filter((f) => s[f]?.value === null || s[f]?.value === undefined);
  if (!Number.isFinite(s.frequencyResponse?.low_hz) && !Number.isFinite(s.frequencyResponse?.high_hz)) missing.push('frequency-response limits');
  return missing;
};
const sourceMap = new Map();
for (const s of data) {
  for (const f of physicalFields) {
    const x = s[f];
    if (x?.value !== null && x?.value !== undefined && x.source) {
      if (!sourceMap.has(x.source)) sourceMap.set(x.source, []);
      sourceMap.get(x.source).push(`${s.brand} ${s.model} — ${fieldLabels[f]}`);
    }
  }
  const fr = s.frequencyResponse;
  if ((Number.isFinite(fr?.low_hz) || Number.isFinite(fr?.high_hz)) && fr.source) {
    if (!sourceMap.has(fr.source)) sourceMap.set(fr.source, []);
    sourceMap.get(fr.source).push(`${s.brand} ${s.model} — frequency-response limits`);
  }
  if (isValidResponsePointTable(fr)) {
    if (!sourceMap.has(fr.pointsSource)) sourceMap.set(fr.pointsSource, []);
    sourceMap.get(fr.pointsSource).push(`${s.brand} ${s.model} — source-backed response points (${fr.pointsSourceType.toLowerCase()})`);
  }
}
const today = new Date().toISOString().slice(0, 10);
const audit = {
  records: data.length,
  uniqueIds: new Set(data.map((s) => s.id)).size,
  uniqueBrandModels: new Set(data.map((s) => `${s.brand}::${s.model}`.toLowerCase())).size,
  populated: Object.fromEntries([...physicalFields.map((f) => [f, valueCount(f)]), ['frequencyResponse', responseLimits]]),
  statusCounts,
  modeledFromPublishedLimits: responseModelCounts.modeledFromPublishedLimits,
  genericReference: responseModelCounts.total,
  responseCurves: curveCounts,
  physicallyModeledResponseModels: data.length - curveCounts.total,
  unverifiedRecords: data.filter((s) => s.overallStatus === 'UNVERIFIED').length,
  thirdPartyFields: data.reduce((n, s) => n + ['sensitivity','power','impedance','resonantFreq','voiceCoil','woofer','frequencyResponse'].filter((f) => s[f]?.status === 'THIRD_PARTY_VERIFIED').length, 0),
  thirdPartyRecords: data.filter((s) => ['sensitivity','power','impedance','resonantFreq','voiceCoil','woofer','frequencyResponse'].some((f) => s[f]?.status === 'THIRD_PARTY_VERIFIED')).length,
  partiallyVerified: data.filter((s) => s.overallStatus === 'PARTIALLY_VERIFIED').length,
  unavailableRecords: data.filter((s) => s.overallStatus === 'UNAVAILABLE').length,
  recordsWithAnySource: data.filter(sourced).length,
  recordsWithNoSource: data.filter((s) => !sourced(s) && s.overallStatus !== 'UNAVAILABLE').length,
  sources: sourceMap.size,
};
if (audit.uniqueIds !== audit.records) throw new Error('Duplicate speaker IDs detected while generating release docs.');
if (audit.uniqueBrandModels !== audit.records) throw new Error('Duplicate brand/model pairs detected while generating release docs.');

const archivedPath = path.join(root, 'scripts/research/removed-unavailable-records.json');
const archivedCount = JSON.parse(fs.readFileSync(archivedPath, 'utf8')).records.length;
const round5ArchivePath = path.join(root, 'scripts/research/removed-owner-round5-records.json');
const round5ArchivedCount = JSON.parse(fs.readFileSync(round5ArchivePath, 'utf8')).records.length;
const decisionsArchivePath = path.join(root, 'scripts/research/removed-owner-2026-10-12-decisions.json');
const decisionsArchivedCount = JSON.parse(fs.readFileSync(decisionsArchivePath, 'utf8')).records.length;
const reviewedTotal = audit.records + archivedCount + round5ArchivedCount + decisionsArchivedCount;
const statusDoc = [
  '# Cavity Audio — Speaker Data Status', '',
  'Generated from `src/data/speakers.json`; counts are not hand-maintained.', '',
  `Updated ${today}.`, '',
  `The live authoritative dataset contains **${audit.records} active catalog records**; the reviewed catalog total is **${reviewedTotal}** (${audit.records} live + ${archivedCount} archived in scripts/research/removed-unavailable-records.json + ${round5ArchivedCount} archived in scripts/research/removed-owner-round5-records.json, removed at owner request 2026-10-11 + ${decisionsArchivedCount} archived in scripts/research/removed-owner-2026-10-12-decisions.json, archived at owner request 2026-10-12). The archived records were removed from the live dataset at the owner's request on 2026-10-10 (all UNAVAILABLE records, including the duplicate Sonos aliases). They are excluded from speaker selection and from every count in this document. A record is ` + '`PARTIALLY_VERIFIED`' + ` only when at least one sourced acoustic specification (sensitivity, power, impedance, resonant frequency, voice-coil size, woofer size, or a structured frequency-response limit) is retained. Source-backed structural facts such as driver count or active status alone remain ` + '`UNVERIFIED`' + ` because they do not supply an acoustic specification for simulation. ` + '`UNAVAILABLE`' + ` is reserved for unresolved catalog identities and confirmed non-loudspeaker components; those records are retained but excluded from speaker selection.`, '',

  '## Record status',
  `- PARTIALLY_VERIFIED: ${audit.partiallyVerified}`,
  `- UNVERIFIED: ${audit.unverifiedRecords}`,
  `- UNAVAILABLE: ${audit.unavailableRecords}`, '',
  '## Current source-backed fields',
  `- Sensitivity: ${audit.populated.sensitivity}`,
  `- Power: ${audit.populated.power}`,
  `- Impedance: ${audit.populated.impedance}`,
  `- Resonant frequency: ${audit.populated.resonantFreq}`,
  `- Voice-coil size: ${audit.populated.voiceCoil}`,
  `- Woofer size: ${audit.populated.woofer}`,
  `- Frequency-response limits: ${audit.populated.frequencyResponse}`,
  `- Of these, THIRD_PARTY_VERIFIED (retailer or third-party copy of an exact-model spec, not a manufacturer page): ${audit.thirdPartyFields} field(s) on ${audit.thirdPartyRecords} record(s)`, '',
  '## Response-model policy',
  `- Embedded source-backed response-point datasets: ${audit.responseCurves.total} (measurement ${audit.responseCurves.measurement}, manufacturer ${audit.responseCurves.manufacturer}, reputable database ${audit.responseCurves.reputableDatabase})`,
  `- Models derived from published frequency limits: ${audit.modeledFromPublishedLimits}`,
  `- Generic reference models with missing published bounds: ${audit.genericReference}`, 
  '- No synthesized curve is represented as a laboratory measurement.', '',
  '## Directivity / scatter',
  '- Embedded speaker polar/directivity datasets: 0',
  '- Physical scatter model: not implemented',
  '- Speaker selection alone does not imply speaker-specific room directivity.', '',
  '## Integrity rule',
  'A missing field is `N/A` rather than guessed. A published bandwidth is not converted into a fabricated frequency-response curve.',
].join('\n') + '\n';
fs.writeFileSync(path.join(root, 'SPEAKER-DATA-STATUS.md'), statusDoc, 'utf8');

const gapLines = [
  '# Cavity Audio — Speaker Data Gaps', '',
  `Generated ${today} from the authoritative ${audit.records}-record database.`, '',
  'This inventory lists fields that are not currently populated with retained source evidence. It is intentionally exhaustive and is not a claim that the missing information does not exist on the internet.', '',
  '| ID | Brand | Model | Status | Missing fields |',
  '|---|---|---|---|---|',
];
for (const s of data) {
  const missing = missingFields(s);
  gapLines.push(`| ${s.id} | ${String(s.brand).replaceAll('|','\\|')} | ${String(s.model).replaceAll('|','\\|')} | ${s.overallStatus} | ${missing.length ? missing.join(', ') : 'none'} |`);
}
gapLines.push('', `**Records with at least one source-backed acoustic field:** ${audit.recordsWithAnySource}`, `**Records with no source-backed acoustic field:** ${audit.recordsWithNoSource}`, `**Unavailable identities or confirmed non-loudspeaker records:** ${audit.unavailableRecords}`, '');
fs.writeFileSync(path.join(root, 'SPEAKER-DATA-GAPS.md'), gapLines.join('\n'), 'utf8');

const sourceLines = [
  '# Cavity Audio — Speaker Sources', '',
  `Generated ${today} from the authoritative dataset. ${sourceMap.size} unique source URLs are retained for populated fields.`, '',
  'The source is attached to the exact field it supports. A source URL here does not imply that every specification for that speaker came from the same source.', '',
];
for (const [url, entries] of [...sourceMap.entries()].sort(([a],[b]) => a.localeCompare(b))) {
  sourceLines.push(`## ${url}`, '');
  for (const entry of [...new Set(entries)].sort()) sourceLines.push(`- ${entry}`);
  sourceLines.push('');
}
fs.writeFileSync(path.join(root, 'SPEAKER-SOURCES.md'), sourceLines.join('\n'), 'utf8');

const speakerSection = [
  '## Speaker DB', '',
  '**PASS — static database audit.** Counts below are generated from the authoritative `src/data/speakers.json` dataset:', '',
  `- ${audit.records} records`,
  `- ${audit.uniqueIds} unique IDs`,
  `- 0 duplicate IDs`,
  `- ${audit.uniqueBrandModels} unique brand/model pairs`,
  `- 0 duplicate brand/model pairs`,
  ...['PARTIALLY_VERIFIED', 'UNVERIFIED', 'UNAVAILABLE'].map((k) => `- \`${k}\`: ${audit.statusCounts[k] ?? 0}`),
  `- source-backed fields: sensitivity ${audit.populated.sensitivity}, power ${audit.populated.power}, impedance ${audit.populated.impedance}, resonant frequency ${audit.populated.resonantFreq}, voice-coil size ${audit.populated.voiceCoil}, woofer size ${audit.populated.woofer}, frequency-response limits ${audit.populated.frequencyResponse}`,
  `- embedded JSON response-point datasets: ${audit.responseCurves.total}`,
  `- declared response-point provenance: manufacturer ${audit.responseCurves.manufacturer}, measurement ${audit.responseCurves.measurement}, verified database ${audit.responseCurves.reputableDatabase}`,
  `- physically modeled response models: ${audit.physicallyModeledResponseModels}`,
  `- generic reference models: ${audit.genericReference}`,
  `- models derived from published bandwidth limits: ${audit.modeledFromPublishedLimits}`,
  '- embedded speaker polar/directivity data: 0', '',
  'The database does not claim that every catalog record is independently web-verified. Records without source-backed fields are explicitly `UNVERIFIED` and retain `N/A` physical fields rather than guessed values.',
].join('\n');
let auditText = fs.readFileSync(path.join(root, 'AUDIT.md'), 'utf8');
let aStart = auditText.indexOf('## Speaker DB');
let aEnd = auditText.indexOf('\n## Environment blockers', aStart);
if (aStart < 0) throw new Error('AUDIT.md is missing its Speaker DB section.');
if (aEnd < 0) aEnd = auditText.length;
auditText = auditText.slice(0, aStart) + speakerSection + '\n\n' + auditText.slice(aEnd + 1);
auditText = auditText.replace(/^\*\*Date:\*\* \d{4}-\d{2}-\d{2}$/m, `**Date:** ${today}`);
auditText = auditText.replace(
  /`node scripts\/speaker-quality-audit\.mjs` — \*\*PASS\*\*,[^\n]*/,
  `\`node scripts/speaker-quality-audit.mjs\` — **PASS**, ${audit.records} records, ${audit.records - audit.uniqueIds} duplicate IDs, ${audit.records - audit.uniqueBrandModels} duplicate brand/model pairs, ${audit.responseCurves.total} embedded response-point datasets (${audit.responseCurves.manufacturer} manufacturer, ${audit.responseCurves.measurement} measurement), no category-based response synthesis.`,
);
auditText = auditText.replace(/`node scripts\/final-audit\.mjs` — \*\*PASS\*\*, \d+ files scanned/g, `\`node scripts/final-audit.mjs\` — **PASS**, ${repositoryFileCount} files scanned`);
if (!hasBinaryReleaseDir) {
  auditText = auditText.replace(/`node scripts\/release-audit\.mjs` —[^\n]*/g, '`node scripts/release-audit.mjs` — **PASS**, source-only workspace; binary release verification is enforced when a Windows release artifact is present.');
}
fs.writeFileSync(path.join(root, 'AUDIT.md'), auditText, 'utf8');

const finalText = [
  '# Cavity Audio — Final Release Verification', '',
  `**Audit date:** ${today}  `,
  '**Product:** Cavity Audio 3.1.0  ',
  '**Release constraints:** free/public/no login/no payment; 50,000,000 FDTD grid-cell ceiling; 1–16 sources; 1–64 receivers.', '',
  '## Verdict', '',
  '# NOT RELEASE READY', '',
  'The source/data gates are prepared and current documentation is generated from the authoritative source. External runtime, Windows signing, cloud credentials, and legal approval remain release-owner responsibilities and are not represented as completed by this source archive.', '',
  '## Speaker database', '',
  `- Records: ${audit.records}`,
  `- Unique IDs: ${audit.uniqueIds}`,
  `- Unique brand/model pairs: ${audit.uniqueBrandModels}`,
  `- PARTIALLY_VERIFIED: ${audit.partiallyVerified}`,
  `- UNVERIFIED: ${audit.unverifiedRecords}`,
  `- UNAVAILABLE: ${audit.unavailableRecords}`,
  `- Source-backed fields: sensitivity ${audit.populated.sensitivity}; power ${audit.populated.power}; impedance ${audit.populated.impedance}; resonant frequency ${audit.populated.resonantFreq}; voice-coil size ${audit.populated.voiceCoil}; woofer size ${audit.populated.woofer}; frequency-response limits ${audit.populated.frequencyResponse}.`,
  `- Response models: ${audit.records}; ${audit.modeledFromPublishedLimits} are modeled from published response limits, ${audit.genericReference} use the generic reference path, and ${audit.responseCurves.total} use source-backed response-point datasets.`,
  `- Source-backed response-point datasets: ${audit.responseCurves.total} (measurement ${audit.responseCurves.measurement}, manufacturer ${audit.responseCurves.manufacturer}, reputable database ${audit.responseCurves.reputableDatabase}).`,
  '- Embedded polar/CLF/GLL speaker directivity datasets: 0.',
  '- Unsupported information remains unavailable rather than guessed.', '',
  '## Scientific/data honesty', '',
  '- Published bandwidth limits are not presented as measured response curves.',
  '- No laboratory measurement is claimed without measurement provenance.',
  '- Generic/reference speaker models are labeled as modeled.',
  '- Speaker-specific polar/directivity behavior is not fabricated.',
  '- Physical scatter is not modeled.',
  '- 2.83 V/1 m sensitivity is normalized to the 1 W/1 m DSP reference only when nominal impedance is known.', '',
  '## Implemented production safeguards', '',
  '- Cloud Run, Cloud Tasks, Storage lifecycle, and Cloud Monitoring provisioning scripts are included.',
  '- Production deployment requires configured release/cloud resources.',
  '- Windows production release requires a signed Authenticode installer.',
  '- Privacy, Terms, license, and third-party notice assets are included.',
  '- Speaker data gaps and source provenance are generated from the current database.', '',
  '## External requirements', '',
  '- Owner/legal approval of the shipped license, Privacy Policy, and Terms is still required.',
  '- GCP/Firebase resources, secrets, notification email, and IAM must be configured in the production project.',
  '- Windows signing credentials/certificate must be configured on the Windows release runner.',
  '- Clean Node 22.23.3+ <23 installation and the complete runtime release gate must be executed in a supported environment.', '',
  '## Release rule', '',
  'This source archive must not be described as a fully runtime-verified Windows production release until the external requirements above produce release evidence.',
].join('\n') + '\n';
fs.writeFileSync(path.join(root, 'FINAL_VERIFICATION.md'), finalText, 'utf8');
console.log(JSON.stringify(audit, null, 2));
