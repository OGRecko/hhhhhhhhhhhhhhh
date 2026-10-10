/**
 * Per-instance job dispatcher.
 *
 * This is a LOCAL run queue only. It holds no authority: Firestore is the
 * source of truth and every run begins with a transactional claim
 * (executeJob -> JobStore.claim), so two instances that both try to run the
 * same job cannot both succeed. What this module adds is *liveness*:
 *
 *   enqueue(id)     the creating instance runs its own job immediately
 *   sweepOnce()     any instance, on a timer, discovers work nobody is doing:
 *                     - `running` jobs whose lease expired (crashed worker)
 *                       -> JobStore.recover (bumps the epoch, fences the old holder)
 *                     - `queued` jobs older than a short grace (creator died before running)
 *                       -> local queue, claim decides the winner
 *                     - `queued` jobs past MAX_QUEUED_AGE_MS -> failed
 *
 * The number of jobs one instance runs at once is capped by `maxConcurrent`.
 */
import { LIMITS } from '../src/lib/publicLimits';
import { executeJob, type ExecutorDeps } from './jobExecutor';
import type { JobRecord, JobStore } from './jobStore';

export interface DispatcherDeps {
  store: JobStore;
  /** Executor dependencies minus the hooks the dispatcher supplies itself. */
  executor: Omit<ExecutorDeps, 'registerAbort' | 'unregisterAbort'>;
  maxConcurrent?: number;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Releases the admission slot for a job that ended without ever running (expired/recovery-exhausted). */
  onJobEndedWithoutRun?: (rec: JobRecord) => Promise<void>;
}

export class Dispatcher {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly running = new Set<string>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly waiters: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping: Promise<void> | null = null;
  private stopped = false;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;

  constructor(private readonly deps: DispatcherDeps) {
    this.maxConcurrent = deps.maxConcurrent ?? LIMITS.MAX_CONCURRENT_SOLVER_JOBS;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  /** Queue a job for local execution. Returns false if it was already queued/running here or the queue is full. */
  enqueue(simulationId: string): boolean {
    if (this.stopped) return false;
    if (this.queued.has(simulationId) || this.running.has(simulationId)) return false;
    // A full queue drops the id; the sweep rediscovers it from Firestore, so nothing is lost.
    if (this.queue.length >= LIMITS.MAX_LOCAL_QUEUE) return false;
    this.queue.push(simulationId);
    this.queued.add(simulationId);
    queueMicrotask(() => this.pump());
    return true;
  }

  /** Fast-path cancellation for a job this instance holds; other instances notice via their heartbeat. */
  cancelLocal(simulationId: string): void {
    if (this.queued.delete(simulationId)) {
      const i = this.queue.indexOf(simulationId);
      if (i >= 0) this.queue.splice(i, 1);
    }
    this.aborts.get(simulationId)?.abort();
  }

  stats() { return { queued: this.queue.length, running: this.running.size }; }

  private pump(): void {
    while (!this.stopped && this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.queued.delete(id);
      this.running.add(id);
      executeJob({
        ...this.deps.executor,
        registerAbort: (sid, c) => { this.aborts.set(sid, c); },
        unregisterAbort: (sid) => { this.aborts.delete(sid); },
      }, id)
        .then((outcome) => this.log('job_finished', { simulationId: id, outcome: outcome.status }))
        .catch((e) => this.log('job_dispatch_error', { simulationId: id, error: String((e as Error)?.message ?? e).slice(0, 200) }))
        .finally(() => {
          this.running.delete(id);
          this.pump();
          if (this.idle()) this.waiters.splice(0).forEach((w) => w());
        });
    }
  }

  private idle(): boolean { return this.queue.length === 0 && this.running.size === 0; }

  /** Resolves once nothing is queued or running locally (used by tests and graceful shutdown). */
  whenIdle(): Promise<void> {
    if (this.idle()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * One pass over durable state. Safe to run on every instance concurrently:
   * every mutation it makes is a fenced Firestore transaction.
   */
  sweepOnce(): Promise<void> {
    // Never overlap two sweeps in one process.
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.doSweep().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  private async doSweep(): Promise<void> {
    const { store } = this.deps;
    await store.forEachActive(async (rec) => {
      try {
        const now = this.now();
        if (rec.status === 'running') {
          if (Number(rec.leaseUntil) > now) return; // a live holder owns it
          const outcome = await store.recover(rec.simulationId);
          if (outcome === 'recovered') { this.log('job_recovered', { simulationId: rec.simulationId }); this.enqueue(rec.simulationId); }
          else if (outcome === 'failed') await this.deps.onJobEndedWithoutRun?.(rec);
          return;
        }
        if (rec.status === 'queued') {
          if (await store.expireStaleQueued(rec.simulationId)) { await this.deps.onJobEndedWithoutRun?.(rec); return; }
          // Leave a just-created job to the instance that created it.
          if (now - Number(rec.updatedAt ?? rec.createdAt) < LIMITS.SWEEP_QUEUED_GRACE_MS) return;
          this.enqueue(rec.simulationId);
        }
      } catch (e) {
        this.log('sweep_item_error', { error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    });
  }

  start(intervalMs: number = LIMITS.SWEEP_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweepOnce().catch((e) => this.log('sweep_error', { error: String((e as Error)?.message ?? e).slice(0, 200) })); }, intervalMs);
    (this.timer as any).unref?.();
  }

  /**
   * Stop accepting new work. Jobs already running are NOT aborted (an abort
   * would be recorded as a failure); the caller waits on whenIdle() for a
   * bounded time, and anything still running when the process exits is
   * recovered by another instance once its lease expires.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
