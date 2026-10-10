// Cavity Audio – Windows desktop shell.
// Starts the bundled server (dist/server.cjs) on a free loopback port in
// *desktop mode* (CAVITY_DESKTOP=1, config.desktop === true) and shows the app
// in a native window. Jobs and artifacts persist under app.getPath('userData').
//
// Headless self-test (used by CI):  "Cavity Audio.exe" --smoke-test --smoke-out=<file.json>
const { app, BrowserWindow, shell, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const hardening = require('./hardening.cjs');

// Electron >= 44 no longer falls back to software WebGL automatically: allow SwiftShader
// so the 3D view still works on machines without a usable GPU.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

const argv = process.argv.slice(1);
const SMOKE = argv.includes('--smoke-test');
const smokeOut = (argv.find((a) => a.startsWith('--smoke-out=')) || '').slice('--smoke-out='.length) || null;

let win = null;
let appOrigin = null; // set once the server port is known; every webContents is guarded against it
let logFile = null;
let serverModule = null;
// The local job store saves on a short debounce; flush it before any exit path (app.exit() skips before-quit).
function flushStore() { try { if (serverModule && typeof serverModule.flushStore === 'function') serverModule.flushStore(); } catch (e) { log('flush failed', e); } }
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.stack : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try { if (logFile) fs.appendFileSync(logFile, line); } catch (err) { console.error('cavity log write failed:', err && err.message, line.trim()); /* a failing logger must not crash the app; stderr is the last resort */ }
}

// IndexedDB (where local projects live) is scoped to the page ORIGIN, including the port. A random port per
// launch would make every project saved in a previous launch invisible after restart. So prefer one stable
// loopback port, and only fall back to a random one if it is occupied (projects from the stable-port
// origin are then not visible in that session; this is logged).
const PREFERRED_PORT = 47615;
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
  });
}
async function freePort() {
  // Test hook: force a specific port so e2e can prove projects survive a DIFFERENT port (0 = random).
  const forced = process.env.CAVITY_PORT_OVERRIDE;
  if (forced !== undefined && /^\d{1,5}$/.test(forced)) return listenOn(Number(forced));
  try { return await listenOn(PREFERRED_PORT); }
  catch (e) { log('preferred port busy; using a random port. Local projects saved under the stable origin will not be visible this session.', { code: e && e.code }); return listenOn(0); }
}

function waitForHealth(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (res) => {
        res.resume();
        res.statusCode === 200 ? resolve() : retry();
      });
      req.on('error', retry);
      req.on('timeout', () => req.destroy());
    };
    const retry = () => (Date.now() - start > timeoutMs ? reject(new Error('Server did not become healthy')) : setTimeout(tick, 250));
    tick();
  });
}

async function startServer() {
  const port = await freePort();
  // With asar disabled the app lives in <install>/resources/app; in dev it is the repo root.
  const root = app.getAppPath();
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Desktop configuration (read by server/config.ts). NODE_ENV is NOT touched.
  process.env.CAVITY_DESKTOP = '1';
  process.env.CAVITY_APP_ROOT = root;
  process.env.CAVITY_DATA_DIR = dataDir;
  process.env.PORT = String(port);

  log('starting server', { root, dataDir, port, packaged: app.isPackaged });
  const mod = require(path.join(root, 'dist', 'server.cjs'));
  serverModule = mod;
  await mod.ready;          // rejects with the real startup error
  await waitForHealth(port); // and prove it answers over HTTP
  log('server healthy', { port });
  return { port, dataDir };
}

async function runSmoke(port, dataDir) {
  const { runSmoke } = require('./smoke.cjs');
  const result = { ok: false, steps: [], error: null, port, packaged: app.isPackaged, windowLoaded: false };
  try {
    win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { ...hardening.SECURE_WEB_PREFERENCES } });
    await win.loadURL(`http://127.0.0.1:${port}/app`);
    result.windowLoaded = true;
    result.windowTitle = win.getTitle();
    // Confirm the React app actually rendered (CSP did not block the bundle).
    result.rootChildren = await win.webContents.executeJavaScript('document.getElementById("root") ? document.getElementById("root").children.length : -1');
    if (!(result.rootChildren > 0)) throw new Error(`React root is empty (children=${result.rootChildren}); client bundle failed to run`);
    result.steps = await runSmoke(`http://127.0.0.1:${port}`, { stateFile: path.join(dataDir, 'smoke-state.json'), log });
    result.ok = true;
  } catch (e) {
    result.error = String((e && e.stack) || e);
    log('smoke failed', e);
  }
  if (smokeOut) { try { fs.writeFileSync(smokeOut, JSON.stringify(result, null, 2)); } catch (e) { log('could not write smoke-out', e); } }
  flushStore();
  app.exit(result.ok ? 0 : 1);
}

async function createWindow() {
  const { port, dataDir } = await startServer();
  appOrigin = `http://127.0.0.1:${port}`; // set BEFORE any window exists; guards below read it
  if (SMOKE) return runSmoke(port, dataDir);
  const origin = `http://127.0.0.1:${port}`;
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 700,
    backgroundColor: '#0b0b0c', title: 'Cavity Audio', autoHideMenuBar: true,
    icon: path.join(app.getAppPath(), 'build', 'icon.ico'),
    webPreferences: { ...hardening.SECURE_WEB_PREFERENCES },
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', { code, desc, url }));
  win.webContents.on('render-process-gone', (_e, d) => log('render-process-gone', d));
  await win.loadURL(`${origin}/app`);
}

// Guard every webContents ever created (main window, smoke window, anything added later). Fail closed:
// until appOrigin is known no URL is considered same-origin.
app.on('web-contents-created', (_e, contents) => {
  hardening.installNavigationGuards(contents, appOrigin || 'http://invalid.invalid', {
    openExternal: (u) => { shell.openExternal(u).catch((err) => log('openExternal failed', { url: u, err })); },
    log,
  });
});

const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    logFile = path.join(app.getPath('userData'), 'cavity-desktop.log');
    hardening.installPermissionPolicy(session.defaultSession, { log, getAppOrigin: () => appOrigin || 'http://invalid.invalid' });
    return createWindow();
  }).catch((e) => {
    log('fatal', e);
    if (SMOKE) {
      if (smokeOut) { try { fs.writeFileSync(smokeOut, JSON.stringify({ ok: false, error: String((e && e.stack) || e) }, null, 2)); } catch (werr) { log('could not write smoke-out after fatal error', werr); } }
      flushStore();
      app.exit(1);
      return;
    }
    dialog.showErrorBox('Cavity Audio failed to start', `${(e && e.message) || e}\n\nLog: ${logFile}`);
    app.quit();
  });
  app.on('before-quit', flushStore);
  app.on('window-all-closed', () => { if (!SMOKE) app.quit(); });
}
