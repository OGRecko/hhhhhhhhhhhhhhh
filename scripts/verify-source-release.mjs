import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const manifestPath = path.join(root, 'source-release', 'manifest.json');
if (!fs.existsSync(manifestPath)) throw new Error('source-release/manifest.json is missing');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.kind !== 'source-only') throw new Error('source release manifest kind is not source-only');
if (manifest.product !== 'Cavity Audio') throw new Error('source release manifest product mismatch');
const ignoredRoots = new Set(['node_modules', 'dist', '.git', 'source-release']);
const files = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredRoots.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.isFile()) files.push(path.relative(root, p).split(path.sep).join('/'));
  }
}
walk(root);
files.sort();
const hash = crypto.createHash('sha256');
for (const file of files) hash.update(file + '\0' + fs.readFileSync(path.join(root, file)));
const actual = hash.digest('hex');
if (manifest.treeSha256 !== actual) {
  throw new Error(`source tree hash mismatch: manifest=${manifest.treeSha256} actual=${actual}`);
}
if (manifest.fileCount !== files.length) {
  throw new Error(`source file count mismatch: manifest=${manifest.fileCount} actual=${files.length}`);
}
console.log(JSON.stringify({ ok: true, product: manifest.product, version: manifest.version, fileCount: files.length, treeSha256: actual }, null, 2));
