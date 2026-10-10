// Keep recommended-amplifier ranges out of the scalar power.value field.
// The complete source-published range remains in each record's notes with its exact source URL.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const datasetPath = path.join(root, 'src/data/speakers.json');
const data = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
const unresolvedIds = new Set(['bose-acoustimass-10', 'legacy-yam-8', 'qsc-cp15']);
const rangePattern = /\b\d+(?:\.\d+)?\s*(?:-|–|—|to)\s*\d+(?:\.\d+)?\s*W\b/i;
const changed = [];

for (const speaker of data) {
  const power = speaker.power;
  if (power?.value != null && power.role === 'recommended_amplifier') {
    const match = String(speaker.notes ?? '').match(rangePattern);
    if (!match) throw new Error(`${speaker.id}: recommended-amplifier power has no documented range in notes`);
    if (!/^https:\/\//i.test(String(power.source ?? ''))) throw new Error(`${speaker.id}: range has no exact source URL`);
    const source = power.source;
    const sentence = ` Structured power withheld: the exact source publishes a recommended-amplifier range (${match[0]}); the database power.value is scalar, so no range endpoint is stored. Source: ${source}.`;
    speaker.notes = `${String(speaker.notes ?? '').trim()}${sentence}`;
    speaker.power = {
      ...power,
      value: null,
      status: 'UNAVAILABLE',
      source: null,
      sourceType: 'NONE',
    };
    delete speaker.power.role;
    changed.push(speaker.id);
  }
}

const hasSourceBackedField = (speaker) => {
  const physicalFields = ['sensitivity', 'power', 'impedance', 'resonantFreq', 'voiceCoil', 'woofer'];
  return physicalFields.some((field) => speaker?.[field]?.value !== null && speaker?.[field]?.value !== undefined)
    || Number.isFinite(speaker?.frequencyResponse?.low_hz)
    || Number.isFinite(speaker?.frequencyResponse?.high_hz);
};
for (const speaker of data) {
  if (unresolvedIds.has(speaker.id)) {
    if (hasSourceBackedField(speaker)) throw new Error(`${speaker.id}: unresolved identity must not carry populated specifications`);
    speaker.overallStatus = 'UNAVAILABLE';
  } else {
    speaker.overallStatus = hasSourceBackedField(speaker) ? 'PARTIALLY_VERIFIED' : 'UNVERIFIED';
  }
}

fs.writeFileSync(datasetPath, `${JSON.stringify(data, null, 2)}\n`);
console.log(`withheld ${changed.length} range-valued recommended-amplifier scalars; recalculated record statuses`);
console.log(changed.join('\n'));
