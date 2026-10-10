import fs from 'node:fs';
import path from 'node:path';
import { countGenericReference, isValidResponsePointTable, parseKnownCurves } from './lib/speakerAuditCore.mjs';

const root = process.cwd();
const data = JSON.parse(fs.readFileSync(path.join(root, 'src/data/speakers.json'), 'utf8'));
const responseSource = fs.readFileSync(path.join(root, 'src/lib/speakerResponse.ts'), 'utf8');
const { ids: knownCurveIds } = parseKnownCurves(responseSource);
const responseModelCounts = countGenericReference(data, knownCurveIds);
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const docs = {
  audit: read('AUDIT.md'),
  final: read('FINAL_VERIFICATION.md'),
  status: read('SPEAKER-DATA-STATUS.md'),
  gaps: read('SPEAKER-DATA-GAPS.md'),
  queue: read('scripts/research/RESEARCH-QUEUE.md'),
};
const issues = [];
const fields = ['sensitivity','power','impedance','resonantFreq','voiceCoil','woofer'];
const count = (f) => data.filter((s) => s?.[f]?.value !== null && s?.[f]?.value !== undefined).length;
const frCount = data.filter((s) => Number.isFinite(s?.frequencyResponse?.low_hz) || Number.isFinite(s?.frequencyResponse?.high_hz)).length;
const responseCurves = data.filter((s) => isValidResponsePointTable(s?.frequencyResponse));
const curveCounts = {
  total: responseCurves.length,
  manufacturer: responseCurves.filter((s) => s.frequencyResponse.pointsSourceType === 'MANUFACTURER').length,
  measurement: responseCurves.filter((s) => s.frequencyResponse.pointsSourceType === 'MEASUREMENT').length,
  reputableDatabase: responseCurves.filter((s) => s.frequencyResponse.pointsSourceType === 'REPUTABLE_DATABASE').length,
};
const modeledFromLimits = responseModelCounts.modeledFromPublishedLimits;
const sourced = (s) => fields.some((f) => s?.[f]?.value !== null && s?.[f]?.value !== undefined) || Number.isFinite(s?.frequencyResponse?.low_hz) || Number.isFinite(s?.frequencyResponse?.high_hz);
const status = {};
for (const s of data) status[s.overallStatus ?? 'UNSPECIFIED'] = (status[s.overallStatus ?? 'UNSPECIFIED'] ?? 0) + 1;
const expected = {
  records: data.length,
  uniqueIds: new Set(data.map((s) => s.id)).size,
  uniqueBrandModels: new Set(data.map((s) => `${s.brand}::${s.model}`.toLowerCase())).size,
  sensitivity: count('sensitivity'), power: count('power'), impedance: count('impedance'),
  resonantFreq: count('resonantFreq'), voiceCoil: count('voiceCoil'), woofer: count('woofer'), frequencyResponse: frCount,
  partial: status.PARTIALLY_VERIFIED ?? 0,
  unverified: status.UNVERIFIED ?? 0,
  unavailable: status.UNAVAILABLE ?? 0,
  anySource: data.filter(sourced).length,
  noSource: data.filter((s) => !sourced(s) && s.overallStatus !== 'UNAVAILABLE').length,
  generic: responseModelCounts.total,
  modeledFromLimits,
  responseCurves: curveCounts,
  physicallyModeledResponseModels: data.length - curveCounts.total,
};
if (expected.uniqueIds !== expected.records) issues.push(`duplicate IDs: ${expected.records - expected.uniqueIds}`);
if (expected.uniqueBrandModels !== expected.records) issues.push(`duplicate brand/model pairs: ${expected.records - expected.uniqueBrandModels}`);
const queueRecords = data.filter((s) => s.overallStatus !== 'PARTIALLY_VERIFIED');
const queueStatusCounts = {
  unverified: queueRecords.filter((s) => s.overallStatus === 'UNVERIFIED').length,
  unavailable: queueRecords.filter((s) => s.overallStatus === 'UNAVAILABLE').length,
};
const queueBrandCount = new Set(queueRecords.map((s) => s.brand)).size;
const expectedQueueSummary = `Records still needing research: **${queueRecords.length}** of ${data.length} (${queueStatusCounts.unverified} UNVERIFIED, ${queueStatusCounts.unavailable} UNAVAILABLE) across ${queueBrandCount} brands.`;

const needles = [
  ['AUDIT speaker-quality gate', `- ` + '`node scripts/speaker-quality-audit.mjs`' + ` — **PASS**, ${expected.records} records, ${expected.records - expected.uniqueIds} duplicate IDs, ${expected.records - expected.uniqueBrandModels} duplicate brand/model pairs, ${expected.responseCurves.total} embedded response-point datasets (${expected.responseCurves.manufacturer} manufacturer, ${expected.responseCurves.measurement} measurement), no category-based response synthesis.`, docs.audit],
  ['AUDIT records', `- ${expected.records} records`, docs.audit],
  ['AUDIT sensitivity', `sensitivity ${expected.sensitivity}`, docs.audit],
  ['AUDIT power', `power ${expected.power}`, docs.audit],
  ['AUDIT impedance', `impedance ${expected.impedance}`, docs.audit],
  ['AUDIT resonant', `resonant frequency ${expected.resonantFreq}`, docs.audit],
  ['AUDIT voice', `voice-coil size ${expected.voiceCoil}`, docs.audit],
  ['AUDIT woofer', `woofer size ${expected.woofer}`, docs.audit],
  ['AUDIT fr', `frequency-response limits ${expected.frequencyResponse}`, docs.audit],
  ['AUDIT partial', `\`PARTIALLY_VERIFIED\`: ${expected.partial}`, docs.audit],
  ['AUDIT unverified', `\`UNVERIFIED\`: ${expected.unverified}`, docs.audit],
  ['AUDIT unavailable', `\`UNAVAILABLE\`: ${expected.unavailable}`, docs.audit],
  ['STATUS partial', `- PARTIALLY_VERIFIED: ${expected.partial}`, docs.status],
  ['STATUS unverified', `- UNVERIFIED: ${expected.unverified}`, docs.status],
  ['STATUS unavailable', `- UNAVAILABLE: ${expected.unavailable}`, docs.status],
  ['STATUS sensitivity', `- Sensitivity: ${expected.sensitivity}`, docs.status],
  ['STATUS power', `- Power: ${expected.power}`, docs.status],
  ['STATUS impedance', `- Impedance: ${expected.impedance}`, docs.status],
  ['STATUS resonant', `- Resonant frequency: ${expected.resonantFreq}`, docs.status],
  ['STATUS voice', `- Voice-coil size: ${expected.voiceCoil}`, docs.status],
  ['STATUS woofer', `- Woofer size: ${expected.woofer}`, docs.status],
  ['STATUS fr', `- Frequency-response limits: ${expected.frequencyResponse}`, docs.status],
  ['STATUS generic', `- Generic reference models with missing published bounds: ${expected.generic}`, docs.status],
  ['STATUS response points', `- Embedded source-backed response-point datasets: ${expected.responseCurves.total} (measurement ${expected.responseCurves.measurement}, manufacturer ${expected.responseCurves.manufacturer}, reputable database ${expected.responseCurves.reputableDatabase})`, docs.status],
  ['STATUS modeled limits', `- Models derived from published frequency limits: ${expected.modeledFromLimits}`, docs.status],
  ['AUDIT embedded response points', `- embedded JSON response-point datasets: ${expected.responseCurves.total}`, docs.audit],
  ['AUDIT modeled response models', `- physically modeled response models: ${expected.physicallyModeledResponseModels}`, docs.audit],
  ['FINAL partial', `- PARTIALLY_VERIFIED: ${expected.partial}`, docs.final],
  ['FINAL unverified', `- UNVERIFIED: ${expected.unverified}`, docs.final],
  ['FINAL unavailable', `- UNAVAILABLE: ${expected.unavailable}`, docs.final],
  ['FINAL sensitivity', `sensitivity ${expected.sensitivity}`, docs.final],
  ['FINAL power', `power ${expected.power}`, docs.final],
  ['FINAL impedance', `impedance ${expected.impedance}`, docs.final],
  ['FINAL resonant', `resonant frequency ${expected.resonantFreq}`, docs.final],
  ['FINAL voice', `voice-coil size ${expected.voiceCoil}`, docs.final],
  ['FINAL woofer', `woofer size ${expected.woofer}`, docs.final],
  ['FINAL fr', `frequency-response limits ${expected.frequencyResponse}`, docs.final],
  ['FINAL response points', `- Source-backed response-point datasets: ${expected.responseCurves.total} (measurement ${expected.responseCurves.measurement}, manufacturer ${expected.responseCurves.manufacturer}, reputable database ${expected.responseCurves.reputableDatabase}).`, docs.final],
  ['FINAL response model composition', `- Response models: ${expected.records}; ${expected.modeledFromLimits} are modeled from published response limits, ${expected.generic} use the generic reference path, and ${expected.responseCurves.total} use source-backed response-point datasets.`, docs.final],
];
for (const [name, needle, body] of needles) if (!body.includes(needle)) issues.push(`${name}: missing ${needle}`);
if (!docs.queue.includes(expectedQueueSummary)) issues.push(`research queue summary is stale: expected ${expectedQueueSummary}`);
const queueIds = new Set([...docs.queue.matchAll(/\(`([^`]+)`\)/g)].map((m) => m[1]));
const expectedQueueIds = new Set(queueRecords.map((s) => s.id));
for (const id of expectedQueueIds) if (!queueIds.has(id)) issues.push(`research queue is missing ${id}`);
for (const id of queueIds) if (!expectedQueueIds.has(id)) issues.push(`research queue has unexpected ${id}`);
const old = ['Sensitivity: 39','Power: 64','Impedance: 43','Voice-coil size: 4','Woofer size: 64','Frequency-response limits: 71','PARTIALLY_VERIFIED: 772','embedded JSON response curves: 0','Embedded measured/manufacturer response curves: 0','physically modeled response models: 774'];
for (const stale of old) {
  // Stale counts require a numeric-token boundary so a valid newer count (e.g. 40) does not match 4.
  const stalePattern = new RegExp(`${stale}(?![0-9])`);
  if (Object.values(docs).some((body) => stalePattern.test(body))) issues.push(`stale documentation token: ${stale}`);
}
if (!docs.gaps.includes(`**Records with no source-backed acoustic field:** ${expected.noSource}`)) issues.push('speaker gap inventory total is stale');
const rowCount = (docs.gaps.match(/^\| [^|]+ \|/gm) || []).length - 1;
if (rowCount !== expected.records) issues.push(`speaker gap inventory rows: expected ${expected.records}, found ${rowCount}`);
console.log(JSON.stringify({ok: issues.length === 0, expected, issues}, null, 2));
process.exitCode = issues.length ? 1 : 0;
