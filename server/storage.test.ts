import assert from 'node:assert/strict';
import { hashCapabilityToken } from './capabilityToken';
import { parseObjectId, InvalidObjectIdError, type ArtifactStore } from './storage';
import { authorizeArtifact } from './artifactAccess';
import { FakeFirestore } from './testing/memoryFirestore';
import { JobStore } from './jobStore';

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== Storage Security Tests ===\n');

await check('invalid object IDs are rejected', () => {
  assert.throws(() => parseObjectId('../../package.json'), InvalidObjectIdError);
  assert.throws(() => parseObjectId('not-a-uuid_receiver_0.bin'), InvalidObjectIdError);
});
await check('valid receiver and wave object IDs parse correctly', () => {
  const sim = '12345678-1234-4123-8123-123456789abc';
  // parseObjectId returns a numeric `index` (Number(m[3])), not a string
  // `suffix` - this test's expectation was stale relative to the real
  // ParsedObjectId shape; no production caller reads `.suffix` at all
  // (they only use `.simulationId`), confirming `index` is correct.
  assert.deepEqual(parseObjectId(`${sim}_receiver_0.bin`), { simulationId: sim, kind: 'receiver', index: 0 });
  assert.deepEqual(parseObjectId(`${sim}_wave_12.bin`), { simulationId: sim, kind: 'wave', index: 12 });
});

// Same shape requirement as reportAuthorization.test.ts: capability tokens
// must be 64 lowercase hex chars (TOKEN_RE in capabilityToken.ts) or they
// are rejected as malformed before ever being compared to a stored hash.
const VALID_TOKEN = 'a'.repeat(64);
const WRONG_TOKEN = 'b'.repeat(64);

const db = new FakeFirestore();
const store = new JobStore(db);
const sim = '12345678-1234-4123-8123-123456789abc';
const job = '12345678-1234-4123-8123-123456789abd';
const objectId = `${sim}_receiver_0.bin`;
await store.createQueued({ simulationId: sim, jobId: job, type: 'impulse-response', capabilityTokenHash: hashCapabilityToken(VALID_TOKEN), createdAt: Date.now(), jobPayload: {}, room: {L:4,W:4,H:3}, speakers: [], receivers: [] });
const claim = await store.claim(sim, 'test-worker');
assert.equal(claim.claimed, true);
if (!claim.claimed) throw new Error('claim failed');
await store.complete(sim, claim.lease, { result: { traceObjectIds: [objectId] }, artifacts: [objectId], room: {L:4,W:4,H:3}, speakers: [], receivers: [] });

await check('anonymous artifact access without token is denied', async () => {
  const a = await authorizeArtifact(store, objectId, undefined);
  assert.equal(a.ok, false);
});
await check('correct capability token authorizes owned completed artifact', async () => {
  const a = await authorizeArtifact(store, objectId, VALID_TOKEN);
  assert.equal(a.ok, true);
});
await check('wrong capability token is denied', async () => {
  const a = await authorizeArtifact(store, objectId, WRONG_TOKEN);
  assert.equal(a.ok, false);
});
await check('foreign artifact is denied even with a valid token', async () => {
  const foreign = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa_receiver_0.bin';
  const a = await authorizeArtifact(store, foreign, VALID_TOKEN);
  assert.equal(a.ok, false);
});

console.log(`\n=== ${passed} passed ===`);
