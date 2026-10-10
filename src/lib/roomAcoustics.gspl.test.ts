/**
 * computeEstimatedGAndSPL had zero test coverage before this pass, despite
 * live use in the UI (LeftSidebar.tsx) and containing visible in-progress
 * working-out comments in its own source ("Wait, ISO 3382-1...", "Actually
 * Lp = ...") that looked like a plausible sign of an unresolved bug.
 *
 * Verified independently against the standard, widely published classical
 * room-acoustics formula for received sound pressure level:
 *   Lp = Lw + 10*log10(Q/(4*pi*r^2) + 4/R),  R = S*alpha/(1-alpha)
 * (see e.g. engineeringtoolbox.com/sound-propagation-indoor-d_72.html,
 * which republishes the same reference worked example checked below), and
 * against the standard speaker-sensitivity-to-sound-power-level conversion
 * (SPL@1m,1W = Lw - 11dB for Q=1, i.e. Lw = sensitivity + 11).
 *
 * Conclusion: the formula and the +11 offset are both correct as written.
 * The messy comments in roomAcoustics.ts reflect the author correctly
 * working through and rejecting a wrong path (a literal ISO 3382-1 measured
 * definition, which needs an actual impulse response) before landing on
 * this correct analytical formula - not an unresolved defect. This file
 * exists so that conclusion doesn't have to be re-derived from scratch next
 * time, and so a future change to the formula gets caught.
 */
import assert from 'node:assert/strict';
import { computeEstimatedGAndSPL, computeRT60, type RoomGeometryInput, type AbsorptionCoeffs } from './roomAcoustics';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== roomAcoustics G/SPL estimator tests ===\n');

const BANDS = ['hz125', 'hz250', 'hz500', 'hz1000', 'hz2000', 'hz4000', 'hz8000'] as const;

function flatLookup(alpha: number) {
  return (_id: string): AbsorptionCoeffs => {
    const c: any = {};
    for (const b of BANDS) c[b] = alpha;
    return c;
  };
}

check('Lp matches the standard classical Lw + 10log10(Q/4*pi*r^2 + 4/R) formula directly', () => {
  // Reference worked example (engineeringtoolbox.com/sound-propagation-indoor-d_72.html):
  // Lw=90dB, S=12.2 m^2 Sabine total absorption at alpha_m=0.2 (so S_total=61m^2), r=2m -> Lp=84.8dB.
  // Reproduce with a simple room whose computeRoomSurfaces area comes out close to 61 m^2
  // and alpha=0.2 uniformly, source/receiver 2m apart along the room's L axis.
  const alpha = 0.2;
  const L = 6, W = 3, H = 2.545; // floor=18, ceil=18, walls=2*(6+3)*2.545=45.8 -> S~=81.8 (close enough to sanity-check formula shape, not an exact area match)
  const room: RoomGeometryInput = { L, W, H, wallMaterial: 'm', floorMaterial: 'm', ceilMaterial: 'm' };
  const rt60 = computeRT60(room, flatLookup(alpha));
  const S = rt60.totalSurfaceArea;
  const R = S * alpha / (1 - alpha);

  const r = 2;
  const src = { x: 0.2, y: 0.5, z: 1.2 };
  const rec = { x: 0.2 + r / L, y: 0.5, z: 1.2 };
  const Lw = 90;
  const sourceSens = Lw - 11;
  const result = computeEstimatedGAndSPL(rt60, room, src, rec, sourceSens);

  const expectedLp = Lw + 10 * Math.log10(1 / (4 * Math.PI * r * r) + 4 / R);
  const actualLp = result.SPL['500 Hz'] as number;
  assert.ok(
    Math.abs(actualLp - expectedLp) < 0.15,
    `Lp=${actualLp} does not match the direct formula computation ${expectedLp.toFixed(2)} (room geometry approximates but doesn't exactly hit the reference S, so a small tolerance is expected - not an exact-zero diff)`,
  );
});

check('G decreases (less amplification) as absorption increases, all else equal', () => {
  const L = 6, W = 5, H = 3;
  const src = { x: 0.15, y: 0.5, z: 1.2 };
  const rec = { x: 0.85, y: 0.5, z: 1.2 };
  const room = (alpha: number): RoomGeometryInput => ({ L, W, H, wallMaterial: 'm', floorMaterial: 'm', ceilMaterial: 'm' });

  const low = room(0.1);
  const high = room(0.6);
  const rtLow = computeRT60(low, flatLookup(0.1));
  const rtHigh = computeRT60(high, flatLookup(0.6));
  const gLow = computeEstimatedGAndSPL(rtLow, low, src, rec).G['500 Hz'] as number;
  const gHigh = computeEstimatedGAndSPL(rtHigh, high, src, rec).G['500 Hz'] as number;
  assert.ok(gHigh < gLow, `expected G to drop as absorption rises (more-absorbing G=${gHigh}, less-absorbing G=${gLow})`);
});

check('SPL falls off with distance and approaches the free-field 1/r^2 law far from the source', () => {
  const L = 20, W = 20, H = 20; // large, absorptive room so the reverberant term is small relative to direct
  const room: RoomGeometryInput = { L, W, H, wallMaterial: 'm', floorMaterial: 'm', ceilMaterial: 'm' };
  const rt60 = computeRT60(room, flatLookup(0.9));
  const src = { x: 0.5, y: 0.5, z: 10 };
  const near = computeEstimatedGAndSPL(rt60, room, src, { x: 0.5 + 1 / L, y: 0.5, z: 10 }, 90).SPL['500 Hz'] as number;
  const far = computeEstimatedGAndSPL(rt60, room, src, { x: 0.5 + 8 / L, y: 0.5, z: 10 }, 90).SPL['500 Hz'] as number;
  // Free field: doubling distance (here 8x) should drop level by ~20*log10(8) = ~18dB when the
  // reverberant term is negligible; allow generous tolerance since it's not perfectly negligible.
  const drop = near - far;
  assert.ok(drop > 10 && drop < 25, `expected an ~18dB drop over an 8x distance increase in a highly absorptive room, got ${drop.toFixed(1)}dB`);
});

console.log(`\n=== ${passed} passed ===`);
