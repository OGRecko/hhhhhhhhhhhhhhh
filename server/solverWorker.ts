import { parentPort, workerData } from 'worker_threads';
import { getInterpolatedMagnitude } from "./directivityParser.js";
import { SENSITIVITY_REFERENCE_DB } from "../src/lib/speakerResponse.js";
import { validatePolygon, validateWallOpenings, validateWallMaterials } from "../src/lib/publicLimits.js";

/** Message of a thrown value. Falls back to String(err) so an error without a message is never relabelled as something else. */
function errorMessageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string' && (err as { message: string }).message) return (err as { message: string }).message;
  return String(err);
}

function parseFiniteInRange(val: unknown, min: number, max: number, nameOrDef: string | number): number {
  const num = Number(val);
  if (Number.isFinite(num) && num >= min && num <= max) return num;
  if (typeof nameOrDef === "string") throw new Error(nameOrDef + " is invalid");
  return nameOrDef;
}

// Default solver memory ceiling (1.5 GB) used whenever MAX_SOLVER_MEMORY_BYTES
// is absent OR unusable.
export const DEFAULT_MAX_SOLVER_MEMORY_BYTES = 1500000000;

// Absolute ceiling on the solver's memory budget, regardless of how
// MAX_SOLVER_MEMORY_BYTES is configured. Without this, a value with an
// extra digit or two typed by mistake (or a malicious config) would sail
// straight through the Number.isFinite/parsed>0 validation below and be
// honored as-is, letting the solver attempt to allocate far more memory
// than any real instance has and OOM-kill the process - the same failure
// mode the validation immediately below exists to prevent for NaN/zero/
// negative input. Set well above the default (1.5 GB) so a deliberately
// raised ceiling for a larger instance is still honored - this guards
// against a config typo/attack, not against legitimate operators who
// have and want to use more memory than the default assumes.
export const HARD_MAX_SOLVER_MEMORY_BYTES = 8_000_000_000;

/** Bumped whenever numerical behaviour changes, so stored results remain traceable. */
export const SOLVER_VERSION = "1.3.0";

/**
 * Resolve the solver's memory ceiling from configuration.
 *
 * The previous form was:
 *   process.env.MAX_SOLVER_MEMORY_BYTES ? Number(...) : DEFAULT
 *
 * which only checked that the variable was *non-empty*, not that it was a
 * usable number. `MAX_SOLVER_MEMORY_BYTES=abc` is truthy, so it took the
 * configured branch and produced NaN. Every later guard is of the form
 * `estimatedMemoryBytes > maxMemoryBytes`, and any comparison against NaN is
 * false — so a typo in the environment silently DISABLED the memory guard
 * entirely rather than failing loudly, letting a request allocate
 * unbounded Float32Arrays and OOM-kill the process.
 *
 * Zero and negative values are equally unusable (0 would reject every
 * simulation; a negative ceiling is meaningless), and Infinity would again
 * mean "no limit". All of these fall back to the safe default: a
 * misconfiguration must never be able to weaken the protection.
 */
export function resolveMaxSolverMemoryBytes(
  raw?: string | undefined,
): number {
  const value = arguments.length > 0 ? raw : process.env.MAX_SOLVER_MEMORY_BYTES;
  if (value == null || String(value).trim() === "") return DEFAULT_MAX_SOLVER_MEMORY_BYTES;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[SOLVER] Ignoring invalid MAX_SOLVER_MEMORY_BYTES=${JSON.stringify(value)}; ` +
      `falling back to the safe default of ${DEFAULT_MAX_SOLVER_MEMORY_BYTES} bytes.`,
    );
    return DEFAULT_MAX_SOLVER_MEMORY_BYTES;
  }
  if (parsed > HARD_MAX_SOLVER_MEMORY_BYTES) {
    console.warn(
      `[SOLVER] MAX_SOLVER_MEMORY_BYTES=${JSON.stringify(value)} exceeds the hard ceiling of ` +
      `${HARD_MAX_SOLVER_MEMORY_BYTES} bytes; clamping to the ceiling.`,
    );
    return HARD_MAX_SOLVER_MEMORY_BYTES;
  }
  return parsed;
}

import { getAbsorption, getOctaveAbsorption } from "../src/lib/absorption.js";

// --- DSP Helpers ---
function getMinimumPhaseFIR(abs7: number[], Courant: number) {
  const M = 15;
  const N = 128;
  const Y_mag = new Float64Array(N);
  const bands = [125, 250, 500, 1000, 2000, 4000, 8000];
  const C_courant = Math.sqrt(Courant);
  
  for(let i=0; i<N; i++) {
    const f = (i / N) * 20000;
    let alpha = abs7[6];
    if (f <= bands[0]) alpha = abs7[0];
    else {
      for(let b=0; b<6; b++) {
        if (f >= bands[b] && f <= bands[b+1]) {
          const t = (f - bands[b]) / (bands[b+1] - bands[b]);
          alpha = abs7[b] * (1-t) + abs7[b+1] * t;
          break;
        }
      }
    }
    const R = Math.sqrt(Math.max(1 - alpha, 0));
    Y_mag[i] = C_courant * (1 - R) / (1 + R + 1e-9);
  }
  
  const c = new Float64Array(N);
  for(let n=0; n<N; n++) {
    let sum = 0;
    for(let m=0; m<N; m++) sum += Math.log(Math.max(Y_mag[m], 1e-9)) * Math.cos(2*Math.PI*m*n/N);
    c[n] = sum / N;
  }
  
  const c_folded = new Float64Array(N);
  c_folded[0] = c[0];
  for(let n=1; n<N/2; n++) c_folded[n] = 2 * c[n];
  c_folded[N/2] = c[N/2];
  
  const real = new Float64Array(N);
  const imag = new Float64Array(N);
  for(let m=0; m<N; m++) {
    let sumR = 0, sumI = 0;
    for(let n=0; n<N; n++) {
      sumR += c_folded[n] * Math.cos(-2*Math.PI*m*n/N);
      sumI += c_folded[n] * Math.sin(-2*Math.PI*m*n/N);
    }
    const e = Math.exp(sumR);
    real[m] = e * Math.cos(sumI);
    imag[m] = e * Math.sin(sumI);
  }
  
  const y_min = new Float32Array(M);
  for(let n=0; n<M; n++) {
    let sum = 0;
    for(let m=0; m<N; m++) sum += real[m] * Math.cos(2*Math.PI*m*n/N) - imag[m] * Math.sin(2*Math.PI*m*n/N);
    y_min[n] = sum / N;
  }
  return y_min;
}

function getOctaveAbsorptionArray(materialId: string, fallbackAbs: number) {
  const freqs = [125, 250, 500, 1000, 2000, 4000, 8000];
  return freqs.map(f => {
    // Note: getOctaveAbsorption must be available here.
    const a = getOctaveAbsorption(materialId, f);
    return a === 'N/A' ? fallbackAbs : Number(a);
  });
}



import { schroederCurve, computeEDT, computeT20, computeT30 } from "../src/lib/decay.js";
import { paramsFromEnergy } from "../src/lib/impulseResponseParams.js";
import { bandpassBiquad, applyBiquad, OCTAVE_BANDS_HZ, OCTAVE_BAND_LABELS } from "../src/lib/octaveFilter.js";
import { LIMITS, validateRoomDimensions, waveGridRequirement, exceedsGridLimit, POINTS_PER_WAVELENGTH, SPEED_OF_SOUND_MS } from "../src/lib/publicLimits.js";

// Aliases keep the numerical code below readable while every value comes from
// the ONE authoritative limits module (no duplicated literals).
const PUBLIC_MAX_STEPS = LIMITS.MAX_STEPS;
const PUBLIC_MAX_GRID_CELLS = LIMITS.MAX_GRID_CELLS;
const PUBLIC_MAX_ARTIFACT_BYTES = LIMITS.MAX_ARTIFACT_BYTES;
const PUBLIC_MAX_RECEIVERS = LIMITS.MAX_RECEIVERS;
const PUBLIC_MAX_SOURCES = LIMITS.MAX_SOURCES;
function validatePublicRoomDimensions(room: any) { return validateRoomDimensions(room); }

/**
 * Per-call solver limits. The DEFAULT is the public limit. The only way to use
 * different limits is to pass them as an explicit second argument to
 * runWave/runIR from in-process code (the numerical validation suite). The
 * worker-thread dispatch below never passes one and takes nothing from the
 * request payload, so a public caller cannot widen these.
 */
export interface SolverLimits {
  maxGridCells: number;
  maxSteps: number;
  maxArtifactBytes: number;
}
export const PUBLIC_SOLVER_LIMITS: SolverLimits = Object.freeze({
  maxGridCells: PUBLIC_MAX_GRID_CELLS,
  maxSteps: PUBLIC_MAX_STEPS,
  maxArtifactBytes: PUBLIC_MAX_ARTIFACT_BYTES,
});
function getAbsorptionAt500Hz(materialId: string): number {
  return getAbsorption(materialId).hz500;
}

/**
 * 3D CFL stability limit for the 7-point leapfrog scheme used by both
 * solvers, expressed as the SQUARE of the Courant number, because that is
 * the form the update equation actually multiplies by:
 *
 *     p_next = 2p - p_prev + (c*dt/dx)^2 * laplacian(p)
 *
 * Stability requires c*dt/dx <= 1/sqrt(3), i.e. (c*dt/dx)^2 <= 1/3.
 */
export const CFL_LIMIT_SQUARED = 1 / 3;

/**
 * Admission check run before either solver allocates or steps.
 *
 * Previously the CFL condition was only ever REPORTED (`cflStable` in the
 * config block) and never enforced, so an edit to the Courant constant — or
 * a dt derived inconsistently with it — would have silently run a divergent
 * simulation and returned the resulting garbage as a result. Refusing is the
 * only safe answer: an unstable explicit scheme does not produce a
 * degraded answer, it produces an exponentially growing one.
 */
export function assertCflStable(courantSquared: number): void {
  if (!Number.isFinite(courantSquared) || courantSquared <= 0) {
    throw new Error(
      `Solver misconfigured: Courant^2 must be a finite positive number, got ${courantSquared}.`,
    );
  }
  if (courantSquared > CFL_LIMIT_SQUARED) {
    throw new Error(
      `Solver refused: Courant^2 = ${courantSquared} exceeds the 3D CFL stability limit of ${CFL_LIMIT_SQUARED}. ` +
      `Running this configuration would diverge.`,
    );
  }
}

/**
 * Verify that the dt being reported describes the same physics the update
 * loop runs. dt and the Courant constant are two views of one quantity; if
 * they disagree, every "seconds" value downstream (RT60, arrival times,
 * trace duration) is mislabelled even though the field itself is fine.
 */
export function assertTimeStepConsistent(dt: number, dx: number, courantSquared: number, c: number = 343): void {
  const implied = Math.pow((c * dt) / dx, 2);
  if (!Number.isFinite(implied) || Math.abs(implied - courantSquared) > 1e-9 * Math.max(1, courantSquared)) {
    throw new Error(
      `Solver misconfigured: dt=${dt} with dx=${dx} implies Courant^2=${implied}, ` +
      `but the update loop uses ${courantSquared}.`,
    );
  }
}

/**
 * Zero-mean, band-limited excitation (Ricker / Mexican-hat wavelet).
 *
 * WHY NOT A SINGLE-SAMPLE IMPULSE
 * -------------------------------
 * The solvers used to start from `p[srcIdx] = 1.0` with `p_prev` all zeros.
 * That initial condition injects a NET VOLUME into a closed box, which
 * excites the discrete system's zero-frequency (spatially constant) mode.
 * For the leapfrog update that mode obeys p_next = 2p - p_prev, i.e. it
 * drifts LINEARLY in time and never decays:
 *
 *   - With rigid walls (alpha = 0) the total field energy grew without
 *     bound instead of being conserved: measured +30 dB over 3000 steps.
 *   - With absorbing walls the DC term settled onto a plateau that dwarfed
 *     the acoustic decay, so the receiver trace's energy was FLAT in time.
 *     Absorption changed the plateau's LEVEL but not its SLOPE.
 *
 * The visible consequences: every Schroeder fit returned UNAVAILABLE (the
 * raw trace showed no decay to fit), so `simulatedRt60` was null for every
 * room, and any test comparing "total energy" across alpha measured a level
 * shift while believing it had measured a decay rate.
 *
 * A Ricker wavelet is the second derivative of a Gaussian: its integral and
 * its first moment are both zero, so it injects no net volume and cannot
 * excite the DC mode. It is also band-limited, which suits the grid better
 * than a delta — a delta puts energy at every frequency up to Nyquist,
 * precisely where this scheme is most dispersive.
 *
 * f0 is tied to the grid's own reliable upper frequency so the excitation
 * never contains energy the mesh cannot carry.
 */
export function makeRickerSource(dt: number, reliableFmaxHz: number) {
  // Half the grid's reliable ceiling keeps essentially all of the wavelet's
  // energy inside the resolvable band.
  const f0 = Math.max(20, reliableFmaxHz * 0.5);
  // Delay the peak by one period so the wavelet starts from ~0 rather than
  // stepping discontinuously.
  const t0 = 1 / f0;
  const durationSteps = Math.max(1, Math.ceil((2 * t0) / dt));
  const k = Math.PI * Math.PI * f0 * f0;
  return {
    f0,
    t0,
    durationSteps,
    /** Wavelet amplitude at integer step `step` (t = step * dt). */
    at(step: number): number {
      const tau = step * dt - t0;
      const a = k * tau * tau;
      return (1 - 2 * a) * Math.exp(-a);
    },
  };
}

/**
 * Resolve the three surface absorption coefficients for a run.
 *
 * Normally these come from the material ids via the shared per-octave-band
 * table. A caller may instead supply explicit coefficients
 * (`wallAbsorption` / `floorAbsorption` / `ceilAbsorption`, each 0..1).
 *
 * This exists so a controlled experiment can hold everything constant and
 * vary ONLY alpha — the named materials give a scattered set of values
 * (0.05, 0.10, 0.85...) that conflates "absorption changed" with "which
 * material changed", and two of the ids the old tests used
 * ("painted_concrete", "concrete_painted") aren't in the table at all, so
 * they silently resolved to the 0.10 unknown-material fallback and the test
 * was not measuring what it claimed to measure.
 *
 * Anything non-finite or out of range falls back to the material lookup:
 * an override can select a valid coefficient, it can never inject a NaN
 * into the boundary update.
 */
export function resolveSurfaceAbsorption(payload: any): { wallAbs: number; floorAbs: number; ceilAbs: number } {
  const pick = (explicit: any, materialId: string): number => {
    const n = Number(explicit);
    if (explicit != null && Number.isFinite(n) && n >= 0 && n <= 1) return n;
    return getAbsorptionAt500Hz(materialId);
  };
  return {
    wallAbs: pick(payload?.wallAbsorption, payload?.wallMaterial),
    floorAbs: pick(payload?.floorAbsorption, payload?.floorMaterial),
    ceilAbs: pick(payload?.ceilAbsorption, payload?.ceilMaterial),
  };
}

/**
 * Speaker-model disclosure for the solver's config/inspector output.
 *
 * The room simulation remains speaker-agnostic by default. When a validated
 * directivity dataset is explicitly supplied on the source, the solver uses
 * that dataset only at octave bands with sufficiently close supplied frequency
 * data. Sensitivity and broadband frequency response are never invented or inferred from the speaker database.
 *
 * Per-speaker frequency-response shaping DOES exist (src/lib/speakerDSP.ts),
 * but it only drives the audition/preview tone in SpeakerPicker.tsx over
 * Web Audio — a separate signal path that never touches this solver.
 *
 * This is not itself a bug to "fix" by inventing a directivity model; a
 * fabricated per-speaker room response would be worse than an honest
 * disclosure. This object is that disclosure, so any caller (report
 * generator, Simulation Inspector, sim-result UI) can surface it wherever
 * speaker selection appears next to simulation results, instead of
 * implying the two are connected.
 */
function speakerDisclosure(payload: any) {
  const requested = payload?.speakerId ?? payload?.speaker?.id ?? null;
  const data = payload?.source?.directivityData;
  const directional = Boolean(payload?.source?.isDirectional && data);
  const frequencies = directional && Array.isArray(data.frequencies) ? data.frequencies.filter((v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0) : [];
  const bandCount = directional ? [125,250,500,1000,2000,4000,8000].filter(f => hasDirectivityCoverage(data, f)).length : 0;
  return {
    status: !directional ? "NOT_MODELED" as const : bandCount >= 3 ? "MODELED_FREQUENCY_DEPENDENT" as const : "MODELED_REPRESENTATIVE" as const,
    requestedSpeakerId: requested,
    directivityFrequencyBins: frequencies,
    directivityCoveredBands: bandCount,
    note: directional
      ? bandCount >= 3
        ? `This simulation uses the supplied frequency-dependent directivity dataset across ${bandCount} resolvable octave bands with source orientation. Bands without sufficiently close source data are left omnidirectional; no response is fabricated.`
        : `This simulation uses the supplied directivity data only where its frequency coverage is close enough to a requested octave band (${bandCount} covered band${bandCount === 1 ? '' : 's'}). Missing bands remain omnidirectional; no broadband response is fabricated.`
      : requested
        ? "No directivity dataset was supplied for this speaker, so the room simulation excites the room with an omnidirectional point source and does not use the speaker's frequency response or directivity (its frequency-response shaping exists only in the audition/preview tone). The speaker's sensitivity, when one is recorded, only scales the relative source level and the calibrated SPL estimate; if none is recorded, SPL is reported as unavailable."
        : "No speaker is selected and no directivity dataset was supplied, so the room simulation excites the room with an omnidirectional point source. Calibrated SPL is only available when a source has a recorded sensitivity."
  };
}





type SolverPolyPoint = { x: number; y: number };
type SolverWallOpening = 'full' | { start: number; end: number } | null;

function solverPointInPolygon(point: SolverPolyPoint, poly: SolverPolyPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    const cross = (b.x-a.x)*(point.y-a.y) - (b.y-a.y)*(point.x-a.x);
    const on = Math.abs(cross) < 1e-9 && point.x >= Math.min(a.x,b.x)-1e-9 && point.x <= Math.max(a.x,b.x)+1e-9 && point.y >= Math.min(a.y,b.y)-1e-9 && point.y <= Math.max(a.y,b.y)+1e-9;
    if (on) return true;
    if ((a.y > point.y) !== (b.y > point.y)) {
      const x = (b.x-a.x)*(point.y-a.y)/(b.y-a.y) + a.x;
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
}

function pointSegmentDistanceAndT(p: SolverPolyPoint, a: SolverPolyPoint, b: SolverPolyPoint) {
  const dx=b.x-a.x, dy=b.y-a.y;
  const den=dx*dx+dy*dy;
  const t=den>0 ? Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/den)) : 0;
  const q={x:a.x+t*dx,y:a.y+t*dy};
  return {distance:Math.hypot(p.x-q.x,p.y-q.y),t};
}

function nearestWallSide(point: SolverPolyPoint, poly: SolverPolyPoint[], openings: SolverWallOpening[]) {
  let best=-1, bestD=Infinity, bestT=0;
  for (let i=0;i<poly.length;i++) {
    const r=pointSegmentDistanceAndT(point,poly[i],poly[(i+1)%poly.length]);
    if (r.distance<bestD) { bestD=r.distance; best=i; bestT=r.t; }
  }
  if (best < 0) return -1;
  const o=openings[best] ?? null;
  if (o==='full' || (o && typeof o==='object' && bestT>=o.start-1e-6 && bestT<=o.end+1e-6)) return -2;
  return best;
}

interface FootprintGrid {
  inside: Uint8Array;
  xm: Int16Array; xp: Int16Array; zm: Int16Array; zp: Int16Array;
}

/** Rasterizes the editor footprint once. -1 means normal in-room neighbor, -2 an open edge, >=0 a wall segment. */
function buildFootprintGrid(poly: SolverPolyPoint[], openings: SolverWallOpening[], nx: number, nz: number): FootprintGrid {
  const size=nx*nz;
  const inside=new Uint8Array(size);
  const xm=new Int16Array(size), xp=new Int16Array(size), zm=new Int16Array(size), zp=new Int16Array(size);
  xm.fill(-1); xp.fill(-1); zm.fill(-1); zp.fill(-1);
  // Fill the complete mask first; neighbor classification must not depend on iteration order.
  for(let iz=0;iz<nz;iz++) for(let ix=0;ix<nx;ix++) {
    const k=iz*nx+ix;
    inside[k]=solverPointInPolygon({x:(ix+0.5)/nx,y:(iz+0.5)/nz},poly) ? 1 : 0;
  }
  for(let iz=0;iz<nz;iz++) for(let ix=0;ix<nx;ix++) {
    const k=iz*nx+ix;
    if(!inside[k]) continue;
    const q={x:(ix+0.5)/nx,y:(iz+0.5)/nz};
    const checks:[Int16Array,number,number][]=[[xm,ix-1,iz],[xp,ix+1,iz],[zm,ix,iz-1],[zp,ix,iz+1]];
    for(const [arr,nx2,nz2] of checks) {
      const outside=nx2<0 || nx2>=nx || nz2<0 || nz2>=nz || !inside[nz2*nx+nx2];
      if(!outside) continue;
      const q2={x:(nx2+0.5)/nx,y:(nz2+0.5)/nz};
      arr[k]=nearestWallSide({x:(q.x+q2.x)/2,y:(q.y+q2.y)/2},poly,openings);
    }
  }
  return {inside,xm,xp,zm,zp};
}
// Compute the 500 Hz analytical Sabine cross-check from the exact simulated footprint.
// Open wall spans are removed from the absorbing wall area; in the time-domain
// solver those spans use an absorbing (pressure-release/radiation) boundary
// approximation so they do not behave like rigid missing-wall reflections.
function computeFootprintSabins500(payload:any, roomL:number, roomW:number, roomH:number, floorAbs:number, ceilAbs:number, wallFallbackAbs:number) {
  const footprint = validateSolverFootprint(payload);
  const area = Math.abs(footprint.poly.reduce((a,p,i)=>{const q=footprint.poly[(i+1)%footprint.poly.length]; return a+p.x*q.y-q.x*p.y;},0))/2 * roomL * roomW;
  const wallSegments = footprint.poly.map((p,i)=>{
    const q=footprint.poly[(i+1)%footprint.poly.length];
    const fullLength=Math.hypot((q.x-p.x)*roomL,(q.y-p.y)*roomW);
    const o=footprint.openings[i];
    const openFraction=o==='full'?1:(o&&typeof o==='object'?Math.max(0,Math.min(1,o.end-o.start)):0);
    const effectiveLength=fullLength*(1-openFraction);
    const openingLength=fullLength-effectiveLength;
    const mat=payload.wallSegMats?.[i] || payload.wallMaterial;
    const explicitWallAbs = payload.wallAbsorption != null && Number.isFinite(Number(payload.wallAbsorption)) && Number(payload.wallAbsorption) >= 0 && Number(payload.wallAbsorption) <= 1
      ? Number(payload.wallAbsorption) : null;
    const a=explicitWallAbs !== null ? explicitWallAbs : getOctaveAbsorption(mat,500);
    const alpha=a==='N/A'?wallFallbackAbs:Number(a);
    return {area:effectiveLength*roomH, openingArea:openingLength*roomH, alpha};
  });
  const wallSabins=wallSegments.reduce((sum,w)=>sum+w.area*w.alpha+w.openingArea,0);
  const floorArea=area, ceilArea=area, volume=area*roomH;
  const totalSabins=wallSabins+floorArea*floorAbs+ceilArea*ceilAbs;
  return {footprint, floorArea, ceilArea, volume, wallArea:wallSegments.reduce((a,w)=>a+w.area+w.openingArea,0), totalSabins};
}

function validateSolverFootprint(payload:any): {poly: SolverPolyPoint[]; openings: SolverWallOpening[]} {
  // Same validators as the API, so the worker can never accept a model the API would reject
  // (self-intersecting polygons, wrong-length wallOpenings / wallSegMats are errors, never "repaired").
  const rawPoly = Array.isArray(payload.poly) ? payload.poly : [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
  const pr = validatePolygon(rawPoly);
  if (!pr.ok) throw new Error(pr.error);
  const orr = validateWallOpenings(payload.wallOpenings, pr.poly.length);
  if (!orr.ok) throw new Error(orr.error);
  const mr = validateWallMaterials(payload.wallSegMats, pr.poly.length);
  if (!mr.ok) throw new Error(mr.error);
  return {poly: pr.poly as SolverPolyPoint[], openings: orr.wallOpenings as SolverWallOpening[]};
}

function worldToLocalDirection(dx: number, dy: number, dz: number, source: any) {
  const yawDeg = Number(source?.yawDeg);
  const pitchDeg = Number(source?.pitchDeg);
  const rollDeg = Number(source?.rollDeg);
  const yaw = (Number.isFinite(yawDeg) ? yawDeg : 0) * Math.PI / 180;
  const pitch = (Number.isFinite(pitchDeg) ? pitchDeg : 0) * Math.PI / 180;
  const roll = (Number.isFinite(rollDeg) ? rollDeg : 0) * Math.PI / 180;
  // Apply inverse Z-X-Y Euler rotation to transform a world direction into
  // the speaker's local coordinate system. Directivity files define +Y as
  // forward, so the azimuth convention below matches directivityParser.ts.
  const cy=Math.cos(yaw), sy=Math.sin(yaw);
  let x = cy*dx + sy*dy;
  let y = -sy*dx + cy*dy;
  let z = dz;
  const cp=Math.cos(pitch), sp=Math.sin(pitch);
  const x2=cp*x - sp*z;
  const z2=sp*x + cp*z;
  x=x2; z=z2;
  const cr=Math.cos(roll), sr=Math.sin(roll);
  const y2=cr*y + sr*z;
  const z3=-sr*y + cr*z;
  return {x, y:y2, z:z3};
}

function hasDirectivityCoverage(data: any, frequencyHz: number): boolean {
  const freqs = Array.isArray(data?.frequencies) ? data.frequencies.filter((v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0) : [];
  if (!freqs.length) return false;
  let best = Infinity;
  for (const f of freqs) best = Math.min(best, Math.abs(Math.log2(f / frequencyHz)));
  // Accept a source polar dataset when it is within half an octave of the
  // requested band; otherwise do not silently reuse an unrelated frequency.
  return best <= 0.5;
}

/**
 * Maps a requested source position to a grid node.
 *
 * The position must be valid: x,y are finite numbers in [0,1] (fractions of the footprint box) and z is a finite
 * number of metres in [0,H]. Anything else is REFUSED. It is never clamped to a different position and never
 * replaced by a default, because a result for a source that is not where the user put it is a wrong result.
 * (An omitted z is the documented 0.7*H default; the public request validator applies the same default.)
 *
 * The stencil and source injection only operate on interior nodes, so a source on a wall, the floor or the ceiling
 * is placed on the nearest interior node, i.e. at most one cell from where it was requested. Reported distances and
 * delays use the requested continuous coordinates (see sourceWorldPosition), as they do for receivers.
 */
export function resolveSourceGridNode(src: any, nx: number, ny: number, nz: number, roomH: number): { srcIx: number; srcIy: number; srcIz: number } {
  const w = sourceWorldFractions(src, roomH);
  const inner = (i: number, n: number) => Math.min(n - 2, Math.max(1, i));
  return {
    srcIx: inner(Math.round(w.x * (nx - 1)), nx),
    srcIy: inner(Math.round((w.z / roomH) * (ny - 1)), ny),
    srcIz: inner(Math.round(w.y * (nz - 1)), nz),
  };
}

/**
 * Z placement when a request omits it. These are the ONLY places the solver substitutes a height, and every
 * substitution is reported in the result's `positionAssumptions` (and the PDF report) instead of being silent.
 * An explicit z of 0 is a real height (floor level) and is never treated as missing.
 */
export const ASSUMED_SOURCE_Z_FRACTION = 0.7;
export const ASSUMED_RECEIVER_Z_FRACTION = 0.5;

export interface PositionAssumption {
  kind: 'source' | 'receiver';
  /** The point's id when it has one, else null. */
  id: string | null;
  /** Index within the request's sources / receivers. */
  index: number;
  axis: 'z';
  /** The height (m) the solver actually used. */
  assumedMeters: number;
  rule: string;
}

const zIsMissing = (p: unknown): boolean => {
  if (typeof p !== 'object' || p === null) return true;
  const z = (p as { z?: unknown }).z;
  return z === undefined || z === null;
};
const pointId = (p: unknown): string | null => {
  const id = typeof p === 'object' && p !== null ? (p as { id?: unknown }).id : undefined;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
};

/** Height (m) used for a receiver: its own z (including 0) when given, otherwise the documented assumption. */
export function receiverZMeters(receiver: unknown, roomH: number): number {
  return zIsMissing(receiver) ? ASSUMED_RECEIVER_Z_FRACTION * roomH : Number((receiver as { z: unknown }).z);
}

/** Lists every source/receiver whose z was absent and therefore placed by assumption. Empty when all z were explicit. */
export function collectPositionAssumptions(sources: readonly unknown[], receivers: readonly unknown[], roomH: number): PositionAssumption[] {
  const out: PositionAssumption[] = [];
  sources.forEach((s, index) => {
    if (zIsMissing(s)) out.push({ kind: 'source', id: pointId(s), index, axis: 'z', assumedMeters: ASSUMED_SOURCE_Z_FRACTION * roomH, rule: `source Z not supplied; placed at ${ASSUMED_SOURCE_Z_FRACTION} x room height` });
  });
  receivers.forEach((r, index) => {
    if (zIsMissing(r)) out.push({ kind: 'receiver', id: pointId(r), index, axis: 'z', assumedMeters: ASSUMED_RECEIVER_Z_FRACTION * roomH, rule: `receiver Z not supplied; placed at ${ASSUMED_RECEIVER_Z_FRACTION} x room height` });
  });
  return out;
}

/** Validated requested source position: x,y as footprint fractions, z in metres. Throws on anything invalid. */
function sourceWorldFractions(src: any, roomH: number): { x: number; y: number; z: number } {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const x = num(src?.x), y = num(src?.y);
  const z = src?.z === undefined || src?.z === null ? ASSUMED_SOURCE_Z_FRACTION * roomH : num(src.z);
  if (x === null || y === null || z === null || x < 0 || x > 1 || y < 0 || y > 1 || z < 0 || z > roomH) {
    throw new Error('Invalid source position: coordinates must be finite numbers within room bounds.');
  }
  return { x, y, z };
}

function computeInjectionNodes(
  source: any,
  srcIx: number,
  srcIy: number,
  srcIz: number,
  nx: number,
  ny: number,
  nz: number,
  nxz: number,
  frequencyHz = 1000
) {
  const injectionNodes: { idx: number, weight: number }[] = [];
  const safeSrcIdx = Math.min(Math.max(srcIy * nxz + srcIz * nx + srcIx, 0), nx * ny * nz - 1);

  if (source && source.isDirectional && source.directivityData && hasDirectivityCoverage(source.directivityData, frequencyHz)) {
    let sumWeights = 0;
    const rMax = 4;
    for (let dy = -rMax; dy <= rMax; dy++) {
      for (let dz = -rMax; dz <= rMax; dz++) {
        for (let dx2 = -rMax; dx2 <= rMax; dx2++) {
          const iy = srcIy + dy;
          const iz = srcIz + dz;
          const ix = srcIx + dx2;
          
          if (ix > 0 && ix < nx - 1 && iy > 0 && iy < ny - 1 && iz > 0 && iz < nz - 1) {
            const r = Math.sqrt(dx2*dx2 + dy*dy + dz*dz);
            if (r > 0 && r <= rMax) {
              const local = worldToLocalDirection(dx2, dy, dz, source);
              const az = Math.atan2(local.x, local.y) * (180 / Math.PI);
              const el = Math.asin(Math.max(-1, Math.min(1, local.z / r))) * (180 / Math.PI);
              const dbMag = getInterpolatedMagnitude(source.directivityData, frequencyHz, az, el);
              const weight = Math.pow(10, dbMag / 20) / (r * r);
              injectionNodes.push({ idx: iy * nxz + iz * nx + ix, weight });
              sumWeights += weight;
            }
          }
        }
      }
    }
    if (sumWeights > 0) {
      for (const node of injectionNodes) {
        node.weight /= sumWeights;
      }
    } else {
      injectionNodes.push({ idx: safeSrcIdx, weight: 1.0 });
    }
  } else {
    injectionNodes.push({ idx: safeSrcIdx, weight: 1.0 });
  }

  return injectionNodes;
}


/**
 * Strict numeric reader. `Number(null)` and `Number('')` are 0, which would turn a missing value into a
 * legitimate-looking 0; only real finite numbers (or numeric strings) are accepted here.
 */
function strictFinite(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}

/**
 * Source sensitivity (dB SPL @ 1 W / 1 m) using the SAME validity rule as resolveSensitivity() in
 * src/lib/speakerResponse.ts: a finite number > 0. Returns null when the source has no usable value; no
 * sensitivity is ever invented here.
 */
function sourceSensitivityDb(source: { sensitivityDb?: unknown; sens?: unknown } | null | undefined): number | null {
  const v = strictFinite(source?.sensitivityDb ?? source?.sens);
  return v !== null && v > 0 ? v : null;
}

/**
 * Source gain in dB, or null when it is not usable. A missing gain is 0 dB (a legitimate default and a valid
 * value). The range is the SAME one the public API enforces (LIMITS), so the worker rejects what the API
 * would, instead of turning e.g. +1e9 dB into Infinity and filling the impulse response with NaN/Infinity.
 */
function sourceGainDb(source: { gainDb?: unknown } | null | undefined): number | null {
  const raw = source?.gainDb;
  const gain = raw === undefined || raw === null ? 0 : strictFinite(raw);
  if (gain === null || gain < LIMITS.MIN_SOURCE_GAIN_DB || gain > LIMITS.MAX_SOURCE_GAIN_DB) return null;
  return gain;
}

function sourceGainLinear(source: { id?: unknown; gainDb?: unknown; sensitivityDb?: unknown; sens?: unknown } | null | undefined): number {
  const gain = sourceGainDb(source);
  if (gain === null) throw new Error(`Invalid source gainDb for source ${String(source?.id)}: must be a finite number between ${LIMITS.MIN_SOURCE_GAIN_DB} and ${LIMITS.MAX_SOURCE_GAIN_DB} dB.`);
  // FDTD excitation remains a numerical field. Sensitivity is used only as a relative source-strength
  // reference (relative to SENSITIVITY_REFERENCE_DB, the resolver's unity reference). A source without a
  // usable sensitivity contributes at the reference (no sensitivity scaling); estimateCalibratedSplDb()
  // then reports SPL as unavailable rather than assuming a value.
  const sensitivity = sourceSensitivityDb(source);
  const offsetDb = sensitivity === null ? 0 : sensitivity - SENSITIVITY_REFERENCE_DB;
  return Math.pow(10, (offsetDb + gain) / 20);
}

function estimateCalibratedSplDb(sources: any[], receiver: any, roomL: number, roomW: number, roomH: number): number | null {
  // All-or-nothing: an SPL summed over only the sources that happen to have a sensitivity would silently
  // omit the others, so any audible source without a usable sensitivity makes the whole value unavailable.
  const rx = strictFinite(receiver?.x), ry = strictFinite(receiver?.y);
  if (rx === null || ry === null) return null;
  const rzRaw = receiver?.z === undefined || receiver?.z === null ? ASSUMED_RECEIVER_Z_FRACTION * roomH : strictFinite(receiver.z); // same placement convention as the solver
  if (rzRaw === null) return null;
  const pressures: number[] = [];
  for (const source of sources) {
    if (source?.muted === true) continue;
    const sens = sourceSensitivityDb(source);
    if (sens === null) return null;
    const powerRaw = source?.referencePowerW === undefined || source?.referencePowerW === null ? 1 : strictFinite(source.referencePowerW); // sensitivity is defined at 1 W
    if (powerRaw === null || powerRaw < 0) return null;
    const gainRaw = sourceGainDb(source);
    if (gainRaw === null) return null;
    const sw = sourceWorldFractions(source, roomH); // strict: the same validated position the solver placed
    const d = Math.max(1, Math.hypot(rx * roomL - sw.x * roomL, ry * roomW - sw.y * roomW, rzRaw - sw.z));
    if (powerRaw === 0) { pressures.push(0); continue; } // zero drive power is a valid, silent source
    const spl = sens + 10 * Math.log10(powerRaw) + gainRaw - 20 * Math.log10(d);
    pressures.push(Math.pow(10, spl / 20));
  }
  if (!pressures.length) return null;
  const sum = pressures.reduce((acc, v) => acc + v, 0);
  return sum > 0 ? 20 * Math.log10(sum) : null;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map(k => JSON.stringify(k)+':'+stableSerialize(record[k])).join(',') + '}';
}
function requestFingerprint(payload: any): string {
  const raw = stableSerialize({
    L:payload.L,W:payload.W,H:payload.H,poly:payload.poly,wallMaterial:payload.wallMaterial,wallSegMats:payload.wallSegMats,wallOpenings:payload.wallOpenings,
    floorMaterial:payload.floorMaterial,ceilMaterial:payload.ceilMaterial,steps:payload.steps,fmax:payload.fmax,accuracyMode:payload.accuracyMode,
    frequencyDependentBoundaries:payload.frequencyDependentBoundaries,sources:payload.sources,receivers:payload.receivers
  });
  let h=2166136261; for(let i=0;i<raw.length;i++){ h^=raw.charCodeAt(i); h=Math.imul(h,16777619); }
  return (h>>>0).toString(16).padStart(8,'0');
}

export function runWave(payload: any, limits: SolverLimits = PUBLIC_SOLVER_LIMITS) {
  const { elements, steps, L, W, H, wallMaterial, floorMaterial, ceilMaterial, source, receiver } = payload;

  // Public mode hard cap on grid cells, independent of any client-side budget hint.
  const hardCap = limits.maxGridCells;
  const MAX_PUBLIC_ARTIFACT_BYTES = limits.maxArtifactBytes;
  const MAX_PUBLIC_WAVEFIELD_BYTES = MAX_PUBLIC_ARTIFACT_BYTES;
  
  const roomL = Number(L);
  const roomW = Number(W);
  const roomH = Number(H);
  const roomValidation = validatePublicRoomDimensions({ L: roomL, W: roomW, H: roomH });
  if ('error' in roomValidation) throw new Error(roomValidation.error);

  const accuracyMode = String(payload.accuracyMode || 'balanced');
  const useFrequencyDependent = payload.frequencyDependentBoundaries === true;
  if (!Object.prototype.hasOwnProperty.call(POINTS_PER_WAVELENGTH, accuracyMode)) {
    throw new Error("accuracyMode must be fast, balanced, or high.");
  }

  const targetFmax = payload.fmax == null ? 500 : Number(payload.fmax);
  if (!Number.isFinite(targetFmax) || targetFmax <= 0 || targetFmax > 24000) {
    throw new Error("fmax must be a finite frequency between 1 Hz and 24 kHz.");
  }

  const rawSteps = payload.steps == null ? 40 : Number(payload.steps);
  if (!Number.isFinite(rawSteps) || !Number.isInteger(rawSteps) || rawSteps < 1 || rawSteps > limits.maxSteps) {
    throw new Error(`steps must be an integer between 1 and ${limits.maxSteps}.`);
  }
  const numStepsRequested = rawSteps;
  const speedOfSound = SPEED_OF_SOUND_MS;

  // The SAME function the API uses to pre-flight the request.
  const { pointsPerWavelength, requiredDx, requiredElements } =
    waveGridRequirement({ L: roomL, W: roomW, H: roomH }, targetFmax, accuracyMode as 'fast' | 'balanced' | 'high');

  if (requiredElements > hardCap && !payload.confirmReducedResolution) {
      const supportedElements = hardCap;
      const actualFmax = speedOfSound / (pointsPerWavelength * Math.cbrt((roomL * roomW * roomH) / supportedElements));
      
      throw new Error(JSON.stringify({
          requiresConfirmation: true,
          message: `Requested ${targetFmax} Hz simulation at ${accuracyMode.toUpperCase()} accuracy requires ${requiredElements.toLocaleString()} elements, which exceeds the public safe limit of ${hardCap.toLocaleString()}.

Current configuration safely supports up to ~${Math.round(actualFmax)} Hz.

Continue with reduced resolution?`,
          requestedFmax: targetFmax,
          supportedFmax: actualFmax,
          requestedResolution: requiredDx,
          supportedResolution: Math.cbrt((roomL * roomW * roomH) / supportedElements),
          estimatedMemoryMb: Math.round(supportedElements * 4 * 3 / 1024 / 1024),
      }));
  }
  
  let dx = requiredDx;
  if (requiredElements > hardCap) {
    const rawCellVolume = (roomL * roomH * roomW) / hardCap;
    dx = Math.cbrt(rawCellVolume);
  }
  dx = Math.max(dx, 0.02); // absolute 2 cm cell floor

  let nx = Math.max(4, Math.round(roomL / dx));
  let ny = Math.max(4, Math.round(roomH / dx));
  let nz = Math.max(4, Math.round(roomW / dx));
  let N = nx * ny * nz;

  // Rounding can push the actual grid slightly above the element budget.
  // Increase the cell size until the FINAL allocated grid is within the cap.
  if (N > hardCap) {
    dx = Math.max(dx, Math.cbrt((roomL * roomW * roomH) / hardCap));
    nx = Math.max(4, Math.floor(roomL / dx));
    ny = Math.max(4, Math.floor(roomH / dx));
    nz = Math.max(4, Math.floor(roomW / dx));
    N = nx * ny * nz;
  }
  if (!Number.isFinite(N) || isNaN(N) || N <= 0 || N > hardCap) {
    throw new Error(JSON.stringify({ error: "The final FDTD grid exceeds the server safety limit." }));
  }

  // Pre-allocation memory safety check: verify total solver memory budget BEFORE allocating arrays.
  const receiversPayloadPre = payload.receivers || (payload.receiver ? [payload.receiver] : []);
  const numStepsPre = numStepsRequested;
  const boundaryCellsEstimate = Math.min(N, 2 * (nx * nz + nx * ny + ny * nz));
  const boundaryStateBytes = useFrequencyDependent ? (N * Int32Array.BYTES_PER_ELEMENT) + boundaryCellsEstimate * OCTAVE_BANDS_HZ.length * Float32Array.BYTES_PER_ELEMENT * 2 : 0;
  const estimatedMemoryBytes = N * 12 + boundaryStateBytes + (receiversPayloadPre.length * numStepsPre * Float32Array.BYTES_PER_ELEMENT) + 75_000_000;
  const maxMemoryBytes = resolveMaxSolverMemoryBytes();
  if (estimatedMemoryBytes > maxMemoryBytes) {
    throw new Error("Simulation exceeds available system memory budget. Reduce resolution or duration.");
  }

  // Report capability from the ACTUAL final grid spacing, not a theoretical
  // element-volume estimate that can differ after rounding/clamping.
  const actualFmax = speedOfSound / (pointsPerWavelength * dx);
  const numSteps = numStepsRequested;
  if (numSteps > limits.maxSteps) {
    throw new Error(`Public simulations are limited to ${limits.maxSteps} time steps.`);
  }
  const reducedResolution = actualFmax + 1e-9 < targetFmax;
  const nxz = nx * nz;
  const footprint = validateSolverFootprint(payload);
  const footprintGrid = buildFootprintGrid(footprint.poly, footprint.openings, nx, nz);
  const roomInside = footprintGrid.inside;

  // Per-surface absorption -> boundary damping. The broadband path uses the
  // shared 500 Hz reference coefficient; when frequencyDependentBoundaries is
  // enabled below, the solver uses the complete seven-band table and persistent
  // causal boundary states instead of collapsing the material to one number.
  const { wallAbs, floorAbs, ceilAbs } = resolveSurfaceAbsorption(payload);
  // Reflection coefficient per boundary: sqrt(1 - absorption) is the usual
  // pressure-reflection approximation from the energy absorption coefficient.
  const wallRefl = Math.sqrt(Math.max(1 - wallAbs, 0));
  const floorRefl = Math.sqrt(Math.max(1 - floorAbs, 0));
  const ceilRefl = Math.sqrt(Math.max(1 - ceilAbs, 0));

  const receiversPayload = payload.receivers || (payload.receiver ? [payload.receiver] : []);
  if (receiversPayload.length === 0 || receiversPayload.length > PUBLIC_MAX_RECEIVERS) {
    throw new Error(`Simulation must have between 1 and ${PUBLIC_MAX_RECEIVERS} receivers.`);
  }
  const MAX_RECEIVERS = PUBLIC_MAX_RECEIVERS;

  if (source === undefined || source === null) throw new Error('Simulation must have a source (source is required).');
  const { srcIx, srcIy, srcIz } = resolveSourceGridNode(source, nx, ny, nz, roomH);
  const srcIdx = srcIy * nxz + srcIz * nx + srcIx;

  const receiverIndices = receiversPayload.map((r: any) => {
    if (r?.x == null || !Number.isFinite(Number(r.x)) || Number(r.x) < 0 || Number(r.x) > 1 ||
        r?.y == null || !Number.isFinite(Number(r.y)) || Number(r.y) < 0 || Number(r.y) > 1 ||
        (r?.z != null && (!Number.isFinite(Number(r.z)) || Number(r.z) < 0 || Number(r.z) > roomH))) {
      throw new Error("Invalid receiver position: coordinates must be finite numbers within room bounds.");
    }
    const recX = Number(r.x), recZ = Number(r.y);
    const recIx = Math.round(recX * (nx - 1));
    const recIy = Math.round((receiverZMeters(r, roomH) / roomH) * (ny - 1));
    const recIz = Math.round(recZ * (nz - 1));
    if (recIx < 0 || recIx >= nx || recIy < 0 || recIy >= ny || recIz < 0 || recIz >= nz || !roomInside[recIz * nx + recIx]) {
      throw new Error("Invalid receiver position: placed outside the room footprint.");
    }
    return Math.max(0, Math.min(N - 1, recIy * nxz + recIz * nx + recIx));
  });

  try {
    if (isNaN(N) || !isFinite(N) || N <= 0) throw new Error("Invalid geometry calculations resulted in NaN/Infinity elements.");
    if (srcIx < 0 || srcIx >= nx || srcIy < 0 || srcIy >= ny || srcIz < 0 || srcIz >= nz || !roomInside[srcIz * nx + srcIx]) {
      throw new Error("Invalid source position: placed outside the room footprint.");
    }

    console.log(`[WAVE SOLVER] Room ${roomL}x${roomW}x${roomH}m -> FDTD grid ${nx}x${ny}x${nz} (${N.toLocaleString()} elements, dx=${dx.toFixed(3)}m). Steps: ${numSteps}. Receivers: ${receiverIndices.length}`);

    const boundaryCellsEstimate = Math.min(N, 2 * (nx * nz + nx * ny + ny * nz));
    const boundaryStateBytes = useFrequencyDependent ? (N * Int32Array.BYTES_PER_ELEMENT) + boundaryCellsEstimate * OCTAVE_BANDS_HZ.length * Float32Array.BYTES_PER_ELEMENT * 2 : 0;
    const estimatedMemoryBytes = N * 12 + boundaryStateBytes + (receiverIndices.length * numSteps * Float32Array.BYTES_PER_ELEMENT) + 75_000_000;
    const maxMemoryBytes = resolveMaxSolverMemoryBytes();
    if (estimatedMemoryBytes > maxMemoryBytes) {
      throw new Error("Simulation exceeds available system memory budget. Reduce resolution or duration.");
    }
    const startTime = Date.now();

    const p_prev = new Float32Array(N);
    const p = new Float32Array(N);
    const p_next = new Float32Array(N);

    const Courant = 0.1;
    const dt = (dx * Math.sqrt(Courant)) / 343;
    assertCflStable(Courant);
    assertTimeStepConsistent(dt, dx, Courant, speedOfSound);
    const excitation = makeRickerSource(dt, actualFmax);
    const directionalBands = [125, 250, 500, 1000, 2000, 4000, 8000].filter(f => f < (1 / dt) / 2);
    const injectionBands = directionalBands.map(freqHz => {
      const nodes = computeInjectionNodes(source, srcIx, srcIy, srcIz, nx, ny, nz, nxz, freqHz);
      const raw = new Array<number>(excitation.durationSteps);
      for (let i=0;i<raw.length;i++) raw[i] = excitation.at(i);
      const filtered = applyBiquad(raw, bandpassBiquad(freqHz, 1 / dt, Math.SQRT1_2));
      return { freqHz, nodes, filtered };
    });
    const injectionNodes = computeInjectionNodes(source, srcIx, srcIy, srcIz, nx, ny, nz, nxz, 1000);
    
          const receiverTraces: number[][] = receiverIndices.map(() => []);

      const exportWavefield = payload.exportWavefield === true;
      if (exportWavefield) {
        const wavefieldStride = Math.max(1, Math.floor(numSteps / 60));
        const frameCount = Math.ceil(numSteps / wavefieldStride);
        const estimatedWavefieldBytes = frameCount * nx * nz * Float32Array.BYTES_PER_ELEMENT;
        const estimatedTraceBytes = receiverIndices.length * numSteps * Float32Array.BYTES_PER_ELEMENT;
        if (estimatedWavefieldBytes + estimatedTraceBytes > MAX_PUBLIC_ARTIFACT_BYTES) {
          throw new Error("Wavefield export exceeds the public artifact-size limit. Reduce resolution or disable wavefield export.");
        }
      }
      const wavefieldFrames: Float32Array[] = [];
      const wavefieldStride = Math.max(1, Math.floor(numSteps / 60));
      const wavefieldSliceY = Math.round(ny / 2);
      if (exportWavefield && parentPort) {
        parentPort.postMessage({ type: 'expected_frames', count: Math.ceil(numSteps / wavefieldStride) });
      }


    let boundaryBandState: Float32Array | null = null;
    let boundaryBandIndex: Int32Array | null = null;
    let boundaryBandBeta: Float32Array | null = null;
    
    const C_courant = Math.sqrt(Courant);
    const bands = OCTAVE_BANDS_HZ;
    const bandPoles = bands.map(f => Math.exp(-2 * Math.PI * f * dt));
    const betaForAbsorption = (alpha: number) => {
      const R = Math.sqrt(Math.max(1 - alpha, 0));
      return C_courant * (1 - R) / (1 + R + 1e-9);
    };
    const explicitWallAbs = payload.wallAbsorption != null && Number.isFinite(Number(payload.wallAbsorption)) && Number(payload.wallAbsorption) >= 0 && Number(payload.wallAbsorption) <= 1 ? Number(payload.wallAbsorption) : null;
    const explicitFloorAbs = payload.floorAbsorption != null && Number.isFinite(Number(payload.floorAbsorption)) && Number(payload.floorAbsorption) >= 0 && Number(payload.floorAbsorption) <= 1 ? Number(payload.floorAbsorption) : null;
    const explicitCeilAbs = payload.ceilAbsorption != null && Number.isFinite(Number(payload.ceilAbsorption)) && Number(payload.ceilAbsorption) >= 0 && Number(payload.ceilAbsorption) <= 1 ? Number(payload.ceilAbsorption) : null;
    const bandBetasForMaterial = (materialId: string | undefined, explicit: number | null) => {
      const out = new Float32Array(bands.length);
      for (let k = 0; k < bands.length; k++) {
        const a = explicit !== null ? explicit : getOctaveAbsorption(materialId || '', bands[k]);
        if (a !== 'N/A') out[k] = betaForAbsorption(Number(a));
      }
      return out;
    };
    const wallBandBetas = bandBetasForMaterial(payload.wallMaterial, explicitWallAbs);
    const floorBandBetas = bandBetasForMaterial(payload.floorMaterial, explicitFloorAbs);
    const ceilBandBetas = bandBetasForMaterial(payload.ceilMaterial, explicitCeilAbs);
    const segmentBandBetas = footprint.poly.map((_, seg) => bandBetasForMaterial(payload.wallSegMats?.[seg] || payload.wallMaterial, explicitWallAbs));
    const wallBeta500 = betaForAbsorption(wallAbs);
    const floorBeta500 = betaForAbsorption(floorAbs);
    const ceilBeta500 = betaForAbsorption(ceilAbs);
    // Per-segment 500 Hz beta must reflect wallSegMats/explicit overrides the
    // same way the frequency-dependent path (segmentBandBetas, above) already
    // does. Previously this filled every segment with the single global
    // wallBeta500, so a per-wall material override or explicit absorption
    // override had zero effect on the broadband (non-frequency-dependent)
    // solver path, which is the default and what most simulations use.
    const segmentBeta500 = footprint.poly.map((_, seg) => {
      const matId = payload.wallSegMats?.[seg] || payload.wallMaterial;
      const a = explicitWallAbs !== null ? explicitWallAbs : getAbsorptionAt500Hz(matId);
      return betaForAbsorption(Number(a));
    });
    const sideBeta = (side: number) => side >= 0 ? { b0: segmentBeta500[side] ?? wallBeta500 } : { b0: 0 };

    if (useFrequencyDependent) {
      const boundaryIndices: number[] = [];
      const betaRows: number[] = [];
      for (let iy = 0; iy < ny; iy++) {
        for (let iz = 0; iz < nz; iz++) {
          for (let ix = 0; ix < nx; ix++) {
            const fi = iz * nx + ix;
            if (!roomInside[fi]) continue;
            const idx = iy * nxz + iz * nx + ix;
            const isBoundary = ix === 0 || ix === nx - 1 || iz === 0 || iz === nz - 1 || iy === 0 || iy === ny - 1 || footprintGrid.xm[fi] >= -2 || footprintGrid.xp[fi] >= -2 || footprintGrid.zm[fi] >= -2 || footprintGrid.zp[fi] >= -2;
            if (!isBoundary) continue;
            const row = new Float32Array(bands.length);
            const addSeg = (side:number) => { if (side >= 0) for (let k=0;k<bands.length;k++) row[k] += segmentBandBetas[side][k]; };
            addSeg(footprintGrid.xm[fi]); addSeg(footprintGrid.xp[fi]); addSeg(footprintGrid.zm[fi]); addSeg(footprintGrid.zp[fi]);
            if (iy === 0) for (let k=0;k<bands.length;k++) row[k] += floorBandBetas[k];
            if (iy === ny - 1) for (let k=0;k<bands.length;k++) row[k] += ceilBandBetas[k];
            boundaryIndices.push(idx);
            for (let k=0;k<bands.length;k++) betaRows.push(row[k]);
          }
        }
      }
      boundaryBandIndex = new Int32Array(N);
      boundaryBandIndex.fill(-1);
      for (let i=0;i<boundaryIndices.length;i++) boundaryBandIndex[boundaryIndices[i]] = i;
      boundaryBandState = new Float32Array(boundaryIndices.length * bands.length);
      boundaryBandBeta = new Float32Array(betaRows);
    }

    for (let t = 0; t < numSteps; t++) {
      // Update the complete physical domain. Cells outside the footprint are
      // masked out; previously the rectangular interior update advanced them
      // before the boundary pass, which let pressure leak through custom L/U/H
      // shaped rooms. Every in-room cell now sees either a real neighbor or a
      // classified wall/opening boundary on each horizontal face.
      for (let iy = 0; iy < ny; iy++) {
        for (let iz = 0; iz < nz; iz++) {
          for (let ix = 0; ix < nx; ix++) {
            const footprintIndex = iz * nx + ix;
            const idx = iy * nxz + iz * nx + ix;
            if (!roomInside[footprintIndex]) {
              // bnd_v_prev: obsolete reference to a per-cell boundary velocity
              // array from an earlier implementation. The current causal
              // boundary state (`boundaryBandState`) is indexed by
              // `boundaryBandIndex[footprintIndex]`, not by the raw cell
              // index, so zeroing a same-shape-as-N array here was never
              // correct for the current model. Nothing needs zeroing for
              // out-of-room cells beyond p_next, which is already handled.
              p_next[idx] = 0;
              continue;
            }

            let b0Sum = 0;
            let openBeta = 0;
            let p_neighbors = 0;

            const sxm = footprintGrid.xm[footprintIndex];
            const sxp = footprintGrid.xp[footprintIndex];
            // BUG (root cause of exponential blow-up at coarse grids): this
            // used to be `if (sxm >= -2)`, which also matches sxm === -1 -
            // the sentinel buildFootprintGrid uses for "normal in-room
            // neighbor, not a boundary at all" (see its doc comment). That
            // let ordinary interior faces fall into the wall/opening branch
            // below, which doubles the neighbor's contribution
            // (`2 * p[idx-1]`) instead of using the correct undoubled
            // `p[idx-1]` for a real neighbor - injecting spurious energy
            // into the Laplacian every step and breaking the leapfrog
            // scheme's energy conservation, regardless of the nominal CFL
            // check passing. runIR's equivalent block (below, ~line 1320)
            // already had the correct three-way split; mirrored here.
            if (sxm === -2) {
              // Open wall: first-order radiation/absorbing approximation.
              openBeta += C_courant;
              if (!useFrequencyDependent) b0Sum += C_courant;
            } else if (sxm >= 0) {
              const b = sideBeta(sxm);
              b0Sum += b.b0;
              if (ix > 0) p_neighbors += 2 * p[idx - 1];
            } else if (ix > 0) {
              p_neighbors += p[idx - 1];
            }
            if (sxp === -2) {
              openBeta += C_courant;
              if (!useFrequencyDependent) b0Sum += C_courant;
            } else if (sxp >= 0) {
              const b = sideBeta(sxp);
              b0Sum += b.b0;
              if (ix < nx - 1) p_neighbors += 2 * p[idx + 1];
            } else if (ix < nx - 1) {
              p_neighbors += p[idx + 1];
            }

            if (iy === 0) {
              if (!useFrequencyDependent) b0Sum += floorBeta500;
              p_neighbors += 2 * p[idx + nxz];
            } else if (iy === ny - 1) {
              if (!useFrequencyDependent) b0Sum += ceilBeta500;
              p_neighbors += 2 * p[idx - nxz];
            } else {
              p_neighbors += p[idx - nxz] + p[idx + nxz];
            }

            const szm = footprintGrid.zm[footprintIndex];
            const szp = footprintGrid.zp[footprintIndex];
            if (szm === -2) {
              openBeta += C_courant;
              if (!useFrequencyDependent) b0Sum += C_courant;
            } else if (szm >= 0) {
              const b = sideBeta(szm);
              b0Sum += b.b0;
              if (iz > 0) p_neighbors += 2 * p[idx - nx];
            } else if (iz > 0) {
              p_neighbors += p[idx - nx];
            }
            if (szp === -2) {
              openBeta += C_courant;
              if (!useFrequencyDependent) b0Sum += C_courant;
            } else if (szp >= 0) {
              const b = sideBeta(szp);
              b0Sum += b.b0;
              if (iz < nz - 1) p_neighbors += 2 * p[idx + nx];
            } else if (iz < nz - 1) {
              p_neighbors += p[idx + nx];
            }

            const F = 2 * p[idx] - p_prev[idx] + Courant * (p_neighbors - 6 * p[idx]);
            if (useFrequencyDependent && boundaryBandState && boundaryBandBeta && boundaryBandIndex) {
              const bi = boundaryBandIndex[idx];
              let memoryTerm = 0;
              let betaSum = 0;
              let activeBands = 0;
              if (bi >= 0) {
                const base = bi * bands.length;
                const vPrev = p[idx] - p_prev[idx];
                for (let k = 0; k < bands.length; k++) {
                  const beta = boundaryBandBeta[base + k];
                  betaSum += beta;
                  if (beta > 0) activeBands++;
                  const pole = bandPoles[k];
                  const state = pole * boundaryBandState[base + k] + (1 - pole) * vPrev;
                  boundaryBandState[base + k] = state;
                  memoryTerm += beta * state;
                }
              }
              const divisor = Math.max(1, activeBands);
              const effectiveBeta = betaSum / divisor + openBeta;
              p_next[idx] = (F + effectiveBeta * p_prev[idx] - memoryTerm / divisor) / (1 + effectiveBeta);
              if (!Number.isFinite(p_next[idx])) throw new Error('Numerical instability produced a non-finite pressure sample.');
            } else {
              // b0Sum already includes C_courant contributions for open wall
              // spans on this path (see the `if (!useFrequencyDependent)
              // b0Sum += C_courant` additions above for sxm/sxp/szm/szp), so
              // openBeta is not added again here — doing so would double
              // count open-wall damping. b0Sum is the correct total.
              p_next[idx] = (F + b0Sum * p_prev[idx]) / (1 + b0Sum);
            }
          }
        }
      }

      if (t < excitation.durationSteps) {
          if (source?.isDirectional && source?.directivityData) {
            for (const band of injectionBands) {
              const exc = band.filtered[t] ?? 0;
              if (exc === 0) continue;
              for (const node of band.nodes) p_next[node.idx] += exc * node.weight;
            }
          } else {
            const exc = excitation.at(t);
            for (let i = 0; i < injectionNodes.length; i++) p_next[injectionNodes[i].idx] += exc * injectionNodes[i].weight;
          }
        }

              for (let i = 0; i < receiverIndices.length; i++) {
          receiverTraces[i].push(p_next[receiverIndices[i]]);
        }

        if (exportWavefield && t % wavefieldStride === 0) {
          const stepX = Math.max(1, Math.ceil(nx / 128));
          const stepZ = Math.max(1, Math.ceil(nz / 128));
          const outNx = Math.ceil(nx / stepX);
          const outNz = Math.ceil(nz / stepZ);
          const frame = new Float32Array(outNx * outNz);
          let fIdx = 0;
          for (let iz = 0; iz < nz; iz += stepZ) {
            for (let ix = 0; ix < nx; ix += stepX) {
               frame[fIdx++] = p_next[wavefieldSliceY * nxz + iz * nx + ix];
            }
          }
          // Stream frame to main thread instead of accumulating in RAM
          if (parentPort) parentPort.postMessage({ type: 'wavefield_frame', frame });
        }


      p_prev.set(p);
      p.set(p_next);
    }

    // Only compute simulatedRt60 for the primary receiver for backward compatibility in the quick preview.
    // Use /api/solver/impulse-response for accurate decay results across all receivers.
    let simulatedRt60: number | null = null;
    if (receiverTraces.length > 0) {
      const primaryTrace = receiverTraces[0];
      let peak = 0;
      let peakIdx = 0;
      for (let i = 0; i < primaryTrace.length; i++) {
        if (Math.abs(primaryTrace[i]) > peak) {
          peak = Math.abs(primaryTrace[i]);
          peakIdx = i;
        }
      }
      if (!(peak > 0)) peak = 1e-9;
      
      let decayIdxRelative = -1;
      const threshold = peak * Math.pow(10, -30 / 20);
      for (let i = peakIdx; i < primaryTrace.length; i++) {
        if (Math.abs(primaryTrace[i]) < threshold) {
          decayIdxRelative = i - peakIdx;
          break;
        }
      }
      if (decayIdxRelative > 0) {
        simulatedRt60 = (decayIdxRelative * dt) * 2; 
      }
    }

    const analytical = computeFootprintSabins500(payload, roomL, roomW, roomH, floorAbs, ceilAbs, wallAbs);
    const { floorArea, ceilArea, volume, wallArea, totalSabins } = analytical;
    const sabineRt60 = (0.161 * volume) / Math.max(totalSabins, 0.01);

    const endTime = Date.now();
    const durationMs = endTime - startTime;

    return {
      success: true,
      meshSize: N,
      gridDims: [nx, ny, nz],
      actualFmax: actualFmax,
      targetFmax: targetFmax,
      reducedResolution,
      requestedElements: requiredElements,
      cellSizeM: dx,
      steps: numSteps,
      durationMs,
      rt60: sabineRt60,
      simulatedRt60,
      receivers: receiversPayload,
      receiverTraces,
      // For backward compatibility for a single trace if any client code relies on it:
      receiverTrace: receiverTraces[0],
      dtEstimate: dt,
      speaker: speakerDisclosure(payload),
      positionAssumptions: collectPositionAssumptions([source], receiversPayload, roomH),
      boundaryModel: useFrequencyDependent ? { type: "seven-band-causal-relaxation", bandsHz: OCTAVE_BANDS_HZ, missingBandPolicy: "no-fabrication" } : { type: "broadband-500Hz-reference" },
      wavefield: exportWavefield ? {
        outNx: Math.ceil(nx / Math.max(1, Math.ceil(nx / 128))),
        outNz: Math.ceil(nz / Math.max(1, Math.ceil(nz / 128))),
        dt: dt * Math.max(1, Math.floor(numSteps / 60))
      } : undefined,
      message: `Computed ${numSteps} time steps over a ${nx}x${ny}x${nz} grid (${N.toLocaleString()} elements) matching your ${roomL}x${roomW}x${roomH}m room in ${durationMs}ms.`
    };

  } catch (err: unknown) {
    console.error("Wave Solver Error:", err);
    throw new Error(errorMessageOf(err));
  }

}

export function runIR(payload: any, limits: SolverLimits = PUBLIC_SOLVER_LIMITS) {
  const { L, W, H, wallMaterial, floorMaterial, ceilMaterial, sources, receiver } = payload;

  const roomL = Number(L);
  const roomW = Number(W);
  const roomH = Number(H);
  const roomValidation = validatePublicRoomDimensions({ L: roomL, W: roomW, H: roomH });
  if ('error' in roomValidation) throw new Error(roomValidation.error);

  const { wallAbs, floorAbs, ceilAbs } = resolveSurfaceAbsorption(payload);

  const analytical = computeFootprintSabins500(payload, roomL, roomW, roomH, floorAbs, ceilAbs, wallAbs);
  const { floorArea, ceilArea, volume, wallArea, totalSabins } = analytical;
  const estimatedRt60 = (0.161 * volume) / Math.max(totalSabins, 0.01);

  const MIN_USEFUL_DURATION_SEC = 0.2;
  const MAX_DURATION_SEC = 3.0;
  const explicitDuration = Number(payload?.durationSec);
  const durationBasis = (payload?.durationSec != null && Number.isFinite(explicitDuration) && explicitDuration > 0)
    ? explicitDuration
    : estimatedRt60;
  const requestedDurationSec = Math.min(
    Math.max(durationBasis, MIN_USEFUL_DURATION_SEC),
    MAX_DURATION_SEC,
  );
  const durationTruncatedByCap = durationBasis > MAX_DURATION_SEC;

  const COURANT = 0.1;
  const CFL_LIMIT_SQUARED = 1/3;
  const C_SOUND = 343;
  const SQRT_COURANT = Math.sqrt(COURANT);

  const MAX_STEPS = limits.maxSteps;
  const MAX_CELL_UPDATES = 2.5e8;
  const MIN_DX = 0.05;
  const MAX_DX = 0.75;

  const STEP_BUDGET_MARGIN = 1.001;
  const dxForStepBudget = (requestedDurationSec * C_SOUND * STEP_BUDGET_MARGIN) / (MAX_STEPS * SQRT_COURANT);
  const dxForWorkBudget = Math.pow(
    (volume * requestedDurationSec * C_SOUND) / (SQRT_COURANT * MAX_CELL_UPDATES),
    0.25,
  );

  const dxUnclamped = Math.max(MIN_DX, dxForStepBudget, dxForWorkBudget);
  const dx = Math.min(dxUnclamped, MAX_DX);
  const gridClampedByMaxDx = dxUnclamped > MAX_DX;

  const nx = Math.max(4, Math.round(roomL / dx));
  const ny = Math.max(4, Math.round(roomH / dx));
  const nz = Math.max(4, Math.round(roomW / dx));
  const N = nx * ny * nz;

  if (!Number.isFinite(N) || isNaN(N) || N <= 0 || exceedsGridLimit(N)) {
    throw new Error(`The impulse-response FDTD grid (${N.toLocaleString()} cells) exceeds the public safety limit of ${PUBLIC_MAX_GRID_CELLS.toLocaleString()} cells.`);
  }

  // Pre-allocation memory safety check: verify total solver memory budget BEFORE allocating arrays.
  const receiversPayloadPre = payload.receivers || (payload.receiver ? [payload.receiver] : []);
  const dtPre = (dx * SQRT_COURANT) / C_SOUND;
  const numStepsPre = Math.min(Math.ceil(requestedDurationSec / dtPre), MAX_STEPS);
  const estimatedMemoryBytesPre = N * 12 + (receiversPayloadPre.length * numStepsPre * Float32Array.BYTES_PER_ELEMENT) + 75_000_000;
  const maxMemoryBytes = resolveMaxSolverMemoryBytes();
  if (estimatedMemoryBytesPre > maxMemoryBytes) {
    throw new Error("Simulation exceeds available system memory budget. Reduce resolution or duration.");
  }

  const nxz = nx * nz;
  const footprint = validateSolverFootprint(payload);
  const footprintGrid = buildFootprintGrid(footprint.poly, footprint.openings, nx, nz);
  const roomInside = footprintGrid.inside;

  const dt = (dx * SQRT_COURANT) / C_SOUND;
  const stepsForTarget = Math.ceil(requestedDurationSec / dt);
  const numSteps = Math.min(stepsForTarget, MAX_STEPS);

  const POINTS_PER_WAVELENGTH = 9;
  const reliableFmaxHz = C_SOUND / (POINTS_PER_WAVELENGTH * dx);
  const targetDurationSec = requestedDurationSec;
  const reachedTarget = stepsForTarget <= MAX_STEPS;

  const sourcesPayload = payload.sources || (payload.source ? [payload.source] : []);
  if (sourcesPayload.length === 0 || sourcesPayload.length > PUBLIC_MAX_SOURCES) {
    throw new Error(`Simulation must have between 1 and ${PUBLIC_MAX_SOURCES} sources.`);
  }
  
  const srcIndices = sourcesPayload.map((src: any) => {
    const { srcIx, srcIy, srcIz } = resolveSourceGridNode(src, nx, ny, nz, roomH);
    if (srcIx < 0 || srcIx >= nx || srcIy < 0 || srcIy >= ny || srcIz < 0 || srcIz >= nz || !roomInside[srcIz * nx + srcIx]) {
      throw new Error("Invalid source position: placed outside the room footprint.");
    }
    return { srcIx, srcIy, srcIz, srcIdx: srcIy * nxz + srcIz * nx + srcIx };
  });

  const receiversPayload = payload.receivers || (payload.receiver ? [payload.receiver] : []);
  if (receiversPayload.length === 0 || receiversPayload.length > PUBLIC_MAX_RECEIVERS) {
    throw new Error(`Simulation must have between 1 and ${PUBLIC_MAX_RECEIVERS} receivers.`);
  }

  const receiverIndices = receiversPayload.map((r: any) => {
    if (r?.x == null || !Number.isFinite(Number(r.x)) || Number(r.x) < 0 || Number(r.x) > 1 ||
        r?.y == null || !Number.isFinite(Number(r.y)) || Number(r.y) < 0 || Number(r.y) > 1 ||
        (r?.z != null && (!Number.isFinite(Number(r.z)) || Number(r.z) < 0 || Number(r.z) > roomH))) {
      throw new Error("Invalid receiver position: coordinates must be finite numbers within room bounds.");
    }
    const recX = Number(r.x), recZ = Number(r.y);
    const recIx = Math.round(recX * (nx - 1));
    const recIy = Math.round((receiverZMeters(r, roomH) / roomH) * (ny - 1));
    const recIz = Math.round(recZ * (nz - 1));
    if (recIx < 0 || recIx >= nx || recIy < 0 || recIy >= ny || recIz < 0 || recIz >= nz || !roomInside[recIz * nx + recIx]) {
      throw new Error("Invalid receiver position: placed outside the room footprint.");
    }
    return Math.max(0, Math.min(N - 1, recIy * nxz + recIz * nx + recIx));
  });

  try {
    if (isNaN(N) || !isFinite(N) || N <= 0) throw new Error("Invalid geometry calculations resulted in NaN/Infinity elements.");

    console.log("[IMPULSE RESPONSE SOLVER] Room " + roomL + "x" + roomW + "x" + roomH + "m -> coarse grid " + nx + "x" + ny + "x" + nz + " (" + N.toLocaleString() + " elements, dx=" + dx.toFixed(3) + "m). Steps: " + numSteps + "/" + stepsForTarget + " (target " + targetDurationSec.toFixed(2) + "s). Receivers: " + receiverIndices.length + ". Sources: " + sourcesPayload.length);

    // Memory budget covers the three pressure grids and receiver traces.
    // Unlike runWave's optional causal boundary state, the IR solver always
    // uses a memoryless per-band absorption boundary (see boundaryModel below)
    // and never allocates the persistent seven-band relaxation state, so there
    // is no `useFrequencyDependent`-gated boundary-state term to add here.
    const estimatedMemoryBytes = N * 12 + (receiverIndices.length * numSteps * Float32Array.BYTES_PER_ELEMENT) + 75_000_000;
    const maxMemoryBytes = resolveMaxSolverMemoryBytes();
    if (estimatedMemoryBytes > maxMemoryBytes) {
      throw new Error("Simulation exceeds available system memory budget. Reduce resolution or duration.");
    }
    const startTime = Date.now();
    
    assertCflStable(COURANT);
    assertTimeStepConsistent(dt, dx, COURANT, C_SOUND);
    const excitation = makeRickerSource(dt, reliableFmaxHz);
    const sampleRateHz = 1 / dt;

    // We will accumulate broadband trace and per-band energy for each receiver
    const receiverBroadbandPressure: Float32Array[] = receiverIndices.map(() => new Float32Array(numSteps));
    const receiverBandEnergy: Record<number, Float32Array[]> = {};
    for (const hz of OCTAVE_BANDS_HZ) {
      receiverBandEnergy[hz] = receiverIndices.map(() => new Float32Array(numSteps));
    }
    
    // We also need delay calculation. Delay is Distance / C_SOUND
    const receiverDelays = receiversPayload.map((r: any) => {
      const delays = sourcesPayload.map((s: any) => {
        const rActualX = Number(r.x) * roomL;
        const rActualY = Number(r.y) * roomW;
        const rActualZ = receiverZMeters(r, roomH);
        const sw = sourceWorldFractions(s, roomH); // the REQUESTED position, same convention as the receiver above
        const sActualX = sw.x * roomL;
        const sActualY = sw.y * roomW;
        const sActualZ = sw.z;
        const dist = Math.sqrt((rActualX - sActualX)**2 + (rActualY - sActualY)**2 + (rActualZ - sActualZ)**2);
        return { sourceId: s.id, delayMs: (dist / C_SOUND) * 1000, distanceMeters: dist };
      });
      return delays;
    });

    const p_prev = new Float32Array(N);
    const p = new Float32Array(N);
    const p_next = new Float32Array(N);

    for (let sIdx = 0; sIdx < sourcesPayload.length; sIdx++) {
      const src = sourcesPayload[sIdx];
      const { srcIx, srcIy, srcIz } = srcIndices[sIdx];
      if (src?.muted === true) continue;
      const sourceGain = sourceGainLinear(src);
      const delayMs = Number(src?.delayMs);
      const sourceDelaySteps = Math.max(0, Math.round((Number.isFinite(delayMs) ? delayMs : 0) / dt));
      
      for (const bandHz of OCTAVE_BANDS_HZ) {
        const injectionNodes = computeInjectionNodes(src, srcIx, srcIy, srcIz, nx, ny, nz, nxz, bandHz);
        // Skip bands above Nyquist; they are reported as unavailable rather
        // than being synthesized from a neighbouring band.
        if (bandHz >= sampleRateHz / 2) continue;
        
        const explicitW = payload.wallAbsorption != null && Number.isFinite(Number(payload.wallAbsorption)) && Number(payload.wallAbsorption) >= 0 && Number(payload.wallAbsorption) <= 1 ? Number(payload.wallAbsorption) : null;
        const explicitF = payload.floorAbsorption != null && Number.isFinite(Number(payload.floorAbsorption)) && Number(payload.floorAbsorption) >= 0 && Number(payload.floorAbsorption) <= 1 ? Number(payload.floorAbsorption) : null;
        const explicitC = payload.ceilAbsorption != null && Number.isFinite(Number(payload.ceilAbsorption)) && Number(payload.ceilAbsorption) >= 0 && Number(payload.ceilAbsorption) <= 1 ? Number(payload.ceilAbsorption) : null;

        let absWall = explicitW !== null ? explicitW : getOctaveAbsorption(payload.wallMaterial, bandHz);
        let absFloor = explicitF !== null ? explicitF : getOctaveAbsorption(payload.floorMaterial, bandHz);
        let absCeil = explicitC !== null ? explicitC : getOctaveAbsorption(payload.ceilMaterial, bandHz);
        if (absWall === 'N/A') absWall = wallAbs;
        if (absFloor === 'N/A') absFloor = floorAbs;
        if (absCeil === 'N/A') absCeil = ceilAbs;
        
        const R_wall = Math.sqrt(Math.max(1 - Number(absWall), 0));
        const R_floor = Math.sqrt(Math.max(1 - Number(absFloor), 0));
        const R_ceil = Math.sqrt(Math.max(1 - Number(absCeil), 0));
        
        const b0_wall = SQRT_COURANT * (1 - R_wall) / (1 + R_wall + 1e-9);
        const b0_floor = SQRT_COURANT * (1 - R_floor) / (1 + R_floor + 1e-9);
        const b0_ceil = SQRT_COURANT * (1 - R_ceil) / (1 + R_ceil + 1e-9);
        const segmentB0 = footprint.poly.map((_, seg) => { const a = explicitW !== null ? explicitW : getOctaveAbsorption(payload.wallSegMats?.[seg] || payload.wallMaterial, bandHz); const aa = a === 'N/A' ? Number(wallAbs) : Number(a); const R=Math.sqrt(Math.max(1-aa,0)); return SQRT_COURANT*(1-R)/(1+R+1e-9); });

        // Reset grids
        p_prev.fill(0);
        p.fill(0);
        p_next.fill(0);
        
        const receiverTraces: number[][] = receiverIndices.map(() => []);

        for (let t = 0; t < numSteps; t++) {
          for (let iy = 1; iy < ny - 1; iy++) {
            for (let iz = 1; iz < nz - 1; iz++) {
              const rowBase = iy * nxz + iz * nx;
              for (let ix = 1; ix < nx - 1; ix++) {
                const i = rowBase + ix;
                if (!roomInside[iz * nx + ix]) { p_next[i] = 0; continue; }
                p_next[i] = (2 * p[i]) - p_prev[i] + COURANT * (
                  p[i - 1] + p[i + 1] +
                  p[i - nx] + p[i + nx] +
                  p[i - nxz] + p[i + nxz] -
                  (6 * p[i])
                );
              }
            }
          }

          // Update only cells inside the footprint. Wall segments use their
          // segment material; openings use the same first-order radiation
          // approximation as the wave solver rather than accidentally acting
          // as rigid pressure mirrors.
          for (let iy = 0; iy < ny; iy++) {
            for (let iz = 0; iz < nz; iz++) {
              for (let ix = 0; ix < nx; ix++) {
                const footprintIndex = iz * nx + ix;
                const idx = iy * nxz + iz * nx + ix;
                if (!roomInside[footprintIndex]) { p_next[idx] = 0; continue; }

                let b0Sum = 0;
                let p_neighbors = 0;
                const sxm=footprintGrid.xm[footprintIndex], sxp=footprintGrid.xp[footprintIndex];
                if (sxm === -2) {
                  b0Sum += SQRT_COURANT;
                } else if (sxm >= 0) {
                  b0Sum += segmentB0[sxm];
                  if (ix > 0) p_neighbors += 2 * p[idx-1];
                } else if (ix > 0) {
                  p_neighbors += p[idx-1];
                }
                if (sxp === -2) {
                  b0Sum += SQRT_COURANT;
                } else if (sxp >= 0) {
                  b0Sum += segmentB0[sxp];
                  if (ix < nx-1) p_neighbors += 2 * p[idx+1];
                } else if (ix < nx-1) {
                  p_neighbors += p[idx+1];
                }

                if (iy === 0) { b0Sum += b0_floor; p_neighbors += 2 * p[idx+nxz]; }
                else if (iy === ny-1) { b0Sum += b0_ceil; p_neighbors += 2 * p[idx-nxz]; }
                else p_neighbors += p[idx-nxz] + p[idx+nxz];

                const szm=footprintGrid.zm[footprintIndex], szp=footprintGrid.zp[footprintIndex];
                if (szm === -2) {
                  b0Sum += SQRT_COURANT;
                } else if (szm >= 0) {
                  b0Sum += segmentB0[szm];
                  if (iz > 0) p_neighbors += 2 * p[idx-nx];
                } else if (iz > 0) {
                  p_neighbors += p[idx-nx];
                }
                if (szp === -2) {
                  b0Sum += SQRT_COURANT;
                } else if (szp >= 0) {
                  b0Sum += segmentB0[szp];
                  if (iz < nz-1) p_neighbors += 2 * p[idx+nx];
                } else if (iz < nz-1) {
                  p_neighbors += p[idx+nx];
                }

                const F = 2 * p[idx] - p_prev[idx] + COURANT * (p_neighbors - 6 * p[idx]);
                p_next[idx] = (F + b0Sum * p_prev[idx]) / (1 + b0Sum);
              }
            }
          }

          const excitationIndex = t - sourceDelaySteps;
          if (excitationIndex >= 0 && excitationIndex < excitation.durationSteps) {
            const exc = excitation.at(excitationIndex) * sourceGain;
            for (let i = 0; i < injectionNodes.length; i++) {
              p_next[injectionNodes[i].idx] += exc * injectionNodes[i].weight;
            }
          }

          for (let i = 0; i < receiverIndices.length; i++) {
            receiverTraces[i].push(p_next[receiverIndices[i]]);
          }

          p_prev.set(p);
          p.set(p_next);
        }

        // Apply octave filter for this band
        const biquad = bandpassBiquad(bandHz, sampleRateHz, Math.SQRT1_2);
        for (let rIdx = 0; rIdx < receiverIndices.length; rIdx++) {
          const filtered = applyBiquad(receiverTraces[rIdx], biquad);
          const bbArray = receiverBroadbandPressure[rIdx];
          const energyArray = receiverBandEnergy[bandHz][rIdx];
          for (let n = 0; n < numSteps; n++) {
            bbArray[n] += filtered[n];
            energyArray[n] += filtered[n] * filtered[n];
          }
        }
      }
    }

    const excitationF0Hz = excitation.f0;
    // The diffuse-field validity check below compares the excitation's
    // frequency reach against the Schroeder frequency. Using the Ricker
    // wavelet's spectral-peak frequency (f0 = reliableFmaxHz/2, see
    // makeRickerSource) understates how high the excitation actually
    // carries useful energy: the wavelet's spectrum extends well above f0,
    // up to roughly reliableFmaxHz, which is the grid's own resolvable
    // ceiling. Comparing f0 against Schroeder made a run whose excitation
    // genuinely spans into the diffuse regime (reliableFmaxHz above
    // Schroeder) get reported as still-modal, because its single spectral
    // peak point happened to sit below the Schroeder frequency even though
    // the excitation's bandwidth did not.
    const excitationReachHz = reliableFmaxHz;
    const schroederFrequencyHz = 2000 * Math.sqrt(Math.max(estimatedRt60, 1e-6) / volume);
    const sabineRt60 = estimatedRt60;

    const actualDurationSec = numSteps * dt;
    const durationMs = Date.now() - startTime;
    const reproducibilityFingerprint = requestFingerprint(payload);

    const receiversResults = receiversPayload.map((rPayload: any, i: number) => {
      // Reconstruct broadband trace
      const trace = Array.from(receiverBroadbandPressure[i]);
      
      // Compute broadband decay from the combined energy of all bands
      const bbEnergy = new Array(numSteps).fill(0);
      for (const hz of OCTAVE_BANDS_HZ) {
        if (!receiverBandEnergy[hz]) continue;
        const eArray = receiverBandEnergy[hz][i];
        for (let n = 0; n < numSteps; n++) {
          bbEnergy[n] += eArray[n];
        }
      }
      
      const bbParams = paramsFromEnergy(bbEnergy, dt);
      
      const bbMagnitude = new Float32Array(numSteps);
      for (let n = 0; n < numSteps; n++) bbMagnitude[n] = Math.sqrt(bbEnergy[n]);
      const bbSchroeder = schroederCurve(bbMagnitude);
      const edt = computeEDT(bbSchroeder, dt);
      const t20 = computeT20(bbSchroeder, dt);
      const t30 = computeT30(bbSchroeder, dt);

      const preferredFit = [t30, t20, edt].find(f => f.status === "VALIDATED")
        ?? [t30, t20, edt].find(f => f.status === "LIMITED")
        ?? null;
      const simulatedRt60 = preferredFit?.rt60Sec ?? null;
      
      const metrics: any = {
        rt60: simulatedRt60,
        edt: edt?.rt60Sec ?? null,
        t20: t20?.rt60Sec ?? null,
        t30: t30?.rt60Sec ?? null,
        c50: bbParams.c50,
        c80: bbParams.c80,
        d50: bbParams.d50,
        centerTimeMs: bbParams.centerTimeMs,
        spl: null,
        bands: {}
      };
      
      let sumBbE = 0;
      for (let n = 0; n < numSteps; n++) sumBbE += bbEnergy[n];
      metrics.relativeLevelDb = sumBbE > 0 ? 10 * Math.log10(sumBbE) : null;
      metrics.spl = estimateCalibratedSplDb(sourcesPayload, rPayload, roomL, roomW, roomH);
      metrics.splBasis = metrics.spl == null ? 'unavailable' : 'sensitivity_1w_1m_estimate';
      
      for (const hz of OCTAVE_BANDS_HZ) {
        const eArray = receiverBandEnergy[hz]?.[i];
        if (!eArray) continue;
        const label = hz + " Hz";
        const p = paramsFromEnergy(Array.from(eArray), dt);
        
        let sumE = 0;
        for (let n = 0; n < numSteps; n++) sumE += eArray[n];
        const relativeLevelDb = sumE > 0 ? 10 * Math.log10(sumE) : null;
        const spl = estimateCalibratedSplDb(sourcesPayload, rPayload, roomL, roomW, roomH);
        
        const bMag = new Float32Array(numSteps);
        for (let n = 0; n < numSteps; n++) bMag[n] = Math.sqrt(eArray[n]);
        const bSchroeder = schroederCurve(bMag);
        const bEdt = computeEDT(bSchroeder, dt);
        const bT20 = computeT20(bSchroeder, dt);
        const bT30 = computeT30(bSchroeder, dt);
        
        const pf = [bT30, bT20, bEdt].find(f => f.status === "VALIDATED")
          ?? [bT30, bT20, bEdt].find(f => f.status === "LIMITED")
          ?? null;
        
        metrics.bands[label] = {
          rt60: pf?.rt60Sec ?? null,
          edt: pf?.rt60Sec ? bEdt.rt60Sec : null,
          t20: pf?.rt60Sec ? bT20.rt60Sec : null,
          t30: pf?.rt60Sec ? bT30.rt60Sec : null,
          c50: p.c50,
          c80: p.c80,
          d50: p.d50,
          centerTimeMs: p.centerTimeMs,
          spl, relativeLevelDb, splBasis: spl == null ? 'unavailable' : 'sensitivity_1w_1m_estimate'
        };
      }

      return {
        ...rPayload,
        trace, 
        simulatedRt60,
        delays: receiverDelays[i],
        metrics,
        reproducibilityFingerprint,
        solverVersion: SOLVER_VERSION,
        decay: {
          method: "Schroeder backward integration (Schroeder 1965)",
          edt,
          t20,
          t30,
          preferred: preferredFit
            ? { metric: preferredFit === t30 ? "T30" : preferredFit === t20 ? "T20" : "EDT", ...preferredFit }
            : null,
          sabineRt60Sec: sabineRt60,
          sabineNote: "Sabine is an analytical estimate from absorption area, not a simulation result.",
          validity: {
            excitationCentreHz: excitationF0Hz,
            reliableFmaxHz,
            schroederFrequencyHz,
            diffuseFieldValid: excitationReachHz >= schroederFrequencyHz,
            note: excitationReachHz >= schroederFrequencyHz
              ? "Excitation sits above this room's Schroeder frequency, so the diffuse-field assumption behind Sabine/Eyring broadly applies."
              : "Excitation sits BELOW this room's Schroeder frequency: the response is modal, not diffuse. The numerical RT60 is a valid measurement of this simulation but is not directly comparable to Sabine/Eyring, and will shift if the run is resized.",
          }
        }
      };
    });

    return {
      success: true,
      meshSize: N,
      gridDims: [nx, ny, nz],
      cellSizeM: dx,
      steps: numSteps,
      requestedSteps: stepsForTarget,
      reachedTarget,
      actualDurationSec,
      targetDurationSec,
      computeTimeMs: durationMs,
      rt60: sabineRt60,
      
      simulatedRt60: receiversResults[0]?.simulatedRt60 ?? null,
      decay: receiversResults[0]?.decay ?? null,
      receiverTrace: receiversResults[0]?.trace ?? [],
      
      receivers: receiversResults,
      dtEstimate: dt,
      positionAssumptions: collectPositionAssumptions(sourcesPayload, receiversPayload, roomH),

      config: {
        solver: "fdtd-ir",
        solverVersion: SOLVER_VERSION,
        backend: "cpu-worker",
        scheme: "7-point Cartesian, 2nd order in space and time",
        room: { L: roomL, W: roomW, H: roomH, volumeM3: volume },
        grid: { nx, ny, nz, cells: N, dx, dy: dx, dz: dx },
        time: { dt, courantSquared: COURANT, cflLimitSquared: CFL_LIMIT_SQUARED, cflStable: COURANT <= CFL_LIMIT_SQUARED },
        duration: {
          estimatedRt60Sec: estimatedRt60,
          requestedSec: requestedDurationSec,
          actualSec: actualDurationSec,
          requiredSteps: stepsForTarget,
          executedSteps: numSteps,
          reachedTarget,
          terminationReason: reachedTarget
            ? "target-duration-reached"
            : gridClampedByMaxDx
              ? "grid-resolution-floor"
              : "step-cap",
          durationCappedByPolicy: durationTruncatedByCap,
        },
        resolution: {
          reliableFmaxHz: reliableFmaxHz,
          pointsPerWavelength: POINTS_PER_WAVELENGTH,
          note: "Spatial bound only. Decay metrics depend on simulated duration, not mesh fineness.",
        },
        boundaryModel: { type: "seven-band-per-band-IR", bandsHz: OCTAVE_BANDS_HZ, missingBandPolicy: "no-fabrication" },
        memory: {
          estimatedBytes: estimatedMemoryBytes,
          limitBytes: maxMemoryBytes,
        },
        budgets: {
          maxSteps: MAX_STEPS,
          maxCellUpdates: MAX_CELL_UPDATES,
          actualCellUpdates: N * numSteps,
        },
        speaker: speakerDisclosure(payload),
      },

      warning: reachedTarget
        ? (durationTruncatedByCap
            ? "This room's estimated RT60 (" + estimatedRt60.toFixed(2) + "s) exceeds the " + MAX_DURATION_SEC.toFixed(1) + "s analysis cap. The full " + requestedDurationSec.toFixed(2) + "s was simulated, but the tail beyond that is not represented."
            : null)
        : "Simulation executed " + numSteps + " of the " + stepsForTarget + " steps required to reach " + requestedDurationSec.toFixed(2) + "s (" + actualDurationSec.toFixed(2) + "s simulated). Reason: " + (gridClampedByMaxDx ? "grid resolution floor" : "step cap") + ". RT60/C50/C80/Ts derived from this trace may understate the room's true reverberance.",
      message: "Computed " + numSteps + " time steps (" + actualDurationSec.toFixed(2) + "s simulated, " + nx + "x" + ny + "x" + nz + " grid, dx=" + dx.toFixed(3) + "m) in " + durationMs + "ms."
    };
  } catch (err: unknown) {
    console.error("Impulse Response Solver Error:", err);
    throw new Error(errorMessageOf(err));
  }
}

// Worker dispatch. Kept at the END of the module: it runs during module evaluation, so every
// `const` helper it calls must already be initialized (earlier placement threw a TDZ error on every job).
// Only run it when this module is actually loaded as a
// worker thread. Importing it from a test/tooling process leaves workerData
// null, and the dispatch below would otherwise throw on destructuring and
// post a spurious failure message. This guard is what makes runWave/runIR
// directly callable from the numerical test suite without spawning workers.
if (workerData) try {
  const { type, payload } = workerData;
  if (type === 'wave') {
    const result = runWave(payload);
    parentPort?.postMessage({ success: true, data: result });
  } else if (type === 'impulse-response') {
    const result = runIR(payload);
    parentPort?.postMessage({ success: true, data: result });
  } else {
    throw new Error("Unknown solver type");
  }
} catch (err: unknown) {
  parentPort?.postMessage({ success: false, error: errorMessageOf(err) });
}
