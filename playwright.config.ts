import { defineConfig } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * UI tests for the Download EXE button. They run the REAL built server (dist/server.cjs, `npm run build` first)
 * three times against three different release folders, and drive the page in Electron's Chromium
 * (tests/e2e/host.cjs) so no separate browser download is needed.
 */
export const E2E_ROOT = path.join(os.tmpdir(), 'cavity-e2e');
export const PORTS = { good: 4710, empty: 4711, tampered: 4712, badhash: 4713, notpe: 4714 } as const;
export const EXE_NAME = 'Cavity-Audio-Setup-v9.9.9.exe';

// Deterministic fixture installer: minimal valid PE headers (MZ, e_lfanew=0x40, "PE\0\0") followed by a repeating
// pattern. The server refuses anything that is not a real PE file, so "MZ" alone is no longer enough.
const peHead = Buffer.alloc(0x44); peHead.write('MZ', 0, 'latin1'); peHead.writeUInt32LE(0x40, 0x3c); peHead.write('PE\0\0', 0x40, 'latin1');
const body = Buffer.concat([peHead, Buffer.alloc(300_000).map((_, i) => (i * 31 + 7) & 0xff)]);
export const FIXTURE = { size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };

const dirs = { good: path.join(E2E_ROOT, 'releases-good'), empty: path.join(E2E_ROOT, 'releases-empty'), tampered: path.join(E2E_ROOT, 'releases-tampered'), badhash: path.join(E2E_ROOT, 'releases-badhash'), notpe: path.join(E2E_ROOT, 'releases-notpe') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(dirs.good, EXE_NAME), body);
fs.writeFileSync(path.join(dirs.good, 'manifest.json'), JSON.stringify({ version: '9.9.9', file: EXE_NAME, size: body.length, sha256: FIXTURE.sha256 }));
for (const f of fs.readdirSync(dirs.empty)) fs.rmSync(path.join(dirs.empty, f), { recursive: true, force: true });
fs.writeFileSync(path.join(dirs.tampered, EXE_NAME), body.subarray(0, 1000)); // size does not match the manifest
// Same size as the manifest, different content: only the SHA-256 check can catch this.
{ const flipped = Buffer.from(body); flipped[flipped.length - 1] ^= 0xff;
  fs.mkdirSync(dirs.badhash, { recursive: true });
  fs.writeFileSync(path.join(dirs.badhash, EXE_NAME), flipped);
  fs.writeFileSync(path.join(dirs.badhash, 'manifest.json'), JSON.stringify({ version: '9.9.9', file: EXE_NAME, size: body.length, sha256: FIXTURE.sha256 })); }
fs.writeFileSync(path.join(dirs.tampered, 'manifest.json'), JSON.stringify({ version: '9.9.9', file: EXE_NAME, size: body.length, sha256: FIXTURE.sha256 }));

const server = (name: keyof typeof PORTS) => ({
  command: 'node dist/server.cjs',
  url: `http://127.0.0.1:${PORTS[name]}/api/health`,
  reuseExistingServer: false,
  timeout: 60_000,
  env: {
    CAVITY_DESKTOP: '1', // local, loopback-only server mode: no cloud credentials needed
    CAVITY_APP_ROOT: process.cwd(),
    CAVITY_DATA_DIR: path.join(E2E_ROOT, `data-${name}`),
    PORT: String(PORTS[name]),
    RELEASES_DIR: dirs[name],
  },
});

export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 20_000 }, // cold Electron start after a heavy build can exceed the 5s default
  reporter: [['list']],
  webServer: [server('good'), server('empty'), server('tampered'), server('badhash'), server('notpe')],
});

// A file that is the right size with a matching SHA-256 but is NOT a PE executable (e.g. a renamed ZIP).
{ const fake = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(300_000, 7)]);
  fs.mkdirSync(dirs.notpe, { recursive: true });
  fs.writeFileSync(path.join(dirs.notpe, EXE_NAME), fake);
  fs.writeFileSync(path.join(dirs.notpe, 'manifest.json'), JSON.stringify({ version: '9.9.9', file: EXE_NAME, size: fake.length, sha256: crypto.createHash('sha256').update(fake).digest('hex') })); }
