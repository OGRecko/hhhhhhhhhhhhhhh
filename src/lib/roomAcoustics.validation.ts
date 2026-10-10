// Validation suite: calls the REAL, production computeRT60() function
// (src/lib/roomAcoustics.ts) against independently published analytical
// reference cases — not a reimplementation of the formula. This is what
// backs any "validated against known reference cases" claim on a public
// validation page. Do not make that claim without this actually passing,
// and do not add a reference case without a real, citable published
// source.
//
// Run with: npx tsx src/lib/roomAcoustics.validation.ts
// (No test-framework dependency on purpose, so it runs standalone even
// before a full test setup exists in this project. Wire into a proper
// test runner / CI once one exists — this should run on every change to
// roomAcoustics.ts or absorption.ts.)

import { computeRT60, type RoomGeometryInput } from './roomAcoustics';
import type { AbsorptionCoeffs } from './absorption';

interface ReferenceCase {
  name: string;
  source: string; // full citation — every case must have one
  L: number; W: number; H: number;
  floorAlpha: number; ceilAlpha: number; wallAlpha: number;
  expectedSabineRt60Sec: number;
  tolerancePercent: number; // published examples round intermediate values
}

const REFERENCE_CASES: ReferenceCase[] = [
  {
    name: 'EELE 217 worked example (Montana State University, Spring 2012)',
    source: 'https://p-20.montana.edu/rmaher/eele217_sp12/sabine_calc_example_SP12.pdf',
    L: 20, W: 15, H: 4, // published as 15x20m floor, 4m ceiling
    floorAlpha: 0.2, ceilAlpha: 0.4, wallAlpha: 0.6,
    expectedSabineRt60Sec: 0.56,
    tolerancePercent: 2,
  },
];

function flatAlpha(a: number): AbsorptionCoeffs {
  return { hz125: a, hz250: a, hz500: a, hz1000: a, hz2000: a, hz4000: a, hz8000: a };
}

export function runValidation(): { passed: number; failed: number; results: string[] } {
  const results: string[] = [];
  let passed = 0, failed = 0;

  for (const c of REFERENCE_CASES) {
    const room: RoomGeometryInput = {
      poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      L: c.L, W: c.W, H: c.H,
      wallMaterial: 'validation_wall',
      wallSegMats: [null, null, null, null],
      floorMaterial: 'validation_floor',
      ceilMaterial: 'validation_ceiling',
    };

    // Custom lookup fed directly into the REAL computeRT60(), so this test
    // exercises the actual production geometry + Sabine/Eyring code path,
    // not a separate reimplementation of it.
    const lookup = (materialId: string): AbsorptionCoeffs => {
      if (materialId === 'validation_wall') return flatAlpha(c.wallAlpha);
      if (materialId === 'validation_floor') return flatAlpha(c.floorAlpha);
      if (materialId === 'validation_ceiling') return flatAlpha(c.ceilAlpha);
      return flatAlpha(0.1);
    };

    const result = computeRT60(room, lookup);
    // Flat alpha across all bands means every band's Sabine value should be
    // identical — use the 500Hz band as the representative value.
    const computedSabine = result.sabine['500 Hz'];
    const computedEyring = result.eyring['500 Hz'];

    const errorPercent = Math.abs((computedSabine as number) - c.expectedSabineRt60Sec) / c.expectedSabineRt60Sec * 100;
    const ok = errorPercent <= c.tolerancePercent;
    if (ok) passed++; else failed++;

    results.push(
      `${ok ? 'PASS' : 'FAIL'}: ${c.name}\n` +
      `  Source: ${c.source}\n` +
      `  Room: ${c.L}x${c.W}x${c.H}m, floor a=${c.floorAlpha}, ceil a=${c.ceilAlpha}, wall a=${c.wallAlpha}\n` +
      `  Expected Sabine RT60: ${c.expectedSabineRt60Sec}s | Computed (via real computeRT60()): ${(computedSabine as number).toFixed(3)}s | Error: ${errorPercent.toFixed(2)}% (tolerance ${c.tolerancePercent}%)\n` +
      `  Eyring RT60 (no independent published reference for this specific case): ${(computedEyring as number).toFixed(3)}s`
    );
  }

  const regressionRoom: RoomGeometryInput = {
    poly: [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],
    L: 10, W: 10, H: 3, wallMaterial: 'regWallA',
    wallSegMats: ['regWallA','regWallB','regWallA','regWallA'],
    wallOpenings: [null, null, null, null], floorMaterial: 'regFloor', ceilMaterial: 'regCeil',
  };
  const regLookup = (id: string): AbsorptionCoeffs => flatAlpha(
    id === 'regWallA' ? 0.1 : id === 'regWallB' ? 0.8 : 0.2
  );
  const closed = computeRT60(regressionRoom, regLookup);
  const opened = computeRT60({...regressionRoom, wallOpenings:[null,'full',null,null]}, regLookup);
  const materialChanged = computeRT60({...regressionRoom, wallSegMats:['regWallA','regWallA','regWallA','regWallA']}, regLookup);
  if (computeRT60(regressionRoom).sabine['8000 Hz'] !== null) throw new Error('8 kHz RT60 must be unavailable when the production material coefficient is unavailable.');
  if (Math.abs((opened.totalSurfaceArea ?? 0) - (closed.totalSurfaceArea ?? 0)) > 1e-9) throw new Error('A full wall opening must preserve the room boundary area while changing its energy-loss model.');
  if ((opened.sabine['500 Hz'] ?? Infinity) >= (closed.sabine['500 Hz'] ?? Infinity)) { failed++; results.push('FAIL: full wall opening regression did not increase energy loss / reduce RT60'); }
  else { passed++; results.push('PASS: full wall opening regression increases energy loss and reduces RT60'); }
  if ((materialChanged.sabine['500 Hz'] ?? 0) === (closed.sabine['500 Hz'] ?? 0)) { failed++; results.push('FAIL: per-wall material regression did not change RT60'); }
  else { passed++; results.push('PASS: per-wall material regression changes RT60'); }

  return { passed, failed, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { passed, failed, results } = runValidation();
  results.forEach(r => console.log(r + '\n'));
  console.log(`${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}
