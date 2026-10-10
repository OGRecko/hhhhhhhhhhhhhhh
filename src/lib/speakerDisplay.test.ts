import assert from 'node:assert/strict';
import { formatWooferSize } from './speakerDisplay';

assert.equal(formatWooferSize(5.25, 'in'), '5.25"', 'inch notation remains compact');
assert.equal(formatWooferSize(20, 'cm'), '20 cm', 'non-inch source units are displayed without conversion');
assert.equal(formatWooferSize(null, 'cm'), 'N/A', 'missing values remain unavailable');
assert.equal(formatWooferSize(Infinity, 'in'), 'N/A', 'invalid values are not displayed as a plausible driver size');

console.log('speaker display unit tests passed');
