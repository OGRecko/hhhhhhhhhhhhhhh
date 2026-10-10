// Sound absorption coefficients (α), per octave band, for every material id
// defined in materials.ts.
//
// IMPORTANT — this is a distinct physical quantity from materials.ts's `tl`
// (Transmission Loss, in dB): TL describes how much sound is blocked from
// passing THROUGH a wall into the next space (isolation between rooms). α
// describes what fraction of sound energy is absorbed ON REFLECTION inside
// the room the surface bounds (0 = fully reflective, 1 = fully absorptive).
// RT60 / reverberance depends on α, not TL. A material can have high TL and
// low α at the same time (e.g. concrete: blocks sound well, but is very
// reflective inside the room) — the two numbers are not interchangeable and
// deliberately live in separate files.
//
// Octave bands: 125, 250, 500, 1000, 2000, 4000, 8000 Hz. The 8 kHz values are populated only where this project already had an explicit reference value; other materials remain unavailable rather than being extrapolated.
//
// SOURCING NOTE: values below are drawn from commonly published architectural
// acoustics references (e.g. Commercial Acoustics' absorption coefficient
// chart, cross-referenced against standard textbook tables). Real materials
// vary by thickness, mounting, and manufacturer — these are reasonable
// general-purpose defaults, not lab measurements of a specific product. Where
// this app's material list doesn't have a direct published entry (e.g.
// "Suspended Acoustic Clouds", "Isolated Ceiling"), the closest physically
// analogous published material was used and is noted inline. Do not present
// these numbers as certified/lab-tested — they're standard reference
// estimates, appropriate for room-level design guidance, not for compliance
// documentation.

export interface AbsorptionCoeffs {
  hz125: number;
  hz250: number;
  hz500: number;
  hz1000: number;
  hz2000: number;
  hz4000: number;
  hz8000: number | null;
}

function a(hz125: number, hz250: number, hz500: number, hz1000: number, hz2000: number, hz4000: number, hz8000?: number): AbsorptionCoeffs {
  return { hz125, hz250, hz500, hz1000, hz2000, hz4000, hz8000: (hz8000 !== undefined) ? hz8000 : null };
}

// NRC-style single-number average (250/500/1000/2000 Hz mean), for quick
// display purposes only — full RT60 calculation should use per-band values.
export function nrc(c: AbsorptionCoeffs): number {
  return Math.round(((c.hz250 + c.hz500 + c.hz1000 + c.hz2000) / 4) * 100) / 100;
}

export const ABSORPTION: Record<string, AbsorptionCoeffs> = {
  // --- Walls ---
  drywall: a(0.29, 0.10, 0.05, 0.04, 0.07, 0.09, 0.09), // gypsum board on studs
  brick: a(0.05, 0.04, 0.02, 0.04, 0.05, 0.05), // unpainted brick
  concrete: a(0.01, 0.01, 0.02, 0.02, 0.02, 0.02, 0.04), // painted/sealed concrete
  cinder_block: a(0.36, 0.44, 0.31, 0.29, 0.39, 0.25), // unpainted CMU (porous block)
  glass: a(0.18, 0.06, 0.04, 0.03, 0.02, 0.02, 0.03), // glass window
  glass_double: a(0.10, 0.07, 0.05, 0.03, 0.02, 0.02), // double glazing: similar surface reflectivity, slightly damped by pane coupling — approximation
  wood_panel: a(0.28, 0.22, 0.17, 0.09, 0.10, 0.11), // wood paneling on studs
  plywood_panel: a(0.28, 0.22, 0.17, 0.09, 0.10, 0.11), // same order as wood paneling
  acoustic_panel: a(0.20, 0.55, 0.75, 0.80, 0.75, 0.65, 0.97), // ~1" fiberglass/mineral wool panel
  acoustic_panel_thick: a(0.35, 0.70, 0.85, 0.90, 0.90, 0.85), // ~2" panel: deeper = better low-freq
  curtain_wall: a(0.07, 0.31, 0.49, 0.75, 0.70, 0.60), // heavy curtains, draped
  tile_wall: a(0.01, 0.01, 0.01, 0.01, 0.02, 0.02), // ceramic tile, hard/reflective
  wallpaper: a(0.29, 0.10, 0.05, 0.04, 0.07, 0.09), // paper on plaster behaves like painted drywall/plaster
  marble_wall: a(0.01, 0.01, 0.01, 0.01, 0.02, 0.02), // marble/stone, highly reflective
  iso_wall: a(0.05, 0.07, 0.06, 0.05, 0.06, 0.07), // isolation wall: mass-heavy assemblies are reflective inside the room despite blocking transmission — approximation based on dense multi-layer wall

  // --- Floors ---
  wood_floor: a(0.15, 0.11, 0.10, 0.07, 0.06, 0.07, 0.08), // hardwood on joists
  tile: a(0.01, 0.01, 0.01, 0.01, 0.02, 0.02), // ceramic tile floor
  polished_concrete: a(0.01, 0.01, 0.02, 0.02, 0.02, 0.02, 0.04),
  vinyl: a(0.02, 0.03, 0.03, 0.03, 0.03, 0.02),
  carpet_thin: a(0.01, 0.02, 0.06, 0.15, 0.25, 0.45), // thin carpet on hard floor
  carpet_thick: a(0.05, 0.10, 0.20, 0.35, 0.45, 0.55, 0.75), // thick carpet, more low/mid absorption than thin
  carpet_padded: a(0.08, 0.24, 0.57, 0.69, 0.71, 0.73), // carpet on foam/padding underlay
  concrete_floor: a(0.01, 0.02, 0.04, 0.06, 0.08, 0.10), // unpainted rough concrete
  raised_access: a(0.02, 0.03, 0.03, 0.03, 0.03, 0.02), // treated as vinyl/hard-surface-equivalent — approximation
  cork: a(0.02, 0.03, 0.06, 0.10, 0.15, 0.20), // cork flooring: modest porous absorption — approximation from general porous-floor behavior
  iso_floor: a(0.02, 0.03, 0.03, 0.03, 0.03, 0.02), // floating floor: still hard-surfaced from above — treated as vinyl/hard floor equivalent

  // --- Ceilings ---
  drywall_ceil: a(0.29, 0.10, 0.05, 0.04, 0.07, 0.09), // gypsum board, same as wall drywall
  stonewool: a(0.30, 0.60, 0.80, 0.85, 0.80, 0.75, 0.95), // mineral wool acoustic ceiling tile
  stonewool_thick: a(0.45, 0.75, 0.90, 0.92, 0.90, 0.85), // thicker tile, better low-freq
  acoustic_tile: a(0.20, 0.55, 0.75, 0.80, 0.75, 0.65), // fiberglass acoustic tile, similar order to 1" panel
  acoustic_cloud: a(0.15, 0.40, 0.55, 0.60, 0.55, 0.50), // suspended clouds cover partial ceiling area with edge diffraction losses — scaled down from full-coverage panel values as an approximation
  exposed_concrete: a(0.01, 0.01, 0.02, 0.02, 0.02, 0.02, 0.04), // exposed concrete deck
  exposed_deck: a(0.05, 0.07, 0.06, 0.05, 0.06, 0.07), // painted/exposed metal deck — approximated as reflective sheet metal
  wood_ceil: a(0.15, 0.11, 0.10, 0.07, 0.06, 0.07), // wood slat ceiling, similar to wood flooring/paneling order
  coffered_plaster: a(0.29, 0.10, 0.05, 0.04, 0.07, 0.09), // plaster surface, similar to drywall but slightly higher diffusion from coffers — approximation
  perforated_metal: a(0.25, 0.55, 0.65, 0.65, 0.60, 0.55), // perforated metal over acoustic backing, similar order to acoustic tile
  iso_ceil: a(0.05, 0.07, 0.06, 0.05, 0.06, 0.07), // isolated ceiling assembly, reflective inside room despite isolation — approximation matching iso_wall
};

export class UnknownMaterialError extends Error {
  readonly materialId: string | null | undefined;
  constructor(materialId: string | null | undefined) {
    super(`Unknown material id: ${JSON.stringify(materialId ?? null)}. Choose a material from the material list; no default absorption is substituted.`);
    this.name = 'UnknownMaterialError';
    this.materialId = materialId;
  }
}

export function isKnownMaterial(materialId: string | null | undefined): boolean {
  return typeof materialId === 'string' && Object.prototype.hasOwnProperty.call(ABSORPTION, materialId);
}

/** Strict lookup: throws UnknownMaterialError instead of inventing a coefficient. */
export function getAbsorption(materialId: string | null | undefined): AbsorptionCoeffs {
  if (typeof materialId === 'string' && Object.prototype.hasOwnProperty.call(ABSORPTION, materialId)) {
    return ABSORPTION[materialId];
  }
  throw new UnknownMaterialError(materialId);
}

export type NullableAbsorption = { [K in keyof AbsorptionCoeffs]: number | null };

/** Non-throwing lookup for analytical RT60: unknown material => every band null (reported as N/A). */
export function getAbsorptionOrNull(materialId: string | null | undefined): NullableAbsorption {
  if (isKnownMaterial(materialId)) return ABSORPTION[materialId as string];
  return { hz125: null, hz250: null, hz500: null, hz1000: null, hz2000: null, hz4000: null, hz8000: null };
}

export function getOctaveAbsorption(materialId: string, freqHz: number): number | 'N/A' {
  const coeff = ABSORPTION[materialId];
  if (!coeff) return 'N/A';
  if (freqHz === 125) return coeff.hz125;
  if (freqHz === 250) return coeff.hz250;
  if (freqHz === 500) return coeff.hz500;
  if (freqHz === 1000) return coeff.hz1000;
  if (freqHz === 2000) return coeff.hz2000;
  if (freqHz === 4000) return coeff.hz4000;
  if (freqHz === 8000) return coeff.hz8000 ?? 'N/A';
  return 'N/A';
}
