import assert from 'node:assert/strict';
import { installPermissionPolicy } from '../electron/hardening.cjs';

const APP_ORIGIN = 'http://127.0.0.1:47615';
const handlers = {};
const logs = [];
const session = {
  setPermissionRequestHandler(fn) { handlers.request = fn; },
  setPermissionCheckHandler(fn) { handlers.check = fn; },
};
installPermissionPolicy(session, { log: (...args) => logs.push(args), getAppOrigin: () => APP_ORIGIN });

const wc = { getURL: () => APP_ORIGIN };
let result;
handlers.request(wc, 'media', (allowed) => { result = allowed; }, { requestingUrl: APP_ORIGIN, mediaTypes: ['audio'] });
assert.equal(result, true);

handlers.request(wc, 'media', (allowed) => { result = allowed; }, { requestingUrl: APP_ORIGIN, mediaTypes: ['video'] });
assert.equal(result, false);

handlers.request(wc, 'media', (allowed) => { result = allowed; }, { requestingUrl: 'http://127.0.0.1:47615@evil.example/', mediaTypes: ['audio'] });
assert.equal(result, false);

assert.equal(handlers.check(wc, 'media', APP_ORIGIN, { mediaType: 'audio' }), true);
assert.equal(handlers.check(wc, 'media', APP_ORIGIN, { mediaType: 'video' }), false);
assert.equal(handlers.check(wc, 'media', 'https://evil.example', { mediaType: 'audio' }), false);

console.log('electron permission policy PASS');
