/**
 * Production SolverRunner: runs the numerical solver in a worker_thread.
 *
 * Hardened relative to the previous inline runner:
 *  - wavefield frames are counted and byte-budgeted BEFORE being stored
 *  - message handling is fully try/caught (no unhandled rejections)
 *  - abort/timeout terminate the thread immediately
 *  - worker error TEXT is never propagated; only a fixed public code is
 *  - malformed / oversized worker messages are rejected
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { SolverError, type SolverRunArgs, type SolverOutput } from './jobExecutor';
import { PUBLIC_ERROR_CODES, type PublicErrorCode } from './jobStore';
import { LIMITS } from '../src/lib/publicLimits';

export interface WorkerRunnerOptions {
  /** Absolute path to the worker entry; defaults from NODE_ENV. */
  workerPath?: string;
  execArgv?: string[];
  timeoutMs?: number;
}

/** Map a worker's internal error text to a fixed public code. Text itself is discarded. */
export function classifyWorkerError(message: unknown): PublicErrorCode {
  const m = String(message ?? '');
  if (/memory budget|exceeds available system memory|server safety limit|safety limit|artifact-size|too many|limited to|exceed public limits|grid exceeds/i.test(m)) return PUBLIC_ERROR_CODES.resource_limit;
  if (/invalid|must be|outside|refus|unstable|courant|non-finite|is required/i.test(m)) return PUBLIC_ERROR_CODES.invalid_input;
  return PUBLIC_ERROR_CODES.solver_failed;
}

/**
 * Translate the stored, validated request into the shape the numerical solver
 * expects. A wavefield run takes ONE `source`; an impulse response takes
 * `sources`. Only validated fields ever reach the worker.
 */
export function toWorkerPayload(type: 'wave' | 'impulse-response', payload: Record<string, unknown>, simulationId: string): Record<string, unknown> {
  const p: Record<string, unknown> = { ...payload, simulationId };
  if (type === 'wave' && Array.isArray(p.sources)) p.source = p.sources[0];
  return p;
}

export function defaultWorkerPath(): { workerPath: string; execArgv?: string[] } {
  // Desktop and production both run the bundled worker; only plain dev uses tsx on the TS source.
  // CAVITY_APP_ROOT is set by the desktop shell so the path never depends on process.cwd().
  const prod = process.env.NODE_ENV === 'production' || process.env.CAVITY_DESKTOP === '1';
  const root = process.env.CAVITY_APP_ROOT || process.cwd();
  return prod
    ? { workerPath: path.join(root, 'dist', 'solverWorker.cjs') }
    : { workerPath: path.join(process.cwd(), 'server', 'solverWorker.ts'), execArgv: ['--import', 'tsx'] };
}

export function createWorkerRunner(opts: WorkerRunnerOptions = {}) {
  return function runSolverInWorker(args: SolverRunArgs): Promise<SolverOutput> {
    const def = defaultWorkerPath();
    const workerPath = opts.workerPath ?? def.workerPath;
    const execArgv = opts.execArgv ?? def.execArgv;
    const timeoutMs = opts.timeoutMs ?? LIMITS.SOLVER_TIMEOUT_MS;

    return new Promise<SolverOutput>((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: { type: args.type, payload: toWorkerPayload(args.type, args.payload, args.simulationId) },
        ...(execArgv ? { execArgv } : {}),
        resourceLimits: { maxOldGenerationSizeMb: 1536 },
      });

      let settled = false;
      let aborting = false;
      let gotResult = false; // the worker legitimately exits right after posting its result
      let frameCount = 0;
      let expectedFrames = 0;
      const pendingWrites: Promise<void>[] = [];
      const waveIds: string[] = [];
      let writeError: SolverError | Error | null = null;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        args.signal.removeEventListener('abort', onAbort);
        worker.terminate().catch(() => { /* worker already exited; terminate() rejecting here is expected and harmless */ });
        fn();
      };
      const abortWithReason = (reason: PublicErrorCode) => {
        if (aborting || settled) return;
        aborting = true;
        void worker.terminate().catch(() => { /* worker already exited; terminate() rejecting here is expected and harmless */ });
        // Wavefield uploads are asynchronous. Rejecting immediately used to
        // let jobExecutor delete the recorded objects while an in-flight save
        // could still finish afterward, recreating an orphaned artifact.
        // Stop the worker first, then drain already-started writes before the
        // executor gets control and performs terminal cleanup.
        void Promise.race([
          Promise.allSettled(pendingWrites),
          new Promise<void>(resolve => setTimeout(resolve, 5000)),
        ]).finally(() => finish(() => reject(new SolverError(reason))));
      };
      const onAbort = () => {
        const reason = args.signal.reason;
        abortWithReason(reason === PUBLIC_ERROR_CODES.timeout ? PUBLIC_ERROR_CODES.timeout : PUBLIC_ERROR_CODES.cancelled);
      };
      const timer = setTimeout(() => { abortWithReason(PUBLIC_ERROR_CODES.timeout); }, timeoutMs);
      timer.unref?.(); // don't keep the process alive just for this timeout
      if (args.signal.aborted) { onAbort(); return; }
      args.signal.addEventListener('abort', onAbort, { once: true });

      worker.on('message', (msg: WorkerMessage | null | undefined) => {
        // Never let a handler exception escape as an unhandled rejection.
        try {
          if (settled || !msg || typeof msg !== 'object') return;

          if (msg.type === 'wavefield_frame') {
            const frame = msg.frame;
            if (!(frame instanceof Float32Array)) { throw new SolverError(PUBLIC_ERROR_CODES.solver_failed, 'bad frame'); }
            const index = frameCount++;
            if (index >= LIMITS.MAX_WAVEFIELD_FRAMES) { finish(() => reject(new SolverError(PUBLIC_ERROR_CODES.resource_limit))); return; }
            pendingWrites.push(
              args.putWaveFrame(index, frame).then((id) => { waveIds[index] = id; }).catch((e) => { writeError = e; }),
            );
            return;
          }
          if (msg.type === 'expected_frames') {
            const n = Number(msg.count);
            if (!Number.isInteger(n) || n < 0 || n > LIMITS.MAX_WAVEFIELD_FRAMES) { finish(() => reject(new SolverError(PUBLIC_ERROR_CODES.resource_limit))); return; }
            expectedFrames = n;
            return;
          }
          if (typeof msg.success !== 'boolean') return;

          if (!msg.success) {
            finish(() => reject(new SolverError(classifyWorkerError(msg.error), String(msg.error).slice(0, 300))));
            return;
          }
          gotResult = true;
          if (!msg.data || typeof msg.data !== 'object') { finish(() => reject(new SolverError(PUBLIC_ERROR_CODES.solver_failed))); return; }
          const data = msg.data as WorkerSolverData;

          Promise.all(pendingWrites).then(() => {
            if (writeError) {
              const code = writeError instanceof SolverError ? writeError.code : PUBLIC_ERROR_CODES.storage_failed;
              return finish(() => reject(new SolverError(code)));
            }
            if (data.wavefield && expectedFrames > 0 && waveIds.filter(Boolean).length !== expectedFrames) {
              return finish(() => reject(new SolverError(PUBLIC_ERROR_CODES.storage_failed, 'frame count mismatch')));
            }
            const result = buildPublicResult(args.type, data, waveIds.filter(Boolean).length);
            const traces = extractTraces(args.type, data);
            finish(() => resolve({ result, traces, waveObjectIds: waveIds.filter(Boolean) }));
          }).catch((e) => finish(() => reject(e)));
        } catch (e) {
          finish(() => reject(e instanceof SolverError ? e : new SolverError(PUBLIC_ERROR_CODES.solver_failed)));
        }
      });

      worker.on('error', () => finish(() => reject(new SolverError(PUBLIC_ERROR_CODES.solver_failed))));
      // While aborting, terminate() itself triggers 'exit'. The abort path owns settlement (it drains in-flight frame
      // writes, then rejects with the true reason: cancelled/timeout), so an exit during abort must not pre-empt it.
      worker.on('exit', (code) => { if (gotResult || aborting) return; finish(() => reject(new SolverError(PUBLIC_ERROR_CODES.solver_failed, `worker exited ${code}`))); });
    });
  };
}

/** A message posted by the solver worker thread. Shape is checked at runtime before any field is trusted. */
interface WorkerMessage { type?: string; frame?: unknown; count?: unknown; success?: unknown; error?: unknown; data?: unknown }

/** The parts of a worker result that this module reads; everything else is passed through untouched. */
interface WorkerSolverData {
  wavefield?: { outNx: number; outNz: number; dt: number } | null;
  receivers?: Array<Record<string, unknown> | null>;
  receiverTraces?: unknown[];
  [key: string]: unknown;
}

/**
 * Bulky per-sample data never goes into the Firestore result document: traces
 * are persisted as artifacts and referenced by ID. This is the ONLY place that
 * decides what a stored result may contain.
 */
const STRIPPED_TOP_LEVEL = new Set(['receiverTrace', 'receiverTraces', 'wavefield', 'receivers']);

export function buildPublicResult(type: 'wave' | 'impulse-response', data: WorkerSolverData | null | undefined, frameCount: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data ?? {})) if (!STRIPPED_TOP_LEVEL.has(k)) result[k] = v;
  result.receivers = (Array.isArray(data?.receivers) ? data.receivers : []).map((r: Record<string, unknown> | null) => {
    const { trace, ...others } = r || {};
    return others;
  });
  if (data?.wavefield) {
    result.wavefield = { outNx: data.wavefield.outNx, outNz: data.wavefield.outNz, dt: data.wavefield.dt, frameCount };
  }
  return result;
}

/** Per-receiver Float32 traces. A wavefield run reports them as `receiverTraces`; an IR run as `receivers[i].trace`. */
export function extractTraces(type: 'wave' | 'impulse-response', data: WorkerSolverData | null | undefined): Array<Float32Array | null> {
  const toF32 = (a: unknown) => (Array.isArray(a) || ArrayBuffer.isView(a)) && (a as ArrayLike<number>).length > 0 ? new Float32Array(a as ArrayLike<number>) : null;
  if (type === 'wave') return (Array.isArray(data?.receiverTraces) ? data.receiverTraces : []).map(toF32);
  return (Array.isArray(data?.receivers) ? data.receivers : []).map((r: { trace?: unknown } | null) => toF32(r?.trace));
}
