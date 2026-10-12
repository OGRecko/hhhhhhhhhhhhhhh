/**
 * THE authoritative public-service limits and request validators.
 *
 * This module performs no I/O and reads no environment. It shares the same
 * public limits and validation rules between the browser, API, worker, scripts,
 * and tests so they cannot disagree about what is allowed.
 *
 * The frontend uses these only to give early, friendly feedback. They are NOT
 * a security boundary there: the API re-validates every request with the same
 * functions, and the worker validates once more before allocating memory.
 */

import { ABSORPTION } from './absorption';

export const LIMITS = Object.freeze({
  /** Maximum JSON request body, in bytes. */
  MAX_JSON_BODY_BYTES: 64 * 1024,
  /** Room dimensions in metres. */
  MIN_ROOM_DIM_M: 0.5,
  MAX_ROOM_L_M: 100,
  MAX_ROOM_W_M: 100,
  MAX_ROOM_H_M: 30,
  /** Time steps. */
  MIN_STEPS: 1,
  MAX_STEPS: 3000,
  DEFAULT_STEPS: 40,
  /** FDTD grid cells. */
  MAX_GRID_CELLS: 50_000_000,
  /** Maximum footprint vertices / wall segments in a public room. */
  MAX_ROOM_VERTICES: 64,
  /** Sources / receivers per simulation. */
  MIN_SOURCES: 1,
  MAX_SOURCES: 16,
  MIN_RECEIVERS: 1,
  MAX_RECEIVERS: 64,
  /** Source calibration / mixer bounds. */
  MIN_SOURCE_GAIN_DB: -60,
  MAX_SOURCE_GAIN_DB: 24,
  MIN_SOURCE_DELAY_MS: 0,
  MAX_SOURCE_DELAY_MS: 2_000,
  MIN_SOURCE_SENSITIVITY_DB: 40,
  MAX_SOURCE_SENSITIVITY_DB: 140,
  MIN_REFERENCE_POWER_W: 0.01,
  MAX_REFERENCE_POWER_W: 10_000,
  /** Maximum simulated frequency (Hz). */
  MIN_FMAX_HZ: 1,
  MAX_FMAX_HZ: 24_000,
  /** Solver memory budget (bytes); the worker also honours a stricter env override. */
  MAX_SOLVER_MEMORY_BYTES: 1_500_000_000,
  /** Total bytes of artifacts (traces + wavefield frames) one simulation may store. */
  MAX_ARTIFACT_BYTES: 128 * 1024 * 1024,
  /** Hard cap on the number of wavefield frames one simulation may emit. */
  MAX_WAVEFIELD_FRAMES: 600,
  /** Per-object download cap (bytes); larger objects are never served. */
  MAX_SERVED_OBJECT_BYTES: 64 * 1024 * 1024,
  /** Wall-clock budget for one solver run. */
  SOLVER_TIMEOUT_MS: 60_000,
  /** Global concurrent solver jobs across all instances.
   *
   * Each job can use up to MAX_SOLVER_MEMORY_BYTES (1.5 GB by default) of
   * heap for its FDTD grids. The deployed Cloud Run instance has 2 GiB of
   * memory (see scripts/deploy-cloud-run.mjs, --memory=2Gi). Two
   * concurrent jobs could together demand up to 3 GB - comfortably over
   * the instance's actual 2 GiB - so this must stay at 1 until either the
   * instance is sized up or MAX_SOLVER_MEMORY_BYTES is lowered enough that
   * two jobs' combined worst case fits in 2 GiB with headroom for the
   * runtime itself. */
  MAX_CONCURRENT_SOLVER_JOBS: 1,
  /** Jobs one IP may have queued or running at once. */
  MAX_ACTIVE_JOBS_PER_IP: 1,
  /** Solver submissions permitted per IP per hour. */
  SOLVER_SUBMISSIONS_PER_IP_PER_HOUR: 60,
  /** Minimum gap between two submissions from one IP. */
  SOLVER_COOLDOWN_MS: 3_000,
  /** Report exports permitted per IP per hour. */
  REPORT_EXPORTS_PER_IP_PER_HOUR: 10,
  /** Job / artifact reads permitted per IP per minute. */
  READS_PER_IP_PER_MINUTE: 600,
  /** Failed cleanup-secret attempts permitted per IP per 15 minutes. */
  CLEANUP_AUTH_FAILURES_PER_IP: 5,
  /** Client error reports per IP per minute. */
  CLIENT_ERROR_REPORTS_PER_IP_PER_MINUTE: 10,
  /** How long finished simulations and their artifacts are kept. */
  RETENTION_MS: 24 * 60 * 60 * 1000,
  /** Lease a worker holds on a job; it must heartbeat well inside this. */
  JOB_LEASE_MS: 30_000,
  JOB_HEARTBEAT_MS: 10_000,
  /** A job queued this long with nobody claiming it is failed rather than left pending forever. */
  MAX_QUEUED_AGE_MS: 10 * 60 * 1000,
  /** Absolute wall-clock ceiling for one job from creation to a terminal state. */
  MAX_JOB_AGE_MS: 15 * 60 * 1000,
  /** Maximum times an expired lease may be recovered before the job is failed. */
  MAX_RECOVERY_ATTEMPTS: 3,
  /** Capability token length in bytes (hex-encoded to 2x this). */
  CAPABILITY_TOKEN_BYTES: 32,
  /** Longest Authorization header we will even look at. */
  MAX_AUTH_HEADER_CHARS: 200,
  /** Per-route JSON body caps (bytes). MAX_JSON_BODY_BYTES above is the solver-route cap. */
  MAX_REPORT_BODY_BYTES: 2 * 1024,
  MAX_CLIENT_ERROR_BODY_BYTES: 10 * 1024,
  /** A slow client must deliver its body within this window (slow-loris protection). */
  BODY_READ_TIMEOUT_MS: 10_000,
  /** Largest serialized result document written to Firestore (hard doc limit is 1 MiB). */
  MAX_RESULT_DOC_BYTES: 512 * 1024,
  /** Requests carrying a missing/invalid credential permitted per IP per minute (per instance). */
  AUTH_FAILURES_PER_IP_PER_MINUTE: 30,
  /** Solver admission slot lifetime; refreshed by the job heartbeat and released on every terminal path. */
  SOLVER_SLOT_TTL_MS: 5 * 60 * 1000,
  /** PDF renders allowed at once per instance, wall-clock budget, and output ceiling. */
  MAX_CONCURRENT_REPORTS: 2,
  REPORT_TIMEOUT_MS: 20_000,
  MAX_REPORT_BYTES: 20 * 1024 * 1024,
  MIN_ASSUMED_SNR_DB: -20,
  MAX_ASSUMED_SNR_DB: 60,
  /** Longest free-text label (name/brand/model) accepted on a source or receiver. */
  MAX_LABEL_CHARS: 100,
  /** Background sweep cadence, and how long a queued job is left to its creating instance first. */
  SWEEP_INTERVAL_MS: 15_000,
  SWEEP_QUEUED_GRACE_MS: 5_000,
  /** Jobs an instance will hold in its local run queue (the sweep re-discovers anything dropped). */
  MAX_LOCAL_QUEUE: 200,
  /** Page size for cleanup / sweep scans. Scans continue until exhausted; this is NOT a cap. */
  SCAN_PAGE_SIZE: 200,
  /** Bound on distinct client keys the in-process limiter tracks (memory-exhaustion guard). */
  MAX_LOCAL_LIMITER_KEYS: 50_000,
});

/** True when a grid of `cells` exceeds the public ceiling. Exactly MAX_GRID_CELLS is admitted. */
export const exceedsGridLimit = (cells: number): boolean => !Number.isFinite(cells) || cells > LIMITS.MAX_GRID_CELLS;

export const CAPABILITY_TOKEN_HEX_LENGTH = LIMITS.CAPABILITY_TOKEN_BYTES * 2;

export type Ok<T = {}> = { ok: true } & T;
export type Err = { ok: false; error: string };
export type Result<T = {}> = Ok<T> | Err;

const fail = (error: string): Err => ({ ok: false, error });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Strict finite-number reader. Unlike `Number(x)`, this refuses strings,
 * booleans, null, arrays and everything else that coerces to a number, so
 * `"5"`, `true`, `[]`, `""` and `null` cannot slip through as 5 / 1 / 0.
 */
export function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function validateRoomDimensions(body: unknown): Result<{ L: number; W: number; H: number }> {
  if (!isPlainObject(body)) return fail('Invalid room geometry.');
  const L = finiteNumber(body.L);
  const W = finiteNumber(body.W);
  const H = finiteNumber(body.H);
  if (L === null || W === null || H === null) return fail('Invalid room geometry.');
  if (L < LIMITS.MIN_ROOM_DIM_M || W < LIMITS.MIN_ROOM_DIM_M || H < LIMITS.MIN_ROOM_DIM_M) {
    return fail(`Room dimensions must be at least ${LIMITS.MIN_ROOM_DIM_M} m.`);
  }
  if (L > LIMITS.MAX_ROOM_L_M || W > LIMITS.MAX_ROOM_W_M || H > LIMITS.MAX_ROOM_H_M) {
    return fail(`Room dimensions exceed public limits (L/W <= ${LIMITS.MAX_ROOM_L_M} m, H <= ${LIMITS.MAX_ROOM_H_M} m).`);
  }
  return { ok: true, L, W, H };
}

export function validateSteps(value: unknown): Result<{ steps: number }> {
  const steps = value === undefined || value === null ? LIMITS.DEFAULT_STEPS : value;
  if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < LIMITS.MIN_STEPS || steps > LIMITS.MAX_STEPS) {
    return fail(`steps must be an integer between ${LIMITS.MIN_STEPS} and ${LIMITS.MAX_STEPS}.`);
  }
  return { ok: true, steps };
}

export function validateFmax(value: unknown): Result<{ fmax: number }> {
  if (value === undefined || value === null) return { ok: true, fmax: 500 };
  const f = finiteNumber(value);
  if (f === null || f < LIMITS.MIN_FMAX_HZ || f > LIMITS.MAX_FMAX_HZ) {
    return fail(`fmax must be a finite frequency between ${LIMITS.MIN_FMAX_HZ} Hz and ${LIMITS.MAX_FMAX_HZ} Hz.`);
  }
  return { ok: true, fmax: f };
}

export interface DirectivityDataInput {
  frequencies: number[];
  points: Record<string, number[]>;
  angularResolution: number;
  brand?: string;
  model?: string;
}
export interface Point {
  x: number; y: number; z?: number; id?: string; name?: string; brand?: string; model?: string;
  isDirectional?: boolean; directivityData?: DirectivityDataInput;
  yawDeg?: number; pitchDeg?: number; rollDeg?: number;
  gainDb?: number; delayMs?: number; muted?: boolean; sensitivityDb?: number; referencePowerW?: number;
}
export interface PolygonPoint { x: number; y: number }
export type WallOpening = 'full' | { start: number; end: number };

function polygonAreaNormalized(points: PolygonPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function orientation(a: PolygonPoint, b: PolygonPoint, c: PolygonPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function onSegment(a: PolygonPoint, b: PolygonPoint, p: PolygonPoint): boolean {
  const eps = 1e-9;
  return Math.abs(orientation(a, b, p)) <= eps && p.x >= Math.min(a.x,b.x)-eps && p.x <= Math.max(a.x,b.x)+eps && p.y >= Math.min(a.y,b.y)-eps && p.y <= Math.max(a.y,b.y)+eps;
}
function segmentsIntersect(a: PolygonPoint, b: PolygonPoint, c: PolygonPoint, d: PolygonPoint): boolean {
  const eps = 1e-9;
  const o1 = orientation(a,b,c), o2 = orientation(a,b,d), o3 = orientation(c,d,a), o4 = orientation(c,d,b);
  if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) return true;
  return (Math.abs(o1) <= eps && onSegment(a,b,c)) || (Math.abs(o2) <= eps && onSegment(a,b,d)) || (Math.abs(o3) <= eps && onSegment(c,d,a)) || (Math.abs(o4) <= eps && onSegment(c,d,b));
}

export function pointInPolygon(point: PolygonPoint, poly: PolygonPoint[]): boolean {
  let inside = false;
  for (let i=0,j=poly.length-1; i<poly.length; j=i++) {
    const a=poly[i], b=poly[j];
    if (onSegment(a,b,point)) return true;
    const hit = ((a.y > point.y) !== (b.y > point.y)) && point.x < (b.x-a.x)*(point.y-a.y)/(b.y-a.y) + a.x;
    if (hit) inside = !inside;
  }
  return inside;
}

export function validatePolygon(value: unknown): Result<{ poly: PolygonPoint[] }> {
  if (!Array.isArray(value) || value.length < 3 || value.length > LIMITS.MAX_ROOM_VERTICES) return fail(`poly must contain 3 to ${LIMITS.MAX_ROOM_VERTICES} vertices.`);
  const poly: PolygonPoint[] = [];
  for (const p of value) {
    if (!isPlainObject(p)) return fail('Invalid room polygon.');
    const x=finiteNumber(p.x), y=finiteNumber(p.y);
    if (x===null || y===null || x<0 || x>1 || y<0 || y>1) return fail('Room polygon coordinates must be finite numbers between 0 and 1.');
    poly.push({x,y});
  }
  if (polygonAreaNormalized(poly) < 1e-4) return fail('Room polygon area is too small.');
  for (let i=0;i<poly.length;i++) {
    const a=poly[i], b=poly[(i+1)%poly.length];
    if (Math.hypot(a.x-b.x,a.y-b.y) < 1e-6) return fail('Room polygon contains duplicate or zero-length edges.');
    for (let j=i+1;j<poly.length;j++) {
      if (j===i || (j+1)%poly.length===i || (i+1)%poly.length===j) continue;
      if (segmentsIntersect(a,b,poly[j],poly[(j+1)%poly.length])) return fail('Room polygon edges must not cross.');
    }
  }
  return {ok:true, poly};
}

export function validateWallOpenings(value: unknown, count: number): Result<{ wallOpenings: (WallOpening | null)[] }> {
  if (value === undefined || value === null) return {ok:true, wallOpenings: new Array(count).fill(null)};
  if (!Array.isArray(value) || value.length !== count) return fail('wallOpenings must match the number of room wall segments.');
  const out: (WallOpening | null)[] = [];
  for (const o of value) {
    if (o === null || o === undefined) { out.push(null); continue; }
    if (o === 'full') { out.push('full'); continue; }
    if (!isPlainObject(o)) return fail('Invalid wall opening.');
    const start=finiteNumber(o.start), end=finiteNumber(o.end);
    if (start===null || end===null || start<0 || end>1 || end<=start) return fail('Wall opening start/end must satisfy 0 <= start < end <= 1.');
    out.push({start,end});
  }
  return {ok:true, wallOpenings: out};
}

export function validateWallMaterials(value: unknown, count: number): Result<{ wallSegMats: (string|null)[] }> {
  if (value === undefined || value === null) return {ok:true, wallSegMats:new Array(count).fill(null)};
  if (!Array.isArray(value) || value.length !== count) return fail('wallSegMats must match the number of room wall segments.');
  const out:(string|null)[]=[];
  for (const m of value) {
    if (m===null || m===undefined || m==='') { out.push(null); continue; }
    const parsed=optionalMaterial(m);
    if (parsed===null) return fail('Invalid wall segment material identifier.');
    out.push(parsed ?? null);
  }
  return {ok:true, wallSegMats:out};
}

const LABEL_FIELDS = ['id', 'name', 'brand', 'model'] as const;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * x and y are normalised 0..1 room fractions; z is metres within 0..H.
 * Every coordinate must be a real, finite JSON number.
 */
function validateDirectivity(value: unknown): Result<{ directivityData: DirectivityDataInput }> {
  if (!isPlainObject(value)) return fail('Invalid directivity data.');
  const frequencies = value.frequencies;
  const rawPoints = value.points;
  if (!Array.isArray(frequencies) || frequencies.length < 1 || frequencies.length > 16) return fail('Directivity frequencies must contain 1 to 16 values.');
  const freqOut = frequencies.map(v => finiteNumber(v));
  if (freqOut.some(v => v === null || v <= 0 || v > 24_000)) return fail('Directivity frequencies must be finite values between 0 and 24000 Hz.');
  if (!isPlainObject(rawPoints)) return fail('Invalid directivity point map.');
  const keys = Object.keys(rawPoints);
  if (keys.length < 1 || keys.length > 4096) return fail('Directivity data contains too many angular points.');
  const points: Record<string, number[]> = {};
  for (const key of keys) {
    const parts = key.split(',');
    if (parts.length !== 2) return fail('Invalid directivity angular key.');
    const az = Number(parts[0]), el = Number(parts[1]);
    const mags = rawPoints[key];
    if (!Number.isFinite(az) || !Number.isFinite(el) || az < -360 || az > 720 || el < -90 || el > 90 || !Array.isArray(mags) || mags.length !== freqOut.length) {
      return fail('Invalid directivity angular sample.');
    }
    const clean = mags.map(v => finiteNumber(v));
    if (clean.some(v => v === null || v < -120 || v > 30)) return fail('Directivity magnitudes must be finite dB values between -120 and 30 dB.');
    points[key] = clean as number[];
  }
  const angularResolution = finiteNumber(value.angularResolution);
  if (angularResolution === null || angularResolution <= 0 || angularResolution > 90) return fail('Invalid directivity angular resolution.');
  const brand = typeof value.brand === 'string' ? value.brand.slice(0, LIMITS.MAX_LABEL_CHARS) : undefined;
  const model = typeof value.model === 'string' ? value.model.slice(0, LIMITS.MAX_LABEL_CHARS) : undefined;
  return { ok: true, directivityData: { frequencies: freqOut as number[], points, angularResolution, brand, model } };
}

export function validatePoint(p: unknown, H: number, kind: 'source' | 'receiver'): Result<{ point: Point }> {
  if (!isPlainObject(p)) return fail(`Invalid ${kind}.`);
  const x = finiteNumber(p.x);
  const y = finiteNumber(p.y);
  if (x === null || y === null) return fail(`Invalid ${kind} coordinates. Must be finite numbers.`);
  let z: number | undefined;
  if (p.z !== undefined && p.z !== null) {
    const zz = finiteNumber(p.z);
    if (zz === null) return fail(`Invalid ${kind} coordinates. Must be finite numbers.`);
    z = zz;
  }
  const effZ = z === undefined ? (kind === 'source' ? H * 0.7 : H / 2) : z;
  if (x < 0 || x > 1 || y < 0 || y > 1 || effZ < 0 || effZ > H) {
    return fail(`${kind === 'source' ? 'Source' : 'Receiver'} outside room bounds.`);
  }
  const point: Point = { x, y };
  if (z !== undefined) point.z = z;
  for (const f of LABEL_FIELDS) {
    const v = p[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v.length > LIMITS.MAX_LABEL_CHARS || CONTROL_CHARS_RE.test(v)) {
      return fail(`Invalid ${kind} ${f}.`);
    }
    point[f] = v;
  }
  for (const angle of ['yawDeg', 'pitchDeg', 'rollDeg'] as const) {
    if (p[angle] !== undefined) {
      const n = finiteNumber(p[angle]);
      if (n === null || n < -360 || n > 360) return fail(`Invalid ${kind} orientation.`);
      point[angle] = n;
    }
  }
  if (kind === 'source') {
    const gainDb = p.gainDb === undefined ? 0 : finiteNumber(p.gainDb);
    const delayMs = p.delayMs === undefined ? 0 : finiteNumber(p.delayMs);
    const sensitivityDb = p.sensitivityDb === undefined ? (p.sens === undefined ? null : finiteNumber(p.sens)) : finiteNumber(p.sensitivityDb);
    const referencePowerW = p.referencePowerW === undefined ? 1 : finiteNumber(p.referencePowerW);
    if (gainDb === null || gainDb < LIMITS.MIN_SOURCE_GAIN_DB || gainDb > LIMITS.MAX_SOURCE_GAIN_DB) return fail(`Source gain must be between ${LIMITS.MIN_SOURCE_GAIN_DB} and ${LIMITS.MAX_SOURCE_GAIN_DB} dB.`);
    if (delayMs === null || delayMs < LIMITS.MIN_SOURCE_DELAY_MS || delayMs > LIMITS.MAX_SOURCE_DELAY_MS) return fail(`Source delay must be between ${LIMITS.MIN_SOURCE_DELAY_MS} and ${LIMITS.MAX_SOURCE_DELAY_MS} ms.`);
    if (sensitivityDb !== null && (sensitivityDb < LIMITS.MIN_SOURCE_SENSITIVITY_DB || sensitivityDb > LIMITS.MAX_SOURCE_SENSITIVITY_DB)) return fail(`Source sensitivity must be between ${LIMITS.MIN_SOURCE_SENSITIVITY_DB} and ${LIMITS.MAX_SOURCE_SENSITIVITY_DB} dB.`);
    if (referencePowerW === null || referencePowerW < LIMITS.MIN_REFERENCE_POWER_W || referencePowerW > LIMITS.MAX_REFERENCE_POWER_W) return fail('Invalid source reference power.');
    if (p.muted !== undefined && typeof p.muted !== 'boolean') return fail('Source muted must be a boolean.');
    point.gainDb = gainDb; point.delayMs = delayMs; point.referencePowerW = referencePowerW;
    if (sensitivityDb !== null) point.sensitivityDb = sensitivityDb;
    point.muted = p.muted === true;
  }
  if (kind === 'source') {
    if (p.isDirectional !== undefined && typeof p.isDirectional !== 'boolean') return fail('isDirectional must be a boolean.');
    if (p.isDirectional === true) {
      const d = validateDirectivity(p.directivityData);
      if ('error' in d) return fail(d.error);
      point.isDirectional = true;
      point.directivityData = d.directivityData;
    }
  }
  return { ok: true, point };
}

export function validatePointList(
  list: unknown,
  H: number,
  kind: 'source' | 'receiver',
): Result<{ points: Point[] }> {
  const min = kind === 'source' ? LIMITS.MIN_SOURCES : LIMITS.MIN_RECEIVERS;
  const max = kind === 'source' ? LIMITS.MAX_SOURCES : LIMITS.MAX_RECEIVERS;
  if (!Array.isArray(list) || list.length < min || list.length > max) {
    return fail(`${kind}s must be an array of length ${min} to ${max}.`);
  }
  const points: Point[] = [];
  const seenIds = new Set<string>();
  for (const item of list) {
    const r = validatePoint(item, H, kind);
    if ('error' in r) return fail(r.error);
    // Results are keyed by id downstream (traces, report rows), so two entries sharing an explicit id would overwrite each other.
    const rawId = isPlainObject(item) ? (item as Record<string, unknown>).id : undefined;
    if (typeof rawId === 'string' || typeof rawId === 'number') {
      const key = String(rawId);
      if (seenIds.has(key)) return fail(`Duplicate ${kind} id "${key.slice(0, 40)}": each ${kind} must have a unique id.`);
      seenIds.add(key);
    }
    points.push(r.point);
  }
  return { ok: true, points };
}

const ACCURACY_MODES = ['fast', 'balanced', 'high'] as const;
const ACCURACY_MODE_SET = new Set<string>(ACCURACY_MODES);

export interface ValidatedSolverRequest {
  L: number; W: number; H: number;
  steps: number;
  fmax: number;
  accuracyMode: 'fast' | 'balanced' | 'high';
  confirmReducedResolution: boolean;
  exportWavefield: boolean;
  sources: Point[];
  receivers: Point[];
  poly: PolygonPoint[];
  wallSegMats: (string | null)[];
  wallOpenings: (WallOpening | null)[];
  wallMaterial?: string; floorMaterial?: string; ceilMaterial?: string;
  projectName?: string; roomName?: string;
  wallAbsorption?: number; floorAbsorption?: number; ceilAbsorption?: number;
  frequencyDependentBoundaries?: boolean;
}

const MATERIAL_ID_RE = /^[a-z0-9_]{1,64}$/i;
const KNOWN_MATERIAL_IDS = new Set(Object.keys(ABSORPTION));

function optionalMaterial(v: unknown): string | undefined | null {
  if (v === undefined || v === null || v === '') return undefined;
  return typeof v === 'string' && MATERIAL_ID_RE.test(v) && KNOWN_MATERIAL_IDS.has(v) ? v : null;
}

function optionalAbsorption(v: unknown): number | undefined | null {
  if (v === undefined || v === null) return undefined;
  const n = finiteNumber(v);
  return n !== null && n >= 0 && n <= 1 ? n : null;
}

/**
 * The single validator for a public solver request body. Returns a NEW,
 * sanitised object containing only recognised fields, so unknown/oversized
 * client-supplied properties are never persisted or forwarded to the worker.
 *
 * `kind` decides the source rules: a wave run uses one source; an impulse
 * response accepts a list.
 */
export function validateSolverRequest(body: unknown, kind: 'wave' | 'impulse-response'): Result<{ request: ValidatedSolverRequest }> {
  if (!isPlainObject(body)) return fail('Request body must be a JSON object.');

  const room = validateRoomDimensions(body);
  if ('error' in room) return fail(room.error);
  const defaultPoly = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
  const polyResult = validatePolygon(body.poly === undefined ? defaultPoly : body.poly);
  if ('error' in polyResult) return fail(polyResult.error);
  const steps = validateSteps(body.steps);
  if ('error' in steps) return fail(steps.error);
  const fmax = validateFmax(body.fmax);
  if ('error' in fmax) return fail(fmax.error);

  if (body.projectId !== undefined && body.projectId !== null && body.projectId !== '') {
    return fail('Project persistence is not available in public mode.');
  }
  const projectName: string | undefined = typeof body.projectName === 'string' ? body.projectName : undefined;
  const roomName: string | undefined = typeof body.roomName === 'string' ? body.roomName : undefined;
  for (const [label, value] of [['projectName', projectName], ['roomName', roomName]] as const) {
    if (value !== undefined && (typeof value !== 'string' || value.length > LIMITS.MAX_LABEL_CHARS || CONTROL_CHARS_RE.test(value))) {
      return fail(`Invalid ${label}.`);
    }
  }

  const rawReceivers = body.receivers !== undefined ? body.receivers : (body.receiver !== undefined ? [body.receiver] : []);
  const receivers = validatePointList(rawReceivers, room.H, 'receiver');
  if ('error' in receivers) return fail(receivers.error);
  for (const p of receivers.points) if (!pointInPolygon(p, polyResult.poly)) return fail('Receiver is outside the room footprint.');

  let rawSources: unknown;
  if (body.sources !== undefined) rawSources = body.sources;
  else if (body.source !== undefined) rawSources = [body.source];
  else rawSources = [];
  const sources = validatePointList(rawSources, room.H, 'source');
  if ('error' in sources) return fail(sources.error);
  for (const p of sources.points) if (!pointInPolygon(p, polyResult.poly)) return fail('Source is outside the room footprint.');

  let accuracyMode: 'fast' | 'balanced' | 'high' = 'balanced';
  if (body.accuracyMode !== undefined && body.accuracyMode !== null) {
    if (typeof body.accuracyMode !== 'string' || !ACCURACY_MODE_SET.has(body.accuracyMode)) {
      return fail('accuracyMode must be fast, balanced, or high.');
    }
    accuracyMode = body.accuracyMode as typeof accuracyMode;
  }

  for (const flag of ['confirmReducedResolution', 'exportWavefield', 'frequencyDependentBoundaries'] as const) {
    if (body[flag] !== undefined && body[flag] !== null && typeof body[flag] !== 'boolean') {
      return fail(`${flag} must be a boolean.`);
    }
  }

  const wall = optionalMaterial(body.wallMaterial);
  const floor = optionalMaterial(body.floorMaterial);
  const ceil = optionalMaterial(body.ceilMaterial);
  if (wall === null || floor === null || ceil === null) return fail('Invalid material identifier.');
  const wallSegMats = validateWallMaterials(body.wallSegMats, polyResult.poly.length);
  if ('error' in wallSegMats) return fail(wallSegMats.error);
  const wallOpenings = validateWallOpenings(body.wallOpenings, polyResult.poly.length);
  if ('error' in wallOpenings) return fail(wallOpenings.error);
  const wAbs = optionalAbsorption(body.wallAbsorption);
  const fAbs = optionalAbsorption(body.floorAbsorption);
  const cAbs = optionalAbsorption(body.ceilAbsorption);
  if (wAbs === null || fAbs === null || cAbs === null) return fail('Absorption coefficients must be numbers between 0 and 1.');
  // Every surface needs a material or an explicit absorption. Without either, the solver has no coefficient for that
  // surface and used to fail after the job was queued (solver_failed). Reject up front; never substitute a default.
  if (wall === undefined && wAbs === undefined) return fail('wallMaterial or wallAbsorption is required.');
  if (floor === undefined && fAbs === undefined) return fail('floorMaterial or floorAbsorption is required.');
  if (ceil === undefined && cAbs === undefined) return fail('ceilMaterial or ceilAbsorption is required.');

  const request: ValidatedSolverRequest = {
    L: room.L, W: room.W, H: room.H,
    poly: polyResult.poly,
    wallSegMats: wallSegMats.wallSegMats,
    wallOpenings: wallOpenings.wallOpenings,
    steps: steps.steps,
    fmax: fmax.fmax,
    accuracyMode,
    confirmReducedResolution: body.confirmReducedResolution === true,
    exportWavefield: body.exportWavefield === true,
    sources: sources.points,
    receivers: receivers.points,
  };
  if (wall !== undefined) request.wallMaterial = wall;
  if (floor !== undefined) request.floorMaterial = floor;
  if (ceil !== undefined) request.ceilMaterial = ceil;
  if (wAbs !== undefined) request.wallAbsorption = wAbs;
  if (fAbs !== undefined) request.floorAbsorption = fAbs;
  if (cAbs !== undefined) request.ceilAbsorption = cAbs;
  if (typeof body.frequencyDependentBoundaries === 'boolean') request.frequencyDependentBoundaries = body.frequencyDependentBoundaries;
  if (projectName !== undefined) request.projectName = projectName;
  if (roomName !== undefined) request.roomName = roomName;
  return { ok: true, request };
}

/** Deterministic pre-flight estimate the API can use to reject before queueing. */
export function estimateSolverCost(req: Pick<ValidatedSolverRequest, 'L' | 'W' | 'H' | 'steps' | 'receivers' | 'frequencyDependentBoundaries'>, cells: number): {
  memoryBytes: number;
} {
  // Three Float32 pressure fields = 12 bytes/cell. Frequency-dependent boundaries
  // store seven states plus seven coefficients only on boundary cells.
  const dx = Math.cbrt((req.L * req.W * req.H) / Math.max(1, cells));
  const nx = Math.ceil(req.L / dx), ny = Math.ceil(req.H / dx), nz = Math.ceil(req.W / dx);
  const boundaryCells = Math.min(cells, 2 * (nx * nz + nx * ny + ny * nz));
  const boundaryBytes = req.frequencyDependentBoundaries ? (cells * 4) + boundaryCells * 7 * 4 * 2 : 0;
  const receiverBytes = req.receivers.length * req.steps * Float32Array.BYTES_PER_ELEMENT;
  return { memoryBytes: cells * 12 + boundaryBytes + receiverBytes + 75_000_000 };
}

// ---- Solver pre-flight (shared by the API and the worker) ------------------

export const SPEED_OF_SOUND_MS = 343;
export const POINTS_PER_WAVELENGTH: Readonly<Record<'fast' | 'balanced' | 'high', number>> = Object.freeze({ fast: 5, balanced: 9, high: 13 });

/**
 * Grid a wavefield run needs for the requested accuracy and fmax, BEFORE any
 * cap is applied. The worker uses this same function, so the API's early
 * rejection and the worker's decision can never disagree.
 */
export function waveGridRequirement(room: { L: number; W: number; H: number }, fmax: number, accuracyMode: 'fast' | 'balanced' | 'high') {
  const pointsPerWavelength = POINTS_PER_WAVELENGTH[accuracyMode];
  const requiredDx = SPEED_OF_SOUND_MS / (pointsPerWavelength * fmax);
  const requiredNx = Math.max(4, Math.ceil(room.L / requiredDx));
  const requiredNy = Math.max(4, Math.ceil(room.H / requiredDx));
  const requiredNz = Math.max(4, Math.ceil(room.W / requiredDx));
  return { pointsPerWavelength, requiredDx, requiredElements: requiredNx * requiredNy * requiredNz };
}

export type Preflight =
  | { ok: true; cells: number; memoryBytes: number }
  | { ok: false; kind: 'requires_confirmation'; error: string; details: { requestedFmax: number; supportedFmax: number; requiredElements: number; maxElements: number } }
  | { ok: false; kind: 'resource_limit'; error: string };

/**
 * Deterministic pre-queue check. For a wavefield run the FDTD grid is capped at
 * MAX_GRID_CELLS; a request that would need more must be explicitly confirmed
 * (reduced resolution) and is otherwise refused before it is ever queued.
 */
export function preflightSolver(req: ValidatedSolverRequest, kind: 'wave' | 'impulse-response'): Preflight {
  let cells = 0;
  if (kind === 'wave') {
    const g = waveGridRequirement(req, req.fmax, req.accuracyMode);
    if (exceedsGridLimit(g.requiredElements) && !req.confirmReducedResolution) {
      const supportedDx = Math.cbrt((req.L * req.W * req.H) / LIMITS.MAX_GRID_CELLS);
      return {
        ok: false, kind: 'requires_confirmation',
        error: `This accuracy needs ${g.requiredElements.toLocaleString('en-US')} grid cells, above the public limit of ${LIMITS.MAX_GRID_CELLS.toLocaleString('en-US')}. Confirm reduced resolution to continue.`,
        details: {
          requestedFmax: req.fmax,
          supportedFmax: SPEED_OF_SOUND_MS / (g.pointsPerWavelength * supportedDx),
          requiredElements: g.requiredElements,
          maxElements: LIMITS.MAX_GRID_CELLS,
        },
      };
    }
    cells = Math.min(g.requiredElements, LIMITS.MAX_GRID_CELLS);
  } else {
    cells = LIMITS.MAX_GRID_CELLS; // the IR solver sizes its own grid; budget for the ceiling
  }
  const { memoryBytes } = estimateSolverCost(req, cells);
  if (memoryBytes > LIMITS.MAX_SOLVER_MEMORY_BYTES) {
    return { ok: false, kind: 'resource_limit', error: 'The simulation exceeds the public resource limits.' };
  }
  return { ok: true, cells, memoryBytes };
}

// ---- Identifier formats shared by API, storage and tests -----------------

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
export const CAPABILITY_TOKEN_RE = /^[0-9a-f]{64}$/;
