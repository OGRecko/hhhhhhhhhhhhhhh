import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { sameOrigin, isSafeExternalUrl } = createRequire(import.meta.url)('../electron/originCheck.cjs');
const O = 'http://127.0.0.1:47615';
let n = 0; const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  PASS  ${name}`); };
t('legitimate same-origin URLs are accepted', () => { for (const u of [`${O}/app`, `${O}/`, `${O}/a/b?x=1#h`]) assert.equal(sameOrigin(u, O), true, u); });
t('origin-confusion URLs are rejected', () => {
  for (const u of ['http://127.0.0.1:47615@evil.example/', 'http://127.0.0.1:47615:pw@evil.example/', 'http://evil.example/http://127.0.0.1:47615',
    'http://127.0.0.1.evil.example:47615/', 'http://127.0.0.1:47616/', 'https://127.0.0.1:47615/', 'http://localhost:47615/', 'http://127.0.0.1@47615/',
    'http://user@127.0.0.1:47615/', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,x', 'about:blank', '', 'not a url'])
    assert.equal(sameOrigin(u, O), false, u);
});
t('backslash form is parsed by WHATWG/Chromium as a LOCAL path, never as host evil.example', () => {
  const u = new URL('http://127.0.0.1:47615\\@evil.example/');
  assert.equal(u.hostname, '127.0.0.1'); assert.equal(u.pathname, '/@evil.example/'); assert.equal(sameOrigin(u.href, O), true);
});
t('external opener allows only plain http(s) without credentials', () => {
  assert.equal(isSafeExternalUrl('https://example.com/x'), true);
  for (const u of ['file:///C:/x.exe', 'javascript:alert(1)', 'data:text/html,x', 'ms-msdt:/id', 'vbscript:x', 'smb://host/share', 'https://user:pw@example.com/', '', 'x'])
    assert.equal(isSafeExternalUrl(u), false, u);
});
console.log(`\n=== ${n} electron origin checks passed ===`);
