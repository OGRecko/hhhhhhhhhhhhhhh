import assert from 'node:assert/strict';
import { CloudTaskDispatcher } from './cloudTaskDispatcher';

const secret = 'CloudTask-Secret-9x8y7z6w5v4u3t2s1';
const dispatcher = new CloudTaskDispatcher({
  enabled: false,
  projectId: 'demo-cavity', location: 'us-central1', queue: 'cavity-solver',
  targetUrl: 'https://cavity.example/api/internal/job-run', dispatchSecret: secret,
});
assert.equal(dispatcher.enabled, false);
assert.equal(dispatcher.authorize(secret), true);
assert.equal(dispatcher.authorize('wrong'), false);
assert.equal(await dispatcher.enqueue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), true);
console.log('PASS Cloud Tasks dispatcher: disabled-mode idempotence and constant-time secret gate');
