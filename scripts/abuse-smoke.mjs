const appUrl = process.env.APP_URL?.replace(/\/$/, '');
if (!appUrl) throw new Error('APP_URL is required');
const concurrency = Math.max(1, Math.min(Number(process.env.ABUSE_CONCURRENCY || 50), 250));
const body = JSON.stringify({ L: 0, W: 5, H: 3, steps: 1, sources: [{x:.5,y:.5,z:1}], receivers: [{x:.5,y:.5,z:1}] });
const results = await Promise.all(Array.from({ length: concurrency }, async () => {
  const r = await fetch(`${appUrl}/api/solver/wave`, { method: 'POST', headers: {'content-type':'application/json'}, body });
  return r.status;
}));
if (!results.every(s => s === 400 || s === 429)) throw new Error(`Unexpected abuse responses: ${results.join(',')}`);
const oversized = 'x'.repeat(70 * 1024);
const r = await fetch(`${appUrl}/api/solver/wave`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ data: oversized }) });
if (![400,413].includes(r.status)) throw new Error(`Expected oversized request rejection, got ${r.status}`);
console.log(`PASS abuse smoke: ${concurrency} invalid requests safely rejected`);
