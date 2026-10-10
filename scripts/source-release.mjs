import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
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
const treeSha256 = hash.digest('hex');
const manifest = {
  kind: 'source-only',
  product: 'Cavity Audio',
  version: pkg.version,
  fileCount: files.length,
  treeSha256,
  generatedAt: new Date().toISOString(),
  note: 'This is a source integrity manifest. It is not a Windows installer release manifest.'
};
fs.mkdirSync(path.join(root, 'source-release'), { recursive: true });
fs.writeFileSync(path.join(root, 'source-release', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
