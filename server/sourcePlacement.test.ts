/**
 * Regression tests: a source must be simulated and reported where the user put it.
 *
 * Found in the release audit: both solvers silently clamped every source into the inner 96% of the room
 * (0.02..0.98 of each dimension, and of z/H) and substituted 0.5 / a fabricated source for missing values.
 * The public validator accepts x,y in [0,1] and z in [0,H], so a source on a wall, the floor or the ceiling
 * (a floor-standing speaker is the common case) was simulated up to 2% of the room dimension away - 0.8 m in a
 * 40 m room - and the reported source-receiver distance described that moved position, not the requested one.
 * Receivers were always validated strictly; sources were not.
 */
import assert from 'node:assert/strict';
import { runIR, runWave } from './solverWorker';

let passed = 0;
const quiet = <T,>(fn: () => T): T => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS  ${name}`); };
const energy = (t: ArrayLike<number>) => { let e = 0; for (let i = 0; i < t.length; i++) e += t[i] * t[i]; return e; };
const allFinite = (t: ArrayLike<number>) => { for (let i = 0; i < t.length; i++) if (!Number.isFinite(t[i])) return false; return true; };
const throwsWith = (fn: () => unknown, re: RegExp) => { let msg = ''; try { quiet(fn as () => unknown); } catch (e: any) { msg = String(e?.message); } return re.test(msg) ? true : (msg || 'did not throw'); };

console.log('\n=== Source placement (both solvers) ===\n');

const room = { L: 40, W: 10, H: 3, wallMaterial: 'drywall', floorMaterial: 'wood_floor', ceilMaterial: 'drywall' };
const rcv = { id: 'r', x: 0.5, y: 0.5, z: 1.5 };

check('IR: reported source-receiver distance equals the requested geometry for sources on/near a wall', () => {
  for (const sx of [0, 0.005, 0.01, 0.02, 0.1, 1, 0.995]) {
    const r: any = quiet(() => runIR({ ...room, sources: [{ id: 's', x: sx, y: 0.5, z: 1.5 }], receivers: [rcv] }));
    const d = r.receivers[0].delays[0].distanceMeters;
    const expected = Math.abs(0.5 - sx) * room.L;
    assert.ok(Math.abs(d - expected) < 1e-9, `source x=${sx}: reported ${d} m, requested geometry ${expected} m`);
  }
});

check('IR: reported distance honours y and z at the room boundary too', () => {
  const r: any = quiet(() => runIR({ ...room, sources: [{ id: 's', x: 0.2, y: 0, z: 0 }], receivers: [rcv] }));
  const expected = Math.hypot(0.3 * room.L, 0.5 * room.W, 1.5);
  assert.ok(Math.abs(r.receivers[0].delays[0].distanceMeters - expected) < 1e-9, `got ${r.receivers[0].delays[0].distanceMeters}, want ${expected}`);
});

check('IR: sources on the wall / floor / ceiling / corner that the API accepts still run, stay finite and radiate', () => {
  const small = { L: 4, W: 3, H: 2.5, wallMaterial: 'drywall', floorMaterial: 'wood_floor', ceilMaterial: 'drywall' };
  const spots = [{ x: 0, y: 0.5, z: 1.2 }, { x: 1, y: 0.5, z: 1.2 }, { x: 0.5, y: 0, z: 1.2 }, { x: 0.5, y: 1, z: 1.2 }, { x: 0.5, y: 0.5, z: 0 }, { x: 0.5, y: 0.5, z: 2.5 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 2.5 }];
  for (const p of spots) {
    const r: any = quiet(() => runIR({ ...small, sources: [{ id: 's', ...p }], receivers: [{ id: 'r', x: 0.6, y: 0.4, z: 1.2 }] }));
    assert.ok(allFinite(r.receiverTrace), `non-finite trace for source ${JSON.stringify(p)}`);
    assert.ok(energy(r.receiverTrace) > 0, `source ${JSON.stringify(p)} never reached the receiver`);
  }
});

check('IR: an invalid source position is refused, not clamped or defaulted', () => {
  const base = { ...room, receivers: [rcv] };
  const bad: Array<[string, any]> = [
    ['x above 1', { x: 1.7, y: 0.5, z: 1 }], ['x below 0', { x: -0.2, y: 0.5, z: 1 }], ['y above 1', { x: 0.5, y: 3, z: 1 }],
    ['z above room height', { x: 0.5, y: 0.5, z: 9 }], ['z negative', { x: 0.5, y: 0.5, z: -1 }],
    ['NaN x', { x: NaN, y: 0.5, z: 1 }], ['Infinity z', { x: 0.5, y: 0.5, z: Infinity }],
    ['missing x', { y: 0.5, z: 1 }], ['missing y', { x: 0.5, z: 1 }], ['null x', { x: null, y: 0.5, z: 1 }],
    ['string x', { x: '0.5', y: 0.5, z: 1 }], ['no object', null],
  ];
  for (const [label, s] of bad) {
    const ok = throwsWith(() => runIR({ ...base, sources: [s] }), /Invalid source position/);
    assert.equal(ok, true, `IR accepted or mis-reported "${label}": ${ok}`);
  }
});

check('IR: zero sources is an error, not a fabricated mid-room source', () => {
  assert.equal(throwsWith(() => runIR({ ...room, sources: [], receivers: [rcv] }), /between 1 and \d+ sources/), true);
  assert.equal(throwsWith(() => runIR({ ...room, receivers: [rcv] }), /between 1 and \d+ sources/), true);
});

check('IR: an omitted source height is the documented 0.7*H default (same as the API validator)', () => {
  const explicit: any = quiet(() => runIR({ ...room, sources: [{ id: 's', x: 0.3, y: 0.5, z: 0.7 * room.H }], receivers: [rcv] }));
  const omitted: any = quiet(() => runIR({ ...room, sources: [{ id: 's', x: 0.3, y: 0.5 }], receivers: [rcv] }));
  assert.equal(omitted.receivers[0].delays[0].distanceMeters, explicit.receivers[0].delays[0].distanceMeters);
});

const wave = (source: any) => ({ L: 4, W: 4, H: 3, steps: 60, fmax: 250, accuracyMode: 'fast', wallMaterial: 'drywall', floorMaterial: 'wood_floor', ceilMaterial: 'drywall_ceil', source, receivers: [{ x: 0.6, y: 0.4, z: 1.5 }] });

check('Wave: sources on the boundary that the API accepts still run, stay finite and radiate', () => {
  for (const p of [{ x: 0, y: 0.5, z: 1.5 }, { x: 0.5, y: 1, z: 1.5 }, { x: 0.5, y: 0.5, z: 0 }, { x: 0.5, y: 0.5, z: 3 }, { x: 1, y: 1, z: 3 }]) {
    const r: any = quiet(() => runWave(wave(p)));
    assert.ok(allFinite(r.receiverTrace), `non-finite wave trace for ${JSON.stringify(p)}`);
    assert.ok(energy(r.receiverTrace) > 0, `wave source ${JSON.stringify(p)} never reached the receiver`);
  }
});

check('Wave: an invalid or missing source is refused, not clamped or defaulted', () => {
  for (const [label, s] of [['x above 1', { x: 1.7, y: 0.5, z: 1 }], ['z above H', { x: 0.5, y: 0.5, z: 9 }], ['NaN', { x: NaN, y: 0.5, z: 1 }], ['missing x', { y: 0.5, z: 1 }], ['absent source', undefined]] as Array<[string, any]>) {
    const ok = throwsWith(() => runWave(wave(s)), /Invalid source position|between 1 and \d+ sources|source is required/i);
    assert.equal(ok, true, `wave accepted or mis-reported "${label}": ${ok}`);
  }
});

console.log(`\n=== ${passed} passed ===`);
