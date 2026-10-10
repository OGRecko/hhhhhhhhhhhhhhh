import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
const req = createRequire(import.meta.url);
const h = req('../electron/hardening.cjs');
const O = 'http://127.0.0.1:47615';
let n = 0; const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  PASS  ${name}`); };

function fakeContents() {
  const c: any = new EventEmitter();
  c.openHandler = null;
  c.setWindowOpenHandler = (f: any) => { c.openHandler = f; };
  return c;
}
function setup() {
  const opened: string[] = []; const logs: any[][] = [];
  const c = fakeContents();
  h.installNavigationGuards(c, O, { openExternal: (u: string) => opened.push(u), log: (...a: any[]) => logs.push(a) });
  const fire = (ev: string, ...args: any[]) => { let prevented = false; const e = { preventDefault: () => { prevented = true; } }; c.emit(ev, e, ...args); return prevented; };
  return { c, opened, logs, fire };
}

t('secure web preferences are exactly isolation on, node off, sandbox on, webview off', () => {
  assert.deepEqual({ ...h.SECURE_WEB_PREFERENCES }, { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false });
  assert.throws(() => { 'use strict'; (h.SECURE_WEB_PREFERENCES as any).nodeIntegration = true; }, TypeError); // frozen
});
t('will-navigate: same-origin allowed; spoofed/lookalike/other-scheme prevented and never opened externally unless plain http(s)', () => {
  const s = setup();
  assert.equal(s.fire('will-navigate', `${O}/app`), false);
  assert.equal(s.fire('will-navigate', 'http://127.0.0.1:47615@evil.example/'), true);
  assert.equal(s.fire('will-navigate', 'http://127.0.0.1.evil.example:47615/'), true);
  assert.equal(s.fire('will-navigate', 'file:///C:/Windows/System32/calc.exe'), true);
  assert.equal(s.fire('will-navigate', 'javascript:alert(1)'), true);
  // Blocked in-app. The credentialed spoof URL, file: and javascript: must NOT reach the OS browser; the
  // credential-free lookalike host is an ordinary external http URL, so it is (by design) opened externally,
  // never loaded inside the app window.
  assert.deepEqual(s.opened, ['http://127.0.0.1.evil.example:47615/']);
  s.opened.length = 0;
  assert.equal(s.fire('will-navigate', 'https://example.com/docs'), true);
  assert.deepEqual(s.opened, ['https://example.com/docs']);
});
t('will-redirect: any cross-origin redirect is prevented and never opened externally', () => {
  const s = setup();
  assert.equal(s.fire('will-redirect', `${O}/app`), false);
  assert.equal(s.fire('will-redirect', 'https://example.com/'), true);
  assert.equal(s.fire('will-redirect', 'http://127.0.0.1:47615@evil.example/'), true);
  assert.deepEqual(s.opened, []);
  assert.ok(s.logs.length >= 2, 'blocked redirects must be logged');
});
t('will-attach-webview is always prevented', () => {
  const s = setup();
  assert.equal(s.fire('will-attach-webview', {}, { src: `${O}/x` }), true);
  assert.equal(s.fire('will-attach-webview', {}, undefined), true);
});
t('window.open: always denied; only plain http(s) goes to the OS browser', () => {
  const s = setup();
  assert.deepEqual(s.c.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.deepEqual(s.c.openHandler({ url: 'file:///C:/x.exe' }), { action: 'deny' });
  assert.deepEqual(s.c.openHandler({ url: 'http://127.0.0.1:47615@evil.example/' }), { action: 'deny' });
  assert.deepEqual(s.opened, ['https://example.com/']);
});
t('permission policy: only same-origin audio-only microphone is allowed; everything else is denied', () => {
  const ORIGIN = 'http://127.0.0.1:47615';
  let reqHandler: any, chkHandler: any, devHandler: any; const logs: any[] = [];
  h.installPermissionPolicy({ setPermissionRequestHandler: (f: any) => { reqHandler = f; }, setPermissionCheckHandler: (f: any) => { chkHandler = f; }, setDevicePermissionHandler: (f: any) => { devHandler = f; } }, { log: (...a: any[]) => logs.push(a), getAppOrigin: () => ORIGIN });
  const wc = { getURL: () => ORIGIN };
  for (const p of ['geolocation', 'notifications', 'clipboard-read', 'midi', 'openExternal']) {
    let granted: boolean | undefined; reqHandler(wc, p, (g: boolean) => { granted = g; }, { requestingUrl: ORIGIN });
    assert.equal(granted, false, p); assert.equal(chkHandler(wc, p, ORIGIN, {}), false, p);
  }
  const ask = (details: any, url = ORIGIN) => { let g: boolean | undefined; reqHandler(wc, 'media', (x: boolean) => { g = x; }, { requestingUrl: url, ...details }); return g; };
  assert.equal(ask({ mediaTypes: ['audio'] }), true, 'same-origin audio');
  assert.equal(ask({ mediaTypes: ['video'] }), false, 'video denied');
  assert.equal(ask({ mediaTypes: ['audio', 'video'] }), false, 'audio+video denied');
  assert.equal(ask({ mediaTypes: ['audio'] }, 'http://127.0.0.1:47615@evil.example/'), false, 'spoofed origin denied');
  assert.equal(chkHandler(wc, 'media', ORIGIN, { mediaType: 'audio' }), true);
  assert.equal(chkHandler(wc, 'media', 'https://evil.example', { mediaType: 'audio' }), false);
  assert.equal(devHandler({ deviceType: 'microphone', origin: ORIGIN }), true);
  assert.equal(devHandler({ deviceType: 'camera', origin: ORIGIN }), false);
  assert.equal(devHandler({ deviceType: 'microphone', origin: 'https://evil.example' }), false);
  assert.equal(logs.length, 8, 'every denied media/other request is logged');
});
t('source scan: no preload, no IPC, no contextBridge; every BrowserWindow uses the secure preferences; no empty catch', () => {
  const dir = new URL('../electron/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.cjs'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/ipcMain|ipcRenderer|contextBridge|preload\s*:/.test(code), `${f}: IPC/preload/contextBridge must not exist`);
    assert.ok(!/catch\s*(\(\w*\))?\s*\{\s*\}/.test(code), `${f}: empty catch block`);
    for (const m of code.matchAll(/new BrowserWindow\(([\s\S]*?)\n?\s*\}\)\s*;/g)) {
      assert.ok(m[1].includes('...hardening.SECURE_WEB_PREFERENCES'), `${f}: BrowserWindow without SECURE_WEB_PREFERENCES`);
      assert.ok(!/nodeIntegration\s*:\s*true|sandbox\s*:\s*false|contextIsolation\s*:\s*false/.test(m[1]), `${f}: insecure webPreference`);
    }
  }
  const main = readFileSync(new URL('main.cjs', dir), 'utf8');
  assert.equal((main.match(/new BrowserWindow\(/g) || []).length, 2, 'expected exactly the main and smoke windows');
  assert.ok(main.includes("app.on('web-contents-created'"), 'guards must be installed on every webContents');
  assert.ok(main.includes('installPermissionPolicy(session.defaultSession'), 'permission policy must be installed');
});
console.log(`\n=== ${n} electron hardening checks passed ===`);
