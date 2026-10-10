/**
 * The solver's speaker disclosure must describe what the solver actually does.
 * Run with:  npx tsx server/speakerDisclosure.test.ts
 */
import assert from 'node:assert/strict';
import { runIR, runWave } from './solverWorker';

let passed = 0;
let failed = 0;
const quiet = <T,>(fn: () => T): T => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : String(e)}`); }
}
console.log('\n=== Speaker disclosure matches solver behaviour ===\n');

const room = { L: 4, W: 4, H: 3, wallMaterial: 'drywall', floorMaterial: 'wood_floor', ceilMaterial: 'drywall_ceil' };
const run = (sens?: number) => quiet(() => runWave({
  ...room, speakerId: 'any-speaker', steps: 40, fmax: 250, accuracyMode: 'fast',
  source: { id: 's', x: 0.3, y: 0.3, z: 1.5, ...(sens === undefined ? {} : { sensitivityDb: sens }) },
  receivers: [{ id: 'r', x: 0.7, y: 0.7, z: 1.5 }],
})) as unknown as { speaker: { status: string; note: string }; receivers: Array<Record<string, unknown>> };

check('note does not claim the speaker sensitivity is unused', () => {
  const r = run(95);
  assert.ok(!/does not use (this|any) speaker.s sensitivity/i.test(r.speaker.note), r.speaker.note);
  assert.ok(/sensitivity/i.test(r.speaker.note), 'note should explain how sensitivity is used');
});

check('without directivity data the status is NOT_MODELED and the note says omnidirectional', () => {
  const r = run(95);
  assert.equal(r.speaker.status, 'NOT_MODELED');
  assert.ok(/omnidirectional/i.test(r.speaker.note));
});

check('the note says SPL is unavailable when no sensitivity is recorded', () => {
  assert.ok(/unavailable/i.test(run().speaker.note), run().speaker.note);
});

const irMetrics = (sens?: number) => (quiet(() => runIR({
  ...room,
  sources: [{ id: 's', x: 0.2, y: 0.2, z: 1.5, ...(sens === undefined ? {} : { sensitivityDb: sens }) }],
  receivers: [{ id: 'r', x: 0.8, y: 0.8, z: 1.5 }],
})) as unknown as { receivers: Array<{ metrics: { spl: number | null; splBasis: string } }> }).receivers[0].metrics;

check('solver behaviour behind the note: no sensitivity -> SPL null/"unavailable"; with sensitivity -> a finite SPL estimate', () => {
  const none = irMetrics();
  assert.equal(none.spl, null);
  assert.equal(none.splBasis, 'unavailable');
  const withSens = irMetrics(95);
  assert.ok(typeof withSens.spl === 'number' && Number.isFinite(withSens.spl));
  assert.equal(withSens.splBasis, 'sensitivity_1w_1m_estimate');
});

check('a 10 dB higher sensitivity raises the calibrated SPL by 10 dB (sensitivity really is used)', () => {
  const d = (irMetrics(95).spl as number) - (irMetrics(85).spl as number);
  assert.ok(Math.abs(d - 10) < 1e-6, `expected +10 dB, got ${d}`);
});

check('when a sensitivity IS recorded the note says how it is used, matching the solver (relative level + SPL)', () => {
  const hi = run(95);
  assert.ok(/scales the relative source level/i.test(hi.speaker.note), hi.speaker.note);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
