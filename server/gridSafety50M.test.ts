/**
 * Regression tests for 50,000,000 grid cell safety and pre-allocation guards.
 *
 * Verifies that the public numerical ceiling of 50M cells and memory budgets
 * are strictly enforced BEFORE allocating arrays across wave and IR solvers.
 */
import assert from "node:assert/strict";
import { runWave, runIR } from "./solverWorker.js";
import { LIMITS, waveGridRequirement } from "../src/lib/publicLimits.js";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
};

console.log("\n=== 50M Grid Ceiling & Pre-Allocation Safety Tests ===\n");

check("LIMITS.MAX_GRID_CELLS is exactly 50,000,000", () => {
  assert.equal(LIMITS.MAX_GRID_CELLS, 50_000_000);
});

check("waveGridRequirement computes correct elements for standard room", () => {
  const req = waveGridRequirement({ L: 6, W: 4, H: 2.8 }, 200, "balanced");
  assert(req.requiredElements > 0 && req.requiredElements < 50_000_000);
});

check("oversized wave simulation (> 50M cells) requires reduced resolution confirmation", () => {
  // A large hall at high Fmax and fine accuracy requires > 50M elements
  assert.throws(
    () => {
      runWave({
        wallMaterial: 'drywall', floorMaterial: 'wood_floor', ceilMaterial: 'drywall_ceil', L: 50, W: 40, H: 20,
        fmax: 800,
        accuracyMode: "high",
        confirmReducedResolution: false,
        source: { x: 0.5, y: 0.5, z: 1.5 },
        receiver: { x: 0.5, y: 0.5, z: 1.5 },
      });
    },
    (err: any) => {
      const msg = err.message || "";
      return msg.includes("requiresConfirmation") || msg.includes("exceeds the public safe limit");
    },
    "Expected confirmation requirement for grid requiring > 50M cells"
  );
});

check("oversized wave simulation with confirmReducedResolution clamps grid to <= 50,000,000", () => {
  const result = runWave({
    wallMaterial: 'drywall', floorMaterial: 'wood_floor', ceilMaterial: 'drywall_ceil', L: 40, W: 30, H: 10,
    fmax: 600,
    accuracyMode: "high",
    confirmReducedResolution: true,
    steps: 10,
    source: { x: 0.5, y: 0.5, z: 1.5 },
    receiver: { x: 0.5, y: 0.5, z: 1.5 },
  });
  assert(result.meshSize <= 50_000_000, `Grid size ${result.meshSize} exceeded 50,000,000`);
});

check("negative or non-finite dimensions are rejected before allocation", () => {
  assert.throws(() => {
    runWave({ L: -10, W: 4, H: 3, source: { x: 0.5, y: 0.5 }, receiver: { x: 0.5, y: 0.5 } });
  });
  assert.throws(() => {
    runWave({ L: NaN, W: 4, H: 3, source: { x: 0.5, y: 0.5 }, receiver: { x: 0.5, y: 0.5 } });
  });
  assert.throws(() => {
    runWave({ L: Infinity, W: 4, H: 3, source: { x: 0.5, y: 0.5 }, receiver: { x: 0.5, y: 0.5 } });
  });
  assert.throws(() => {
    runIR({ L: -10, W: 4, H: 3, source: { x: 0.5, y: 0.5 }, receiver: { x: 0.5, y: 0.5 } });
  });
  assert.throws(() => {
    runIR({ L: NaN, W: 4, H: 3, source: { x: 0.5, y: 0.5 }, receiver: { x: 0.5, y: 0.5 } });
  });
});

check("memory budget guard rejects excessive memory request before allocating arrays", () => {
  // Mock MAX_SOLVER_MEMORY_BYTES to a small threshold (e.g. 100 KB) and verify rejection
  const origEnv = process.env.MAX_SOLVER_MEMORY_BYTES;
  try {
    process.env.MAX_SOLVER_MEMORY_BYTES = "100000"; // 100 KB
    assert.throws(
      () => {
        runWave({
          wallMaterial: 'drywall', floorMaterial: 'wood_floor', ceilMaterial: 'drywall_ceil', L: 6, W: 4, H: 2.8,
          fmax: 200,
          accuracyMode: "balanced",
          confirmReducedResolution: true,
          source: { x: 0.5, y: 0.5, z: 1.5 },
          receiver: { x: 0.5, y: 0.5, z: 1.5 },
        });
      },
      (err: any) => err.message.includes("exceeds available system memory budget")
    );
  } finally {
    if (origEnv === undefined) delete process.env.MAX_SOLVER_MEMORY_BYTES;
    else process.env.MAX_SOLVER_MEMORY_BYTES = origEnv;
  }
});

console.log(`\n=== ${passed} passed, 0 failed ===\n`);

// ---- Exact boundary behaviour (49,999,999 / 50,000,000 / 50,000,001) ----
import { exceedsGridLimit, preflightSolver, type ValidatedSolverRequest } from "../src/lib/publicLimits.js";

check("exceedsGridLimit: 49,999,999 and 50,000,000 admitted, 50,000,001 refused", () => {
  assert.equal(exceedsGridLimit(49_999_999), false);
  assert.equal(exceedsGridLimit(50_000_000), false);
  assert.equal(exceedsGridLimit(50_000_001), true);
  assert.equal(exceedsGridLimit(NaN), true);
  assert.equal(exceedsGridLimit(Infinity), true);
});

// Real waveGridRequirement at dx = 0.1 m ('fast' = 5 pts/wavelength -> fmax 686 Hz). Dimensions sit just under a
// multiple of dx so ceil() is unambiguous.
const dims = (nx: number, ny: number, nz: number) => ({ L: nx * 0.1 - 0.01, H: ny * 0.1 - 0.01, W: nz * 0.1 - 0.01 });
const mkReq = (d: { L: number; W: number; H: number }, confirm = false) => ({
  ...d, steps: 10, fmax: 686, accuracyMode: "fast", confirmReducedResolution: confirm,
  sources: [{ x: 0.5, y: 0.5, z: 0.5 }], receivers: [{ x: 0.5, y: 0.5, z: 0.5 }],
}) as unknown as ValidatedSolverRequest;

check("preflight: real grid of exactly 50,000,000 cells (500x500x200) is admitted without confirmation", () => {
  // MAX_ROOM dims are 100 x 100 x 30 m; at dx = 0.2 m (fmax 343, fast) 500x500x150 is the same order, so use dx 0.2 for 500x500x200.
  const d = { L: 500 * 0.2 - 0.02, H: 200 * 0.2 - 0.02, W: 500 * 0.2 - 0.02 };
  const req = { ...mkReq(d), fmax: 343.0 } as ValidatedSolverRequest;
  const g = waveGridRequirement(req, req.fmax, "fast");
  assert.equal(g.requiredElements, 50_000_000);
  const r = preflightSolver(req, "wave");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.cells, 50_000_000);
});

check("preflight: real grid of 50,000,001+ cells is refused unless reduced resolution is confirmed, and is then clamped", () => {
  const d = { L: 501 * 0.2 - 0.02, H: 200 * 0.2 - 0.02, W: 500 * 0.2 - 0.02 };
  const req = { ...mkReq(d), fmax: 343.0 } as ValidatedSolverRequest;
  const g = waveGridRequirement(req, req.fmax, "fast");
  assert(g.requiredElements > 50_000_000);
  const refused = preflightSolver(req, "wave");
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.kind, "requires_confirmation");
  const confirmed = preflightSolver({ ...req, confirmReducedResolution: true } as ValidatedSolverRequest, "wave");
  assert.equal(confirmed.ok, true);
  if (confirmed.ok) assert.equal(confirmed.cells, 50_000_000);
});

check("preflight: slightly-under grid (499x500x200 = 49,900,000) is admitted at its true size", () => {
  const d = { L: 499 * 0.2 - 0.02, H: 200 * 0.2 - 0.02, W: 500 * 0.2 - 0.02 };
  const req = { ...mkReq(d), fmax: 343.0 } as ValidatedSolverRequest;
  const r = preflightSolver(req, "wave");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.cells, 49_900_000);
});

check("admission happens before allocation: pre-flight is pure arithmetic (no array allocation for a refused request)", () => {
  const before = process.memoryUsage().arrayBuffers;
  const d = { L: 900 * 0.2, H: 900 * 0.2, W: 900 * 0.2 };
  const r = preflightSolver({ ...mkReq(d), fmax: 343.0 } as ValidatedSolverRequest, "wave");
  assert.equal(r.ok, false);
  assert(process.memoryUsage().arrayBuffers - before < 10_000_000);
});
