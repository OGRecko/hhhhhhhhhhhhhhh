import {
  LIMITS,
  validateFmax,
  validatePointList,
  validatePolygon,
  validateRoomDimensions,
  finiteNumber,
} from './publicLimits';
import { SCHEMA_VERSION } from './version';
import { ABSORPTION } from './absorption';
import speakerData from '../data/speakers.json';

export type ValidationResult = { ok: true; data: Record<string, any> } | { ok: false; error: string };

const PROJECT_SCHEMA_MIN = 1;
const PROJECT_SCHEMA_MAX = SCHEMA_VERSION;
const LABEL_RE = /[\u0000-\u001f\u007f]/;
const MATERIAL_ID_RE = /^[a-z0-9_]{1,64}$/i;
const KNOWN_MATERIAL_IDS = new Set(Object.keys(ABSORPTION));
const KNOWN_SPEAKER_IDS = new Set((speakerData as Array<{ id: string }>).map(s => s.id));
const ACCURACY_MODES = new Set(['fast', 'balanced', 'high']);
const UX_MODES = new Set(['beginner', 'advanced']);

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateLabel(value: unknown, field: string): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > LIMITS.MAX_LABEL_CHARS || LABEL_RE.test(value)) return null;
  return value;
}

function validateMaterial(value: unknown, field: string, fallback: string): string | null {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !MATERIAL_ID_RE.test(value) || !KNOWN_MATERIAL_IDS.has(value)) return null;
  return value;
}

function validateWallArrays(d: Record<string, any>, wallCount: number): ValidationResult {
  const mats = d.wallSegMats === undefined || d.wallSegMats === null
    ? new Array(wallCount).fill(null)
    : d.wallSegMats;
  if (!Array.isArray(mats) || mats.length !== wallCount) return { ok: false, error: 'wallSegMats must match room wall count.' };
  const wallSegMats = mats.map((m: unknown) => {
    if (m === null || m === undefined || m === '') return null;
    return typeof m === 'string' && MATERIAL_ID_RE.test(m) && KNOWN_MATERIAL_IDS.has(m) ? m : '__INVALID__';
  });
  if (wallSegMats.includes('__INVALID__')) return { ok: false, error: 'Invalid wall segment material identifier.' };

  const openings = d.wallOpenings === undefined || d.wallOpenings === null
    ? new Array(wallCount).fill(null)
    : d.wallOpenings;
  if (!Array.isArray(openings) || openings.length !== wallCount) return { ok: false, error: 'wallOpenings must match room wall count.' };
  const wallOpenings = openings.map((o: any) => {
    if (o === null || o === undefined) return null;
    if (o === 'full') return 'full';
    if (!isObject(o)) return '__INVALID__';
    const start = finiteNumber(o.start), end = finiteNumber(o.end);
    if (start === null || end === null || start < 0 || end > 1 || end <= start) return '__INVALID__';
    return { start, end };
  });
  if (wallOpenings.includes('__INVALID__')) return { ok: false, error: 'Invalid wall opening. Use "full" or 0 <= start < end <= 1.' };
  return { ok: true, data: { wallSegMats, wallOpenings } };
}

function validateScatter(value: unknown): { ok: true; data: { walls: number; floor: number; ceiling: number } } | { ok: false; error: string } {
  const d = value === undefined || value === null ? { walls: 0.15, floor: 0.15, ceiling: 0.15 } : value;
  if (!isObject(d)) return { ok: false, error: 'scatter must be an object.' };
  const walls = finiteNumber(d.walls), floor = finiteNumber(d.floor), ceiling = finiteNumber(d.ceiling);
  if ([walls, floor, ceiling].some(v => v === null || v < 0 || v > 1)) return { ok: false, error: 'scatter values must be finite numbers between 0 and 1.' };
  return { ok: true, data: { walls: walls!, floor: floor!, ceiling: ceiling! } };
}

function validateReceiverGrid(value: unknown, H: number): { ok: true; data: any } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, data: null };
  if (!isObject(value)) return { ok: false, error: 'receiverGrid must be an object.' };
  const keys = ['xMin','xMax','yMin','yMax','zHeight','spacing'];
  const nums = Object.fromEntries(keys.map(k => [k, finiteNumber(value[k])]));
  if (Object.values(nums).some(v => v === null)) return { ok: false, error: 'receiverGrid contains invalid numeric values.' };
  if (nums.xMin! < 0 || nums.xMax! > 1 || nums.xMin! >= nums.xMax! || nums.yMin! < 0 || nums.yMax! > 1 || nums.yMin! >= nums.yMax!) return { ok: false, error: 'receiverGrid bounds must be ordered and within 0..1.' };
  if (nums.zHeight! < 0 || nums.zHeight! > H || nums.spacing! <= 0 || nums.spacing! > Math.max(H, 100)) return { ok: false, error: 'receiverGrid height or spacing is invalid.' };
  return { ok: true, data: nums };
}

function migrateSchema(d: Record<string, any>): ValidationResult {
  const raw = d.schemaVersion === undefined || d.schemaVersion === null ? 1 : d.schemaVersion;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false, error: 'Project schemaVersion must be an integer.' };
  if (raw < PROJECT_SCHEMA_MIN) return { ok: false, error: `Unsupported project schemaVersion ${raw}.` };
  if (raw > PROJECT_SCHEMA_MAX) return { ok: false, error: `Project was created by a newer app version (schema ${raw}); update Cavity Audio before importing it.` };
  // v1/v2 are intentionally migrated by defaults for fields introduced later.
  return { ok: true, data: { ...d, schemaVersion: SCHEMA_VERSION } };
}

export function validateProjectData(input: unknown): ValidationResult {
  if (!isObject(input)) return { ok: false, error: 'Project file must contain a JSON object.' };
  const migrated = migrateSchema(input);
  if (!migrated.ok) return migrated;
  const d = migrated.data;

  const room = validateRoomDimensions({ L: d.L, W: d.W, H: d.H });
  if ('error' in room) return { ok: false, error: room.error };
  const poly = validatePolygon(d.poly);
  if ('error' in poly) return { ok: false, error: poly.error };
  const sources = validatePointList(d.sources, room.H, 'source');
  if ('error' in sources) return { ok: false, error: sources.error };
  const receivers = validatePointList(d.receivers, room.H, 'receiver');
  if ('error' in receivers) return { ok: false, error: receivers.error };
  const fmax = validateFmax(d.fmax);
  if ('error' in fmax) return { ok: false, error: fmax.error };
  const walls = validateWallArrays(d, poly.poly.length);
  if (!walls.ok) return walls;
  const scatter = validateScatter(d.scatter);
  if (!scatter.ok) return scatter;
  const receiverGrid = validateReceiverGrid(d.receiverGrid, room.H);
  if (!receiverGrid.ok) return receiverGrid;

  const projectName = validateLabel(d.projectName, 'projectName');
  const roomName = validateLabel(d.roomName, 'roomName');
  if (projectName === null || roomName === null) return { ok: false, error: 'Project and room names must be plain text labels up to 100 characters.' };

  const wallMaterial = validateMaterial(d.wallMaterial, 'wallMaterial', 'drywall');
  const floorMaterial = validateMaterial(d.floorMaterial, 'floorMaterial', 'wood_floor');
  const ceilMaterial = validateMaterial(d.ceilMaterial, 'ceilMaterial', 'stonewool');
  if (wallMaterial === null || floorMaterial === null || ceilMaterial === null) return { ok: false, error: 'Invalid material identifier.' };

  const accuracyMode = d.accuracyMode === undefined ? 'balanced' : d.accuracyMode;
  if (typeof accuracyMode !== 'string' || !ACCURACY_MODES.has(accuracyMode)) return { ok: false, error: 'accuracyMode must be fast, balanced, or high.' };
  if (d.confirmReducedResolution !== undefined && typeof d.confirmReducedResolution !== 'boolean') return { ok: false, error: 'confirmReducedResolution must be a boolean.' };
  const uxMode = d.uxMode === undefined ? 'beginner' : d.uxMode;
  if (typeof uxMode !== 'string' || !UX_MODES.has(uxMode)) return { ok: false, error: 'uxMode must be beginner or advanced.' };

  for (const rawSource of d.sources as any[]) {
    const speakerId = rawSource?.speakerId;
    if (speakerId !== undefined && speakerId !== null && speakerId !== '' && (typeof speakerId !== 'string' || !KNOWN_SPEAKER_IDS.has(speakerId))) {
      const shown = typeof speakerId === 'string' ? speakerId : String(speakerId);
      return { ok: false, error: `Project references speaker ID "${shown}", which is not in the current catalog. It may have been archived or removed; the project was not opened. Choose a replacement speaker for the affected source, then save the project again. See SAVED-PROJECT-SPEAKER-REFERENCES.md.` };
    }
  }
  const sourceIds = new Set(sources.points.map(x => x.id).filter(Boolean));
  const receiverIds = new Set(receivers.points.map(x => x.id).filter(Boolean));
  if (sourceIds.size !== sources.points.length || receiverIds.size !== receivers.points.length) {
    return { ok: false, error: 'Source and receiver IDs must be unique.' };
  }
  const sims = Array.isArray(d.simulations) ? d.simulations : [];

  if (sims.length > 100) return { ok: false, error: 'Project contains too many simulations.' };
  const safeSims = sims.filter((x: any) => isObject(x) && typeof x.id === 'string' && typeof x.name === 'string' && x.name.length <= LIMITS.MAX_LABEL_CHARS && !LABEL_RE.test(x.name) && sourceIds.has(x.sourceId) && receiverIds.has(x.receiverId));
  if (safeSims.length !== sims.length) return { ok: false, error: 'Project contains an invalid simulation reference or name.' };

  const primaryReceiverId = d.primaryReceiverId == null || d.primaryReceiverId === '' ? receivers.points[0]?.id ?? null : d.primaryReceiverId;
  if (primaryReceiverId !== null && !receiverIds.has(primaryReceiverId)) return { ok: false, error: 'primaryReceiverId does not reference a receiver in this project.' };

  return {
    ok: true,
    data: {
      schemaVersion: SCHEMA_VERSION,
      appVersion: typeof d.appVersion === 'string' ? d.appVersion.slice(0, 32) : undefined,
      projectName: projectName ?? 'My Project',
      roomName: roomName ?? 'Space 1',
      L: room.L, W: room.W, H: room.H,
      fmax: fmax.fmax,
      accuracyMode,
      confirmReducedResolution: d.confirmReducedResolution === true,
      poly: poly.poly,
      wallMaterial, wallSegMats: walls.data.wallSegMats, wallOpenings: walls.data.wallOpenings,
      floorMaterial, ceilMaterial,
      scatter: scatter.data,
      sources: sources.points,
      receivers: receivers.points,
      simulations: safeSims,
      uxMode,
      primaryReceiverId,
      receiverGrid: receiverGrid.data,
    },
  };
}
