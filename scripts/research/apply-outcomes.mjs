// Applies pass-128 research outcomes (notes, plus status changes that are explicitly marked).
// Usage: node scripts/research/apply-outcomes.mjs
import fs from 'node:fs';
const dsPath = 'src/data/speakers.json';
const d = JSON.parse(fs.readFileSync(dsPath, 'utf8'));
const outcomes = JSON.parse(fs.readFileSync('scripts/research/pass-128-outcomes.json', 'utf8'));
const byId = new Map(d.map((s) => [s.id, s]));
const stamp = 'Pass-128 check (2026-10-10): ';
let n = 0;
for (const [id, o] of Object.entries(outcomes)) {
  const s = byId.get(id);
  if (!s) throw new Error(`unknown id ${id}`);
  if (o.status) s.overallStatus = o.status;
  s.notes = (s.notes ? s.notes.replace(/\s*$/, ' ') : '') + stamp + o.note;
  n++;
}
// Infinity RS-1B: identity cannot be resolved -> UNAVAILABLE (explicitly marked).
const rs1b = byId.get('infinity-rs1');
if (!rs1b) throw new Error('infinity-rs1 missing');
rs1b.overallStatus = 'UNAVAILABLE';
rs1b.notes = (rs1b.notes ? rs1b.notes.replace(/\s*$/, ' ') : '') + stamp + 'UNAVAILABLE: identity not established. Sources conflict on configuration: an active 4-way with servo (6 ohm, 86 dB, 25-32 kHz) versus a passive 5-way (4 ohm, 25-32 kHz). The RS-1B revision cannot be fixed from the catalog row, so no values are transferred.';
n++;
fs.writeFileSync(dsPath, JSON.stringify(d, null, 2) + '\n', 'utf8');
console.log('applied outcomes:', n);
