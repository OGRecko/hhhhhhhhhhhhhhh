/**
 * Report generation tests — exercises the ACTUAL PDFKit stream lifecycle
 * server.ts drives, not just that generateProjectReport() resolves.
 *
 * The regression this guards against: generateProjectReport() used to call
 * doc.end() internally and then return the already-ended document.
 * server.ts's /api/report/export calls `doc.pipe(res); doc.end();` on
 * whatever this function returns — a second .end() on an already-finalized
 * PDFKit stream throws ERR_STREAM_PUSH_AFTER_EOF synchronously, which the
 * route's catch turned into a silent 500 on every single call. There was no
 * test exercising the full pipe+end lifecycle, so this went unnoticed
 * through multiple audit passes.
 *
 * Run with:  npx tsx server/reportGenerator.test.ts
 */

import fs from "fs";
import os from "os";
import path from "path";
import { PDFParse } from "pdf-parse";
import { generateProjectReport, type ReportInput } from "./reportGenerator";

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
function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

const ROOM = {
  L: 10, W: 8, H: 3,
  poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  wallSegMats: ["drywall", "drywall", "drywall", "drywall"],
  wallMaterial: "drywall",
  floorMaterial: "carpet_thin",
  ceilMaterial: "drywall",
} as any;

/**
 * Reproduces EXACTLY what server.ts's /api/report/export handler does with
 * the returned document: pipe to a writable stream, then call end(). If
 * generateProjectReport ever double-ends again, this throws synchronously,
 * the same way it did in production.
 */
async function renderLikeTheRealRoute(input: ReportInput): Promise<Buffer> {
  const doc = await generateProjectReport(input);
  const tmpFile = path.join(os.tmpdir(), `cavity-report-test-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  const out = fs.createWriteStream(tmpFile);
  doc.pipe(out);
  doc.end(); // <-- exactly what server.ts does; this is the line that used to throw
  await new Promise<void>((resolve, reject) => {
    out.on("finish", () => resolve());
    out.on("error", reject);
    doc.on("error", reject);
  });
  const buf = fs.readFileSync(tmpFile);
  fs.unlinkSync(tmpFile);
  return buf;
}

async function pdfText(buf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buf });
  const result = await parser.getText();
  return result.text;
}

console.log("\n=== Report generation (end-to-end stream lifecycle) ===\n");

await checkAsync("minimal report (no solverResult) renders without throwing", async () => {
  const buf = await renderLikeTheRealRoute({
    projectName: "P", roomName: "R", room: ROOM, speakers: [], receivers: [],
  } as any);
  assert(buf.length > 1000, `suspiciously small PDF: ${buf.length} bytes`);
  assert(buf.subarray(0, 4).toString("ascii") === "%PDF", "output is not a PDF");
});

await checkAsync("VALIDATED decay fit renders method, metric, R^2 and value", async () => {
  const buf = await renderLikeTheRealRoute({
    projectName: "P", roomName: "R", room: ROOM, speakers: [], receivers: [],
    solverResult: {
      rt60: 2.72,
      simulatedRt60: 0.856,
      decay: {
        method: "Schroeder backward integration (Schroeder 1965)",
        dynamicRangeDb: 42.3,
        preferred: { metric: "T30", rt60Sec: 0.856, r2: 0.994, status: "VALIDATED", reason: null, fitRangeDb: [-5, -35] },
      },
      gridDims: [12, 6, 10], steps: 5995,
      actualDurationSec: 2.722, targetDurationSec: 2.722,
      reachedTarget: true, warning: null,
    },
  } as any);
  const text = await pdfText(buf);
  for (const expect of ["T30", "Schroeder", "0.994"]) {
    assert(text.includes(expect), `expected "${expect}" in rendered PDF text`);
  }
});

await checkAsync("UNAVAILABLE decay fit renders the reason, not a fabricated number", async () => {
  const buf = await renderLikeTheRealRoute({
    projectName: "P", roomName: "R", room: ROOM, speakers: [], receivers: [],
    solverResult: {
      rt60: 0.4,
      simulatedRt60: null,
      decay: {
        method: "Schroeder backward integration (Schroeder 1965)",
        dynamicRangeDb: 4.2,
        preferred: {
          metric: "T30", rt60Sec: null, status: "UNAVAILABLE", r2: null,
          reason: "Trace shows only 4.2 dB of real energy decay (15 dB required).",
          fitRangeDb: [-5, -35],
        },
      },
      gridDims: [8, 6, 7], steps: 1200,
      actualDurationSec: 0.2, targetDurationSec: 0.2,
      reachedTarget: true, warning: null,
    },
  } as any);
  const text = await pdfText(buf);
  assert(text.includes("UNAVAILABLE"), "expected UNAVAILABLE status in rendered PDF");
  assert(text.includes("required"), "expected the refusal reason in rendered PDF");
  // The Sabine figure ("Sabine RT60 (Calculated): 0.40 s") is a legitimate,
  // separately-labeled analytical estimate and is SUPPOSED to render even
  // when the simulated-IR figure is UNAVAILABLE — §44 wants disagreement
  // surfaced, not hidden. What must NOT appear is a numeric value bolted
  // onto the simulated-IR line itself, i.e. immediately after its own
  // "UNAVAILABLE" label.
  assert(
    !/UNAVAILABLE\s*[\d.]+\s*s\b/.test(text),
    "the simulated-IR RT60 line shows a number immediately after UNAVAILABLE",
  );
});

await checkAsync("legacy records (no decay object) still render", async () => {
  const buf = await renderLikeTheRealRoute({
    projectName: "P", roomName: "R", room: ROOM, speakers: [], receivers: [],
    solverResult: {
      rt60: 0.9, simulatedRt60: 0.75, gridDims: [9, 7, 8], steps: 3000,
      actualDurationSec: 1.0, targetDurationSec: 1.0, reachedTarget: true, warning: null,
    },
  } as any);
  const text = await pdfText(buf);
  assert(text.includes("legacy"), "expected the legacy-path label distinguishing it from a fit-backed figure");
});

await checkAsync("truncated IR (reachedTarget: false) renders the warning banner", async () => {
  const buf = await renderLikeTheRealRoute({
    projectName: "P", roomName: "R", room: ROOM, speakers: [], receivers: [],
    solverResult: {
      rt60: 2.0, simulatedRt60: 0.3, gridDims: [10, 8, 9], steps: 6000,
      actualDurationSec: 0.5, targetDurationSec: 2.0, reachedTarget: false,
      warning: "Simulation executed 6000 of 24000 steps required.",
    },
  } as any);
  const text = await pdfText(buf);
  assert(text.includes("TRUNCATED"), "expected the truncation warning banner");
});

await checkAsync("report generation is repeatable (no shared mutable state between calls)", async () => {
  const input: any = { projectName: "P", roomName: "R", room: ROOM, speakers: [], receivers: [] };
  const b1 = await renderLikeTheRealRoute(input);
  const b2 = await renderLikeTheRealRoute(input);
  assert(b1.length > 0 && b2.length > 0, "one of two identical calls produced an empty document");
});

// ---------------------------------------------------------------------------
// Regression: reports generated from a REAL persisted simulation record.
//
// server.ts persists `sim.room` as literally `req.body` of the solver call
// (L/W/H/source/receiver -- no `poly`, no `wallSegMats`), and
// `sim.speakers`/`sim.receivers` as `[req.body.source]`/`[req.body.receiver]`
// -- plain {x,y,z} points, not ReportSpeaker/ReportReceiver shapes. Every
// fixture above hand-builds a report-shaped room/speaker/receiver, which
// masked two real bugs that only show up against the shape actually stored
// in Firestore:
//   1. `room.poly` undefined -> computeRoomSurfaces did `poly.map(...)` on
//      undefined -> unhandled crash -> every export of a real simulation
//      500'd.
//   2. speakers/receivers missing brand/model/name -> rendered as the
//      literal string "undefined undefined" in the PDF, silently.
// ---------------------------------------------------------------------------

const SOLVER_SHAPED_ROOM = {
  L: 10, W: 8, H: 3,
  wallMaterial: "drywall",
  wallSegMats: undefined,
  floorMaterial: "carpet_thin",
  ceilMaterial: "drywall",
} as any;

await checkAsync("a room with no poly/wallSegMats (the real persisted shape) does not crash", async () => {
  const buf = await renderLikeTheRealRoute({
    projectName: "Export", roomName: "Export",
    room: SOLVER_SHAPED_ROOM, speakers: [], receivers: [],
  } as any);
  assert(buf.subarray(0, 4).toString("ascii") === "%PDF", "output is not a PDF");
});

await checkAsync("speakers/receivers normalized from solver shape render real labels, not 'undefined undefined'", async () => {
  // Mirrors server.ts's normalization of `[req.body.source]` /
  // `[req.body.receiver]` before they reach the report.
  const buf = await renderLikeTheRealRoute({
    projectName: "Export", roomName: "Export",
    room: SOLVER_SHAPED_ROOM,
    speakers: [{ brand: "Unknown", model: "Speaker", x: 0.5, y: 0.5 }],
    receivers: [{ name: "Receiver 1", x: 0.25, y: 0.5 }],
  } as any);
  const text = await pdfText(buf);
  assert(!text.includes("undefined"), `report text contains the literal word "undefined": ${text.slice(0, 2000)}`);
  assert(text.includes("Receiver 1"), "expected the normalized receiver name to render");
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
