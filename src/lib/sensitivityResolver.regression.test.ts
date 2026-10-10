/**
 * Regression: speakerDSP.ts used `spec.sensitivity?.value || 89` (and `?? 92` in the narrow-band path),
 * so negative / Infinity values leaked into the gain and the fallback was invisible. The DSP now uses the
 * single authoritative resolveSensitivity(). These tests drive the REAL buildSpeakerChain and the offline DSP.
 */
import assert from 'node:assert/strict';
import { buildSpeakerChain, normalizeSpeakerSpec, type SpeakerSpec } from './speakerDSP';
import { resolveSensitivity, simulateSpeakerDSP, SENSITIVITY_REFERENCE_DB, interpolateLogFrequency } from './speakerResponse';
import { sourceSensitivityDb } from './sourceSensitivity';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== sensitivity resolver regression ===\n');

// Minimal AudioContext stub: records the first GainNode created after input/output (the sensitivity/distance gain stage).
function stubCtx() {
  const gains: { gain: { value: number } }[] = [];
  const node = () => ({ connect() {}, disconnect() {}, frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 1 },
    threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, type: '', curve: null, oversample: '' });
  const ctx: any = { sampleRate: 48000,
    createGain: () => { const n = node(); gains.push(n as any); return n; },
    createBiquadFilter: node, createDynamicsCompressor: node, createWaveShaper: node };
  return { ctx, gains };
}
const mk = (value: unknown, extra: Partial<SpeakerSpec> = {}): SpeakerSpec => normalizeSpeakerSpec({
  id: 't', brand: 'T', model: 'T', category: 'studio-monitor', year: 2020, sensitivity: { value }, ...extra } as any);
const gainStage = (spec: SpeakerSpec) => {
  const { ctx, gains } = stubCtx();
  const chain = buildSpeakerChain(ctx, spec);
  return { g: gains[2].gain.value, chain };
};

check('valid manufacturer sensitivity: used verbatim, not fallback', () => {
  const r = resolveSensitivity({ sensitivity: { value: 95, sourceType: 'MANUFACTURER', status: 'MANUFACTURER_VERIFIED' } } as any);
  assert.equal(r.valueDb, 95); assert.equal(r.isFallback, false); assert.equal(r.source, 'manufacturer');
});
check('estimated sensitivity: source=estimated, not fallback', () => {
  const r = resolveSensitivity({ sensitivity: { value: 92, sourceType: 'ESTIMATED', status: 'LEGACY' } } as any);
  assert.equal(r.isFallback, false); assert.equal(r.source, 'estimated');
});
check('unavailable / zero / negative / NaN / Infinity / malformed all resolve to flagged fallback', () => {
  for (const v of [undefined, null, 0, -3, NaN, Infinity, -Infinity, '95', {}, []]) {
    const r = resolveSensitivity({ sensitivity: { value: v } } as any);
    assert.equal(r.isFallback, true, String(v)); assert.equal(r.valueDb, SENSITIVITY_REFERENCE_DB); assert.equal(r.source, 'none');
  }
  assert.equal(resolveSensitivity({} as any).isFallback, true);
});
check('real chain: gain uses resolver (95 dB -> +6 dB linear)', () => {
  const { g, chain } = gainStage(mk(95, { sensitivity: { value: 95, unit: 'dB', status: 'MANUFACTURER_VERIFIED', source: 'x', sourceType: 'MANUFACTURER' } } as any));
  assert.ok(Math.abs(g - Math.pow(10, 6 / 20)) < 1e-9); assert.equal(chain.sensitivity.isFallback, false);
});
check('real chain: negative / Infinity / NaN / 0 sensitivity -> unity gain and fallback flag exposed', () => {
  for (const v of [-20, Infinity, NaN, 0]) {
    const { g, chain } = gainStage(mk(v));
    assert.ok(Number.isFinite(g), `gain finite for ${v}`); assert.equal(g, 1);
    assert.equal(chain.sensitivity.isFallback, true); assert.equal(chain.sensitivity.source, 'none');
  }
});
check('narrow-band path (guitar-cab) also uses resolver: Infinity cannot produce an unbounded gain', () => {
  const { ctx, gains } = stubCtx();
  buildSpeakerChain(ctx, mk(Infinity, { category: 'guitar-cab' as any }));
  assert.ok(gains.every((n) => Number.isFinite(n.gain.value) && n.gain.value <= 2.5));
});
check('offline DSP is deterministic and higher sensitivity yields higher output', () => {
  const spec = mk(98, { sensitivity: { value: 98, unit: 'dB', status: 'MANUFACTURER_VERIFIED', source: 'x', sourceType: 'MANUFACTURER' } } as any);
  const x = new Float32Array(256).fill(0.1);
  const y1 = simulateSpeakerDSP(x, 48000, spec), y2 = simulateSpeakerDSP(x, 48000, spec);
  assert.deepEqual(Array.from(y1), Array.from(y2)); // deterministic
  const hi = simulateSpeakerDSP(x, 48000, mk(80)); const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  assert.ok(rms(y1) > rms(hi));
});


check('store source sensitivity converts 2.83V/1m to 1W/1m only with known impedance', () => {
  // 2.83 V into 4 ohm is 2.002 W (not exactly 2 W), so the exact conversion is 88 - 10*log10(2.83^2/4) = 84.985 dB.
  const r4 = sourceSensitivityDb({ manufacturerSensitivityDb: 88, manufacturerSensitivityReference: '2.83V/1m', speakerImpedanceOhm: 4 });
  assert.ok(r4 !== null && Math.abs(r4 - (88 - 10 * Math.log10((2.83 * 2.83) / 4))) < 1e-12 && Math.abs(r4 - 85) < 0.02);
  assert.equal(sourceSensitivityDb({ manufacturerSensitivityDb: 88, manufacturerSensitivityReference: '2.83Vrms/1m', speakerImpedanceOhm: 8 }), 88 - 10 * Math.log10((2.83 * 2.83) / 8));
  assert.equal(sourceSensitivityDb({ manufacturerSensitivityDb: 88, manufacturerSensitivityReference: '2.83V/1m', speakerImpedanceOhm: null }), null);
});
check('store source sensitivity rejects unknown measurement references rather than reinterpreting them', () => {
  assert.equal(sourceSensitivityDb({ manufacturerSensitivityDb: 88, manufacturerSensitivityReference: '2.83V/2m', speakerImpedanceOhm: 4 }), null);
});

check('2.83V/1m and 2.83Vrms/1m sensitivity are normalized to 1W/1m', () => {
  for (const reference of ['2.83V/1m', '2.83Vrms/1m']) {
    const r = resolveSensitivity({ sensitivity: { value: 88, sourceType: 'MANUFACTURER', status: 'MANUFACTURER_VERIFIED', reference }, impedance: { value: 4 } } as any);
    assert.ok(Math.abs(r.valueDb - (88 - 10 * Math.log10((2.83 * 2.83) / 4))) < 1e-9 && Math.abs(r.valueDb - 85) < 0.02);
    assert.equal(r.isFallback, false);
  }
});
check('unknown sensitivity reference falls back instead of being silently reinterpreted', () => {
  const r = resolveSensitivity({ sensitivity: { value: 88, sourceType: 'MANUFACTURER', status: 'MANUFACTURER_VERIFIED', reference: '2.83Vrms/2m' } } as any);
  assert.equal(r.isFallback, true);
  assert.equal(r.valueDb, SENSITIVITY_REFERENCE_DB);
});
check('log-frequency interpolation rejects malformed/duplicate points without NaN', () => {
  const y = interpolateLogFrequency([{ hz: 100, db: -2 }, { hz: 100, db: -1 }, { hz: NaN, db: 0 }, { hz: 1000, db: 0 }] as any, 300);
  assert.ok(Number.isFinite(y));
});
console.log(`\n=== ${passed} passed ===`);
