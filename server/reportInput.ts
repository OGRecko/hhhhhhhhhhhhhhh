/**
 * Builds the report input from what the SERVER stored for one authorised
 * simulation. Nothing here reads client-supplied room/speaker/result data:
 * the only client-controlled value that reaches the report is the assumed SNR,
 * which is range-checked by the API before this is called.
 *
 * Ownership rule: a trace is loaded only if its object ID appears in the
 * simulation's own recorded artifact list AND parses to this simulation's ID.
 * A tampered or foreign ID in a stored result is ignored, never followed.
 */
import { LIMITS } from '../src/lib/publicLimits';
import type { JobRecord } from './jobStore';
import { logError } from './observability';
import { parseObjectId, type ArtifactStore } from './storage';

export interface ReportBuildInput {
  projectName: string;
  roomName: string;
  room: Record<string, unknown>;
  speakers: Array<Record<string, unknown>>;
  receivers: Array<Record<string, unknown>>;
  solverResult: Record<string, unknown>;
  assumedSnrDb?: number;
  simulationId: string;
}

/** Only the parts of the stored solver result that this module reads. Everything is `unknown` until checked at runtime. */
interface StoredResult {
  traceObjectIds?: unknown;
  receivers?: unknown;
  [key: string]: unknown;
}

/** Only the parts of the stored room that this module reads. */
interface StoredRoom {
  projectName?: unknown;
  roomName?: unknown;
  L?: unknown;
  W?: unknown;
  H?: unknown;
  poly?: unknown;
  wallSegMats?: unknown;
  wallOpenings?: unknown;
  wallMaterial?: unknown;
  floorMaterial?: unknown;
  ceilMaterial?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class ReportNotReadyError extends Error { constructor() { super('Report not ready'); this.name = 'ReportNotReadyError'; } }

export async function buildReportInput(rec: JobRecord, artifacts: ArtifactStore, assumedSnrDb?: number): Promise<ReportBuildInput> {
  if (rec.status !== 'completed' || !rec.result || typeof rec.result !== 'object' || !rec.room || typeof rec.room !== 'object') {
    throw new ReportNotReadyError();
  }
  const result = rec.result as StoredResult;
  const owned = new Set(Array.isArray(rec.artifacts) ? rec.artifacts : []);
  const ids: unknown[] = Array.isArray(result.traceObjectIds) ? result.traceObjectIds : [];

  const traces: Array<number[] | null> = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || !owned.has(id)) { traces.push(null); continue; }
    try {
      if (parseObjectId(id).simulationId !== rec.simulationId) { traces.push(null); continue; }
      const buf = await artifacts.get(id, LIMITS.MAX_SERVED_OBJECT_BYTES);
      // Copy into an aligned buffer: a Buffer's byteOffset need not be 4-byte aligned.
      const f32 = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4)));
      traces.push(Array.from(f32));
    } catch (err) {
      // The report is still produced, but WITHOUT this receiver's trace (the report marks it unavailable).
      // Log it so a storage fault is not mistaken for a receiver that never had a trace.
      logError('report_trace_load_failed', err, { simulationId: rec.simulationId });
      traces.push(null);
    }
  }

  const storedReceivers: unknown[] = Array.isArray(result.receivers) ? result.receivers : [];
  // Index alignment with `traces` matters, so a malformed (non-object) entry becomes {} rather than being dropped.
  const receiversOut: Array<Record<string, unknown>> = storedReceivers.map((r, i) => {
    const base: Record<string, unknown> = isRecord(r) ? { ...r } : {};
    return traces[i] ? { ...base, receiverTrace: traces[i] } : base;
  });
  const solverResult: Record<string, unknown> = { ...result, receivers: receiversOut };
  delete solverResult.traceObjectIds;
  delete solverResult.waveObjectIds;
  if (traces[0]) solverResult.receiverTrace = traces[0];

  const room = rec.room as StoredRoom;
  return {
    projectName: typeof room.projectName === 'string' && room.projectName ? room.projectName : 'Cavity simulation',
    roomName: typeof room.roomName === 'string' && room.roomName ? room.roomName : 'Room',
    room: {
      L: room.L, W: room.W, H: room.H,
      poly: Array.isArray(room.poly) ? room.poly : undefined,
      wallSegMats: Array.isArray(room.wallSegMats) ? room.wallSegMats : undefined,
      wallOpenings: Array.isArray(room.wallOpenings) ? room.wallOpenings : undefined,
      wallMaterial: room.wallMaterial || 'smooth_concrete',
      floorMaterial: room.floorMaterial || 'concrete',
      ceilMaterial: room.ceilMaterial || 'concrete',
    },
    speakers: (Array.isArray(rec.speakers) ? rec.speakers : []) as Array<Record<string, unknown>>,
    receivers: (Array.isArray(rec.receivers) ? rec.receivers : []) as Array<Record<string, unknown>>,
    solverResult,
    assumedSnrDb,
    simulationId: rec.simulationId,
  };
}
