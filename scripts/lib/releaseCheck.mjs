import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Returns { ok, problems[], manifest }. Never throws for a bad release; only reports it. */
export function checkRelease(dir) {
  const problems = [];
  const mpath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mpath)) return { ok: false, problems: [`manifest.json is missing in ${dir}`], manifest: null };
  let m;
  try { m = JSON.parse(fs.readFileSync(mpath, 'utf8')); } catch { return { ok: false, problems: ['manifest.json is not valid JSON'], manifest: null }; }
  for (const k of ['version', 'file', 'size', 'sha256']) if (m[k] === undefined) problems.push(`manifest.json lacks "${k}"`);
  if (problems.length) return { ok: false, problems, manifest: m };
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) problems.push('manifest.version must be a semantic x.y.z version');
  if (typeof m.file !== 'string' || path.basename(m.file) !== m.file || !m.file.toLowerCase().endsWith('.exe')) return { ok: false, problems: ['manifest.file must be a bare .exe file name'], manifest: m };
  if (typeof m.version === 'string' && !m.file.includes(`v${m.version}.exe`)) problems.push(`manifest.file/version mismatch: ${m.file} vs ${m.version}`);
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.version !== m.version) problems.push(`manifest/package version mismatch: ${m.version} vs ${pkg.version}`);
  } catch { /* standalone release checker may be copied without package.json */ }
  const exe = path.join(dir, m.file);
  if (!fs.existsSync(exe)) return { ok: false, problems: [`${m.file} listed in manifest but not found`], manifest: m };
  const st = fs.statSync(exe);
  if (st.size !== m.size) problems.push(`size mismatch: file is ${st.size} bytes, manifest says ${m.size}`);
  const fd = fs.openSync(exe, 'r'); const head = Buffer.alloc(2); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
  if (head[0] !== 0x4d || head[1] !== 0x5a) problems.push('missing MZ header: not a Windows PE executable');
  if (!/^[0-9a-f]{64}$/.test(String(m.sha256))) problems.push('manifest.sha256 is not 64 lowercase hex chars');
  else {
    const h = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
    if (h !== m.sha256) problems.push(`sha256 mismatch: file ${h}, manifest ${m.sha256}`);
  }
  return { ok: problems.length === 0, problems, manifest: m };
}
