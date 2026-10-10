/**
 * Tests for scripts/lib/speakerAuditCore.mjs: the audit must FAIL when it should, not only pass on today's data.
 * Run with:  npx tsx scripts/speakerAuditCore.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { auditNullableFlags, auditResponsePoints, checkResponseModelSource, countGenericReference, isPublishedHz, isValidResponsePointTable } from './lib/speakerAuditCore.mjs';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== speaker audit core ===\n');

const real = fs.readFileSync('src/lib/speakerResponse.ts', 'utf8');

check('isPublishedHz matches the app rule (finite number > 0)', () => {
  for (const v of [0, -1, NaN, Infinity, null, undefined, '40']) assert.equal(isPublishedHz(v), false);
  assert.equal(isPublishedHz(40), true);
});

check('generic reference: counts missing-both / low-only / high-only; explicit curves and fully published rows are not generic', () => {
  const row = (id: string, low: unknown, high: unknown) => ({ id, frequencyResponse: { low_hz: low, high_hz: high } });
  const r = countGenericReference([row('a', null, null), row('b', 50, null), row('c', null, 20000), row('d', 50, 20000), row('e', null, null)], ['e']);
  assert.deepEqual(r, { total: 3, missingBothLimits: 1, missingLowOnly: 1, missingHighOnly: 1, modeledFromPublishedLimits: 1, explicitCurves: 1, speakers: 5 });
});

check('explicit response points require their own HTTPS source, verified status, context, and ordered finite data', () => {
  const valid = {
    id: 'measured',
    frequencyResponse: {
      low_hz: 32,
      high_hz: 20000,
      points: [{ hz: 20, db: -14 }, { hz: 1000, db: -1.5 }, { hz: 20000, db: -3.5 }],
      pointsStatus: 'MEASUREMENT_VERIFIED',
      pointsSource: 'https://example.org/exact-model.pdf',
      pointsSourceType: 'MEASUREMENT',
      pointsContext: 'On-axis response measured at 1 m; source dB table has a stated 100 dB reference.'
    }
  };
  assert.equal(isValidResponsePointTable(valid.frequencyResponse), true);
  assert.deepEqual(auditResponsePoints([valid]), {
    counts: { total: 1, manufacturer: 0, measurement: 1, reputable_database: 0 },
    problems: []
  });
  assert.equal(countGenericReference([valid], []).explicitCurves, 1, 'source-backed response points are not generic-reference curves');
  const missingSource = structuredClone(valid) as any;
  missingSource.frequencyResponse.pointsSource = null;
  assert.ok(auditResponsePoints([missingSource]).problems.length > 0, 'missing curve source must fail');
  const fakeType = structuredClone(valid) as any;
  fakeType.frequencyResponse.pointsSourceType = 'ESTIMATED';
  assert.ok(auditResponsePoints([fakeType]).problems.length > 0, 'estimated points must fail the verified-data audit');
  const repeatedFrequency = structuredClone(valid);
  repeatedFrequency.frequencyResponse.points[1].hz = 20;
  assert.ok(auditResponsePoints([repeatedFrequency]).problems.length > 0, 'duplicate/non-increasing frequencies must fail');
  const noContext = structuredClone(valid);
  noContext.frequencyResponse.pointsContext = '';
  assert.ok(auditResponsePoints([noContext]).problems.length > 0, 'points without publication/measurement context must fail');
});

check('null states: null = unknown, absent key counted separately, invalid types are problems', () => {
  const r = auditNullableFlags([
    { id: 'ok', overallStatus: 'PARTIALLY_VERIFIED', driverCount: 2, active: true, panel: false },
    { id: 'unk', overallStatus: 'PARTIALLY_VERIFIED', driverCount: null, active: null, panel: null },
    { id: 'abs', overallStatus: 'PARTIALLY_VERIFIED' },
    { id: 'bad', overallStatus: 'PARTIALLY_VERIFIED', driverCount: 0, active: 'yes', panel: 1 },
  ]);
  assert.deepEqual(r.counts.driverCount, { known: 1, unknown: 1, absent: 1, invalid: 1 });
  assert.equal(r.problems.length, 3);
});

check('LEGACY rows with concrete driverCount/active/panel are reported; all-null LEGACY rows are not', () => {
  const concrete = auditNullableFlags([{ id: 'l', overallStatus: 'LEGACY', driverCount: 1, active: false, panel: false }]);
  assert.equal(concrete.legacyWithConcreteFlags, 1);
  assert.ok(concrete.warnings.length > 0);
  const nulls = auditNullableFlags([{ id: 'l', overallStatus: 'LEGACY', driverCount: null, active: null, panel: null }]);
  assert.equal(nulls.legacyWithConcreteFlags, 0);
});

check('response-model source check passes on the real speakerResponse.ts', () => {
  const r = checkResponseModelSource(real);
  assert.deepEqual(r.problems, []);
});

check('response-model source check FAILS if explicit response points lose their verified-source gate', () => {
  const bypassed = real.replace('response?.pointsStatus === expectedPointStatus', 'true');
  assert.ok(!checkResponseModelSource(bypassed).ok, 'point-source gate removal must fail release audit');
});

check('response-model source check FAILS if category-based synthesis comes back (and ignores comments)', () => {
  const start = real.indexOf('export function getSpeakerResponseModel');
  const injected = real.slice(0, start) + real.slice(start).replace('const publishedLow =', "const bias = spec.category === 'subwoofer' ? 2 : 0;\n  const publishedLow =");
  const r = checkResponseModelSource(injected);
  assert.ok(r.problems.some((p) => /category-based synthesis/.test(p)), r.problems.join('|'));
  assert.ok(checkResponseModelSource(real.replace('const publishedLow =', '// category is not used here\n  const publishedLow =')).ok);
});

check('response-model source check FAILS if the isGenericReference rule or publishedHz rule drifts', () => {
  assert.ok(!checkResponseModelSource(real.replace('referenceBounds.length > 0', 'true')).ok);
  assert.ok(!checkResponseModelSource(real.replace('Number.isFinite(v) && v > 0 ? v : null', 'true ? v : null')).ok);
});

console.log(`\n${passed} passed, 0 failed`);
