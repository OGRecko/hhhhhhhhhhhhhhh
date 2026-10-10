// Runs the desktop self-test against a running server (any OS): node scripts/desktop-smoke.mjs http://127.0.0.1:PORT [stateFile]
import { createRequire } from 'node:module';
const { runSmoke } = createRequire(import.meta.url)('../electron/smoke.cjs');
const base = process.argv[2];
if (!base) { console.error('usage: desktop-smoke.mjs <baseUrl> [stateFile]'); process.exit(2); }
try { await runSmoke(base.replace(/\/$/, ''), { stateFile: process.argv[3] }); console.log('DESKTOP SMOKE OK'); }
catch (e) { console.error('DESKTOP SMOKE FAILED:', e.message); process.exit(1); }
