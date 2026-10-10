/**
 * Durable, lease-fenced job store.
 *
 * DISTRIBUTED-SAFETY MODEL
 * ------------------------
 * Firestore is the single source of truth. Every mutation is a Firestore
 * transaction that re-reads the job document and validates BOTH the state
 * machine (jobStateMachine.ts) and lease ownership before writing.
 *
 *  - `claim`   queued -> running. Grants (leaseOwner, leaseEpoch). Exactly one
 *              caller can win: the loser's transaction re-reads a `running`
 *              document with a live lease and refuses.
 *  - `heartbeat` extends the lease, but only for the CURRENT (owner, epoch).
 *  - `complete` / `fail` require the current (owner, epoch). A worker whose
 *              lease expired and was recovered holds a stale epoch, so it can
 *              never overwrite the new holder's outcome ("fencing token").
 *  - `recover` running -> queued, legal ONLY when the lease has expired; it
 *              bumps the epoch so the old holder is fenced out immediately.
 *  - `cancel`  is legal from queued/running and wins over an in-flight
 *              completion because complete() re-checks the state.
 *
 * The store never sees a raw capability token, only its SHA-256 hash.
 */

import { assertTransition, isJobState, isTerminal, InvalidTransitionError, type JobState } from './jobStateMachine';
import { LIMITS } from '../src/lib/publicLimits';

/** The minimal Firestore surface this module needs (real Firestore satisfies it). */
export interface TxLike {
  get(ref: any): Promise<{ exists: boolean; data(): any }>;
  set(ref: any, data: any, opts?: { merge?: boolean }): any;
  update?(ref: any, data: any): any;
  delete(ref: any): any;
}
export interface FirestoreLike {
  collection(name: string): any;
  doc(path: string): any;
  runTransaction<T>(fn: (tx: TxLike) => Promise<T>): Promise<T>;
}

export interface JobRecord {
  simulationId: string;
  jobId: string;
  type: 'wave' | 'impulse-response';
  status: JobState;
  capabilityTokenHash: string;
  createdAt: number;
  updatedAt: number;
  /** Non-secret solver request, validated before it was persisted. */
  jobPayload?: Record<string, unknown>;
  leaseOwner: string | null;
  leaseEpoch: number;
  leaseUntil: number;
  recoveryAttempts: number;
  completedAt?: number;
  /** Set only by server code; always a fixed, non-sensitive public code. */
  errorCode?: string;
  /** Artifact object IDs this simulation legitimately owns. */
  artifacts?: string[];
  /** Admission slot held for this job (non-secret); released on every terminal path. */
  slotId?: string;
  room?: unknown;
  speakers?: unknown;
  receivers?: unknown;
  result?: unknown;
}

export interface Lease { owner: string; epoch: number }

export type ClaimOutcome =
  | { claimed: true; lease: Lease; record: JobRecord }
  | { claimed: false; reason: 'not_found' | 'not_claimable' | 'lease_held' | 'terminal' | 'expired_job' };

export type MutationOutcome = { ok: true } | { ok: false; reason: 'not_found' | 'lost_lease' | 'terminal' | 'invalid_state' };

/** Fixed, public failure codes. Raw error text is NEVER stored or returned. */
export const PUBLIC_ERROR_CODES = {
  cancelled: 'cancelled',
  invalid_input: 'invalid_input',
  resource_limit: 'resource_limit',
  timeout: 'timeout',
  solver_failed: 'solver_failed',
  storage_failed: 'storage_failed',
  expired: 'expired',
  recovery_exhausted: 'recovery_exhausted',
  lost_lease: 'lost_lease',
} as const;
export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[keyof typeof PUBLIC_ERROR_CODES];

export const PUBLIC_ERROR_MESSAGES: Record<PublicErrorCode, string> = {
  cancelled: 'The simulation was cancelled.',
  invalid_input: 'The simulation request was not valid.',
  resource_limit: 'The simulation exceeds the public resource limits.',
  timeout: 'The simulation took too long and was stopped.',
  solver_failed: 'The simulation failed.',
  storage_failed: 'The simulation result could not be stored.',
  expired: 'The simulation expired before it could run.',
  recovery_exhausted: 'The simulation could not be completed.',
  lost_lease: 'The simulation was interrupted.',
};

export interface JobStoreMetrics {
  inc(name: string, by?: number): void;
}


/**
 * Firestore rejects `undefined` field values (unless ignoreUndefinedProperties
 * is enabled), so every document we write goes through this to drop them.
 * Deliberately shallow-recursive over plain objects/arrays only.
 */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

const COLLECTION = 'simulations';

export class JobStore {
  constructor(
    private readonly db: FirestoreLike,
    private readonly now: () => number = Date.now,
    private readonly metrics: JobStoreMetrics = { inc() {} },
  ) {}

  private ref(simulationId: string) {
    return this.db.collection(COLLECTION).doc(simulationId);
  }

  /** Creates a queued job. Fails (returns false) if the simulation ID already exists (duplicate submission). */
  async createQueued(rec: Omit<JobRecord, 'status' | 'leaseOwner' | 'leaseEpoch' | 'leaseUntil' | 'recoveryAttempts' | 'updatedAt'>): Promise<boolean> {
    const ref = this.ref(rec.simulationId);
    const now = this.now();
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      const full: JobRecord = {
        ...rec,
        status: 'queued',
        leaseOwner: null,
        leaseEpoch: 0,
        leaseUntil: 0,
        recoveryAttempts: 0,
        updatedAt: now,
      };
      tx.set(ref, stripUndefined(full));
      return true;
    });
  }

  async get(simulationId: string): Promise<JobRecord | null> {
    const snap = await this.ref(simulationId).get();
    return snap.exists ? (snap.data() as JobRecord) : null;
  }

  /** Look up by jobId. jobId is unique per simulation; there is exactly one match. */
  async getByJobId(jobId: string): Promise<JobRecord | null> {
    const q = await this.db.collection(COLLECTION).where('jobId', '==', jobId).limit(1).get();
    return q.empty ? null : (q.docs[0].data() as JobRecord);
  }

  /**
   * Atomically claim a queued job for `owner`. Exactly one concurrent caller
   * succeeds; every other caller observes the winner's `running` state with a
   * live lease and backs off without executing anything.
   */
  async claim(simulationId: string, owner: string): Promise<ClaimOutcome> {
    const ref = this.ref(simulationId);
    const outcome = await this.db.runTransaction<ClaimOutcome>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { claimed: false, reason: 'not_found' };
      const cur = snap.data() as JobRecord;
      const now = this.now();
      if (!isJobState(cur.status)) return { claimed: false, reason: 'not_claimable' };
      if (isTerminal(cur.status)) return { claimed: false, reason: 'terminal' };
      if (cur.status === 'running') {
        // A running job is only re-claimable through recover(); claim() never steals a live lease.
        return { claimed: false, reason: 'lease_held' };
      }
      if (now - cur.createdAt > LIMITS.MAX_JOB_AGE_MS) {
        assertTransition(cur.status, 'failed', 'expire');
        tx.set(ref, this.terminalPatch(cur, 'failed', PUBLIC_ERROR_CODES.expired, now));
        return { claimed: false, reason: 'expired_job' };
      }
      assertTransition(cur.status, 'running', 'claim');
      const epoch = (cur.leaseEpoch ?? 0) + 1;
      const next: JobRecord = {
        ...cur,
        status: 'running',
        leaseOwner: owner,
        leaseEpoch: epoch,
        leaseUntil: now + LIMITS.JOB_LEASE_MS,
        updatedAt: now,
      };
      tx.set(ref, stripUndefined(next));
      return { claimed: true, lease: { owner, epoch }, record: next };
    });
    if ('reason' in outcome && outcome.reason === 'lease_held') this.metrics.inc('duplicate_claims_rejected');
    return outcome;
  }

  /** Extend the lease. Returns false when the caller no longer owns the job (it must stop working). */
  async heartbeat(simulationId: string, lease: Lease): Promise<boolean> {
    const ref = this.ref(simulationId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const cur = snap.data() as JobRecord;
      if (!this.holdsLease(cur, lease)) return false;
      const now = this.now();
      tx.set(ref, stripUndefined({ ...cur, leaseUntil: now + LIMITS.JOB_LEASE_MS, updatedAt: now }));
      return true;
    });
  }

  /** Read-only check used by workers between long steps. */
  async stillOwns(simulationId: string, lease: Lease): Promise<boolean> {
    const snap = await this.ref(simulationId).get();
    return snap.exists && this.holdsLease(snap.data() as JobRecord, lease);
  }

  /**
   * Complete the job. Requires the CURRENT lease AND state === running. A
   * cancelled/failed/completed job, or a fenced-out zombie worker, cannot be
   * flipped to completed.
   */
  async complete(
    simulationId: string,
    lease: Lease,
    output: { result: unknown; artifacts: string[]; room: unknown; speakers: unknown; receivers: unknown },
  ): Promise<MutationOutcome> {
    const ref = this.ref(simulationId);
    return this.db.runTransaction<MutationOutcome>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false, reason: 'not_found' };
      const cur = snap.data() as JobRecord;
      if (isJobState(cur.status) && isTerminal(cur.status)) return { ok: false, reason: 'terminal' };
      if (cur.status !== 'running') return { ok: false, reason: 'invalid_state' };
      if (!this.holdsLease(cur, lease)) return { ok: false, reason: 'lost_lease' };
      assertTransition(cur.status, 'completed', 'complete');
      const now = this.now();
      const { jobPayload: _drop, ...rest } = cur;
      tx.set(ref, stripUndefined({
        ...rest,
        status: 'completed',
        completedAt: now,
        updatedAt: now,
        leaseOwner: null,
        leaseUntil: 0,
        result: output.result,
        artifacts: output.artifacts,
        room: output.room,
        speakers: output.speakers,
        receivers: output.receivers,
      } as JobRecord));
      return { ok: true };
    });
  }

  /** Fail the job. Requires the CURRENT lease; never overwrites a terminal state. */
  async fail(simulationId: string, lease: Lease, code: PublicErrorCode): Promise<MutationOutcome> {
    const ref = this.ref(simulationId);
    return this.db.runTransaction<MutationOutcome>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false, reason: 'not_found' };
      const cur = snap.data() as JobRecord;
      if (isJobState(cur.status) && isTerminal(cur.status)) return { ok: false, reason: 'terminal' };
      if (cur.status !== 'running') return { ok: false, reason: 'invalid_state' };
      if (!this.holdsLease(cur, lease)) return { ok: false, reason: 'lost_lease' };
      assertTransition(cur.status, 'failed', 'fail');
      tx.set(ref, this.terminalPatch(cur, 'failed', code, this.now()));
      return { ok: true };
    });
  }

  /**
   * Cancel a queued or running job. Legal from both, never from a terminal
   * state. Does not require the lease (the capability holder is authorised by
   * the API layer), but the lease holder's later complete() will be refused.
   */
  async cancel(simulationId: string): Promise<{ ok: true; alreadyFinished: boolean; status: JobState } | { ok: false }> {
    const ref = this.ref(simulationId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false as const };
      const cur = snap.data() as JobRecord;
      if (isJobState(cur.status) && isTerminal(cur.status)) {
        return { ok: true as const, alreadyFinished: true, status: cur.status };
      }
      assertTransition(cur.status, 'cancelled', 'cancel');
      tx.set(ref, this.terminalPatch(cur, 'cancelled', PUBLIC_ERROR_CODES.cancelled, this.now()));
      return { ok: true as const, alreadyFinished: false, status: 'cancelled' as JobState };
    });
  }

  /**
   * Recover a job whose lease EXPIRED (crashed worker). running -> queued with
   * a bumped epoch so the old holder is fenced out. If the job has been
   * recovered too many times or is too old it is failed instead of looping.
   * A live lease, a terminal job, or a queued job is left untouched.
   */
  async recover(simulationId: string): Promise<'recovered' | 'failed' | 'skipped'> {
    const ref = this.ref(simulationId);
    const outcome = await this.db.runTransaction<'recovered' | 'failed' | 'skipped'>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return 'skipped';
      const cur = snap.data() as JobRecord;
      if (cur.status !== 'running') return 'skipped';
      const now = this.now();
      if (Number(cur.leaseUntil) > now) return 'skipped';
      if (now - cur.createdAt > LIMITS.MAX_JOB_AGE_MS) {
        assertTransition(cur.status, 'failed', 'expire');
        tx.set(ref, this.terminalPatch(cur, 'failed', PUBLIC_ERROR_CODES.expired, now));
        return 'failed';
      }
      if ((cur.recoveryAttempts ?? 0) >= LIMITS.MAX_RECOVERY_ATTEMPTS) {
        assertTransition(cur.status, 'failed', 'expire');
        tx.set(ref, this.terminalPatch(cur, 'failed', PUBLIC_ERROR_CODES.recovery_exhausted, now));
        return 'failed';
      }
      assertTransition(cur.status, 'queued', 'recover');
      tx.set(ref, stripUndefined({
        ...cur,
        status: 'queued',
        leaseOwner: null,
        leaseEpoch: (cur.leaseEpoch ?? 0) + 1,
        leaseUntil: 0,
        recoveryAttempts: (cur.recoveryAttempts ?? 0) + 1,
        updatedAt: now,
      } as JobRecord));
      return 'recovered';
    });
    if (outcome === 'recovered') this.metrics.inc('jobs_recovered');
    return outcome;
  }

  /** Fail queued jobs that have waited past MAX_QUEUED_AGE_MS. */
  async expireStaleQueued(simulationId: string): Promise<boolean> {
    const ref = this.ref(simulationId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const cur = snap.data() as JobRecord;
      const now = this.now();
      if (cur.status !== 'queued' || now - cur.createdAt <= LIMITS.MAX_QUEUED_AGE_MS) return false;
      assertTransition(cur.status, 'failed', 'expire');
      tx.set(ref, this.terminalPatch(cur, 'failed', PUBLIC_ERROR_CODES.expired, now));
      return true;
    });
  }

  /**
   * Visit every queued/running job, page by page, until the collection is
   * exhausted. There is deliberately no page ceiling: a fixed cap is how
   * orphaned work past the cap would be silently ignored forever.
   */
  async forEachActive(fn: (rec: JobRecord) => Promise<void>, pageSize: number = LIMITS.SCAN_PAGE_SIZE): Promise<void> {
    let last: any = null;
    for (;;) {
      let q: any = this.db.collection(COLLECTION).where('status', 'in', ['queued', 'running']).orderBy('__name__').limit(pageSize);
      if (last) q = q.startAfter(last);
      const page = await q.get();
      if (page.empty) return;
      for (const d of page.docs) await fn(d.data() as JobRecord);
      last = page.docs[page.docs.length - 1];
      if (page.size < pageSize) return;
    }
  }

  /** Visit every simulation created before `cutoff`, in createdAt order, until exhausted. */
  async forEachCreatedBefore(cutoff: number, fn: (rec: JobRecord) => Promise<void>, pageSize: number = LIMITS.SCAN_PAGE_SIZE): Promise<void> {
    let last: any = null;
    for (;;) {
      let q: any = this.db.collection(COLLECTION).where('createdAt', '<', cutoff).orderBy('createdAt').limit(pageSize);
      if (last) q = q.startAfter(last);
      const page = await q.get();
      if (page.empty) return;
      for (const d of page.docs) await fn(d.data() as JobRecord);
      last = page.docs[page.docs.length - 1];
      if (page.size < pageSize) return;
    }
  }

  /**
   * Delete the record only if it is TERMINAL, decided inside the transaction.
   * An active job can therefore never be deleted out from under its worker,
   * however cleanup and execution interleave. Idempotent: a missing record is
   * reported, not an error.
   */
  async deleteIfTerminal(simulationId: string): Promise<'deleted' | 'skipped' | 'missing'> {
    const ref = this.ref(simulationId);
    return this.db.runTransaction<'deleted' | 'skipped' | 'missing'>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return 'missing';
      const cur = snap.data() as JobRecord;
      if (!(isJobState(cur.status) && isTerminal(cur.status))) return 'skipped';
      tx.delete(ref);
      return 'deleted';
    });
  }

  private holdsLease(cur: JobRecord, lease: Lease): boolean {
    return cur.status === 'running'
      && cur.leaseOwner === lease.owner
      && cur.leaseEpoch === lease.epoch
      && Number(cur.leaseUntil) > this.now();
  }

  private terminalPatch(cur: JobRecord, status: 'failed' | 'cancelled', code: PublicErrorCode, now: number): JobRecord {
    const { jobPayload: _drop, ...rest } = cur;
    return stripUndefined({
      ...rest,
      status,
      errorCode: code,
      completedAt: now,
      updatedAt: now,
      leaseOwner: null,
      leaseUntil: 0,
    }) as JobRecord;
  }
}

export { InvalidTransitionError };
