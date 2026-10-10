import assert from 'node:assert/strict';
import { hashCapabilityToken } from './capabilityToken';
import { authorizeReport } from './artifactAccess';
import { JobStore } from './jobStore';
import { FakeFirestore } from './testing/memoryFirestore';

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== Report Authorization Security Tests ===\n');

// Capability tokens have one accepted shape - 64 lowercase hex chars
// (see TOKEN_RE in capabilityToken.ts) - and anything else is rejected as
// malformed before it is even compared to a stored hash. The placeholder
// strings this file used to use ('token-valid', 'token-bad', 'token-other')
// do not match that shape, so every check here was actually exercising the
// "malformed input" path rather than real token comparison: the
// missing/wrong/cross-sim checks happened to still pass (a malformed token
// is correctly denied either way), but the "valid token" checks could never
// pass, because 'token-valid' itself was never a well-formed token -
// independent of whatever it hashed to. Using real 64-hex-char tokens below
// tests what this file has always claimed to test.
const VALID_TOKEN = 'a'.repeat(64);
const BAD_TOKEN = 'b'.repeat(64);
const OTHER_TOKEN = 'c'.repeat(64);

const db = new FakeFirestore();
const store = new JobStore(db);
const sim = '11111111-1111-4111-8111-111111111111';
const job = '11111111-1111-4111-8111-111111111112';
await store.createQueued({ simulationId: sim, jobId: job, type: 'impulse-response', capabilityTokenHash: hashCapabilityToken(VALID_TOKEN), createdAt: Date.now(), jobPayload: {}, room: {L:10,W:10,H:10}, speakers: [], receivers: [] });

await check('missing token is denied', async () => {
  const a = await authorizeReport(store, sim, undefined);
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.reason, 'denied');
});
await check('wrong token is denied', async () => {
  const a = await authorizeReport(store, sim, BAD_TOKEN);
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.reason, 'denied');
});
await check('token from another simulation is denied', async () => {
  const other = '22222222-2222-4222-8222-222222222222';
  await store.createQueued({ simulationId: other, jobId: '22222222-2222-4222-8222-222222222223', type: 'impulse-response', capabilityTokenHash: hashCapabilityToken(OTHER_TOKEN), createdAt: Date.now(), jobPayload: {}, room: {L:10,W:10,H:10}, speakers: [], receivers: [] });
  const a = await authorizeReport(store, sim, OTHER_TOKEN);
  assert.equal(a.ok, false);
});
await check('unfinished simulation is not reportable', async () => {
  const a = await authorizeReport(store, sim, VALID_TOKEN);
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.reason, 'not_ready');
});
await check('completed simulation with valid token is reportable', async () => {
  const c = await store.claim(sim, 'worker-a');
  assert.equal(c.claimed, true);
  if (!c.claimed) throw new Error('claim failed');
  await store.complete(sim, c.lease, { result: { receivers: [] }, artifacts: [], room: {L:10,W:10,H:10}, speakers: [], receivers: [] });
  const a = await authorizeReport(store, sim, VALID_TOKEN);
  assert.equal(a.ok, true);
});
await check('unknown simulation is indistinguishable from bad credentials', async () => {
  const a = await authorizeReport(store, '33333333-3333-4333-8333-333333333333', VALID_TOKEN);
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.reason, 'denied');
});

console.log(`\n=== ${passed} passed ===`);
