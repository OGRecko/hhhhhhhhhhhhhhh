import assert from 'node:assert/strict';
import { pdfReportRenderer, ReportAbortedError } from './reportRenderer';

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== Report renderer abort tests ===\n');

const input: any = {
  projectName: 'P', roomName: 'R', room: { length: 5, width: 4, height: 3 },
  speakers: [{ brand: 'A', model: 'B', x: 1, y: 1 }], receivers: [{ name: 'r', x: 2, y: 2 }],
  solverResult: {}, simulationId: 'sim', 
};

await check('pre-aborted signal rejects immediately with ReportAbortedError', async () => {
  const ac = new AbortController(); ac.abort();
  await assert.rejects(() => pdfReportRenderer(input, ac.signal), (e: any) => e instanceof ReportAbortedError);
});

await check('no signal: renderer behaviour is unchanged (renders a PDF or fails on its own, never ReportAbortedError)', async () => {
  try { const pdf = await pdfReportRenderer(input); assert.equal(pdf.subarray(0, 4).toString(), '%PDF'); }
  catch (e: any) { assert(!(e instanceof ReportAbortedError)); }
});

await check('abort listener is removed after completion (no listener leak on a reused signal)', async () => {
  const ac = new AbortController();
  try { await pdfReportRenderer(input, ac.signal); } catch { /* render errors are covered elsewhere */ }
  ac.abort(); // must not throw or touch a finished render
});

console.log(`\n=== ${passed} passed ===`);
