// Regression: missing speaker specs and missing receiver Z must stay unknown. They must never be turned into
// plausible-looking physical data (89 dB, 8 ohm, 0.0 kHz, 60 Hz-18 kHz, 6.5", driverCount 2, Z = 1.2 m).
import assert from 'node:assert/strict';
import { formatSensitivity, formatFrequencyRange } from './speakerDisplay';
import { normalizeSpeakerSpec, type SpeakerSpec } from './speakerDSP';
import { getSpeakerResponseModel, resolveSensitivity, SENSITIVITY_REFERENCE_DB, REFERENCE_BAND_LOW_HZ, REFERENCE_BAND_HIGH_HZ } from './speakerResponse';
import { computeEstimatedGAndSPL, computeRT60 } from './roomAcoustics';
import { buildHeatmapData } from './spatialAnalysis';
import { SPEAKER_SPECS } from './speakers';

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { console.error(`  FAIL  ${name}\n        ${(e as Error).message}`); process.exitCode = 1; }
}

check('sensitivity text never shows 89 dB as the speaker value', () => {
  assert.equal(formatSensitivity(95), '95 dB (source reference not specified)');
  assert.equal(formatSensitivity(95, '1W/1m'), '95 dB @ 1W/1m');
  assert.equal(formatSensitivity(90, '2.83V/1m'), '90 dB @ 2.83V/1m');
  for (const v of [null, undefined, 0, -3, NaN, Infinity]) {
    const t = formatSensitivity(v as number | null | undefined);
    assert.match(t, /Unavailable/);
    assert.doesNotMatch(t, /\b89\b/);
  }
});

check('frequency range: no 0.0kHz / 0Hz for a missing bound', () => {
  assert.equal(formatFrequencyRange(50, 20000), '50Hz – 20.0kHz');
  assert.equal(formatFrequencyRange(50, undefined), '50Hz – N/A');
  assert.equal(formatFrequencyRange(null, 20000), 'N/A – 20.0kHz');
  assert.equal(formatFrequencyRange(undefined, undefined), 'N/A');
  assert.equal(formatFrequencyRange(0, 0), 'N/A');
  assert.doesNotMatch(formatFrequencyRange(40, undefined), /0\.0kHz/);
});

const legacy = normalizeSpeakerSpec({ id: 'old-1', brand: 'B', model: 'M', category: 'hifi', year: 1980, sens_db: 91, overallStatus: 'LEGACY' });

check('normalizeSpeakerSpec keeps unknown physical properties unknown', () => {
  assert.equal(legacy.driverCount, null);
  assert.equal(legacy.active, null);
  assert.equal(legacy.panel, null);
  for (const f of ['power', 'impedance', 'resonantFreq', 'voiceCoil', 'woofer'] as const) assert.equal(legacy[f].value, null, f);
  assert.equal(legacy.frequencyResponse.low_hz, null);
  assert.equal(legacy.frequencyResponse.high_hz, null);
  assert.equal(legacy.sensitivity.value, 91); // carried over unchanged
});

check('no-data speaker: response is a flagged generic reference, with no invented limits or character', () => {
  const m = getSpeakerResponseModel(legacy);
  assert.equal(m.provenance, 'physically_modeled');
  assert.equal(m.isMeasuredOrManufacturer, false);
  assert.equal(m.isGenericReference, true);
  assert.deepEqual(m.referenceBounds, ['low_hz', 'high_hz']);
  assert.equal(m.low_hz, REFERENCE_BAND_LOW_HZ);
  assert.equal(m.high_hz, REFERENCE_BAND_HIGH_HZ);
  assert.ok(m.points.every((p) => p.db === 0), 'flat: nothing rolled off or boosted without data');
  assert.match(m.sourceDescription, /not this speaker/i);
});

check('category does not invent a response (subwoofer / guitar-cab / pa with no data are all flat)', () => {
  for (const category of ['subwoofer', 'guitar-cab', 'pa', 'studio-monitor']) {
    const m = getSpeakerResponseModel({ ...legacy, id: `x-${category}`, category });
    assert.ok(m.points.every((p) => p.db === 0), category);
  }
});

check('only the published side rolls off; the other side stays unflagged-free of invention', () => {
  const m = getSpeakerResponseModel({ ...legacy, frequencyResponse: { ...legacy.frequencyResponse, low_hz: 50, status: 'ESTIMATED' } });
  assert.deepEqual(m.referenceBounds, ['high_hz']);
  assert.equal(m.low_hz, 50);
  const at20k = m.points.find((p) => p.hz === 20000)!;
  assert.equal(at20k.db, 0, 'no high-frequency roll-off without a published high limit');
  assert.ok(m.points.find((p) => p.hz === 25)!.db < -3, 'published low limit still rolls off');
});

check('resolveSensitivity normalizes 2.83 V sensitivity to 1 W only with known impedance', () => {
  const fourOhm = { ...legacy, sensitivity: { ...legacy.sensitivity, value: 90, sourceType: 'MANUFACTURER' as const, status: 'MANUFACTURER_VERIFIED' as const, reference: '2.83V/1m' }, impedance: { value: 4, unit: 'ohm', status: 'MANUFACTURER_VERIFIED' as const, source: 'https://example.invalid', sourceType: 'MANUFACTURER' as const } };
  const r = resolveSensitivity(fourOhm);
  assert.ok(Math.abs(r.valueDb - (90 - 10 * Math.log10((2.83 * 2.83) / 4))) < 0.01);
  assert.equal(r.isFallback, false);
  const unknownOhm = { ...fourOhm, impedance: { ...fourOhm.impedance, value: null } };
  assert.equal(resolveSensitivity(unknownOhm).isFallback, true);
});

check('resolveSensitivity stays the authority: missing is distinguishable from real data', () => {
  const missing = resolveSensitivity({ ...legacy, sensitivity: { ...legacy.sensitivity, value: null } });
  assert.equal(missing.isFallback, true);
  assert.equal(missing.source, 'none');
  assert.equal(missing.valueDb, SENSITIVITY_REFERENCE_DB);
  const real = resolveSensitivity({ ...legacy, sensitivity: { ...legacy.sensitivity, value: 91, sourceType: 'MANUFACTURER', status: 'MANUFACTURER_VERIFIED' } });
  assert.equal(real.isFallback, false);
  assert.equal(real.source, 'manufacturer');
});

check('speaker response models never claim a hand-authored curve is manufacturer data', () => {
  const spec = SPEAKER_SPECS.find((s) => s.id === 'genelec-8351b') as SpeakerSpec | undefined;
  if (!spec) return;
  const m = getSpeakerResponseModel(spec);
  assert.equal(m.provenance, 'physically_modeled');
  assert.equal(m.isMeasuredOrManufacturer, false);
});

const room = { poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], L: 6, W: 4, H: 3, wallMaterial: 'drywall', floorMaterial: 'wood_floor', ceilMaterial: 'drywall_ceil' } as Parameters<typeof computeRT60>[0];

check('receiver Z: missing Z => SPL/G unavailable with a reason (no 1.2 m guess)', () => {
  const rt = computeRT60(room);
  const r = computeEstimatedGAndSPL(rt, room, { x: 0.2, y: 0.5, z: 1.5 }, { x: 0.8, y: 0.5 }, 90);
  assert.ok(Object.values(r.SPL).every((v) => v === null));
  assert.ok(Object.values(r.reasons).every((t) => /Z coordinate is unknown/.test(t)));
});

check('receiver Z: an explicit 0 is a real height and is used', () => {
  const rt = computeRT60(room);
  const r = computeEstimatedGAndSPL(rt, room, { x: 0.2, y: 0.5, z: 1.5 }, { x: 0.8, y: 0.5, z: 0 }, 90);
  assert.ok(Object.values(r.SPL).some((v) => typeof v === 'number'));
});

check('heatmap: unknown Z stays null, explicit 0 is preserved', () => {
  const mk = (id: string, z?: number) => ({ id, position: { x: 0.5, y: 0.5, ...(z === undefined ? {} : { z }) }, metrics: { rt60: 1 } }) as Parameters<typeof buildHeatmapData>[1][number];
  const h = buildHeatmapData('RT60', [mk('a'), mk('b', 0)], 6, 4);
  assert.equal(h.points.find((p) => p.receiverId === 'a')!.z, null);
  assert.equal(h.points.find((p) => p.receiverId === 'b')!.z, 0);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
