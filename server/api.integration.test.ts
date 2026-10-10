import assert from 'node:assert/strict';
import http from 'node:http';
import { createApi } from './api';
import { hashCapabilityToken } from './capabilityToken';
import { LIMITS } from '../src/lib/publicLimits';
import type { JobRecord } from './jobStore';
import type { ArtifactStore } from './storage';
import { MemoryArtifactStore } from './testing/memoryArtifactStore';

const sim = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const job = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const token = 'c'.repeat(64);
let rec: JobRecord = {
  simulationId: sim, jobId: job, type: 'impulse-response', status: 'completed',
  capabilityTokenHash: hashCapabilityToken(token), createdAt: Date.now(), updatedAt: Date.now(),
  leaseOwner: null, leaseEpoch: 1, leaseUntil: 0, recoveryAttempts: 0,
  room: { L: 4, W: 4, H: 3 }, speakers: [{x:.5,y:.5,z:1.5}], receivers: [{x:.5,y:.5,z:1.5}],
  result: { receivers: [] }, artifacts: [],
};
const records = new Map([[sim, rec]]);
const store: any = {
  async createQueued(input: any) { if (records.has(input.simulationId)) return false; rec = { ...input, status:'queued', updatedAt:input.createdAt, leaseOwner:null, leaseEpoch:0, leaseUntil:0, recoveryAttempts:0 }; records.set(input.simulationId, rec); return true; },
  async get(id: string) { return records.get(id) ?? null; },
  async getByJobId(id: string) { return [...records.values()].find(r => r.jobId === id) ?? null; },
  async cancel(id: string) { const r=records.get(id); if(!r) return {ok:false}; if(['completed','failed','cancelled'].includes(r.status)) return {ok:true,alreadyFinished:true,status:r.status}; r.status='cancelled'; return {ok:true,alreadyFinished:false,status:'cancelled'}; },
  async forEachCreatedBefore() {}, async deleteIfTerminal(){return 'missing';}, async recover(){return 'skipped';},
};
const admission: any = {
  async rateLimit(){return {allowed:true,retryAfterSeconds:1};},
  async acquireSlot(){return {ok:true,slotId:'slot'};},
  async releaseSlot(){}, async isRateLimited(){return false;}, async purgeExpiredRateLimits(){return 0;},
};
const artifacts: ArtifactStore = new MemoryArtifactStore();
const dispatcher: any = { enqueue(){return true;}, cancelLocal(){} };
const api = createApi({
  store, artifacts, admission, dispatcher, metrics: { inc() {}, snapshot(){return {}; } } as any,
  renderReport: async () => Buffer.from('%PDF-1.4 smoke'),
  cleanup: { store, artifacts, admission, metrics: { inc() {} } as any },
  cloudTasks: { authorize(secret: unknown) { return secret === 'task-secret'; }, async enqueue() { return true; } },
  config: { trustProxy:false, cleanupSecret:'d'.repeat(32), allowedOrigin:null },
});
const server = http.createServer((req,res)=>{ void api(req,res).then(handled=>{ if(!handled){res.statusCode=404;res.end();} }).catch(()=>{if(!res.headersSent){res.statusCode=500;res.end();}}); });
await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('test server did not start');
const base = `http://127.0.0.1:${address.port}`;
async function request(path:string, options:RequestInit={}) { const r=await fetch(base+path,options); return {r, body: await r.text()}; }

try {
  let x = await request(`/api/jobs/${job}`); assert.equal(x.r.status,403);
  x = await request(`/api/jobs/${job}`, {headers:{authorization:'Bearer wrong'}}); assert.equal(x.r.status,403);
  x = await request(`/api/jobs/${job}`, {headers:{authorization:`Bearer ${token}`}}); assert.equal(x.r.status,200);
  x = await request('/api/report/export', {method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({simulationId:sim,solverResult:{forged:true}})});
  assert.equal(x.r.status,200); assert.match(x.r.headers.get('content-type') || '', /application\/pdf/);
  x = await request('/api/report/export', {method:'POST',headers:{'content-type':'application/json',authorization:`Bearer wrong`},body:JSON.stringify({simulationId:sim})}); assert.equal(x.r.status,403);
  x = await request('/api/report/export', {method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({solverResult:{forged:true}})}); assert.equal(x.r.status,400);
  x = await request('/api/solver/wave', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({L:4,W:4,H:3,steps:1,sources:[{x:.5,y:.5,z:1.5}],receivers:[{x:.5,y:.5,z:1.5}]})});
  assert.equal(x.r.status,202);
  x = await request('/api/internal/job-run', {method:'POST',headers:{'content-type':'application/json','x-job-dispatch-secret':'wrong'},body:JSON.stringify({simulationId:sim})}); assert.equal(x.r.status,403);
  x = await request('/api/internal/job-run', {method:'POST',headers:{'content-type':'application/json','x-job-dispatch-secret':'task-secret'},body:JSON.stringify({simulationId:sim})}); assert.equal(x.r.status,202);
  x = await request('/api/internal/job-run', {method:'POST',headers:{'content-type':'application/json','x-job-dispatch-secret':'task-secret'},body:JSON.stringify({simulationId:'not-a-uuid'})}); assert.equal(x.r.status,400);
  console.log('PASS API integration: public submission, job auth, report auth, and forged report data rejection');
} finally { server.close(); }
