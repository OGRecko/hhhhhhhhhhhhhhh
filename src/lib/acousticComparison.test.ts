import { compareImpulseResponses } from './acousticComparison';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const same = compareImpulseResponses([0, 1, 0, 0], [0, 1, 0, 0]);
assert(same.mae === 0 && same.rmse === 0, 'identical traces should have zero error');
assert(same.correlation === 1, 'identical non-constant traces should correlate at 1');
assert(same.peakDelaySamples === 0, 'identical traces should have zero peak delay');

const shifted = compareImpulseResponses([0, 1, 0, 0], [0, 0, 1, 0]);
assert(shifted.peakDelaySamples === 1, 'shifted impulse should report the correct peak delay');

const differentLengths = compareImpulseResponses([0, 1, 0], [0, 1, 0, 0, 0]);
assert(differentLengths.sampleCount === 3, 'comparison should use the common prefix');

const silence = compareImpulseResponses([0, 0, 0], [0, 0, 0]);
assert(silence.mae === 0 && silence.rmse === 0, 'silence should have finite zero error');
assert(silence.correlation === null && silence.peakDelaySamples === null, 'silence should not invent correlation or timing');

const invalid = compareImpulseResponses([0, Number.NaN, 1], [0, 1, 0]);
assert(invalid.mae === null && invalid.rmse === null, 'non-finite input must not produce metrics');

const noisy = compareImpulseResponses([0, 1, 0.1, 0], [0, 0.9, 0.08, 0.01]);
for (const key of ['mae', 'rmse', 'correlation'] as const) {
  const value = noisy[key];
  assert(value === null || Number.isFinite(value), `${key} must never be NaN/Infinity`);
}

console.log('acousticComparison tests passed');
