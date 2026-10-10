import assert from 'node:assert/strict';
import {
  JOB_STATES, allLegalTransitions, assertTransition, canTransition, isTerminal,
  InvalidTransitionError, type JobState, type TransitionReason,
} from './jobStateMachine';

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e: any) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

const REASONS: TransitionReason[] = ['claim', 'complete', 'fail', 'cancel', 'recover', 'expire'];
console.log('\n=== Job state machine ===\n');

// The complete, explicit set of legal edges. Anything else MUST be rejected.
const LEGAL = new Set([
  'queued>running:claim',
  'queued>cancelled:cancel',
  'queued>failed:fail',
  'queued>failed:expire',
  'running>completed:complete',
  'running>failed:fail',
  'running>failed:expire',
  'running>cancelled:cancel',
  'running>queued:recover',
]);

check('the legal transition table is exactly the specified set', () => {
  const actual = new Set(allLegalTransitions().map(([f, t, r]) => `${f}>${t}:${r}`));
  assert.deepEqual([...actual].sort(), [...LEGAL].sort());
});

// Enumerate the ENTIRE cross product so every invalid transition is tested.
let illegalChecked = 0;
for (const from of JOB_STATES) for (const to of JOB_STATES) for (const reason of REASONS) {
  const key = `${from}>${to}:${reason}`;
  if (LEGAL.has(key)) {
    check(`legal: ${key} is allowed`, () => {
      assert.equal(canTransition(from, to, reason), true);
      assert.doesNotThrow(() => assertTransition(from, to, reason));
    });
  } else {
    illegalChecked++;
    check(`illegal: ${key} is rejected`, () => {
      assert.equal(canTransition(from, to, reason), false);
      assert.throws(() => assertTransition(from, to, reason), InvalidTransitionError);
    });
  }
}

// The specific transitions the requirements call out by name.
const mustReject: Array<[JobState, JobState, TransitionReason]> = [
  ['completed', 'running', 'claim'],
  ['completed', 'queued', 'recover'],
  ['failed', 'running', 'claim'],
  ['failed', 'queued', 'recover'],
  ['cancelled', 'running', 'claim'],
  ['cancelled', 'queued', 'recover'],
  ['completed', 'cancelled', 'cancel'],
  ['completed', 'failed', 'fail'],
  ['queued', 'completed', 'complete'],
  ['queued', 'queued', 'recover'],
  // running -> queued is ONLY legal as a recovery, never for any other reason.
  ['running', 'queued', 'claim'],
  ['running', 'queued', 'cancel'],
  ['running', 'queued', 'fail'],
];
for (const [f, t, r] of mustReject) {
  check(`named illegal transition ${f} -> ${t} (${r}) is rejected`, () => {
    assert.throws(() => assertTransition(f, t, r), InvalidTransitionError);
  });
}

check('terminal states have no outgoing transitions at all', () => {
  for (const s of JOB_STATES.filter(isTerminal)) {
    for (const t of JOB_STATES) for (const r of REASONS) assert.equal(canTransition(s, t, r), false, `${s}->${t}:${r}`);
  }
});

check('unknown / garbage states are rejected, not treated as valid', () => {
  for (const bad of [undefined, null, 'RUNNING', 'done', '', 42, {}]) {
    assert.throws(() => assertTransition(bad as any, 'running', 'claim'), InvalidTransitionError);
  }
});

console.log(`\n=== ${passed} passed (${illegalChecked} illegal transitions enumerated) ===`);
if (process.exitCode) process.exit(process.exitCode);
