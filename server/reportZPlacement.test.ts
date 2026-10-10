/**
 * Report: Z placement and missing-spec labelling. Companion to solverZPlacement.test.ts.
 * Run with:  npx tsx server/reportZPlacement.test.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFParse } from 'pdf-parse';
import { generateProjectReport, type ReportInput, type ReportPositionAssumption } from './reportGenerator';

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : String(e)}`); }
}
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

console.log('\n=== Report Z placement and missing-spec labelling ===\n');

const ROOM = { L: 10, W: 8, H: 3, poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], wallSegMats: ['drywall', 'drywall', 'drywall', 'drywall'], wallMaterial: 'drywall', floorMaterial: 'carpet_thin', ceilMaterial: 'drywall' } as unknown as ReportInput['room'];
async function reportText(input: ReportInput): Promise<string> {
  const doc = await generateProjectReport(input);
  const f = path.join(os.tmpdir(), `z-report-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  const out = fs.createWriteStream(f);
  doc.pipe(out); doc.end();
  await new Promise<void>((res, rej) => { out.on('finish', () => res()); out.on('error', rej); doc.on('error', rej); });
  const buf = fs.readFileSync(f); fs.unlinkSync(f);
  return (await new PDFParse({ data: buf }).getText()).text;
}
const pa: ReportPositionAssumption[] = [{ kind: 'receiver', id: 'rx', index: 0, axis: 'z', assumedMeters: 1.5, rule: 'x' }];

await check('report: a receiver with no Z is labelled "not set (assumed 1.50 m)" and the assumption note is printed', async () => {
  const text = await reportText({ projectName: 'P', roomName: 'R', room: ROOM, speakers: [], receivers: [{ name: 'Rx', x: 0.5, y: 0.5 }], solverResult: { rt60: 1, positionAssumptions: pa } } as ReportInput);
  assert(/not set \(assumed 1\.50 m\)/.test(text), 'missing "not set (assumed 1.50 m)"');
  assert(/Position assumption/.test(text), 'missing assumption note');
});

await check('report: explicit Z of 0 prints "Z: 0.00 m" and no assumption note', async () => {
  const text = await reportText({ projectName: 'P', roomName: 'R', room: ROOM, speakers: [], receivers: [{ name: 'Rx', x: 0.5, y: 0.5, z: 0 }], solverResult: { rt60: 1, positionAssumptions: [] } } as ReportInput);
  assert(/Z: 0\.00 m/.test(text), 'missing "Z: 0.00 m"');
  assert(!/Position assumption/.test(text), 'assumption note printed for an explicit Z');
});

await check('report: a speaker with no sensitivity prints "Unavailable", not a number', async () => {
  const text = await reportText({ projectName: 'P', roomName: 'R', room: ROOM, speakers: [{ brand: 'B', model: 'M', x: 0.5, y: 0.5, sens: null }], receivers: [] } as ReportInput);
  assert(/Unavailable/.test(text), 'missing "Unavailable" for a speaker with no sensitivity');
  assert(!/\b8[0-9](\.\d)? dB\b/.test(text), 'a plausible sensitivity number appeared');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
