/**
 * Black-box API security suite. Talks to the real createApi() handler over real
 * HTTP on a loopback port. Only the persistence/admission back-ends are in-memory
 * fakes; no API logic is stubbed and no check is relaxed to make a test pass.
 *
 * Capability tokens in this design do not carry their own expiry: a job (and
 * with it the token's hash) expires when cleanup deletes the record. "Expired"
 * is therefore tested as "record cleaned up => token refused".
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApi } from './api';
import { hashCapabilityToken } from './capabilityToken';
import { LIMITS } from '../src/lib/publicLimits';
import type { JobRecord } from './jobStore';
import { MemoryArtifactStore } from './testing/memoryArtifactStore';

const mk = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const A = { sim: mk('a'), job: mk('b'), token: 'a1'.repeat(32) };
const B = { sim: mk('c'), job: mk('d'), token: 'b2'.repeat(32) };
const baseRec = (x: typeof A): JobRecord => ({
  simulationId: x.sim, jobId: x.job, type: 'impulse-response', status: 'completed',
  capabilityTokenHash: hashCapabilityToken(x.token), createdAt: Date.now(), updatedAt: Date.now(),
  leaseOwner: null, leaseEpoch: 1, leaseUntil: 0, recoveryAttempts: 0,
  room: { L: 4, W: 4, H: 3 }, speakers: [{ x: .5, y: .5, z: 1.5 }], receivers: [{ x: .5, y: .5, z: 1.5 }],
  result: { receivers: [] }, artifacts: [],
} as any);
const records = new Map<string, JobRecord>([[A.sim, baseRec(A)], [B.sim, baseRec(B)]]);
let created = 0;
const store: any = {
  async createQueued(i: any) { if (records.has(i.simulationId)) return false; created++; records.set(i.simulationId, { ...i, status: 'queued', updatedAt: i.createdAt, leaseOwner: null, leaseEpoch: 0, leaseUntil: 0, recoveryAttempts: 0 }); return true; },
  async get(id: string) { return records.get(id) ?? null; },
  async getByJobId(id: string) { return [...records.values()].find((r) => r.jobId === id) ?? null; },
  async cancel(id: string) { const r = records.get(id); if (!r) return { ok: false }; if (['completed', 'failed', 'cancelled'].includes(r.status)) return { ok: true, alreadyFinished: true, status: r.status }; r.status = 'cancelled'; return { ok: true, alreadyFinished: false, status: 'cancelled' }; },
  async forEachCreatedBefore() {}, async deleteIfTerminal() { return 'missing'; }, async recover() { return 'skipped'; },
};
const admission: any = {
  async rateLimit() { return { allowed: true, retryAfterSeconds: 1 }; }, async acquireSlot() { return { ok: true, slotId: 's' }; },
  async releaseSlot() {}, async isRateLimited() { return false; }, async purgeExpiredRateLimits() { return 0; },
};
const artifacts = new MemoryArtifactStore();
// Injectable clock: the API's per-IP limiter is windowed per minute. Each check that sends many requests starts in a
// fresh window so the 413/202/4xx assertions measure validation, not the limiter state left by earlier checks.
let clockOffsetMs = 0;
const nextRateWindow = () => { clockOffsetMs += 60_000; };
const api = createApi({
  now: () => Date.now() + clockOffsetMs,
  store, artifacts, admission, dispatcher: { enqueue() { return true; }, cancelLocal() {} } as any,
  metrics: { inc() {}, snapshot() { return {}; } } as any, renderReport: async () => Buffer.from('%PDF-1.4 x'),
  cleanup: { store, artifacts, admission, metrics: { inc() {} } as any },
  cloudTasks: { authorize(s: unknown) { return s === 'task-secret'; }, async enqueue() { return true; } },
  config: { trustProxy: false, cleanupSecret: 'd'.repeat(32), allowedOrigin: null },
});
const server = http.createServer((req, res) => { void api(req, res).then((h) => { if (!h) { res.statusCode = 404; res.end(); } }).catch(() => { if (!res.headersSent) { res.statusCode = 500; res.end(); } }); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('no server');
const base = `http://127.0.0.1:${addr.port}`;
const JSONH = { 'content-type': 'application/json' };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
async function req(p: string, o: RequestInit = {}) { const r = await fetch(base + p, o); return { status: r.status, headers: r.headers, body: await r.text() }; }
const post = (p: string, body: unknown, h: Record<string, string> = {}) => req(p, { method: 'POST', headers: { ...JSONH, ...h }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const goodWave = () => ({ L: 4, W: 4, H: 3, steps: 1, sources: [{ x: .5, y: .5, z: 1.5 }], receivers: [{ x: 1, y: 1, z: 1.5 }] });

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e: any) { console.error(`  FAIL  ${name}\n        ${e?.stack ?? e}`); process.exitCode = 1; }
}
const rejected = (s: number) => assert.ok(s >= 400 && s < 500, `expected a 4xx rejection, got ${s}`);

try {
  await check('unauthorized: no / wrong / malformed token on job, report, cancel, artifact => 403', async () => {
    for (const h of [{}, bearer('wrong'), bearer('A'.repeat(64)), { authorization: 'Basic abc' }, { authorization: `Bearer ${A.token} extra` }]) {
      assert.equal((await req(`/api/jobs/${A.job}`, { headers: h })).status, 403);
      assert.equal((await req(`/api/jobs/${A.job}`, { method: 'DELETE', headers: h })).status, 403);
      assert.equal((await post('/api/report/export', { simulationId: A.sim }, h as any)).status, 403);
      assert.equal((await req(`/api/storage?id=${A.job}`, { headers: h })).status, 403);
    }
  });
  await check('a valid token is NOT accepted from the URL or the body', async () => {
    assert.equal((await req(`/api/jobs/${A.job}?token=${A.token}`)).status, 403);
    assert.equal((await post('/api/report/export', { simulationId: A.sim, token: A.token })).status, 403);
  });
  await check('cross-project / cross-user: job B token cannot touch job A (status, cancel, report, artifact)', async () => {
    assert.equal((await req(`/api/jobs/${A.job}`, { headers: bearer(B.token) })).status, 403);
    assert.equal((await req(`/api/jobs/${A.job}`, { method: 'DELETE', headers: bearer(B.token) })).status, 403);
    assert.equal((await post('/api/report/export', { simulationId: A.sim }, bearer(B.token))).status, 403);
    assert.equal((await req(`/api/storage?id=${A.job}`, { headers: bearer(B.token) })).status, 403);
    assert.equal((await req(`/api/jobs/${A.job}`, { headers: bearer(A.token) })).status, 200);
  });
  await check('denial is indistinguishable for "exists but not yours" vs "does not exist"', async () => {
    const other = await req(`/api/jobs/${A.job}`, { headers: bearer(B.token) });
    const none = await req(`/api/jobs/${mk('e')}`, { headers: bearer(B.token) });
    assert.equal(other.status, none.status); assert.equal(other.body, none.body);
  });
  await check('expired (cleaned-up) job: its token is refused and the record is not resurrected', async () => {
    const gone = { sim: mk('f'), job: mk('9'), token: 'c3'.repeat(32) };
    records.set(gone.sim, baseRec(gone));
    assert.equal((await req(`/api/jobs/${gone.job}`, { headers: bearer(gone.token) })).status, 200);
    records.delete(gone.sim);
    assert.equal((await req(`/api/jobs/${gone.job}`, { headers: bearer(gone.token) })).status, 403);
    assert.equal(records.has(gone.sim), false);
  });
  await check('malformed job / artifact IDs are rejected without a 5xx', async () => {
    for (const id of ['..%2F..%2Fetc%2Fpasswd', '%00', '%', '%E0%A4%A', 'x'.repeat(5000), '..', '.', 'a%2Fb', '%2e%2e%2f', "' OR 1=1 --", '<script>']) {
      const r = await req(`/api/jobs/${id}`, { headers: bearer(A.token) });
      assert.ok(r.status < 500, `${id.slice(0, 20)} => ${r.status}`); rejected(r.status);
    }
    for (const q of ['', '?id=', '?id=a&id=b', '?id=../../etc/passwd', '?id=%00', `?id=${'z'.repeat(5000)}`, '?id[]=x']) {
      const r = await req(`/api/storage${q}`, { headers: bearer(A.token) });
      assert.ok(r.status < 500, `${q.slice(0, 20)} => ${r.status}`); rejected(r.status);
    }
  });
  await check('path traversal / arbitrary file access via any route never returns file content', async () => {
    for (const p of ['/api/storage?id=../../../../etc/passwd', '/api/../etc/passwd', '/api/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fpackage.json', '/api/storage/../../server.ts']) {
      const r = await req(p, { headers: bearer(A.token) });
      assert.ok(!/root:|"dependencies"|createApi/.test(r.body), `leaked content via ${p}`);
      assert.ok(r.status < 500, `${p} => ${r.status}`);
    }
  });
  await check('malformed JSON, wrong content, non-object bodies => 400, never 5xx', async () => {
    for (const body of ['{', '', 'null', '[]', '"str"', '42', '{"a":', '\u0000', '{"__proto__":{"x":1}}']) {
      const r = await post('/api/solver/wave', body);
      assert.ok(r.status < 500, `body ${JSON.stringify(body)} => ${r.status}`); rejected(r.status);
    }
  });
  await check('oversized request bodies are refused with 413 (solver + report)', async () => {
    nextRateWindow();
    const big = JSON.stringify({ ...goodWave(), pad: 'x'.repeat(LIMITS.MAX_JSON_BODY_BYTES + 1024) });
    assert.equal((await post('/api/solver/wave', big)).status, 413);
    assert.equal((await post('/api/report/export', JSON.stringify({ simulationId: A.sim, pad: 'x'.repeat(LIMITS.MAX_REPORT_BODY_BYTES + 1024) }), bearer(A.token))).status, 413);
  });
  await check('invalid coordinates: NaN-like, strings, out of room, negative, huge, missing', async () => {
    const bad: unknown[] = [{ x: 'a', y: 1, z: 1 }, { x: null, y: 1, z: 1 }, { x: 99, y: 1, z: 1 }, { x: -1, y: 1, z: 1 }, { x: 1e308, y: 1, z: 1 }, { y: 1, z: 1 }, [1, 2, 3], 'x', { x: {}, y: 1, z: 1 }];
    for (const p of bad) {
      let r = await post('/api/solver/wave', { ...goodWave(), receivers: [p] }); rejected(r.status);
      r = await post('/api/solver/wave', { ...goodWave(), sources: [p] }); rejected(r.status);
    }
  });
  await check('invalid receiver count: 0 and 65 rejected; 1 and 64 accepted', async () => {
    nextRateWindow();
    // x/y are NORMALISED room coordinates in [0,1] (z is metres); the old fixture used metres and was correctly refused.
    const rc = (n: number) => Array.from({ length: n }, (_, i) => ({ x: 0.05 + (i % 8) * 0.12, y: 0.05 + Math.floor(i / 8) * 0.12, z: 1.5 }));
    rejected((await post('/api/solver/wave', { ...goodWave(), receivers: [] })).status);
    rejected((await post('/api/solver/wave', { ...goodWave(), receivers: rc(65) })).status);
    assert.equal((await post('/api/solver/wave', { ...goodWave(), receivers: rc(1) })).status, 202);
    assert.equal((await post('/api/solver/wave', { ...goodWave(), receivers: rc(64) })).status, 202);
  });
  await check('invalid source count: 0 and 17 rejected; 16 accepted', async () => {
    nextRateWindow();
    const sc = (n: number) => Array.from({ length: n }, (_, i) => ({ x: 0.1 + (i % 4) * 0.2, y: 0.1 + Math.floor(i / 4) * 0.2, z: 1.5 }));
    rejected((await post('/api/solver/wave', { ...goodWave(), sources: [] })).status);
    rejected((await post('/api/solver/wave', { ...goodWave(), sources: sc(17) })).status);
    assert.equal((await post('/api/solver/wave', { ...goodWave(), sources: sc(16) })).status, 202);
  });
  await check('over-limit simulation: room/steps/fmax beyond public limits rejected BEFORE any job is created', async () => {
    const before = created;
    for (const over of [{ L: 101 }, { W: 101 }, { H: 31 }, { L: 0.1 }, { steps: LIMITS.MAX_STEPS + 1 }, { steps: 0 }, { steps: 1.5 }, { fmax: LIMITS.MAX_FMAX_HZ + 1 }, { L: 100, W: 100, H: 30, fmax: 24000 }]) {
      const r = await post('/api/solver/wave', { ...goodWave(), ...over });
      rejected(r.status);
    }
    assert.equal(created, before, 'a rejected request must not create a job record');
  });
  await check('unexpected HTTP methods => 405 with Allow, unknown paths => 404', async () => {
    for (const [m, p] of [['PUT', '/api/solver/wave'], ['GET', '/api/solver/wave'], ['DELETE', '/api/solver/impulse-response'], ['PATCH', `/api/jobs/${A.job}`], ['POST', `/api/jobs/${A.job}`], ['GET', '/api/report/export'], ['POST', '/api/health'], ['PUT', '/api/storage']] as const) {
      const r = await req(p, { method: m, headers: bearer(A.token) });
      assert.equal(r.status, 405, `${m} ${p} => ${r.status}`);
    }
    assert.equal((await req('/api/does-not-exist')).status, 404);
  });
  await check('internal endpoints require their secret; token cannot substitute', async () => {
    assert.equal((await post('/api/internal/job-run', { simulationId: A.sim }, bearer(A.token))).status, 403);
    assert.equal((await post('/api/internal/job-run', { simulationId: A.sim }, { 'x-job-dispatch-secret': 'nope' })).status, 403);
    assert.equal((await post('/api/internal/job-run', { simulationId: 'not-a-uuid' }, { 'x-job-dispatch-secret': 'task-secret' })).status, 400);
    assert.ok([401, 403].includes((await post('/api/internal/cleanup', {}, bearer(A.token))).status));
    assert.ok([401, 403, 404].includes((await req('/api/internal/metrics', { headers: bearer(A.token) })).status));
  });
  await check('error responses never leak stack traces, file paths or internals', async () => {
    const r = await post('/api/solver/wave', '{"L":');
    assert.ok(!/at .*\(.*:\d+:\d+\)|node_modules|\/home\/|C:\\\\|Error:/.test(r.body), r.body);
  });
} finally { server.close(); }

console.log(`\n=== ${passed} black-box API security checks passed ===`);
