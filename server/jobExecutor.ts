/**
 * Executes ONE durable job under a lease.
 *
 *   claim (transaction)  ->  heartbeat while running  ->  run solver
 *   -> persist artifacts -> fenced complete (transaction)
 *
 * Ownership is verified before completion by the transaction itself
 * (JobStore.complete checks owner+epoch+state). If the lease is lost at any
 * point the worker aborts, deletes anything it wrote, and reports `lost`.
 */
import { JobStore, PUBLIC_ERROR_CODES, type JobRecord, type Lease, type PublicErrorCode } from './jobStore';
import type { ArtifactStore } from './storage';
import { receiverObjectId } from './storage';
import { LIMITS } from '../src/lib/publicLimits';
import type { Metrics } from './observability';

export interface SolverOutput {
  /** Non-artifact result fields safe to return to the capability holder. */
  result: Record<string, unknown>;
  /** Per-receiver Float32 traces to persist as artifacts (index = receiver index). */
  traces: Array<Float32Array | null>;
  /** Wavefield frames already persisted by the runner through `putArtifact`. */
  waveObjectIds: string[];
}

export interface SolverRunArgs {
  type: JobRecord['type'];
  payload: Record<string, unknown>;
  simulationId: string;
  signal: AbortSignal;
  /** Persist a wavefield frame as an artifact; enforces per-simulation byte/frame budgets. */
  putWaveFrame: (index: number, frame: Float32Array) => Promise<string>;
}

export type SolverRunner = (args: SolverRunArgs) => Promise<SolverOutput>;

export class SolverError extends Error {
  constructor(public readonly code: PublicErrorCode, internalDetail?: string) {
    super(internalDetail ?? code);
    this.name = 'SolverError';
  }
}

export type ExecutionOutcome =
  | { status: 'completed' }
  | { status: 'failed'; code: PublicErrorCode }
  | { status: 'cancelled' }
  | { status: 'backed_off'; reason: string }
  | { status: 'lost' };

export interface ExecutorDeps {
  store: JobStore;
  artifacts: ArtifactStore;
  runSolver: SolverRunner;
  metrics: Pick<Metrics, 'inc'>;
  workerId: string;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  /** Overridable for tests. */
  timeoutMs?: number;
  heartbeatMs?: number;
  /** Called after each successful heartbeat so admission slots can be kept alive. */
  onHeartbeat?: (rec: JobRecord) => Promise<void>;
  /** Called exactly once, after a job THIS worker claimed reaches an outcome (never after a back-off). */
  onFinished?: (rec: JobRecord) => Promise<void>;
  /** Lets the dispatcher abort a job it is running locally (fast-path cancellation). */
  registerAbort?: (simulationId: string, controller: AbortController) => void;
  unregisterAbort?: (simulationId: string) => void;
}

export async function executeJob(deps: ExecutorDeps, simulationId: string): Promise<ExecutionOutcome> {
  const { store, artifacts, metrics } = deps;
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.timeoutMs ?? LIMITS.SOLVER_TIMEOUT_MS;
  const heartbeatMs = deps.heartbeatMs ?? LIMITS.JOB_HEARTBEAT_MS;

  const claim = await store.claim(simulationId, deps.workerId);
  if ('reason' in claim) {
    log('job_claim_rejected', { reason: claim.reason });
    return { status: 'backed_off', reason: claim.reason };
  }
  const lease: Lease = claim.lease;
  const rec = claim.record;
  const controller = new AbortController();
  deps.registerAbort?.(simulationId, controller);
  let leaseLost = false;
  let timedOut = false;
  const written = new Set<string>();
  let waveBytes = 0;

  const hb = setInterval(() => {
    store.heartbeat(simulationId, lease).then((ok) => {
      if (!ok && !leaseLost) { leaseLost = true; controller.abort(); return; }
      if (ok) return deps.onHeartbeat?.(rec);
    }).catch(() => { /* transient: the next beat or the completion fence decides */ });
  }, heartbeatMs);
  (hb as any).unref?.();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  (timer as any).unref?.();

  const cleanupWritten = async () => {
    // Object IDs are deterministic per simulation. Deleting by simulation
    // prefix also removes any frame that was successfully uploaded after the
    // last local `written` snapshot was taken. Terminal cleanup is safe because
    // no future legitimate worker may own a terminal job.
    await artifacts.deleteAllForSimulation(simulationId).catch(async () => {
      await Promise.all([...written].map((id) => artifacts.delete(id).catch(() => { /* best-effort per-object delete; the storage lifecycle rule removes anything left behind */ })));
    });
  };

  /**
   * Delete our objects only if nothing else can own them: never when the job is
   * (or may have been) COMPLETED by another worker, whose record references the
   * same deterministic object IDs.
   */
  const cleanupUnlessCompleted = async () => {
    const cur = await store.get(simulationId).catch(() => null);
    if (!cur || cur.status === 'completed') return;
    await cleanupWritten();
  };

  /** Every storage failure becomes the fixed public `storage_failed` code; raw SDK text never propagates. */
  const putArtifact = async (id: string, data: Buffer): Promise<void> => {
    // Recorded BEFORE the write so a partially-written object is still cleaned up on failure.
    written.add(id);
    try { await artifacts.put(id, data); }
    catch (e) {
      if (e instanceof SolverError) throw e;
      throw new SolverError(PUBLIC_ERROR_CODES.storage_failed, 'artifact write failed');
    }
  };

  const putWaveFrame = async (index: number, frame: Float32Array): Promise<string> => {
    if (leaseLost || controller.signal.aborted) throw new SolverError(PUBLIC_ERROR_CODES.lost_lease);
    if (index >= LIMITS.MAX_WAVEFIELD_FRAMES) throw new SolverError(PUBLIC_ERROR_CODES.resource_limit, 'too many wavefield frames');
    waveBytes += frame.byteLength;
    if (waveBytes > LIMITS.MAX_ARTIFACT_BYTES) throw new SolverError(PUBLIC_ERROR_CODES.resource_limit, 'wavefield bytes exceeded');
    const id = `${simulationId}_wave_${index}.bin`;
    await putArtifact(id, Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
    return id;
  };

  try {
    metrics.inc('simulations_started');
    const out = await deps.runSolver({
      type: rec.type,
      payload: (rec.jobPayload ?? {}) as Record<string, unknown>,
      simulationId,
      signal: controller.signal,
      putWaveFrame,
    });

    if (leaseLost) throw new SolverError(PUBLIC_ERROR_CODES.lost_lease);
    if (timedOut) throw new SolverError(PUBLIC_ERROR_CODES.timeout);
    if (controller.signal.aborted) throw new SolverError(PUBLIC_ERROR_CODES.cancelled);

    // Persist per-receiver traces, enforcing the total artifact byte budget.
    let totalBytes = waveBytes;
    const receiverIds: string[] = [];
    for (let i = 0; i < out.traces.length; i++) {
      const t = out.traces[i];
      if (!t || t.length === 0) { receiverIds.push(''); continue; }
      totalBytes += t.byteLength;
      if (totalBytes > LIMITS.MAX_ARTIFACT_BYTES) throw new SolverError(PUBLIC_ERROR_CODES.resource_limit, 'artifact budget exceeded');
      const id = receiverObjectId(simulationId, i);
      await putArtifact(id, Buffer.from(t.buffer, t.byteOffset, t.byteLength));
      receiverIds.push(id);
    }

    // Final ownership + state fence happens INSIDE the completion transaction.
    const result = { ...out.result, traceObjectIds: receiverIds, waveObjectIds: out.waveObjectIds };
    // Firestore documents are capped at 1 MiB; refuse to store anything close to that.
    if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.MAX_RESULT_DOC_BYTES) {
      throw new SolverError(PUBLIC_ERROR_CODES.resource_limit, 'result document too large');
    }
    const done = await store.complete(simulationId, lease, {
      result,
      artifacts: [...written],
      room: rec.room ?? extractRoom(rec),
      speakers: rec.speakers ?? [],
      receivers: rec.receivers ?? [],
    });
    if ('reason' in done) {
      log('job_completion_refused', { reason: done.reason });
      // Object IDs are deterministic per simulation. Only delete what we wrote
      // when no other worker can own the same IDs (the job is terminal). A
      // fenced-out zombie must NOT delete: a new lease holder may be writing them.
      if (done.reason === 'terminal' || done.reason === 'invalid_state') { await cleanupUnlessCompleted(); return { status: 'cancelled' }; }
      return { status: 'lost' };
    }
    metrics.inc('simulations_completed');
    return { status: 'completed' };
  } catch (err: any) {
    if (leaseLost) {
      // Lease loss is either a client cancel (state became `cancelled`) or a genuine takeover.
      const cur = await store.get(simulationId).catch(() => null);
      // (The cancel API already counted this cancellation exactly once.)
      if (cur?.status === 'cancelled') { await cleanupUnlessCompleted(); return { status: 'cancelled' }; }
      return { status: 'lost' }; // takeover: leave the shared object IDs alone
    }
    const code: PublicErrorCode =
      err instanceof SolverError ? err.code
      : timedOut ? PUBLIC_ERROR_CODES.timeout
      : controller.signal.aborted ? PUBLIC_ERROR_CODES.cancelled
      : PUBLIC_ERROR_CODES.solver_failed;
    if (timedOut || code === PUBLIC_ERROR_CODES.timeout) metrics.inc('worker_timeouts');
    if (code === PUBLIC_ERROR_CODES.storage_failed) metrics.inc('storage_failures');
    if (code === PUBLIC_ERROR_CODES.resource_limit) metrics.inc('resource_limit_rejections');
    const failed = await store.fail(simulationId, lease, code);
    if ('reason' in failed) {
      // Most likely already cancelled; never overwrite a terminal state.
      if (failed.reason === 'terminal') { await cleanupUnlessCompleted(); return { status: 'cancelled' }; }
      return { status: 'lost' };
    }
    await cleanupWritten();
    metrics.inc(code === PUBLIC_ERROR_CODES.cancelled ? 'simulations_cancelled' : 'simulations_failed');
    log('job_failed', { code });
    return { status: 'failed', code };
  } finally {
    clearInterval(hb);
    clearTimeout(timer);
    deps.unregisterAbort?.(simulationId);
    await deps.onFinished?.(rec).catch(() => { /* onFinished is an observer hook; its failure must not change the job's already-recorded outcome */ });
  }
}

function extractRoom(rec: JobRecord): unknown {
  const p = (rec.jobPayload ?? {}) as any;
  return { L: p.L, W: p.W, H: p.H, poly: p.poly, wallMaterial: p.wallMaterial, wallSegMats: p.wallSegMats, wallOpenings: p.wallOpenings, floorMaterial: p.floorMaterial, ceilMaterial: p.ceilMaterial };
}
