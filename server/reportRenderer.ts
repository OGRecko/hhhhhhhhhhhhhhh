/**
 * Production PDF renderer. Kept separate from api.ts so the API (and its
 * tests) never need PDFKit: the renderer is an injected dependency, and this
 * is the one that wraps the real generator.
 */
import { generateProjectReport } from './reportGenerator';
import { LIMITS } from '../src/lib/publicLimits';
import type { ReportBuildInput } from './reportInput';

/** `signal` aborts rendering (e.g. the client disconnected); the renderer must stop and reject promptly. */
export type ReportRenderer = (input: ReportBuildInput, signal?: AbortSignal) => Promise<Buffer>;
export class ReportAbortedError extends Error { constructor() { super('Report rendering aborted'); this.name = 'ReportAbortedError'; } }

export class ReportTooLargeError extends Error { constructor() { super('Report exceeds size limit'); this.name = 'ReportTooLargeError'; } }
export class ReportTimeoutError extends Error { constructor() { super('Report rendering timed out'); this.name = 'ReportTimeoutError'; } }

const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export const pdfReportRenderer: ReportRenderer = (input, signal) => new Promise<Buffer>((resolve, reject) => {
  if (signal?.aborted) return reject(new ReportAbortedError());
  let doc: PDFKit.PDFDocument;
  try {
    doc = generateProjectReport({
      projectName: input.projectName,
      roomName: input.roomName,
      room: input.room as any,
      speakers: input.speakers.map((s) => ({
        brand: str(s.brand, 'Speaker'), model: str(s.model, ''), x: num(s.x, 0), y: num(s.y, 0),
      })),
      receivers: input.receivers.map((r, i) => ({ name: str(r.name, `Receiver ${i + 1}`), x: num(r.x, 0), y: num(r.y, 0) })),
      solverResult: input.solverResult as any,
      assumedSnrDb: input.assumedSnrDb,
      simulationId: input.simulationId,
    });
  } catch (e) { return reject(e); }

  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;
  const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(); };
  const timer = setTimeout(() => { done(() => { try { (doc as any).destroy?.(); } catch { /* destroy() on an already-ended PDF stream may throw; the job outcome is reported via reject() right after, so nothing is lost by ignoring this */ } reject(new ReportTimeoutError()); }); }, LIMITS.REPORT_TIMEOUT_MS);
  (timer as any).unref?.();
  const onAbort = () => done(() => { try { (doc as any).destroy?.(); } catch { /* destroy() on an already-ended PDF stream may throw; the job outcome is reported via reject() right after, so nothing is lost by ignoring this */ } reject(new ReportAbortedError()); });
  signal?.addEventListener('abort', onAbort, { once: true });

  doc.on('data', (c: Buffer) => {
    total += c.length;
    if (total > LIMITS.MAX_REPORT_BYTES) { done(() => { try { (doc as any).destroy?.(); } catch { /* destroy() on an already-ended PDF stream may throw; the job outcome is reported via reject() right after, so nothing is lost by ignoring this */ } reject(new ReportTooLargeError()); }); return; }
    chunks.push(c);
  });
  doc.on('end', () => done(() => resolve(Buffer.concat(chunks))));
  doc.on('error', (e: Error) => done(() => reject(e)));
  // generateProjectReport deliberately does not end the document; ending is the caller's job, exactly once.
  doc.end();
});
