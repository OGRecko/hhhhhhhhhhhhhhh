/**
 * Explicit job state machine. Pure: no I/O, no clocks, no globals.
 *
 * The persistence layer (jobStore.ts) calls `assertTransition` inside every
 * Firestore transaction, so an illegal transition cannot be committed no
 * matter which code path or server instance attempts it.
 */

export const JOB_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>(['completed', 'failed', 'cancelled']);

/**
 * Why a transition is happening. Some edges are only legal for a specific
 * reason, e.g. running -> queued is ONLY legal as a lease-expiry recovery.
 */
export type TransitionReason =
  | 'claim'            // a worker takes a queued job
  | 'complete'         // the lease holder finished successfully
  | 'fail'             // the lease holder (or the reaper) failed the job
  | 'cancel'           // the capability holder cancelled
  | 'recover'          // an EXPIRED lease was reclaimed
  | 'expire';          // the job exceeded its maximum age / recovery budget

const ALLOWED: Readonly<Record<JobState, Readonly<Partial<Record<JobState, readonly TransitionReason[]>>>>> = {
  queued: {
    running: ['claim'],
    cancelled: ['cancel'],
    failed: ['fail', 'expire'],
  },
  running: {
    completed: ['complete'],
    failed: ['fail', 'expire'],
    cancelled: ['cancel'],
    // Only a recovered, EXPIRED lease may send a running job back to the queue.
    queued: ['recover'],
  },
  completed: {},
  failed: {},
  cancelled: {},
};

export class InvalidTransitionError extends Error {
  constructor(public readonly from: JobState, public readonly to: JobState, public readonly reason: TransitionReason) {
    super(`Invalid job transition ${from} -> ${to} (${reason})`);
    this.name = 'InvalidTransitionError';
  }
}

export function isJobState(v: unknown): v is JobState {
  return typeof v === 'string' && (JOB_STATES as readonly string[]).includes(v);
}

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: JobState, to: JobState, reason: TransitionReason): boolean {
  return ALLOWED[from]?.[to]?.includes(reason) ?? false;
}

export function assertTransition(from: unknown, to: JobState, reason: TransitionReason): asserts from is JobState {
  if (!isJobState(from) || !canTransition(from, to, reason)) {
    throw new InvalidTransitionError(from as JobState, to, reason);
  }
}

/** Every (from, to, reason) triple that is legal; used by tests to enumerate the illegal complement. */
export function allLegalTransitions(): Array<[JobState, JobState, TransitionReason]> {
  const out: Array<[JobState, JobState, TransitionReason]> = [];
  for (const from of JOB_STATES) {
    for (const [to, reasons] of Object.entries(ALLOWED[from])) {
      for (const reason of reasons!) out.push([from, to as JobState, reason]);
    }
  }
  return out;
}
