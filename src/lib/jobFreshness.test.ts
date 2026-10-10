import assert from 'node:assert/strict';
import { shouldApplyJobResult } from './jobFreshness';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== Job result freshness ===\n');

check('applies a result only for the job the editor is still waiting for', () => {
  assert.equal(shouldApplyJobResult({ effectActive: true, currentJobId: 'job-1', resultJobId: 'job-1' }), true);
});
check('refuses a result after the editor cleared its job (edit, undo/redo, cancel)', () => {
  assert.equal(shouldApplyJobResult({ effectActive: true, currentJobId: null, resultJobId: 'job-1' }), false);
  assert.equal(shouldApplyJobResult({ effectActive: true, currentJobId: undefined, resultJobId: 'job-1' }), false);
});
check('refuses a result for a different (older) job', () => {
  assert.equal(shouldApplyJobResult({ effectActive: true, currentJobId: 'job-2', resultJobId: 'job-1' }), false);
});
check('refuses a result once the polling effect has been torn down', () => {
  assert.equal(shouldApplyJobResult({ effectActive: false, currentJobId: 'job-1', resultJobId: 'job-1' }), false);
});
check('refuses a response with a missing or non-string job id, even if the store has none either', () => {
  for (const bad of [undefined, null, '', 0, {}, []]) {
    assert.equal(shouldApplyJobResult({ effectActive: true, currentJobId: null, resultJobId: bad }), false, `accepted ${JSON.stringify(bad)}`);
    assert.equal(shouldApplyJobResult({ effectActive: true, currentJobId: 'job-1', resultJobId: bad }), false);
  }
});
console.log(`\n=== ${passed} passed ===`);
