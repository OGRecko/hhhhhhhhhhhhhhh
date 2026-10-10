/**
 * Retention cleanup.
 *
 *   1. delete expired rate-limit windows            (paginated until exhausted)
 *   2. for every simulation older than the retention window:
 *        - if it is still queued/running, ask the store to recover/expire it first
 *        - delete its Storage objects, THEN its Firestore record (only if terminal)
 *
 * Properties the tests pin down:
 *   - idempotent: a second run deletes nothing and reports no failures
 *   - safe to run concurrently (in one process or many): every delete is
 *     idempotent and the record delete is a transaction that refuses non-terminal jobs
 *   - a failure on one simulation never aborts the others, and never touches an
 *     active job; a simulation whose Storage delete failed keeps its record so the
 *     next run retries it
 *   - no page ceiling: it keeps scanning until the collection is exhausted
 */
import { LIMITS } from '../src/lib/publicLimits';
import type { Admission } from './admission';
import type { JobStore } from './jobStore';
import type { ArtifactStore } from './storage';
import { isUuid } from '../src/lib/publicLimits';
import type { Metrics } from './observability';

export interface CleanupSummary {
  simulationsDeleted: number;
  artifactsDeleted: number;
  rateLimitsDeleted: number;
  skippedActive: number;
  failures: number;
}

export interface CleanupDeps {
  store: JobStore;
  artifacts: ArtifactStore;
  admission: Admission;
  metrics: Pick<Metrics, 'inc'>;
  now?: () => number;
  retentionMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

const empty = (): CleanupSummary => ({ simulationsDeleted: 0, artifactsDeleted: 0, rateLimitsDeleted: 0, skippedActive: 0, failures: 0 });

async function deleteOne(deps: CleanupDeps, simulationId: string, out: CleanupSummary): Promise<void> {
  const { store, artifacts, metrics } = deps;
  let removed = 0;
  try {
    // Terminal states are final, so checking BEFORE touching Storage is race-free:
    // an active job's objects are never deleted.
    const cur = await store.get(simulationId);
    if (cur && cur.status !== 'completed' && cur.status !== 'failed' && cur.status !== 'cancelled') { out.skippedActive++; return; }
    removed = await artifacts.deleteAllForSimulation(simulationId);
  } catch {
    // Keep the record so the next run retries this simulation's objects.
    out.failures++; metrics.inc('cleanup_failures');
    return;
  }
  try {
    const r = await store.deleteIfTerminal(simulationId);
    if (r === 'deleted') { out.simulationsDeleted++; out.artifactsDeleted += removed; metrics.inc('cleanup_deletions', 1 + removed); }
    else if (r === 'skipped') { out.skippedActive++; out.artifactsDeleted += removed; }
    else { out.artifactsDeleted += removed; } // record already gone (a concurrent run); objects removed by us
  } catch {
    out.failures++; metrics.inc('cleanup_failures');
  }
}

export async function runCleanup(deps: CleanupDeps): Promise<CleanupSummary> {
  const now = (deps.now ?? Date.now)();
  const cutoff = now - (deps.retentionMs ?? LIMITS.RETENTION_MS);
  const out = empty();
  const log = deps.log ?? (() => {});

  try {
    out.rateLimitsDeleted = await deps.admission.purgeExpiredRateLimits();
  } catch {
    out.failures++; deps.metrics.inc('cleanup_failures');
  }

  await deps.store.forEachCreatedBefore(cutoff, async (rec) => {
    if (!isUuid(rec.simulationId)) return;
    try {
      if (rec.status === 'queued' || rec.status === 'running') {
        // Reap first: an expired lease / over-age job becomes terminal (never deleted while live).
        await deps.store.recover(rec.simulationId);
        const fresh = await deps.store.get(rec.simulationId);
        if (!fresh) return;
        if (fresh.status === 'queued' || fresh.status === 'running') { out.skippedActive++; return; }
      }
      await deleteOne(deps, rec.simulationId, out);
    } catch {
      out.failures++; deps.metrics.inc('cleanup_failures');
    }
  });

  log('cleanup_finished', { ...out });
  return out;
}

/**
 * Immediately expire ONE simulation (terminal states only). Used by the
 * production smoke test to prove the deletion pipeline really removes the
 * Firestore record and the Storage objects, without touching anyone else's data.
 */
export async function expireSimulation(deps: CleanupDeps, simulationId: string): Promise<CleanupSummary> {
  const out = empty();
  if (!isUuid(simulationId)) return out;
  await deleteOne(deps, simulationId.toLowerCase(), out);
  return out;
}
