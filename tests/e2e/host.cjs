// Minimal Electron host used by the Playwright tests: one window, downloads saved to E2E_DOWNLOAD_DIR and recorded.
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
global.__downloads = [];
// Headless CI (Xvfb, no GPU): software rendering avoids a GPU-process init failure that hides the window from Playwright.
// Same switches as electron/main.cjs: SwiftShader software WebGL (Electron >= 44 no longer falls back automatically).
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.whenReady().then(() => {
  session.defaultSession.on('will-download', (_e, item) => {
    const filename = item.getFilename();
    const savePath = path.join(process.env.E2E_DOWNLOAD_DIR, filename);
    item.setSavePath(savePath);
    item.once('done', (_ev, state) => global.__downloads.push({ filename, savePath, state, url: item.getURL() }));
  });
  const win = new BrowserWindow({ width: 1280, height: 800, webPreferences: { contextIsolation: true } });
  win.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
