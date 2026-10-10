/**
 * Stages the EXACT runtime dependency closure of dist/server.cjs + dist/solverWorker.cjs into
 * build/stage/node_modules, which electron-builder then ships (extraResources -> resources/app/node_modules).
 *
 * Why: electron-builder's own node_modules collector drops hoisted/deduped packages (observed: call-bind-apply-helpers,
 * side-channel-*), so the packaged server crashed at require("express"). This walks real Node resolution instead, and
 * skips build-only packages (vite, react, three, tailwind...) that the desktop server never loads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'build', 'stage', 'node_modules');
const SKIP = new Set(['vite']); // only reached via a dev-mode dynamic import that desktop mode never takes
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const pkgNameOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
const externals = new Set();
for (const f of ['dist/server.cjs', 'dist/solverWorker.cjs']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of src.matchAll(/require\(["']([^"'./][^"']*)["']\)/g)) {
    if (builtins.has(m[1]) || SKIP.has(pkgNameOf(m[1]))) continue;
    externals.add(pkgNameOf(m[1]));
  }
}

/** Node resolution of a package directory, starting from `fromDir` (the dir of the requiring package). */
function resolvePkgDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const cand = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(cand, 'package.json'))) return fs.realpathSync(cand);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const seen = new Map(); // realpath -> true
const queue = [...externals].map((n) => ({ name: n, from: ROOT, required: true, parent: '(bundle)' }));
const missingRequired = [];
while (queue.length) {
  const { name, from, required, parent } = queue.pop();
  const dir = resolvePkgDir(name, from);
  if (!dir) { if (required) missingRequired.push(`${name} (needed by ${parent})`); continue; }
  if (seen.has(dir)) continue;
  seen.set(dir, true);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const n of Object.keys(pj.dependencies || {})) queue.push({ name: n, from: dir, required: true, parent: pj.name });
  for (const n of Object.keys(pj.optionalDependencies || {})) queue.push({ name: n, from: dir, required: false, parent: pj.name });
  for (const n of Object.keys(pj.peerDependencies || {})) if (!(pj.peerDependenciesMeta?.[n]?.optional)) queue.push({ name: n, from: dir, required: false, parent: pj.name });
}
if (missingRequired.length) { console.error(`Unresolvable runtime dependencies:\n - ${missingRequired.join('\n - ')}`); process.exit(1); }

fs.rmSync(path.join(ROOT, 'build', 'stage'), { recursive: true, force: true });
const rootNm = path.join(ROOT, 'node_modules') + path.sep;
let count = 0, bytes = 0;
for (const dir of seen.keys()) {
  const rel = dir.startsWith(rootNm) ? dir.slice(rootNm.length) : null;
  if (!rel) throw new Error(`dependency outside project node_modules: ${dir}`);
  const dest = path.join(OUT, rel);
  fs.cpSync(dir, dest, {
    recursive: true, dereference: true,
    filter: (src) => {
      const r = path.relative(dir, src).split(path.sep).join('/');
      if (r === '') return true;
      if (r === 'node_modules' || r.startsWith('node_modules/')) return false; // nested deps are separate closure entries
      // Drop docs/tests/maps (top-level only, so a package's real runtime dirs are never touched).
      return !(/^(\.github|test|tests|__tests__|docs?|examples?)(\/|$)/i.test(r) || /\.(md|markdown|map|tsbuildinfo)$/i.test(r));
    },
  });
  count++;
}
for (const d of (function* walk(p) { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) yield* walk(f); else yield f; } })(OUT)) bytes += fs.statSync(d).size;
console.log(`Staged ${count} packages (${(bytes / 1048576).toFixed(0)} MB) for: ${[...externals].sort().join(', ')}`);
