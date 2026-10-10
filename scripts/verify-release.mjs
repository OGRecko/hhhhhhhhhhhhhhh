// CI gate: node scripts/verify-release.mjs [releasesDir]  — exits 1 if the EXE release is not publishable.
import path from 'node:path';
import { checkRelease } from './lib/releaseCheck.mjs';
const dir = path.resolve(process.argv[2] || process.env.RELEASES_DIR || 'releases');
const r = checkRelease(dir);
if (!r.ok) { console.error(`RELEASE INVALID (${dir}):\n - ${r.problems.join('\n - ')}`); process.exit(1); }
console.log(`Release OK: ${r.manifest.file} ${r.manifest.size} bytes sha256=${r.manifest.sha256}`);
