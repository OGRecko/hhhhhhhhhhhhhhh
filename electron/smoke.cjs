// Self-test used by `Cavity Audio.exe --smoke-test` (CI on Windows) and by scripts/desktop-smoke.mjs (any OS).
// Everything here talks to the real HTTP server over loopback; nothing is mocked.
const fs = require('node:fs');
const path = require('node:path');

async function runSmoke(base, { stateFile, timeoutMs = 120000, log = console.log } = {}) {
  const steps = [];
  const pass = (name, extra) => { steps.push({ name, ok: true, ...(extra || {}) }); log(`PASS ${name}`); };
  const req = async (p, o = {}) => {
    const r = await fetch(base + p, o);
    const t = await r.text();
    let body; try { body = JSON.parse(t); } catch { body = t; }
    return { r, body, text: t };
  };

  const health = await req('/api/health');
  if (!health.r.ok || health.body?.status !== 'ok') throw new Error(`health failed: HTTP ${health.r.status}`);
  pass('health');

  const app = await req('/app');
  if (!app.r.ok || !/<div id="root"|<script/i.test(app.text)) throw new Error(`/app did not return the client: HTTP ${app.r.status}`);
  pass('/app serves client');

  // Persistence across launches: a job recorded by a previous launch must still be readable.
  if (stateFile && fs.existsSync(stateFile)) {
    const prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const p = await req(`/api/jobs/${prev.jobId}`, { headers: { authorization: `Bearer ${prev.token}` } });
    if (p.r.status !== 200 || p.body.status !== 'completed') throw new Error(`previous launch's job not persisted: HTTP ${p.r.status} ${JSON.stringify(p.body).slice(0, 200)}`);
    pass('job from previous launch persisted', { jobId: prev.jobId });
  }

  const payload = { L: 4, W: 4, H: 3, steps: 40, sources: [{ x: 0.5, y: 0.5, z: 1.5 }], receivers: [{ x: 0.5, y: 0.5, z: 1.5 }] };
  const run = await req('/api/solver/impulse-response', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (run.r.status !== 202 || !run.body?.jobId || !run.body?.capabilityToken) throw new Error(`solver submit failed: HTTP ${run.r.status} ${JSON.stringify(run.body).slice(0, 200)}`);
  const { jobId, capabilityToken } = run.body;
  pass('solver job accepted', { jobId });

  const deadline = Date.now() + timeoutMs;
  let done;
  for (;;) {
    const j = await req(`/api/jobs/${jobId}`, { headers: { authorization: `Bearer ${capabilityToken}` } });
    if (j.r.status !== 200) throw new Error(`job poll failed: HTTP ${j.r.status}`);
    if (j.body.status === 'completed') { done = j.body; break; }
    if (j.body.status === 'failed' || j.body.status === 'cancelled') throw new Error(`solver ended ${j.body.status}: ${JSON.stringify(j.body.error)}`);
    if (Date.now() > deadline) throw new Error('timed out waiting for solver');
    await new Promise((r) => setTimeout(r, 500));
  }
  pass('solver job completed');

  const result = done.result || {};
  const artifactId = Array.isArray(result.traceObjectIds) ? result.traceObjectIds[0] : (Array.isArray(result.waveObjectIds) ? result.waveObjectIds[0] : null);
  if (artifactId) {
    const a = await fetch(`${base}/api/storage?id=${encodeURIComponent(artifactId)}`, { headers: { authorization: `Bearer ${capabilityToken}` } });
    const bytes = (await a.arrayBuffer()).byteLength;
    if (!a.ok || bytes === 0) throw new Error(`artifact fetch failed: HTTP ${a.status}, ${bytes} bytes`);
    pass('artifact stored and readable', { bytes });
  } else {
    steps.push({ name: 'artifact', ok: true, note: 'completed job exposed no artifact id' });
  }

  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ jobId, token: capabilityToken }));
  return steps;
}

module.exports = { runSmoke };
