/**
 * Objective check that the rendered speaker audio follows the response model at 125 Hz - 8 kHz, and that
 * different speakers produce measurably different output. Steady-state sine tones are pushed through the real
 * simulateSpeakerDSP and the output level is measured; nothing here is mocked.
 */
import { getSpeakerById, SPEAKER_SPECS } from './speakers';
import { normalizeSpeakerSpec } from './speakerDSP';
import { simulateSpeakerDSP, getSpeakerResponseModel, interpolateLogFrequency, solveBandGains, DSP_BAND_CENTERS_HZ, resolveSensitivity, SENSITIVITY_REFERENCE_DB } from './speakerResponse';

const sr = 48000, N = sr * 2;
let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); } catch (e: any) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };
const tone = (f: number) => { const x = new Float32Array(N); for (let i = 0; i < N; i++) x[i] = 0.1 * Math.sin(2 * Math.PI * f * i / sr); return x; };
const rmsTail = (x: Float32Array) => { let s = 0; const a = x.length >> 1; for (let i = a; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / (x.length - a)); };
const gainDb = (id: string, f: number, opts: any = { loudnessMatched: false }) => {
  const sp: any = getSpeakerById(id);
  return 20 * Math.log10(rmsTail(simulateSpeakerDSP(tone(f), sr, sp, opts)) / rmsTail(tone(f)));
};

console.log("\n=== Speaker 7-band response & A/B verification ===\n");

const IDS = ['yamaha-ns10m', 'genelec-8351b', 'neumann-kh-120-ii', 'kef-ls50', 'jbl-m2', 'adam-audio-a77x', 'dutch-and-dutch-8c', 'genelec-1031a', 'legacy-klip-5'];

for (const id of IDS) {
  check(`${id}: rendered level tracks the response model at 125/250/500/1k/2k/4k/8k Hz (within 0.3 dB)`, () => {
    const sp: any = getSpeakerById(id);
    assert(!!sp, `${id} must exist`);
    const model = getSpeakerResponseModel(sp);
    const sensOffset = resolveSensitivity(sp).valueDb - SENSITIVITY_REFERENCE_DB; // raw mode uses the authoritative normalized sensitivity resolver
    for (const f of DSP_BAND_CENTERS_HZ) {
      const err = gainDb(id, f) - sensOffset - interpolateLogFrequency(model.points, f);
      assert(Math.abs(err) < 0.3, `${id} @ ${f} Hz off model by ${err.toFixed(2)} dB`);
    }
  });
}

check("Klipsch Forte uses its sourced on-axis table as measured shape while sensitivity remains the separate level reference", () => {
  const forte: any = getSpeakerById('legacy-klip-5');
  const model = getSpeakerResponseModel(forte);
  assert(model.provenance === 'measurement', `expected measurement, got ${model.provenance}`);
  assert(model.isMeasuredOrManufacturer, 'verified manufacturer-published measurement is explicit');
  assert(model.points.length === 28, `expected all 28 published response points, got ${model.points.length}`);
  assert(model.low_hz === 20 && model.high_hz === 20000, 'measurement span remains separate from the published 32 Hz bandwidth limit');
  assert(Math.abs(interpolateLogFrequency(model.points, 1000)) < 1e-12, 'response points are normalized at 1 kHz');
  assert(Math.abs(interpolateLogFrequency(model.points, 200) - 1.5) < 1e-12, 'source table shape is preserved relative to its 1 kHz anchor');
  assert(model.sourceDescription.includes('1 m') && model.sourceDescription.includes('0 = 100 dB SPL'), 'measurement context must be visible');
  const sensitivity = resolveSensitivity(forte);
  assert(sensitivity.valueDb === 98 && sensitivity.source === 'manufacturer', 'published 98 dB at 1 W/1 m sets level independently');
});

check("unverified response-point arrays are ignored by the simulator", () => {
  const forte: any = getSpeakerById('legacy-klip-5');
  const unverified = { ...forte, frequencyResponse: { ...forte.frequencyResponse, pointsSource: null } };
  const model = getSpeakerResponseModel(unverified);
  assert(model.provenance === 'physically_modeled', 'missing curve provenance must not be presented as measured');
  assert(model.low_hz === 32, 'invalid points must fall back to the published bandwidth model');
  assert(!model.isMeasuredOrManufacturer, 'invalid point data must not be marked verified');
});

check("band-gain solver converges (residual < 0.1 dB) for every speaker with a library curve", () => {
  for (const id of IDS) {
    const m = getSpeakerResponseModel(getSpeakerById(id) as any);
    const sol = solveBandGains(m, sr);
    assert(sol.maxResidualDb < 0.1, `${id} residual ${sol.maxResidualDb.toFixed(3)} dB`);
  }
});

check("A/B: NS-10M vs Genelec 8351B differ by >= 3 dB at 40 Hz (NS-10M quieter: 60 Hz vs 32 Hz sourced LF limit) and not at 2 kHz (no invented voicing)", () => {
  // Both records carry only a sourced bandwidth, so the only defensible difference is the LF/HF edge.
  const lf = gainDb('yamaha-ns10m', 40, { loudnessMatched: true }) - gainDb('genelec-8351b', 40, { loudnessMatched: true });
  assert(lf < -3, `expected NS-10M to roll off >3 dB below the 8351B at 40 Hz, got ${lf.toFixed(2)} dB`);
  const mid = gainDb('yamaha-ns10m', 2000, { loudnessMatched: true }) - gainDb('genelec-8351b', 2000, { loudnessMatched: true });
  assert(Math.abs(mid) < 0.5, `no mid-band difference may be invented at 2 kHz, got ${mid.toFixed(2)} dB`);
});

check("A/B: sensitivity moves level in raw mode and cancels in loudness-matched mode (same curve shape)", () => {
  const kef = getSpeakerById('kef-ls50') as any, gen = getSpeakerById('genelec-8351b') as any;
  const raw = gainDb('kef-ls50', 1000) - gainDb('genelec-8351b', 1000);
  const expected = resolveSensitivity(kef).valueDb - resolveSensitivity(gen).valueDb;
  assert(Math.abs(raw - expected) < 0.3, `raw-mode level gap ${raw.toFixed(2)} dB, sensitivity gap ${expected} dB`);
  const matched = gainDb('kef-ls50', 1000, { loudnessMatched: true }) - gainDb('genelec-8351b', 1000, { loudnessMatched: true });
  assert(Math.abs(matched) < 0.3, `loudness-matched gap should vanish for two flat speakers, got ${matched.toFixed(2)} dB`);
});

check("distance: doubling distance lowers level by 6.02 dB (1/r law) through the real DSP", () => {
  const a = gainDb('genelec-8351b', 1000, { loudnessMatched: true, distanceM: 1 });
  const b = gainDb('genelec-8351b', 1000, { loudnessMatched: true, distanceM: 2 });
  assert(Math.abs((a - b) - 6.02) < 0.1, `got ${(a - b).toFixed(2)} dB`);
});

check("determinism: repeated renders are bit-identical (no hidden randomness)", () => {
  const sp: any = getSpeakerById('yamaha-ns10m');
  const x = simulateSpeakerDSP(tone(1000), sr, sp, { loudnessMatched: false }), y = simulateSpeakerDSP(tone(1000), sr, sp, { loudnessMatched: false });
  for (let i = 0; i < x.length; i++) assert(x[i] === y[i], `sample ${i} differs`);
});

check("provenance honesty: no curve is labelled 'measurement' unless the record itself says MEASUREMENT", () => {
  for (const id of IDS) {
    const sp: any = getSpeakerById(id);
    const m = getSpeakerResponseModel(sp);
    if (m.provenance === 'measurement') {
      const sourceType = sp.frequencyResponse?.pointsSourceType ?? sp.frequencyResponse?.sourceType;
      assert(sourceType === 'MEASUREMENT', `${id} claims measurement without measurement-point provenance`);
    }
  }
});

check("ALL speakers: DSP output is finite and bounded, and band gains reproduce the model within 0.5 dB wherever targets are >= -40 dB", () => {
  const x = tone(1000);
  const x2 = new Float32Array(sr / 2); for (let i = 0; i < x2.length; i++) x2[i] = x[i];
  let n = 0, checkedBands = 0;
  for (const raw of SPEAKER_SPECS as any[]) {
    const sp = normalizeSpeakerSpec(raw);
    const y = simulateSpeakerDSP(x2, sr, sp, { loudnessMatched: false });
    for (let i = 0; i < y.length; i++) assert(Number.isFinite(y[i]) && Math.abs(y[i]) < 50, `${raw.id} non-finite/unbounded sample`);
    const m = getSpeakerResponseModel(sp);
    const targets = DSP_BAND_CENTERS_HZ.map((f) => interpolateLogFrequency(m.points, f));
    const solution = solveBandGains(m, sr);
    n++;
    for (let band = 0; band < targets.length; band++) {
      if (targets[band] < -40) continue;
      checkedBands++;
      const residual = solution.bandResidualsDb[band];
      assert(residual < 0.5, `${raw.id} @ ${DSP_BAND_CENTERS_HZ[band]} Hz residual ${residual.toFixed(2)} dB`);
    }
  }
  const minEligibleBandChecks = Math.ceil(n * DSP_BAND_CENTERS_HZ.length * 0.9);
  assert(n === (SPEAKER_SPECS as any[]).length && checkedBands >= minEligibleBandChecks,
    `swept ${n}, residual-checked ${checkedBands} frequency bands (minimum ${minEligibleBandChecks})`);
});

check("sensitivity fallback is explicit: speakers without a numeric sensitivity are counted and render at the 89 dB reference, never a made-up value", () => {
  const missing = (SPEAKER_SPECS as any[]).filter((r) => !(typeof r.sensitivity?.value === 'number' && Number.isFinite(r.sensitivity.value)));
  for (const r of missing) assert(r.sensitivity?.status === 'UNAVAILABLE' && r.sensitivity?.value === null, `${r.id} has a non-numeric sensitivity without UNAVAILABLE status`);
  const id = missing[0].id;
  const a = gainDb(id, 1000), flat = getSpeakerResponseModel(getSpeakerById(id) as any);
  assert(Math.abs(a - interpolateLogFrequency(flat.points, 1000)) < 0.3, `${id} should render with 0 dB sensitivity offset (89 dB reference)`);
  console.log(`        (${missing.length}/${(SPEAKER_SPECS as any[]).length} speakers use the 89 dB neutral reference fallback)`);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed) process.exit(1);
