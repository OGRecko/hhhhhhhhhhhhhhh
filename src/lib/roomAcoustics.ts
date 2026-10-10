// Room acoustics calculations: per-octave-band RT60 (Sabine and Eyring) and
// a labeled STI proxy, built from the room's real geometry (poly + L/W/H)
// and per-surface materials — including per-wall-segment materials, not a
// single averaged wall material.
//
// This is the single source of truth for RT60/STI math. The FDTD solver
// endpoint in server.ts computes its own broadband (500Hz-only) Sabine RT60
// for its "does the simulated decay look sane" cross-check — that's a
// legitimate, different use case (single-band, matches what a time-domain
// step can produce) and is intentionally not replaced by this module. This
// module is for anything that needs a full per-band reverberation picture:
// the report export, any RT60 display in the UI, etc.

import { getAbsorptionOrNull, nrc, type AbsorptionCoeffs, type NullableAbsorption } from './absorption';
import { SENSITIVITY_REFERENCE_DB } from './speakerResponse';
export type { AbsorptionCoeffs };

export type Point = { x: number; y: number };

export interface RoomGeometryInput {
  // Optional: callers that only have a solver-request shape (L/W/H, no
  // editor footprint -- e.g. a stored simulation's raw room payload, see
  // computeRoomSurfaces below) omit this. A rectangular L x W footprint is
  // assumed when absent.
  poly?: Point[]; // normalized (0-1) footprint coordinates
  L: number; // real-world footprint scale, X axis, meters
  W: number; // real-world footprint scale, Y axis, meters
  H: number; // ceiling height, meters
  wallMaterial: string; // default/global wall material
  wallSegMats?: (string | null)[]; // per-segment override; null = use wallMaterial
  wallOpenings?: ('full' | { start: number; end: number } | null)[];
  floorMaterial: string;
  ceilMaterial: string;
}

const BANDS: (keyof AbsorptionCoeffs)[] = ['hz125', 'hz250', 'hz500', 'hz1000', 'hz2000', 'hz4000', 'hz8000'];
export const BAND_LABELS = ['125 Hz', '250 Hz', '500 Hz', '1000 Hz', '2000 Hz', '4000 Hz', '8000 Hz'];

// Shoelace formula: area of a simple polygon from its vertices.
function polygonArea(points: { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    sum += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(sum) / 2;
}

export interface RoomSurfaces {
  volume: number; // m^3
  floorArea: number; // m^2
  ceilArea: number; // m^2
  // Each wall segment records its closed-wall length plus any opening length.
  // Openings are treated as an alpha=1 energy-loss boundary in the analytical
  // model: sound leaving the room is not reflected back into it.
  wallSegments: { lengthM: number; openingLengthM: number; materialId: string }[];
  totalWallArea: number; // m^2 (sum of segment areas), for reference/display
}

// Derive real-world surface areas and volume from the normalized polygon +
// L/W/H scale. Each poly point (x,y) in [0,1] maps to real coordinates
// (x*L, y*W); wall segment i runs from poly[i] to poly[i+1].
export function computeRoomSurfaces(room: RoomGeometryInput): RoomSurfaces {
  const { L, H, wallMaterial } = room;

  // `poly` is missing for any room object that came from a raw solver
  // request rather than the editor's project state: /api/report/export
  // builds its `room` from `sim.room`, which the solver routes persist as
  // literally `req.body` (see server.ts) -- the wave/IR solver payload
  // shape, which has L/W/H/source/receiver but no poly or wallSegMats at
  // all. Every report generated from a real stored simulation therefore
  // called `poly.map(...)` on `undefined` and crashed inside this function
  // with no catch above it, which is a 500 for every export, not a
  // hypothetical edge case.
  //
  // Fall back to the simple rectangular footprint implied by L x W, which
  // is exactly what the solver itself assumes when it has no polygon.
  const poly: Point[] = room.poly?.length
    ? room.poly
    : [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const wallSegMats = room.wallSegMats?.length === poly.length
    ? room.wallSegMats
    : new Array(poly.length).fill(wallMaterial);
  const W = room.W;

  const realPoints = poly.map(p => ({ x: p.x * L, y: p.y * W }));
  const floorArea = polygonArea(realPoints);

  const wallSegments = realPoints.map((p1, i) => {
    const p2 = realPoints[(i + 1) % realPoints.length];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const lengthM = Math.sqrt(dx * dx + dy * dy);
    const materialId = wallSegMats[i] ?? wallMaterial;
    const opening = room.wallOpenings?.[i] ?? null;
    const openFraction = opening === 'full' ? 1 : (opening && typeof opening === 'object' ? Math.max(0, Math.min(1, opening.end - opening.start)) : 0);
    const openingLengthM = lengthM * openFraction;
    const effectiveLengthM = lengthM - openingLengthM;
    return { lengthM: effectiveLengthM, openingLengthM, materialId };
  });

  const totalWallArea = wallSegments.reduce((sum, seg) => sum + (seg.lengthM + seg.openingLengthM) * H, 0);
  const volume = floorArea * H;

  return {
    volume,
    floorArea,
    ceilArea: floorArea, // ceiling directly mirrors the footprint
    wallSegments,
    totalWallArea,
  };
}

export interface RT60Result {
  // Per-band RT60 in seconds, both methods, for the caller to choose/display.
  // null means the material data for that band is unavailable or the model has
  // no absorbing area, rather than returning a fabricated huge RT60.
  sabine: Record<string, number | null>; // keyed by band label, e.g. "500 Hz"
  eyring: Record<string, number | null>;
  // Area-weighted average absorption coefficient per band (needed for Eyring
  // and useful to show alongside the RT60 numbers).
  avgAbsorption: Record<string, number | null>;
  // Which formula this room's overall absorption level suggests is more
  // appropriate. Eyring's own derivation doesn't specify an exact
  // crossover point; published guidance commonly cites ~0.3 average alpha
  // as where Sabine's overestimate becomes significant (15%+), so that's
  // used here as a conservative rule of thumb, not a standardized cutoff.
  recommendedMethod: 'sabine' | 'eyring';
  volume: number;
  // Real footprint area (m^2) from the actual room polygon, not L*W — the
  // room may be non-rectangular. Exposed directly so callers (e.g. the PDF
  // report) don't need to reverse-engineer it from volume/H, which is only
  // correct today because volume happens to be floorArea*H and would
  // silently break if that relationship ever changed (sloped ceilings,
  // per-segment heights, etc.).
  floorArea: number;
  totalSurfaceArea: number;
}

// Sabine: RT60 = 0.161 * V / A, where A = sum(area_i * alpha_i).
// Eyring: RT60 = 0.161 * V / (-S * ln(1 - alpha_avg)), more accurate as
// absorption increases (Sabine over-predicts RT60 in "dead" rooms).
// Reference: Sabine (1898); Eyring (1930). Both are long-standing, widely
// published methods in architectural acoustics (see e.g. ISO 3382 for
// standard reverberation-time measurement/reporting conventions this
// calculation is meant to be compared against, not a substitute for
// on-site measurement).
//
// materialLookup: optional override for how a material id resolves to
// per-band absorption coefficients. Defaults to the real, shared
// getAbsorption() from absorption.ts (production behavior — the app should
// never pass a custom lookup). Exists so roomAcoustics.validation.ts can
// exercise this exact function against published reference cases that use
// arbitrary custom coefficients not present in our named material table,
// without needing to duplicate this formula in a separate reimplementation.
export function computeRT60(
  room: RoomGeometryInput,
  materialLookup: (materialId: string) => NullableAbsorption = getAbsorptionOrNull
): RT60Result {
  const surfaces = computeRoomSurfaces(room);
  const { volume, floorArea, ceilArea, wallSegments } = surfaces;
  const totalSurfaceArea = floorArea + ceilArea + wallSegments.reduce((s, w) => s + (w.lengthM + w.openingLengthM) * room.H, 0);

  const sabine: Record<string, number | null> = {};
  const eyring: Record<string, number | null> = {};
  const avgAbsorption: Record<string, number | null> = {};

  let sumAlphaMid = 0; // for recommendedMethod decision, using 500Hz+1000Hz average

  BANDS.forEach((band, i) => {
    const label = BAND_LABELS[i];

    const floorAlpha = materialLookup(room.floorMaterial)[band];
    const ceilAlpha = materialLookup(room.ceilMaterial)[band];
    let hasNull = floorAlpha === null || ceilAlpha === null;

    let totalSabins = 0;
    if (!hasNull) {
      totalSabins = floorArea * (floorAlpha as number) + ceilArea * (ceilAlpha as number);
      for (const seg of wallSegments) {
        const alpha = materialLookup(seg.materialId)[band];
        if (alpha === null) {
          hasNull = true;
          break;
        }
        totalSabins += seg.lengthM * room.H * (alpha as number);
        totalSabins += seg.openingLengthM * room.H; // fully open area: energy leaves the modeled room
      }
    }

    // Never manufacture an RT60 when a band has no material coefficient or
    // when the model has zero absorbing area. A null means "not computable
    // from the supplied material data"; an enormous fake RT60 is worse than
    // no number because it looks like a physical prediction.
    if (hasNull || totalSurfaceArea <= 0 || totalSabins <= 0) {
      avgAbsorption[label] = null;
      sabine[label] = null;
      eyring[label] = null;
      return;
    }

    const alphaAvg = Math.min(1, totalSabins / totalSurfaceArea);
    avgAbsorption[label] = Math.round(alphaAvg * 1000) / 1000;

    sabine[label] = Math.round(((0.161 * volume) / totalSabins) * 100) / 100;

    // Eyring: guard alphaAvg -> 1 (would make ln(0) = -Infinity).
    const safeAlpha = Math.min(alphaAvg, 0.999);
    const eyringDenominator = -totalSurfaceArea * Math.log(1 - safeAlpha);
    eyring[label] = eyringDenominator > 0
      ? Math.round(((0.161 * volume) / eyringDenominator) * 100) / 100
      : null;

    if (band === 'hz500' || band === 'hz1000') sumAlphaMid += alphaAvg;
  });

  const avgMidAlpha = sumAlphaMid / 2;

  return {
    sabine,
    eyring,
    avgAbsorption,
    recommendedMethod: avgMidAlpha < 0.3 ? 'sabine' : 'eyring',
    volume,
    floorArea,
    totalSurfaceArea,
  };
}

export interface STIProxyResult {
  value: number; // 0-1
  qualityLabel: string; // Bad / Poor / Fair / Good / Excellent
  // Explicit, non-negotiable caveat — always surface this alongside the
  // number in any UI/report. This is not the IEC 60268-16 measurement.
  disclaimer: string;
}

function stiQualityLabel(sti: number): string {
  if (sti < 0.3) return 'Bad';
  if (sti < 0.45) return 'Poor';
  if (sti < 0.6) return 'Fair';
  if (sti < 0.75) return 'Good';
  return 'Excellent';
}

// Labeled proxy STI estimate from RT60 (mid-frequency, e.g. the 1000Hz
// Sabine/Eyring value) and a signal-to-noise ratio at the listening position that
// the CALLER must supply (there is no default SNR). Returns null for invalid input.
//
// Formula (Houtgast & Steeneken-derived proxy, as published and used in
// open acoustic-analysis tooling — NOT the full IEC 60268-16 modulation
// transfer function calculation, which requires per-band MTF analysis of
// an actual impulse response and is a materially larger undertaking):
//   STI_proxy = 0.15 + 0.85 * (0.65 * R_T + 0.35 * R_S)
//   R_T = 1 / (1 + (RT60/0.8)^1.6)
//   R_S = 1 / (1 + 10^(-(SNR-15)/10))
//
// The source publishing this proxy explicitly notes it "should not be used
// for formal compliance testing" — treat this output the same way. Always
// label it as an estimate, never as a certified/compliant STI measurement.
export function computeSTIProxy(rt60Seconds: number, snrDb: number): STIProxyResult | null {
  // Invalid inputs give "not available", never a NaN or an invented number.
  if (typeof rt60Seconds !== 'number' || !Number.isFinite(rt60Seconds) || rt60Seconds <= 0) return null;
  if (typeof snrDb !== 'number' || !Number.isFinite(snrDb)) return null;
  const rT = 1 / (1 + Math.pow(rt60Seconds / 0.8, 1.6));
  const rS = 1 / (1 + Math.pow(10, -(snrDb - 15) / 10));
  const sti = 0.15 + 0.85 * (0.65 * rT + 0.35 * rS);
  const clamped = Math.max(0, Math.min(1, sti));

  return {
    value: Math.round(clamped * 100) / 100,
    qualityLabel: stiQualityLabel(clamped),
    disclaimer:
      'This is an estimate derived from RT60 and assumed signal-to-noise ratio, not a full IEC 60268-16 speech transmission index measurement. It is not suitable for compliance or certification purposes.',
  };
}

export { nrc };

export interface EstimatedSPLResult {
  G: Record<string, number | null>;
  SPL: Record<string, number | null>;
  /** True when no real sensitivity was supplied and the 90 dB reference was used. */
  sensitivityIsFallback: boolean;
  /** Per-band reason a value is null. */
  reasons: Record<string, string>;
}

export const SPL_REFERENCE_SENSITIVITY_DB = SENSITIVITY_REFERENCE_DB;

export function computeEstimatedGAndSPL(
  rt60Result: RT60Result,
  room: RoomGeometryInput,
  sourcePos: {x: number, y: number, z?: number},
  receiverPos: {x: number, y: number, z?: number},
  sourceSens?: number | null
): EstimatedSPLResult {
  const surfaces = computeRoomSurfaces(room);
  const V = surfaces.volume;
  const S = surfaces.floorArea + surfaces.ceilArea + surfaces.wallSegments.reduce((sum, seg) => sum + ((seg.lengthM + seg.openingLengthM) * room.H), 0);
  
  // Source/receiver x/y are normalized room coordinates; convert them to metres before computing distance.
  const dx = (sourcePos.x - receiverPos.x) * room.L;
  const dy = (sourcePos.y - receiverPos.y) * room.W;
  // A Z coordinate that is genuinely absent is UNKNOWN physical data: it is not replaced with an ear-height guess.
  // An explicit 0 is a real height and is used as-is. With either Z unknown the 3-D distance cannot be computed,
  // so every band is reported unavailable (with a reason) below instead of an SPL/G built on an invented height.
  const zMissing = sourcePos.z == null || receiverPos.z == null;
  const dz = zMissing ? NaN : Number(sourcePos.z) - Number(receiverPos.z);
  const r = Math.max(0.1, Math.sqrt(dx*dx + dy*dy + dz*dz));
  
  const sensitivityIsFallback = !(typeof sourceSens === 'number' && Number.isFinite(sourceSens) && sourceSens > 0);
  const Lw = (sensitivityIsFallback ? SPL_REFERENCE_SENSITIVITY_DB : (sourceSens as number)) + 11;
  const G: Record<string, number | null> = {};
  const SPL: Record<string, number | null> = {};
  const reasons: Record<string, string> = {};
  const coordsOk = [sourcePos.x, sourcePos.y, receiverPos.x, receiverPos.y, dx, dy, dz].every(Number.isFinite);

  for (const band of Object.keys(rt60Result.sabine)) {
    const rt = rt60Result.sabine[band];
    if (!coordsOk) { SPL[band] = null; G[band] = null; reasons[band] = zMissing ? 'Source or receiver Z coordinate is unknown' : 'Non-finite source/receiver coordinates'; continue; }
    if (rt == null || !Number.isFinite(rt) || rt <= 0) { SPL[band] = null; G[band] = null; reasons[band] = 'RT60 not computable for this band (check materials)'; continue; }
    const A = 0.161 * V / rt;
    const alpha_mean = Math.min(0.99, A / S);
    const R_room = S * alpha_mean / (1 - alpha_mean);
    
    // G = 10 log10( 100/r^2 + 400*pi/R_room ) 
    // Wait, ISO 3382-1: G = 10 log10( E / E_10 ) = Lp - Lw_10 = Lp - Lw + 31
    // Actually Lp = Lw + 10 log10( Q / (4 pi r^2) + 4 / R_room )
    const directEnergy = 1 / (4 * Math.PI * r * r);
    const reverbEnergy = 4 / R_room;
    
    const Lp = Lw + 10 * Math.log10(directEnergy + reverbEnergy);
    SPL[band] = Math.round(Lp * 10) / 10;
    
    const Lp_10_free = Lw + 10 * Math.log10(1 / (4 * Math.PI * 100)); // Lw - 31 dB
    const gVal = Lp - Lp_10_free;
    G[band] = Math.round(gVal * 10) / 10;
  }
  return { G, SPL, sensitivityIsFallback, reasons };
}
