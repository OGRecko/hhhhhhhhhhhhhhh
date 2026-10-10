/**
 * Publishes the freshly built Windows installer to releases/ and writes the
 * manifest the UI reads (/release/windows). The manifest is ONLY written after the
 * EXE exists, has a valid PE ("MZ") header and a plausible size.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkRelease } from './lib/releaseCheck.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const src = path.join(ROOT, 'release-build', `Cavity-Audio-Setup-v${pkg.version}.exe`);
const outDir = path.join(ROOT, 'releases');

if (!fs.existsSync(src)) { console.error(`Missing ${src}. Run "npm run desktop:build" first.`); process.exit(1); }
const buf = fs.readFileSync(src);
if (buf.length < 5 * 1024 * 1024) { console.error('EXE is implausibly small.'); process.exit(1); }
if (buf[0] !== 0x4d || buf[1] !== 0x5a) { console.error('File is not a Windows PE executable (missing MZ header).'); process.exit(1); }

fs.mkdirSync(outDir, { recursive: true });
const name = path.basename(src);
fs.copyFileSync(src, path.join(outDir, name));
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
fs.writeFileSync(path.join(outDir, `${name}.sha256`), `${sha256}  ${name}\n`);
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
  version: pkg.version, file: name, size: buf.length, sha256, builtAt: new Date().toISOString(),
}, null, 2));
const verdict = checkRelease(outDir);
if (!verdict.ok) { console.error(`Published release failed verification:\n - ${verdict.problems.join('\n - ')}`); process.exit(1); }
console.log(`Released ${name} (${(buf.length / 1048576).toFixed(1)} MB) sha256=${sha256}`);
