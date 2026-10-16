// Generates scripts/research/RESEARCH-QUEUE.md from the authoritative data.
// Usage: node scripts/research/make-research-queue.mjs
// Reads src/data/speakers.json (live records) and the field provenance inventory.
// The first summary line must match scripts/check-doc-consistency.mjs exactly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'src/data/speakers.json'), 'utf8'));
const inv = JSON.parse(fs.readFileSync(path.join(here, 'field-provenance-inventory.json'), 'utf8')).entries;

const queueRecords = data.filter((s) => s.overallStatus !== 'PARTIALLY_VERIFIED');
const unverified = queueRecords.filter((s) => s.overallStatus === 'UNVERIFIED').length;
const unavailable = queueRecords.filter((s) => s.overallStatus === 'UNAVAILABLE').length;
const brands = new Set(queueRecords.map((s) => s.brand)).size;

const live = inv.filter((e) => e.location === 'LIVE');
const count = (status) => live.filter((e) => e.storedStatus === status).length;
const cited = live.filter((e) => e.storedStatus === 'CITED_IN_NOTES_UNCHECKED');
const citedUrls = new Set(cited.map((e) => e.source).filter(Boolean)).size;
const perRecord = new Map();
for (const e of live.filter((x) => ['CITED_IN_NOTES_UNCHECKED', 'UNSOURCED', 'NO_PROVENANCE'].includes(x.storedStatus))) {
  const k = e.speakerId;
  const row = perRecord.get(k) ?? { brand: e.brand, model: e.model, cited: 0, unsourced: 0, none: 0 };
  if (e.storedStatus === 'CITED_IN_NOTES_UNCHECKED') row.cited += 1;
  else if (e.storedStatus === 'UNSOURCED') row.unsourced += 1;
  else row.none += 1;
  perRecord.set(k, row);
}
const rows = [...perRecord.entries()].sort((a, b) => (b[1].cited + b[1].unsourced + b[1].none) - (a[1].cited + a[1].unsourced + a[1].none) || a[0].localeCompare(b[0]));

const out = [];
out.push('# Speaker research queue (generated from src/data/speakers.json)', '');
out.push('Generated, not hand-edited. Regenerate with: `node scripts/research/make-research-queue.mjs`', '');
out.push(`Records still needing research: **${queueRecords.length}** of ${data.length} (${unverified} UNVERIFIED, ${unavailable} UNAVAILABLE) across ${brands} brands.`, '');
out.push('This summary counts only record-level status. Field-level provenance backlog is listed below and is the real remaining work.', '');
out.push('## Field-level provenance backlog (live records)', '');
out.push(`- CITED_IN_NOTES_UNCHECKED: **${count('CITED_IN_NOTES_UNCHECKED')}** fields across **${citedUrls}** source URLs (not yet opened and checked for these fields).`);
out.push(`- UNSOURCED: **${count('UNSOURCED')}** fields (no source recorded).`);
out.push(`- NO_PROVENANCE: **${count('NO_PROVENANCE')}** fields (null value, no provenance object).`);
out.push('- Detail: `scripts/research/field-provenance-inventory.json` (per field) and `scripts/research/field-provenance-url-queue.json` (per URL).', '');
out.push('Rules for every entry: exact model + revision; manufacturer page/manual/datasheet opened (not a search snippet); populated fields carry their URL; unpublished values stay null or N/A.', '');
out.push('| Record | Brand | Model | Cited unchecked | Unsourced | No provenance |', '|---|---|---|---|---|---|');
for (const [id, r] of rows) out.push(`| ${id} | ${r.brand} | ${r.model} | ${r.cited} | ${r.unsourced} | ${r.none} |`);
out.push('');
fs.writeFileSync(path.join(here, 'RESEARCH-QUEUE.md'), out.join('\n'));
console.log(`queue: ${queueRecords.length} of ${data.length}; cited ${count('CITED_IN_NOTES_UNCHECKED')} across ${citedUrls} URLs; unsourced ${count('UNSOURCED')}; no-provenance ${count('NO_PROVENANCE')}; records with backlog ${rows.length}`);
