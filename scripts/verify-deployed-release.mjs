// node scripts/verify-deployed-release.mjs <APP_URL> <manifest.json>
// Confirms the DEPLOYED server advertises the release and serves bytes whose SHA-256 matches the manifest.
import fs from 'node:fs';
import crypto from 'node:crypto';
const [base0, manifestPath] = process.argv.slice(2);
if (!base0 || !manifestPath) { console.error('usage: verify-deployed-release.mjs <APP_URL> <manifest.json>'); process.exit(2); }
const base = base0.replace(/\/$/, '');
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
let info;
for (let i = 0; i < 12; i++) { // the Cloud Storage mount can lag a few seconds
  info = await (await fetch(`${base}/release/windows`, { cache: 'no-store' })).json();
  if (info.available && info.sha256 === m.sha256) break;
  await new Promise((r) => setTimeout(r, 5000));
}
if (!info?.available || info.sha256 !== m.sha256 || info.version !== m.version || info.file !== m.file) { console.error(`Deployed /release/windows does not advertise this exact release: ${JSON.stringify(info)}`); process.exit(1); }
const res = await fetch(`${base}${info.url}`);
if (!res.ok) { console.error(`Download failed: HTTP ${res.status}`); process.exit(1); }
const buf = Buffer.from(await res.arrayBuffer());
const sha = crypto.createHash('sha256').update(buf).digest('hex');
if (buf.length !== m.size || sha !== m.sha256) { console.error(`Downloaded bytes do not match manifest (size ${buf.length}, sha256 ${sha})`); process.exit(1); }
console.log(`Deployed download OK: ${m.file} ${buf.length} bytes sha256=${sha}`);
