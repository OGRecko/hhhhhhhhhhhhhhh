const appUrl = process.env.APP_URL?.replace(/\/$/, '');
if (!appUrl) throw new Error('APP_URL is required');

async function request(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
}

const health = await request('/api/health');
if (!health.response.ok || health.body?.status !== 'ok') throw new Error(`Health check failed: HTTP ${health.response.status}`);
console.log('PASS production health endpoint');

const invalid = await request('/api/solver/wave', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ L: 0, W: 5, H: 3, steps: 1, receivers: [{ x: 0.5, y: 0.5 }] }),
});
if (invalid.response.status !== 400) throw new Error(`Expected invalid geometry rejection, got HTTP ${invalid.response.status}`);
console.log('PASS production public validation');

const taskGate = await request('/api/internal/job-run', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ simulationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
});
if (taskGate.response.status !== 403) throw new Error(`Cloud Tasks internal endpoint must reject unauthenticated callers, got HTTP ${taskGate.response.status}`);
console.log('PASS Cloud Tasks internal endpoint authorization');

if (process.env.SMOKE_RUN_SOLVER !== 'true') {
  console.log('Production smoke checks passed (solver flow disabled; set SMOKE_RUN_SOLVER=true for full E2E).');
  process.exit(0);
}

const payload = {
  L: 4, W: 4, H: 3, steps: 40,
  sources: [{ x: 0.5, y: 0.5, z: 1.5 }],
  receivers: [{ x: 0.5, y: 0.5, z: 1.5 }],
};
const run = await request('/api/solver/impulse-response', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});
if (run.response.status !== 202 || !run.body?.jobId || !run.body?.capabilityToken) throw new Error(`Production solver smoke failed: HTTP ${run.response.status}`);
const { jobId, capabilityToken } = run.body;
console.log('PASS anonymous solver submission');

const wrong = await request(`/api/jobs/${jobId}`, { headers: { authorization: 'Bearer wrong-token' } });
if (wrong.response.status !== 403) throw new Error(`Wrong-token job access expected 403, got ${wrong.response.status}`);
const missing = await request(`/api/jobs/${jobId}`);
if (missing.response.status !== 403) throw new Error(`Missing-token job access expected 403, got ${missing.response.status}`);
console.log('PASS job capability authorization');

let completed;
const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS || 180000);
for (;;) {
  const r = await request(`/api/jobs/${jobId}`, { headers: { authorization: `Bearer ${capabilityToken}` } });
  if (r.response.status !== 200) throw new Error(`Authorized job polling failed: HTTP ${r.response.status}`);
  if (r.body.status === 'completed') { completed = r.body; break; }
  if (r.body.status === 'failed' || r.body.status === 'cancelled') throw new Error(`Solver ended ${r.body.status}: ${JSON.stringify(r.body.error)}`);
  if (Date.now() > deadline) throw new Error('Timed out waiting for production solver completion.');
  await new Promise(r => setTimeout(r, 1000));
}
console.log('PASS solver completion');

const result = completed.result || {};
const artifactId = Array.isArray(result.traceObjectIds) ? result.traceObjectIds[0] : (Array.isArray(result.waveObjectIds) ? result.waveObjectIds[0] : null);
if (artifactId) {
  const artifact = await request(`/api/storage?id=${encodeURIComponent(artifactId)}`, { headers: { authorization: `Bearer ${capabilityToken}` } });
  if (!artifact.response.ok) throw new Error(`Owned artifact retrieval failed: HTTP ${artifact.response.status}`);
  const foreign = await request(`/api/storage?id=${encodeURIComponent(artifactId)}`, { headers: { authorization: 'Bearer wrong-token' } });
  if (foreign.response.status !== 403) throw new Error(`Foreign artifact access expected 403, got ${foreign.response.status}`);
  console.log('PASS artifact authorization and retrieval');
} else {
  console.log('WARN completed simulation exposed no artifact ID; report authorization is still tested below.');
}

const report = await request('/api/report/export', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${capabilityToken}` },
  body: JSON.stringify({ simulationId: completed.simulationId }),
});
if (!report.response.ok || report.response.headers.get('content-type')?.includes('application/pdf') !== true) {
  throw new Error(`Report export failed: HTTP ${report.response.status}`);
}
console.log('PASS authorized report export');

const reportWrong = await request('/api/report/export', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
  body: JSON.stringify({ simulationId: completed.simulationId }),
});
if (reportWrong.response.status !== 403) throw new Error(`Wrong-token report expected 403, got ${reportWrong.response.status}`);
console.log('PASS report capability authorization');

if (process.env.SMOKE_RUN_CLEANUP === 'true') {
  const secret = process.env.CLEANUP_SECRET;
  if (!secret) throw new Error('CLEANUP_SECRET is required when SMOKE_RUN_CLEANUP=true');
  const cleanup = await request('/api/internal/cleanup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cleanup-secret': secret },
    body: JSON.stringify({ simulationId: completed.simulationId }),
  });
  if (!cleanup.response.ok || cleanup.body?.simulationsDeleted !== 1) throw new Error(`Cleanup smoke failed: HTTP ${cleanup.response.status} ${JSON.stringify(cleanup.body)}`);
  const after = await request(`/api/jobs/${jobId}`, { headers: { authorization: `Bearer ${capabilityToken}` } });
  if (after.response.status !== 403) throw new Error(`Deleted job should be inaccessible, got ${after.response.status}`);
  if (artifactId) {
    const afterArtifact = await request(`/api/storage?id=${encodeURIComponent(artifactId)}`, { headers: { authorization: `Bearer ${capabilityToken}` } });
    if (afterArtifact.response.status !== 403) throw new Error(`Deleted artifact should be inaccessible, got ${afterArtifact.response.status}`);
  }
  console.log('PASS production cleanup and post-cleanup authorization');
}

console.log('Production end-to-end smoke checks passed.');
