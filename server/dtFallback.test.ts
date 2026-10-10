import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static regression guard (run with the repo's test runner): no invented dt/tl fallbacks.
const files = ['src/components/LeftSidebar.tsx', 'src/lib/audioEngine.ts', 'server/reportGenerator.ts'];
for (const f of files) {
  test(`no silent fallback constants in ${f}`, () => {
    const s = readFileSync(f, 'utf8');
    assert.ok(!/dtEstimate \|\| 0\.0001/.test(s), 'dtEstimate || 0.0001');
    assert.ok(!/tl \|\| 30/.test(s), 'tl || 30');
    assert.ok(!/s\.sens \|\| 90/.test(s), 's.sens || 90');
    assert.ok(!/r\.z \|\| 1\.2/.test(s), 'r.z || 1.2');
  });
}
