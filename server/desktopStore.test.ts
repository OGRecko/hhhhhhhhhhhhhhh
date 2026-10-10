import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ConfigError } from './config';
import { FileArtifactStore, LocalFirestore } from './desktop/localStore';
import { ArtifactNotFoundError, ArtifactTooLargeError, InvalidObjectIdError } from './storage';
import { JobStore } from './jobStore';
import { hashCapabilityToken } from './capabilityToken';

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== Desktop store + config tests ===\n');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cavity-desktop-'));

await check('desktop config does not depend on NODE_ENV and needs no cloud settings', () => {
  const c = loadConfig({ CAVITY_DESKTOP: '1', CAVITY_DATA_DIR: '/x', PORT: '4000' } as any);
  assert.equal(c.desktop, true);
  assert.equal(c.dataDir, '/x');
  assert.equal(c.cloudTasks.enabled, false);
  assert.equal(c.allowedOrigin, 'http://127.0.0.1:4000');
  assert.equal(c.credentials, null);
});
await check('desktop config requires data dir and a valid port', () => {
  assert.throws(() => loadConfig({ CAVITY_DESKTOP: '1', PORT: '4000' } as any), ConfigError);
  assert.throws(() => loadConfig({ CAVITY_DESKTOP: '1', CAVITY_DATA_DIR: '/x' } as any), ConfigError);
});
await check('non-desktop production still fails fast', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' } as any), ConfigError);
});

await check('jobs persist across a restart (LocalFirestore)', async () => {
  const dir = tmp();
  const sim = '12345678-1234-4123-8123-123456789abc';
  const db1 = new LocalFirestore(dir, 10);
  const s1 = new JobStore(db1 as any);
  await s1.createQueued({ simulationId: sim, jobId: '12345678-1234-4123-8123-123456789abd', type: 'impulse-response', capabilityTokenHash: hashCapabilityToken('a'.repeat(64)), createdAt: Date.now(), jobPayload: {}, room: { L: 4, W: 4, H: 3 }, speakers: [], receivers: [] });
  db1.flushSync();
  const db2 = new LocalFirestore(dir, 10);
  const snap = await db2.doc(`simulations/${sim}`).get();
  const found = [...db2._store.keys()].some((k) => k.includes(sim));
  assert.ok(found, 'record should be present after reload');
});

await check('corrupt store file is moved aside and the app starts empty', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'store.bin'), Buffer.from('not a v8 payload'));
  const db = new LocalFirestore(dir, 10);
  assert.equal(db._store.size, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('store.bin.corrupt-')));
});

await check('FileArtifactStore round-trips, sizes, deletes and enforces limits', async () => {
  const st = new FileArtifactStore(tmp());
  const sim = '12345678-1234-4123-8123-123456789abc';
  const id = `${sim}_receiver_0.bin`;
  await st.put(id, Buffer.from([1, 2, 3, 4]));
  assert.deepEqual([...(await st.get(id, 100))], [1, 2, 3, 4]);
  assert.equal(await st.sizeForSimulation(sim), 4);
  await assert.rejects(() => st.get(id, 2), ArtifactTooLargeError);
  assert.equal(await st.deleteAllForSimulation(sim), 1);
  await assert.rejects(() => st.get(id, 100), ArtifactNotFoundError);
});
await check('FileArtifactStore rejects path traversal', async () => {
  const st = new FileArtifactStore(tmp());
  await assert.rejects(() => st.put('../../evil.bin', Buffer.from('x')), InvalidObjectIdError);
  await assert.rejects(() => st.get('..\\..\\evil.bin', 10), InvalidObjectIdError);
});

console.log(`\n=== ${passed} passed ===`);
