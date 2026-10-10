import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { PersistingMap } from './desktop/localStore';
import { setLogSinks, resetLogSinks } from './observability';

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e: any) { console.error(`  FAIL  ${name}\n        ${e?.message}`); process.exitCode = 1; }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cavity-store-'));
const blob = (k: string) => v8.serialize({ v: 1, entries: [[k, { data: { ok: true } }]] });

check('crash between move-aside and rename: newest data recovered from .bak', () => {
  const d = tmp(); const f = path.join(d, 'store.bin');
  fs.writeFileSync(`${f}.bak`, blob('job1'));            // primary missing, previous good copy present
  const m = new PersistingMap(f, 5);
  assert.ok(m.has('job1'));
});
check('corrupt primary is moved aside (not deleted) and .bak is used', () => {
  const d = tmp(); const f = path.join(d, 'store.bin');
  fs.writeFileSync(f, Buffer.from('garbage')); fs.writeFileSync(`${f}.bak`, blob('job2'));
  const m = new PersistingMap(f, 5);
  assert.ok(m.has('job2'));
  assert.ok(fs.readdirSync(d).some((n) => n.startsWith('store.bin.corrupt-')));
});
check('corrupt primary with no backup starts empty, keeps the corrupt file', () => {
  const d = tmp(); const f = path.join(d, 'store.bin');
  fs.writeFileSync(f, Buffer.from('garbage'));
  const m = new PersistingMap(f, 5);
  assert.equal(m.size, 0);
  assert.ok(fs.readdirSync(d).some((n) => n.startsWith('store.bin.corrupt-')));
});
check('an unreadable (non-ENOENT) store is NOT treated as empty / overwritten', () => {
  const d = tmp(); const f = path.join(d, 'store.bin');
  fs.mkdirSync(f); // reading a directory => EISDIR
  assert.throws(() => new PersistingMap(f, 5), /Cannot read the job store/);
});
check('flush round-trips and leaves no tmp files', () => {
  const d = tmp(); const f = path.join(d, 'store.bin');
  const m = new PersistingMap(f, 5); m.set('a', { data: { n: 1 } } as any); m.flushSync();
  assert.ok(new PersistingMap(f, 5).has('a'));
  assert.ok(!fs.readdirSync(d).some((n) => n.endsWith('.tmp')));
});
function captured<T>(fn: () => T): { out: T; lines: any[] } {
  const lines: any[] = [];
  setLogSinks((l) => lines.push(JSON.parse(l)), (l) => lines.push(JSON.parse(l)));
  try { return { out: fn(), lines }; } finally { resetLogSinks(); }
}
check('corrupt primary + good .bak is REPORTED (log + recoveryNotes), not silent', () => {
  const d = tmp(); const f = path.join(d, 'store.bin');
  fs.writeFileSync(f, Buffer.from('garbage')); fs.writeFileSync(`${f}.bak`, blob('job3'));
  const { out: m, lines } = captured(() => new PersistingMap(f, 5));
  assert.ok(m.has('job3'));
  assert.ok(lines.some((l) => l.event === 'local_store_recovery' && l.severity === 'ERROR'), 'corruption must be logged at ERROR');
  assert.ok(m.recoveryNotes.some((n) => /corrupt/i.test(n)) && m.recoveryNotes.some((n) => /Recovered 1 job record/.test(n)), JSON.stringify(m.recoveryNotes));
});
check('corrupt primary with NO backup reports that data was lost and the store started empty', () => {
  const d = tmp(); const f = path.join(d, 'store.bin');
  fs.writeFileSync(f, Buffer.from('garbage'));
  const { out: m, lines } = captured(() => new PersistingMap(f, 5));
  assert.equal(m.size, 0);
  assert.ok(m.recoveryNotes.some((n) => /no backup exists; starting with an empty store/.test(n)), JSON.stringify(m.recoveryNotes));
  assert.ok(lines.length >= 1);
});
check('corrupt primary AND corrupt backup is reported', () => {
  const d = tmp(); const f = path.join(d, 'store.bin');
  fs.writeFileSync(f, Buffer.from('garbage')); fs.writeFileSync(`${f}.bak`, Buffer.from('also garbage'));
  const { out: m } = captured(() => new PersistingMap(f, 5));
  assert.equal(m.size, 0);
  assert.ok(m.recoveryNotes.some((n) => /Backup job store is also corrupt/.test(n)), JSON.stringify(m.recoveryNotes));
});
check('a clean first start and a clean reload report nothing', () => {
  const d = tmp(); const f = path.join(d, 'store.bin');
  const first = captured(() => new PersistingMap(f, 5));
  assert.deepEqual(first.out.recoveryNotes, []); assert.equal(first.lines.length, 0);
  first.out.set('a', { data: { n: 1 } } as any); first.out.flushSync();
  const second = captured(() => new PersistingMap(f, 5));
  assert.deepEqual(second.out.recoveryNotes, []); assert.equal(second.lines.length, 0);
});
try {
  const d = tmp(); const f = path.join(d, 'store.bin');
  const m = new PersistingMap(f, 5);
  fs.rmSync(d, { recursive: true, force: true }); // the directory vanishes, so the write must fail
  const lines: any[] = []; setLogSinks(() => {}, (l) => lines.push(JSON.parse(l)));
  try { m.set('a', { data: { n: 1 } } as any); await new Promise((r) => setTimeout(r, 80)); } finally { resetLogSinks(); }
  assert.ok(lines.some((l) => l.event === 'local_store_flush_failed'), 'flush failure must be logged: ' + JSON.stringify(lines));
  fs.mkdirSync(d, { recursive: true }); // let the exit-time retry succeed so this test leaves no noise
  m.flushSync();
  assert.ok(new PersistingMap(f, 5).has('a'), 'data stayed dirty and was persisted by the retry');
  passed++; console.log('  PASS  a failing background flush is logged, not swallowed');
} catch (e: any) { console.error(`  FAIL  a failing background flush is logged, not swallowed\n        ${e?.message}`); process.exitCode = 1; }
console.log(`\n=== ${passed} passed ===`);
