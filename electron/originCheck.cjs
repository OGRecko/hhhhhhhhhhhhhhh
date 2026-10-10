'use strict';
// Origin comparison for in-app navigation. Parsed origins only, never string prefixes.
function sameOrigin(candidate, appOrigin) {
  try {
    const c = new URL(candidate);
    const a = new URL(appOrigin);
    if (c.username || c.password) return false; // userinfo tricks (http://127.0.0.1:47615@evil.example/)
    return c.origin !== 'null' && c.origin === a.origin;
  } catch { return false; }
}
// Only plain web URLs may be handed to the OS browser; never file:, javascript:, data:, custom schemes.
function isSafeExternalUrl(u) {
  try { const p = new URL(u); return (p.protocol === 'https:' || p.protocol === 'http:') && !p.username && !p.password; }
  catch { return false; }
}
module.exports = { sameOrigin, isSafeExternalUrl };
