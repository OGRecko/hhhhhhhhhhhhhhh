'use strict';
// Shared Electron hardening. Applied to EVERY webContents via app.on('web-contents-created'), so the
// main window, the smoke-test window and any future window get identical guards.
// There is deliberately no preload script and no ipcMain handler: the renderer is a plain web page that
// talks to the bundled server over HTTP only. Nothing from Node/Electron is exposed to it.
const originCheck = require('./originCheck.cjs');

// The only webPreferences any window may use. webviewTag is explicit (it is off by default in recent
// Electron, but a security property should not depend on a default).
const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webviewTag: false,
});

function installNavigationGuards(contents, appOrigin, { openExternal, log }) {
  const same = (u) => originCheck.sameOrigin(u, appOrigin);
  contents.setWindowOpenHandler(({ url }) => {
    if (originCheck.isSafeExternalUrl(url)) openExternal(url);
    else log('blocked window.open', { url });
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (same(url)) return;
    e.preventDefault();
    if (originCheck.isSafeExternalUrl(url)) openExternal(url);
    else log('blocked navigation', { url });
  });
  // Server-side / meta redirects bypass will-navigate for the initial request; guard them separately.
  // A redirect is never handed to the OS browser: the app did not ask for that page.
  contents.on('will-redirect', (e, url) => {
    if (same(url)) return;
    e.preventDefault();
    log('blocked redirect', { url });
  });
  // <webview> would let content create a guest page with its own preferences. Never allowed.
  contents.on('will-attach-webview', (e, _webPreferences, params) => {
    e.preventDefault();
    log('blocked webview', { src: params && params.src });
  });
}

// Deny every permission request/check (camera, mic, geolocation, notifications, clipboard-read, ...).
// The app needs none of them; WebGL and Web Audio playback do not use the permission system.
function installPermissionPolicy(session, { log, getAppOrigin }) {
  const allowedSameOrigin = (webContents, requestingUrl) => {
    try {
      const u = String(requestingUrl || webContents?.getURL?.() || '');
      return originCheck.sameOrigin(u, getAppOrigin());
    } catch { return false; }
  };
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = details?.requestingUrl || webContents?.getURL?.();
    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    const allow = permission === 'media'
      && mediaTypes.includes('audio')
      && !mediaTypes.includes('video')
      && allowedSameOrigin(webContents, url);
    if (!allow) log('denied permission request', { permission, url, mediaTypes });
    callback(allow);
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const mediaType = details?.mediaType;
    return permission === 'media'
      && mediaType === 'audio'
      && allowedSameOrigin(webContents, requestingOrigin);
  });
  if (typeof session.setDevicePermissionHandler === 'function') {
    session.setDevicePermissionHandler(({ deviceType, origin }) => deviceType === 'microphone' && origin === getAppOrigin());
  }
}

module.exports = { SECURE_WEB_PREFERENCES, installNavigationGuards, installPermissionPolicy };
