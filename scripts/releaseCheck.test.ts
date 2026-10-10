import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkRelease } from './lib/releaseCheck.mjs';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== Release gate (scripts/lib/releaseCheck.mjs + verify-release.mjs) ===\n');

const PACKAGE = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version as string;
const EXE = `Cavity-Audio-Setup-v${PACKAGE}.exe`;
const body = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200_000).map((_, i) => (i * 13 + 5) & 0xff)]);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Builds a releases folder; every field can be overridden to create a specific defect. */
function fixture(o: { exe?: Buffer | null; manifest?: Record<string, unknown> | string | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cavity-rel-'));
  const exe = o.exe === undefined ? body : o.exe;
  if (exe) fs.writeFileSync(path.join(dir, EXE), exe);
  if (o.manifest !== null) {
    const m = o.manifest === undefined ? { version: PACKAGE, file: EXE, size: body.length, sha256: sha(body) } : o.manifest;
    fs.writeFileSync(path.join(dir, 'manifest.json'), typeof m === 'string' ? m : JSON.stringify(m));
  }
  return dir;
}
const good = { version: PACKAGE, file: EXE, size: body.length, sha256: sha(body) };
const problemsOf = (dir: string) => checkRelease(dir).problems.join(' | ');

check('a valid release passes', () => { const r = checkRelease(fixture()); assert.equal(r.ok, true, problemsOf(fixture())); });
check('missing manifest.json fails', () => { const r = checkRelease(fixture({ manifest: null })); assert.equal(r.ok, false); assert.match(r.problems[0], /manifest\.json is missing/); });
check('unparseable manifest fails', () => { assert.equal(checkRelease(fixture({ manifest: '{not json' })).ok, false); });
check('manifest missing a required field fails', () => { const { sha256, ...rest } = good; const r = checkRelease(fixture({ manifest: rest })); assert.equal(r.ok, false); assert.match(r.problems.join(), /sha256/); });
check('manifest naming an EXE that is not there fails', () => { const r = checkRelease(fixture({ exe: null })); assert.equal(r.ok, false); assert.match(r.problems[0], /not found/); });
check('file without an MZ header fails', () => {
  const bad = Buffer.from(body); bad[0] = 0x58; bad[1] = 0x58;
  const r = checkRelease(fixture({ exe: bad, manifest: { ...good, sha256: sha(bad) } }));
  assert.equal(r.ok, false); assert.match(r.problems.join(), /MZ/);
});
check('size that differs from the manifest fails', () => { const r = checkRelease(fixture({ manifest: { ...good, size: body.length + 1 } })); assert.equal(r.ok, false); assert.match(r.problems.join(), /size mismatch/); });
check('same size + MZ but different bytes fails on SHA-256', () => {
  const tampered = Buffer.from(body); tampered[5000] ^= 0xff;
  const r = checkRelease(fixture({ exe: tampered })); assert.equal(r.ok, false); assert.match(r.problems.join(), /sha256 mismatch/);
});
check('malformed sha256 in the manifest fails', () => { const r = checkRelease(fixture({ manifest: { ...good, sha256: 'ABC' } })); assert.equal(r.ok, false); assert.match(r.problems.join(), /64 lowercase hex/); });
check('manifest.file with a path or a non-.exe name is rejected', () => {
  for (const file of ['../evil.exe', 'sub/dir.exe', 'C:\\x.exe', 'release.zip']) {
    const r = checkRelease(fixture({ manifest: { ...good, file } })); assert.equal(r.ok, false, `accepted ${file}`);
  }
});
check('verify-release.mjs exits 0 for a good release and 1 for a bad one', () => {
  const run = (dir: string) => spawnSync(process.execPath, [path.resolve('scripts/verify-release.mjs'), dir], { encoding: 'utf8' });
  assert.equal(run(fixture()).status, 0);
  const bad = run(fixture({ manifest: null }));
  assert.equal(bad.status, 1); assert.match(bad.stderr, /RELEASE INVALID/);
});

console.log(`\n=== ${passed} passed ===`);
