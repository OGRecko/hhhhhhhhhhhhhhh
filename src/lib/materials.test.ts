import assert from "node:assert/strict";
import { MATERIALS, ABSORPTION, ABSORPTION_OCTAVE, getAbsorption, getOctaveAbsorption } from "./materials";
import { ABSORPTION as RAW_ABSORPTION } from "./absorption";
import { filterIntoBands, bandpassBiquad, applyBiquad, OCTAVE_BANDS_HZ } from "./octaveFilter";
import { interpolateIDW, generateInterpolationGrid } from "./interpolation";
import { computeSpatialSummary, computeAllSpatialSummaries, generateReceiverGrid, estimateGridReceiverCount, buildHeatmapData, checkSpatialResolution } from "./spatialAnalysis";
import { calibrateRelativeLevel } from "./splCalibration";
import { normalizeSpeakerSpec } from "./speakerDSP";

console.log("=== Domain and DSP Unit Tests ===");

// 1. Materials & Absorption
{
  assert.equal(getAbsorption("drywall"), 0.05);
  assert.equal(getAbsorption("nonexistent_mat", 0.12), 0.12);
  assert.equal(getAbsorption(null, 0.2), 0.2);

  assert.equal(getOctaveAbsorption("drywall", 500), 0.05);
  assert.equal(getOctaveAbsorption("drywall", 125), 0.29);
  assert.equal(getOctaveAbsorption("nonexistent", 500), "N/A");
  assert.equal(getOctaveAbsorption("drywall", 9999), "N/A");

  // Verify all categories exist
  assert(MATERIALS.walls.length > 0);
  assert(MATERIALS.floor.length > 0);
  assert(MATERIALS.ceiling.length > 0);

  // Check 8kHz missing data policy
  for (const [id, c] of Object.entries(RAW_ABSORPTION)) {
    const oct = ABSORPTION_OCTAVE[id];
    assert(oct, `Missing octave absorption mapping for ${id}`);
    if (c.hz8000 === null || c.hz8000 === undefined) {
      assert.equal(oct[8000], "N/A", `Expected N/A for undefined 8kHz on ${id}`);
    } else {
      assert.equal(oct[8000], c.hz8000);
    }
  }
  console.log("  PASS  materials & absorption integrity");
}

// 2. Octave Filter
{
  const sr = 48000;
  const biquad = bandpassBiquad(1000, sr, Math.SQRT1_2);
  assert(Number.isFinite(biquad.b0) && Number.isFinite(biquad.a1));

  // Filter a 1000 Hz sine wave vs 200 Hz sine wave
  const N = 4800;
  const sig1k = Array.from({ length: N }, (_, i) => Math.sin(2 * Math.PI * 1000 * (i / sr)));
  const sig200 = Array.from({ length: N }, (_, i) => Math.sin(2 * Math.PI * 200 * (i / sr)));

  const out1k = applyBiquad(sig1k, biquad);
  const out200 = applyBiquad(sig200, biquad);

  const rms1k = Math.sqrt(out1k.slice(2000).reduce((s, x) => s + x * x, 0) / (N - 2000));
  const rms200 = Math.sqrt(out200.slice(2000).reduce((s, x) => s + x * x, 0) / (N - 2000));

  assert(rms1k > rms200 * 3, `Expected 1kHz bandpass to attenuate 200Hz (rms1k=${rms1k.toFixed(3)}, rms200=${rms200.toFixed(3)})`);

  // Nyquist guard in filterIntoBands
  const lowSrBands = filterIntoBands(sig1k, 4000); // Nyquist is 2000 Hz
  assert(lowSrBands[1000] !== undefined, "1000 Hz should be retained below Nyquist");
  assert(lowSrBands[4000] === undefined, "4000 Hz should be dropped above Nyquist");
  assert(lowSrBands[8000] === undefined, "8000 Hz should be dropped above Nyquist");
  console.log("  PASS  octaveFilter DSP & Nyquist protection");
}

// 3. Interpolation
{
  const pts = [
    { x: 0, y: 0, value: 10 },
    { x: 1, y: 0, value: 20 },
    { x: 0, y: 1, value: 30 },
    { x: 1, y: 1, value: 40 },
  ];
  // Exact match
  assert.equal(interpolateIDW(0, 0, pts), 10);
  assert.equal(interpolateIDW(1, 1, pts), 40);

  // Center point symmetry
  const mid = interpolateIDW(0.5, 0.5, pts);
  assert(mid !== null && Math.abs(mid - 25) < 1e-4, `Center IDW should be average 25, got ${mid}`);

  // Empty points
  assert.equal(interpolateIDW(0.5, 0.5, []), null);

  // Grid generator
  const grid = generateInterpolationGrid(pts, 4);
  assert.equal(grid.length, 16);
  assert(grid.every(v => v !== null && Number.isFinite(v)));
  console.log("  PASS  IDW interpolation & grid generation");
}

// 4. Spatial Analysis
{
  const summary = computeSpatialSummary("RT60", [0.4, 0.5, 0.6, 0.7, 0.8]);
  assert(summary !== null);
  assert.equal(summary.min, 0.4);
  assert.equal(summary.max, 0.8);
  assert.equal(summary.mean, 0.6);
  assert.equal(summary.median, 0.6);
  assert.equal(summary.validCount, 5);

  // Fewer than 2 valid values
  assert.equal(computeSpatialSummary("RT60", [null, 0.5, NaN]), null);

  // Receiver grid generator
  const gridDef = { xMin: 0.2, xMax: 0.8, yMin: 0.2, yMax: 0.8, spacing: 2.0, zHeight: 1.2 };
  const rcvs = generateReceiverGrid(gridDef, 10, 8);
  assert(rcvs.length > 0);
  assert(rcvs.every(r => r.x >= 0 && r.x <= 1 && r.y >= 0 && r.y <= 1));

  const estCount = estimateGridReceiverCount(gridDef, 10, 8);
  assert(estCount > 0);

  // Coarse resolution check
  const warn = checkSpatialResolution(4.0, 10, 8); // 4m > 8/4 = 2m
  assert(warn !== null && warn.code === "LOW_SPATIAL_RESOLUTION");
  const noWarn = checkSpatialResolution(1.0, 10, 8);
  assert.equal(noWarn, null);
  console.log("  PASS  spatial analysis metrics & grid calculation");
}

// 5. SPL Calibration
{
  const cal = calibrateRelativeLevel(-12, 85);
  assert.equal(cal.offsetDb, 97);
  assert.equal(cal.calibratedDb, 85);
  assert.throws(() => calibrateRelativeLevel(NaN, 85));
  assert.throws(() => calibrateRelativeLevel(-12, Infinity));
  console.log("  PASS  SPL relative calibration");
}

// 6. Speaker DSP normalization
{
  const legacyRaw = { id: "legacy-1", brand: "Acme", model: "L-100", overallStatus: "LEGACY", sens_db: 90 };
  const norm = normalizeSpeakerSpec(legacyRaw);
  assert.equal(norm.id, "legacy-1");
  assert.equal(norm.overallStatus, "LEGACY");
  assert.equal(norm.sensitivity.value, 90);
  assert.equal(norm.frequencyResponse.status, "UNAVAILABLE");
  console.log("  PASS  speaker DSP spec normalization");
}

console.log("=== All 6 Domain Tests Passed ===");
