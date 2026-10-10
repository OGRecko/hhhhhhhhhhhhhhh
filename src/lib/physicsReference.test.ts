/**
 * Comprehensive physics and analytical acoustics reference test suite
 * Tests:
 * A. Rectangular room with known Sabine RT60 (EELE 217 reference benchmark)
 * B. Room with one wall changed to different absorption coefficient
 * C. Room with a full opening (energy loss sink)
 * D. Room with a partial opening (proportional radiation loss)
 * E. L-shaped room (concave polygon surface area & volume conservation)
 * F. U-shaped concave polygon geometric and acoustic stability
 * G. Multiple sources in numerical FDTD solver
 * H. Multiple receivers in numerical FDTD solver
 * I. Source/receiver at floor level (boundary proximity stability)
 * J. Zero absorption (hard reflection energy conservation)
 * K. Very high absorption (anechoic decay limit)
 */

import { computeRT60, type RoomGeometryInput } from "./roomAcoustics";
import type { AbsorptionCoeffs } from "./absorption";
import { runIR, runWave } from "../../server/solverWorker";

console.log("\n=== Extended Acoustic Physics Reference Benchmarks ===\n");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err: any) {
    failed++;
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err: any) {
    failed++;
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function flatAlpha(a: number): AbsorptionCoeffs {
  return { hz125: a, hz250: a, hz500: a, hz1000: a, hz2000: a, hz4000: a, hz8000: a };
}

function runSilenced<T>(fn: () => T): T {
  const orig = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = orig;
  }
}

// -----------------------------------------------------------------------------
// Case A: Rectangular room with known Sabine RT60 (EELE 217 Reference)
// -----------------------------------------------------------------------------
check("Case A: Rectangular room with known Sabine RT60", () => {
  const room: RoomGeometryInput = {
    poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    L: 20, W: 15, H: 4,
    wallMaterial: "wall_mat",
    wallSegMats: [null, null, null, null],
    floorMaterial: "floor_mat",
    ceilMaterial: "ceil_mat",
  };
  const lookup = (m: string) => {
    if (m === "wall_mat") return flatAlpha(0.6);
    if (m === "floor_mat") return flatAlpha(0.2);
    if (m === "ceil_mat") return flatAlpha(0.4);
    return flatAlpha(0.1);
  };
  const res = computeRT60(room, lookup);
  const sabine500 = res.sabine["500 Hz"] as number;
  const expected = 0.56;
  const errorPercent = Math.abs(sabine500 - expected) / expected * 100;
  assert(errorPercent < 2.0, `Expected ~0.56s, got ${sabine500.toFixed(3)}s (${errorPercent.toFixed(2)}% err)`);
});

// -----------------------------------------------------------------------------
// Case B: Same room with one wall changed to different absorption
// -----------------------------------------------------------------------------
check("Case B: Per-wall material variation modifies absorption correctly", () => {
  const baseRoom: RoomGeometryInput = {
    poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    L: 10, W: 8, H: 3,
    wallMaterial: "mat_low",
    wallSegMats: ["mat_low", "mat_low", "mat_low", "mat_low"],
    floorMaterial: "mat_low",
    ceilMaterial: "mat_low",
  };
  const lookup = (m: string) => (m === "mat_high" ? flatAlpha(0.8) : flatAlpha(0.1));
  const baseRes = computeRT60(baseRoom, lookup);
  const modRoom: RoomGeometryInput = {
    ...baseRoom,
    wallSegMats: ["mat_low", "mat_high", "mat_low", "mat_low"],
  };
  const modRes = computeRT60(modRoom, lookup);

  const rtBase = baseRes.sabine["500 Hz"] as number;
  const rtMod = modRes.sabine["500 Hz"] as number;
  assert(rtMod < rtBase, `Higher absorption wall must decrease RT60: ${rtMod} >= ${rtBase}`);
  assert(modRes.avgAbsorption["500 Hz"]! > baseRes.avgAbsorption["500 Hz"]!, "Average absorption metric must increase");
});

// -----------------------------------------------------------------------------
// Case C: Full wall opening acts as perfect absorber / energy sink
// -----------------------------------------------------------------------------
check("Case C: Full wall opening increases effective loss and decreases RT60", () => {
  const room: RoomGeometryInput = {
    poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    L: 10, W: 10, H: 3,
    wallMaterial: "mat_wall",
    wallSegMats: [null, null, null, null],
    floorMaterial: "mat_floor",
    ceilMaterial: "mat_ceil",
  };
  const lookup = () => flatAlpha(0.1);
  const closed = computeRT60(room, lookup);
  const opened = computeRT60({ ...room, wallOpenings: [null, "full", null, null] }, lookup);

  const rtClosed = closed.sabine["500 Hz"] as number;
  const rtOpen = opened.sabine["500 Hz"] as number;
  assert(rtOpen < rtClosed, `Full opening must reduce RT60: ${rtOpen} >= ${rtClosed}`);
});

// -----------------------------------------------------------------------------
// Case D: Partial opening behaves proportionally between solid and full opening
// -----------------------------------------------------------------------------
check("Case D: Partial opening loss scales monotonically between solid and full", () => {
  const room: RoomGeometryInput = {
    poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    L: 10, W: 10, H: 3,
    wallMaterial: "mat_wall",
    wallSegMats: [null, null, null, null],
    floorMaterial: "mat_floor",
    ceilMaterial: "mat_ceil",
  };
  const lookup = () => flatAlpha(0.1);
  const closed = computeRT60(room, lookup);
  const partial = computeRT60({ ...room, wallOpenings: [null, { start: 0.25, end: 0.75 }, null, null] }, lookup);
  const full = computeRT60({ ...room, wallOpenings: [null, "full", null, null] }, lookup);

  const rtClosed = closed.sabine["500 Hz"] as number;
  const rtPartial = partial.sabine["500 Hz"] as number;
  const rtFull = full.sabine["500 Hz"] as number;

  assert(rtClosed > rtPartial, `Partial opening must have lower RT60 than closed: ${rtPartial} >= ${rtClosed}`);
  assert(rtPartial > rtFull, `Partial opening must have higher RT60 than full opening: ${rtPartial} <= ${rtFull}`);
});

// -----------------------------------------------------------------------------
// Case E: L-shaped room (concave polygon) surface area & volume
// -----------------------------------------------------------------------------
check("Case E: L-shaped concave polygon calculation matches geometric ground truth", () => {
  // L-room: 10x10 bounding with 5x5 cutout -> Area = 100 - 25 = 75 m^2.
  // Perimeter: 10 + 5 + 5 + 5 + 5 + 10 = 40 m. Height: 3m.
  // Wall Area = 40 * 3 = 120 m^2. Floor + Ceil = 2 * 75 = 150 m^2. Total = 270 m^2.
  // Volume = 75 * 3 = 225 m^3.
  const lPoly = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 0.5 },
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 1 },
    { x: 0, y: 1 },
  ];
  const room: RoomGeometryInput = {
    poly: lPoly,
    L: 10, W: 10, H: 3,
    wallMaterial: "mat_std",
    wallSegMats: [null, null, null, null, null, null],
    floorMaterial: "mat_std",
    ceilMaterial: "mat_std",
  };
  const lookup = () => flatAlpha(0.2);
  const res = computeRT60(room, lookup);

  assert(Math.abs(res.volume - 225) < 1e-4, `Expected volume 225, got ${res.volume}`);
  assert(Math.abs(res.totalSurfaceArea - 270) < 1e-4, `Expected surface 270, got ${res.totalSurfaceArea}`);
  // Sabine RT60 = 0.161 * V / A_total = 0.161 * 225 / (270 * 0.2) = 36.225 / 54 = 0.6708 s
  const expectedSabine = 0.161 * 225 / (270 * 0.2);
  const computedSabine = res.sabine["500 Hz"] as number;
  assert(Math.abs(computedSabine - expectedSabine) < 0.01, `Expected Sabine ~${expectedSabine.toFixed(3)}, got ${computedSabine.toFixed(3)}`);
});

// -----------------------------------------------------------------------------
// Case F: Cross / U-shaped concave polygon analytical integrity
// -----------------------------------------------------------------------------
check("Case F: U-shaped polygon preserves geometry and finite RT60", () => {
  const uPoly = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0.7, y: 1 },
    { x: 0.7, y: 0.3 },
    { x: 0.3, y: 0.3 },
    { x: 0.3, y: 1 },
    { x: 0, y: 1 },
  ];
  const room: RoomGeometryInput = {
    poly: uPoly,
    L: 10, W: 10, H: 3,
    wallMaterial: "wood_panel",
    wallSegMats: new Array(8).fill(null),
    floorMaterial: "concrete_floor",
    ceilMaterial: "drywall_ceil",
  };
  const res = computeRT60(room);
  assert(res.volume > 0, "Volume must be strictly positive");
  assert(res.totalSurfaceArea > 0, "Surface area must be strictly positive");
  assert(Number.isFinite(res.sabine["500 Hz"]), "RT60 must be finite");
});

// -----------------------------------------------------------------------------
// Case G & H: Numerical FDTD solver with Multiple Sources and Receivers
// -----------------------------------------------------------------------------
await checkAsync("Case G & H: Numerical IR Solver with multiple sources & receivers", async () => {
  // Solver uses normalized [0, 1] coordinates for x and y, and real meters for z
  const irResult = await runSilenced(() =>
    runIR({
      wallMaterial: 'drywall', floorMaterial: 'wood_floor', ceilMaterial: 'drywall_ceil', L: 5, W: 4, H: 3,
      durationSec: 0.5,
      sources: [
        { id: "src1", x: 0.3, y: 0.3, z: 1.5 },
        { id: "src2", x: 0.7, y: 0.3, z: 1.5 },
      ],
      receivers: [
        { id: "rec1", x: 0.4, y: 0.6, z: 1.5 },
        { id: "rec2", x: 0.6, y: 0.6, z: 1.5 },
      ],
    })
  );

  assert(irResult.receivers.length === 2, `Expected 2 receivers in IR output, got ${irResult.receivers.length}`);
  assert(irResult.receivers[0].trace.length > 50, "Receiver 1 IR must contain numerical samples");
  assert(irResult.receivers[1].trace.length > 50, "Receiver 2 IR must contain numerical samples");
  for (const s of irResult.receivers[0].trace) {
    assert(Number.isFinite(s), "Samples must be finite");
    assert(!Number.isNaN(s), "Samples must not be NaN");
  }
});

// -----------------------------------------------------------------------------
// Case I: Source/Receiver at floor height (Boundary proximity stability)
// -----------------------------------------------------------------------------
await checkAsync("Case I: Source and receiver at floor height boundary numerical stability", async () => {
  const waveResult = await runSilenced(() =>
    runWave({
      wallMaterial: 'drywall', floorMaterial: 'wood_floor', ceilMaterial: 'drywall_ceil', L: 4, W: 4, H: 3,
      fmax: 120,
      steps: 40,
      cflReductionFactor: 0.95,
      source: { x: 0.5, y: 0.5, z: 0.0 }, // Floor level z = 0
      receivers: [{ x: 0.7, y: 0.5, z: 0.0 }], // Floor level z = 0
    })
  );

  assert(Array.isArray(waveResult.receiverTraces), "receiverTraces must be an array");
  assert(waveResult.receiverTraces.length === 1, "Expected 1 receiver trace");
  const trace = waveResult.receiverTraces[0];
  assert(trace.length === 40, "Trace length must match step count");
  const maxAbs = Math.max(...trace.map(Math.abs));
  assert(Number.isFinite(maxAbs), "Max amplitude must be finite");
  assert(!Number.isNaN(maxAbs), "Max amplitude must not be NaN");
  assert(maxAbs > 0, "Floor boundary source must radiate energy to receiver");
});

// -----------------------------------------------------------------------------
// Case J: Zero absorption (Hard reflection boundary energy conservation)
// -----------------------------------------------------------------------------
check("Case J: Zero absorption (rigid boundaries) approaches infinite Sabine RT60", () => {
  const room: RoomGeometryInput = {
    poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    L: 8, W: 6, H: 3,
    wallMaterial: "rigid",
    wallSegMats: [null, null, null, null],
    floorMaterial: "rigid",
    ceilMaterial: "rigid",
  };
  const lookup = () => flatAlpha(0.0001); // Near-zero absorption limit
  const res = computeRT60(room, lookup);
  const rt = res.sabine["500 Hz"] as number;
  assert(rt > 100, `Near-zero absorption room must exhibit massive RT60, got ${rt}s`);
});

// -----------------------------------------------------------------------------
// Case K: Very high absorption (Anechoic limit)
// -----------------------------------------------------------------------------
check("Case K: Very high absorption approaches anechoic zero-reverberation limit", () => {
  const room: RoomGeometryInput = {
    poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    L: 8, W: 6, H: 3,
    wallMaterial: "anechoic",
    wallSegMats: [null, null, null, null],
    floorMaterial: "anechoic",
    ceilMaterial: "anechoic",
  };
  const lookup = () => flatAlpha(0.99); // Anechoic chamber limit
  const res = computeRT60(room, lookup);
  const rt = res.sabine["500 Hz"] as number;
  assert(rt < 0.15, `Anechoic absorption room must exhibit near-instant decay (< 0.15s), got ${rt}s`);
});

console.log(`\n=== Physical Reference Benchmarks: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  console.error("Failures:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
