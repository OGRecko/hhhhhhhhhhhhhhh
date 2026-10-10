// Regenerates RESEARCH-QUEUE.md from the dataset (see that file's header).
import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('src/data/speakers.json', 'utf8'));
const todo = d.filter((s) => s.overallStatus !== 'PARTIALLY_VERIFIED');
const by = {};
for (const s of todo) (by[s.brand] ??= []).push(s);
const brands = Object.entries(by).sort((a, b) => b[1].length - a[1].length);
let o = '# Speaker research queue (generated from src/data/speakers.json)\n\nGenerated, not hand-edited. Regenerate with: node scripts/research/make-queue.mjs\n\n';
o += `Records still needing research: **${todo.length}** of ${d.length} (${todo.filter((s) => s.overallStatus === 'UNVERIFIED').length} UNVERIFIED, ${todo.filter((s) => s.overallStatus === 'UNAVAILABLE').length} UNAVAILABLE) across ${brands.length} brands.\n\n`;
o += 'Rules for every entry: exact model + revision; manufacturer page/manual/datasheet fetched (not a search snippet); populated fields carry their URL; anything unpublished stays N/A. Some discontinued or legacy models will have NO online manufacturer data and must stay UNVERIFIED.\n\n| Brand | Remaining | Models |\n|---|---|---|\n';
for (const [b, l] of brands) o += `| ${b} | ${l.length} | ${l.map((s) => `${s.model} (\`${s.id}\`)`).join('; ')} |\n`;
fs.writeFileSync('scripts/research/RESEARCH-QUEUE.md', o);
console.log(todo.length, 'records,', brands.length, 'brands');
