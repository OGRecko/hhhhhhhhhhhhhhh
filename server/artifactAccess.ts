/**
 * Authorization for reading stored artifacts and exporting reports.
 *
 * Every failure mode (unknown simulation, wrong token, missing token, token
 * for a different simulation, malformed ID, unfinished job, artifact not owned
 * by the simulation) collapses to the SAME outcome, `denied`, so a caller can
 * never learn whether a given simulation or object exists.
 */
import { capabilityTokenMatches } from './capabilityToken';
import { parseObjectId, InvalidObjectIdError } from './storage';
import { isUuid } from '../src/lib/publicLimits';
import type { JobRecord, JobStore } from './jobStore';

export type Access<T> = { ok: true; value: T } | { ok: false; reason: 'denied' | 'not_ready' };
const DENIED = { ok: false, reason: 'denied' } as const;

/** Constant-work token check: always hashes, even when the simulation is missing. */
function tokenOk(token: unknown, rec: JobRecord | null): boolean {
  // Always run the comparison against SOMETHING so timing does not reveal existence.
  const hash = rec?.capabilityTokenHash ?? '0'.repeat(64);
  const match = capabilityTokenMatches(token, hash);
  return match && rec !== null;
}

export async function authorizeSimulation(store: JobStore, simulationId: unknown, token: unknown): Promise<Access<JobRecord>> {
  if (!isUuid(simulationId)) { capabilityTokenMatches(token, '0'.repeat(64)); return DENIED; }
  const rec = await store.get(simulationId.toLowerCase());
  if (!tokenOk(token, rec)) return DENIED;
  return { ok: true, value: rec! };
}

export async function authorizeJob(store: JobStore, jobId: unknown, token: unknown): Promise<Access<JobRecord>> {
  if (!isUuid(jobId)) { capabilityTokenMatches(token, '0'.repeat(64)); return DENIED; }
  const rec = await store.getByJobId(jobId.toLowerCase());
  if (!tokenOk(token, rec)) return DENIED;
  return { ok: true, value: rec! };
}

/**
 * Artifact access requires: a valid token for the OBJECT'S OWN simulation,
 * a completed simulation, and that the object is in that simulation's
 * recorded artifact list. A token minted for simulation A never opens an
 * object belonging to simulation B, because the simulation is derived from the
 * object ID and the token is checked against THAT simulation's hash.
 */
export async function authorizeArtifact(store: JobStore, objectId: unknown, token: unknown): Promise<Access<{ record: JobRecord; objectId: string }>> {
  let parsed;
  try { parsed = parseObjectId(objectId); }
  catch (e) { if (e instanceof InvalidObjectIdError) { capabilityTokenMatches(token, '0'.repeat(64)); return DENIED; } throw e; }
  const rec = await store.get(parsed.simulationId);
  if (!tokenOk(token, rec)) return DENIED;
  if (rec!.status !== 'completed') return { ok: false, reason: 'denied' };
  if (!Array.isArray(rec!.artifacts) || !rec!.artifacts.includes(objectId as string)) return DENIED;
  return { ok: true, value: { record: rec!, objectId: objectId as string } };
}

/** Report export needs a completed simulation that actually has a result. */
export async function authorizeReport(store: JobStore, simulationId: unknown, token: unknown): Promise<Access<JobRecord>> {
  const a = await authorizeSimulation(store, simulationId, token);
  if (!a.ok) return a;
  if (a.value.status !== 'completed' || !a.value.result) return { ok: false, reason: 'not_ready' };
  return a;
}
