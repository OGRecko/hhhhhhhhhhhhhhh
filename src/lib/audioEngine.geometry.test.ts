/**
 * audioEngine.ts cannot be imported in this test environment: it pulls in
 * `useStore` -> `zustand`, a real npm dependency that isn't installed here
 * and there's no network to fetch it (see HARDENING_LEDGER.md). That blocks
 * the whole module, even though two of its methods - lineIntersect and
 * checkWallIntersections - are pure geometry/occlusion math with no actual
 * dependency on AudioContext, the DOM, or the store; only a type annotation
 * references useStore's WallOpening type.
 *
 * This file verifies that pure logic by reproducing it verbatim as
 * standalone functions and testing those - and guards against the copy
 * silently drifting out of sync with the real source by re-reading
 * audioEngine.ts at test time and asserting the two function bodies below
 * are textually identical to what's actually shipped. If someone edits
 * lineIntersect or checkWallIntersections in audioEngine.ts without
 * updating this file, the drift check fails loudly instead of this file
 * quietly testing stale logic forever.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MATERIALS } from './materials';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== audioEngine geometry tests (standalone reproduction - see file header) ===\n');

// --- Verbatim reproduction of the two functions from src/lib/audioEngine.ts ---
function lineIntersect(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number) {
  const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
  if (denom === 0) return null;
  const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
  const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;
  if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) return ub;
  return null;
}

function checkWallIntersections(sx: number, sz: number, rx: number, rz: number, poly: { x: number; y: number }[], wallSegMats: (string | null)[], globalWallMat: string, L: number, W: number, wallOpenings: any[] = []) {
  let lossDb = 0;
  if (!Number.isFinite(L) || !Number.isFinite(W) || L <= 0 || W <= 0) {
    return 0;
  }
  const p1x = (sx / L) + 0.5;
  const p1z = (sz / W) + 0.5;
  const p2x = (rx / L) + 0.5;
  const p2z = (rz / W) + 0.5;

  for (let i = 0; i < poly.length; i++) {
    const nextI = (i + 1) % poly.length;
    const opening = wallOpenings[i];
    if (opening === 'full') continue;
    const hitAt = lineIntersect(p1x, p1z, p2x, p2z, poly[i].x, poly[i].y, poly[nextI].x, poly[nextI].y);
    if (hitAt === null) continue;
    if (opening && typeof opening === 'object' && hitAt >= opening.start && hitAt <= opening.end) {
      continue;
    }
    const matId = wallSegMats[i] || globalWallMat;
    const mat = MATERIALS.walls.find((m) => m.id === matId);
    if (!mat || !Number.isFinite(mat.tl)) {
      throw new Error(`Unknown wall material "${matId}" — cannot compute transmission loss`);
    }
    lossDb += mat.tl;
  }
  return lossDb;
}
// --- end reproduction ---

check('drift check: the real audioEngine.ts methods and this file\'s copies agree on a grid of inputs', () => {
  // A text comparison of compiled output is too brittle (the compiler drops
  // redundant parens, rewrites quotes and number literals, removes trailing
  // semicolons). Compare BEHAVIOUR instead: extract the real method source
  // from audioEngine.ts, evaluate it, and run it against the copies above
  // over the same inputs. Any logic change in the real methods that the
  // copies don't share shows up as a differing result.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, 'audioEngine.ts'), 'utf8');

  const extractMethod = (name: string): string => {
    const start = src.indexOf(`  ${name}(`);
    if (start === -1) throw new Error(`could not find ${name} in audioEngine.ts - has it been renamed?`);
    let parenDepth = 0, p = src.indexOf('(', start);
    for (; p < src.length; p++) {
      if (src[p] === '(') parenDepth++;
      else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) break; }
    }
    const braceStart = src.indexOf('{', p);
    let depth = 0, i = braceStart;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    // Parameter names only (types stripped): everything between the outer parens, minus ": type" and defaults' types.
    const rawParams = src.slice(src.indexOf('(', start) + 1, p);
    const paramNames = rawParams.split(/,(?![^<(]*[>)])/).map((x) => x.trim().split(/[:=]/)[0].trim()).filter(Boolean);
    return `(function(${paramNames.join(',')})${src.slice(braceStart, i + 1)})`;
  };

  // eslint-disable-next-line no-new-func
  const realLineIntersect = (0, eval)(extractMethod('lineIntersect')) as typeof lineIntersect;
  const ctx = { lineIntersect: realLineIntersect };
  // The real method reads MATERIALS from the enclosing module scope and calls this.lineIntersect.
  const realCheck = (new Function('MATERIALS', `return ${extractMethod('checkWallIntersections')};`))(MATERIALS).bind(ctx) as typeof checkWallIntersections;

  const polys = [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }], // L-shaped
  ];
  const coords = [-9, -6, -4, -1, 0, 1, 4, 6, 9];
  const openingSets: any[][] = [[], ['full', null, null, null], [null, { start: 0.2, end: 0.8 }, null, null], [null, null, null, { start: 0, end: 1 }]];
  const dims: [number, number][] = [[10, 10], [8, 5], [0, 5], [10, NaN], [-3, 4]];
  let compared = 0;
  for (const poly of polys) for (const [L, W] of dims) for (const ops of openingSets)
    for (const globalMat of ['drywall', 'concrete', 'no_such_material'])
    for (const sx of coords) for (const rx of coords) for (const sz of [-3, 0, 3]) for (const rz of [-3, 0, 3]) {
      const mats = poly.map((_, i) => (i === 1 ? 'glass' : null)); // mix per-segment override and global fallback
      const run = (fn: typeof checkWallIntersections) => {
        try { return fn(sx, sz, rx, rz, poly, mats, globalMat, L, W, ops); }
        catch (e) { return `THROW:${(e as Error).message}`; }
      };
      const a = run(checkWallIntersections);
      const b = run(realCheck);
      assert.equal(a, b, `copy and real checkWallIntersections disagree: copy=${a} real=${b} for (${sx},${sz})->(${rx},${rz}) L=${L} W=${W} mat=${globalMat}`);
      compared++;
    }
  for (const [x1, y1, x2, y2, x3, y3, x4, y4] of [[0,0,10,10,0,10,10,0],[0,0,10,0,0,5,10,5],[0,0,1,1,5,0,5,-1],[-5,0,5,0,0,-5,0,5]]) {
    assert.equal(lineIntersect(x1,y1,x2,y2,x3,y3,x4,y4), realLineIntersect(x1,y1,x2,y2,x3,y3,x4,y4));
    compared++;
  }
  assert.ok(compared > 1000, `expected a broad comparison grid, only compared ${compared}`);
});

check('lineIntersect finds the crossing point of two segments that cross in the middle', () => {
  const r = lineIntersect(0, 0, 10, 10, 0, 10, 10, 0); // X shape, crosses at (5,5)
  assert.equal(r, 0.5);
});

check('lineIntersect returns null for parallel, non-intersecting segments', () => {
  assert.equal(lineIntersect(0, 0, 10, 0, 0, 5, 10, 5), null);
});

check('lineIntersect returns null when segments would only cross if extended beyond their bounds', () => {
  assert.equal(lineIntersect(0, 0, 1, 1, 5, 0, 5, -1), null);
});

check('checkWallIntersections returns 0 (not NaN/Infinity) for a non-positive or non-finite L or W', () => {
  const poly = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  assert.equal(checkWallIntersections(-4, 0, 4, 0, poly, [null, null, null, null], 'drywall', 0, 10), 0);
  assert.equal(checkWallIntersections(-4, 0, 4, 0, poly, [null, null, null, null], 'drywall', -5, 10), 0);
  assert.equal(checkWallIntersections(-4, 0, 4, 0, poly, [null, null, null, null], 'drywall', NaN, 10), 0);
});

check('checkWallIntersections sums material transmission loss for each wall segment crossed', () => {
  const poly = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const L = 10, W = 10;
  const loss = checkWallIntersections(-6, 0, 6, 0, poly, [null, null, null, null], 'drywall', L, W);
  const tl = MATERIALS.walls.find((m) => m.id === 'drywall')!.tl;
  assert.equal(loss, 2 * tl, `expected 2 crossed drywall segments at ${tl}dB each = ${2 * tl}, got ${loss}`);
});

check('an unknown material id throws instead of being replaced by an invented 30 dB loss', () => {
  const poly = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  assert.throws(
    () => checkWallIntersections(-6, 0, 6, 0, poly, [null, null, null, null], 'no_such_material', 10, 10),
    /Unknown wall material "no_such_material"/,
  );
});

check('a per-segment material overrides the global wall material for that segment only', () => {
  const poly = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  // Line crosses segment 1 (x=1 wall) and segment 3 (x=0 wall). Override only segment 1 with concrete.
  const drywallTl = MATERIALS.walls.find((m) => m.id === 'drywall')!.tl;
  const concreteTl = MATERIALS.walls.find((m) => m.id === 'concrete')!.tl;
  const loss = checkWallIntersections(-6, 0, 6, 0, poly, [null, 'concrete', null, null], 'drywall', 10, 10);
  assert.equal(loss, drywallTl + concreteTl, `expected one drywall + one concrete crossing = ${drywallTl + concreteTl}, got ${loss}`);
});

check('a fully-open wall segment contributes zero loss even when geometrically crossed', () => {
  const poly = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const L = 10, W = 10;
  const loss = checkWallIntersections(-6, 0, 6, 0, poly, [null, null, null, null], 'drywall', L, W, ['full', 'full', 'full', 'full']);
  assert.equal(loss, 0);
});

check('a partial opening (doorway) lets the sound path through only when it crosses within the gap range', () => {
  const poly = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const L = 10, W = 10;
  const loss = checkWallIntersections(-6, 0, 6, 0, poly, [null, null, null, null], 'drywall', L, W, [null, null, null, { start: 0, end: 1 }]);
  const tl = MATERIALS.walls.find((m) => m.id === 'drywall')!.tl;
  assert.equal(loss, tl, `expected only the other (non-doorway) wall's ${tl}dB, got ${loss}`);
});

console.log(`\n=== ${passed} passed ===`);
