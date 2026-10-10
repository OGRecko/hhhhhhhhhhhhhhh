import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DesktopProjectStore } from './desktop/projectStore';
import { setLogSinks, resetLogSinks } from './observability';
import { createDesktopProjectRoutes } from './desktop/projectRoutes';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cavity-proj-'));
let n = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); n++; console.log(`  PASS  ${name}`); } catch (e: any) { console.error(`  FAIL  ${name}\n        ${e?.stack ?? e}`); process.exitCode = 1; }
}
const rec = (id: string, extra: any = {}) => ({ id, name: `P ${id}`, createdAt: 1, updatedAt: 2, isArchived: false, data: { L: 4, sources: [] }, ...extra });

await check('write -> restart (new store instance, same dir) -> read: projects persist independent of any port', async () => {
  const a = new DesktopProjectStore(dir);
  await a.put(rec('project-1')); await a.setActive('project-1');
  const b = new DesktopProjectStore(dir);
  assert.deepEqual((await b.get('project-1'))?.data, { L: 4, sources: [] });
  assert.equal(await b.getActive(), 'project-1');
  assert.equal((await b.list()).length, 1);
});
await check('corrupt primary falls back to .bak and the corrupt file is kept aside, not deleted', async () => {
  const s = new DesktopProjectStore(dir);
  await s.put(rec('c1', { name: 'v1' })); await s.put(rec('c1', { name: 'v2' })); // .bak now holds v1
  fs.writeFileSync(path.join(dir, 'projects', 'c1.json'), '{not json');
  assert.equal((await s.get('c1'))?.name, 'v1');
  assert.ok(fs.readdirSync(path.join(dir, 'projects')).some((f) => f.startsWith('c1.json.corrupt-')));
});
await check('corrupt primary AND corrupt backup => null (no crash, no partial data)', async () => {
  const s = new DesktopProjectStore(dir);
  await s.put(rec('c2')); await s.put(rec('c2'));
  fs.writeFileSync(path.join(dir, 'projects', 'c2.json'), 'x'); fs.writeFileSync(path.join(dir, 'projects', 'c2.json.bak'), 'y');
  assert.equal(await s.get('c2'), null);
});
await check('corruption and recovery of a project file are logged (not silent)', async () => {
  const s = new DesktopProjectStore(dir);
  await s.put(rec('lg1')); await s.put(rec('lg1')); // second put creates lg1.json.bak
  fs.writeFileSync(path.join(dir, 'projects', 'lg1.json'), '{broken');
  const lines: any[] = []; setLogSinks((l) => lines.push(JSON.parse(l)), (l) => lines.push(JSON.parse(l)));
  try { assert.equal((await s.get('lg1'))?.id, 'lg1'); } finally { resetLogSinks(); }
  assert.ok(lines.some((l) => l.event === 'project_file_corrupt'), JSON.stringify(lines));
  assert.ok(lines.some((l) => l.event === 'project_recovered_from_backup'), JSON.stringify(lines));
});
await check('unrecoverable project (primary + backup corrupt) is logged as such', async () => {
  const s = new DesktopProjectStore(dir);
  await s.put(rec('lg2'));
  fs.writeFileSync(path.join(dir, 'projects', 'lg2.json'), 'x'); fs.writeFileSync(path.join(dir, 'projects', 'lg2.json.bak'), 'y');
  const lines: any[] = []; setLogSinks((l) => lines.push(JSON.parse(l)), (l) => lines.push(JSON.parse(l)));
  try { assert.equal(await s.get('lg2'), null); } finally { resetLogSinks(); }
  assert.ok(lines.some((l) => l.event === 'project_backup_corrupt') && lines.some((l) => l.event === 'project_unrecoverable'), JSON.stringify(lines));
});
await check('non-ENOENT filesystem error is surfaced, never treated as an empty store', async () => {
  const s = new DesktopProjectStore(dir);
  fs.mkdirSync(path.join(dir, 'projects', 'dirasfile.json')); // reading a directory => EISDIR
  await assert.rejects(() => s.get('dirasfile'), /Cannot read/);
});
await check('concurrent writes are serialised: 50 parallel puts all land, file is valid JSON', async () => {
  const s = new DesktopProjectStore(dir);
  await Promise.all(Array.from({ length: 50 }, (_, i) => s.put(rec('conc', { updatedAt: i + 10, name: `n${i}` }))));
  const r = await s.get('conc'); assert.ok(r && r.name === 'n49');
});
await check('malformed IDs / traversal rejected; no file escapes the projects dir', async () => {
  const s = new DesktopProjectStore(dir);
  for (const id of ['../x', '..\\x', 'a/b', '', 'a'.repeat(81), '.hidden', 'x.json', 'C:\\x']) {
    await assert.rejects(async () => { await s.get(id); }, (e: unknown) => e instanceof Error, id);
    await assert.rejects(async () => { await s.put(rec(id) as any); }, (e: unknown) => e instanceof Error, id);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'x.json')));
});
await check('legacy import: never overwrites existing, skips invalid, marks migrated once', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cavity-mig-')); const s = new DesktopProjectStore(d2);
  await s.put(rec('keep', { name: 'disk-version' }));
  const r = await s.importLegacy([rec('keep', { name: 'idb-old' }), rec('new1'), { id: '../bad' }, 5], 'new1');
  assert.deepEqual(r, { imported: 1, skipped: 1, invalid: 2 });
  assert.equal((await s.get('keep'))?.name, 'disk-version');
  assert.equal(await s.isMigrated(), true); assert.equal(await s.getActive(), 'new1');
});

await check('empty legacy import does NOT mark migrated (so a later launch on the old origin can still import)', async () => {
  const s = new DesktopProjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cavity-mig2-')));
  assert.deepEqual(await s.importLegacy([], null), { imported: 0, skipped: 0, invalid: 0 });
  assert.equal(await s.isMigrated(), false);
});

// ---- HTTP guard ----
const store = new DesktopProjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cavity-http-')));
let port = 0;
const server = http.createServer((req, res) => { void createDesktopProjectRoutes({ store, port })(req, res).then((h) => { if (!h) { res.statusCode = 404; res.end(); } }); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r())); port = (server.address() as any).port;
const call = (p: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const data = o.body === undefined ? undefined : JSON.stringify(o.body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method: o.method ?? 'GET', headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...o.headers } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, body: b }));
  }); req.on('error', reject); if (data) req.write(data); req.end();
});
const ok = () => ({ 'x-cavity-desktop': '1' });
await check('HTTP: valid same-origin request works end to end (put/get/list/active/delete)', async () => {
  assert.equal((await call('/api/desktop/projects/p1', { method: 'PUT', headers: ok(), body: { project: rec('p1') } })).status, 200);
  assert.equal(JSON.parse((await call('/api/desktop/projects/p1', { headers: ok() })).body).project.id, 'p1');
  assert.equal(JSON.parse((await call('/api/desktop/projects', { headers: ok() })).body).projects.length, 1);
  assert.equal((await call('/api/desktop/active-project', { method: 'PUT', headers: ok(), body: { id: 'p1' } })).status, 200);
  assert.equal(JSON.parse((await call('/api/desktop/active-project', { headers: ok() })).body).id, 'p1');
  assert.equal((await call('/api/desktop/projects/p1', { method: 'DELETE', headers: ok() })).status, 200);
});
await check('HTTP: cross-site / rebinding / missing-header requests are refused with 403 and touch nothing', async () => {
  const bad: Record<string, string>[] = [
    {}, { 'x-cavity-desktop': '0' }, { ...ok(), origin: 'https://evil.example' }, { ...ok(), origin: 'null' },
    { ...ok(), host: `evil.example:${port}` }, { ...ok(), host: 'localhost:' + port }, { ...ok(), 'sec-fetch-site': 'cross-site' }, { ...ok(), 'sec-fetch-site': 'same-site' },
  ];
  for (const h of bad) {
    const r = await call('/api/desktop/projects/p2', { method: 'PUT', headers: h, body: { project: rec('p2') } });
    assert.equal(r.status, 403, JSON.stringify(h));
  }
  assert.equal(await store.get('p2'), null);
  assert.equal((await call('/api/desktop/projects', { headers: { ...ok(), origin: 'https://evil.example' } })).status, 403);
});
await check('HTTP: id mismatch, bad id, bad JSON, bad shape => 4xx and nothing written; unsupported method => 405', async () => {
  assert.equal((await call('/api/desktop/projects/p3', { method: 'PUT', headers: ok(), body: { project: rec('other') } })).status, 400);
  assert.equal(await store.get('other'), null);
  assert.equal((await call('/api/desktop/projects/..%2Fx', { headers: ok() })).status, 400);
  assert.equal((await call('/api/desktop/projects/p3', { method: 'PUT', headers: ok(), body: { project: { id: 'p3', name: 5 } } })).status, 400);
  assert.equal((await call('/api/desktop/projects/p3', { method: 'PATCH', headers: ok() })).status, 405);
  assert.equal((await call('/api/desktop/nope', { headers: ok() })).status, 404);
});
server.close();
console.log(`\n=== ${n} desktop project persistence checks passed ===`);
