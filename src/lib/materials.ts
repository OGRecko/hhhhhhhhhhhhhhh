export const MATERIALS = {
  walls: [
    { id: 'drywall', name: 'Gypsum Board / Drywall', tl: 35 },
    { id: 'brick', name: 'Exposed Brick', tl: 45 },
    { id: 'concrete', name: 'Concrete', tl: 55 },
    { id: 'cinder_block', name: 'Cinder Block', tl: 42 },
    { id: 'glass', name: 'Glass Window', tl: 25 },
    { id: 'glass_double', name: 'Double Glazed Glass', tl: 32 },
    { id: 'wood_panel', name: 'Wood Paneling', tl: 28 },
    { id: 'plywood_panel', name: 'Plywood Paneling', tl: 24 },
    { id: 'acoustic_panel', name: 'Acoustic Panel (1 inch)', tl: 15 },
    { id: 'acoustic_panel_thick', name: 'Acoustic Panel (2 inch)', tl: 20 },
    { id: 'curtain_wall', name: 'Heavy Curtains', tl: 8 },
    { id: 'tile_wall', name: 'Ceramic Tile', tl: 40 },
    { id: 'wallpaper', name: 'Wallpaper on Plaster', tl: 35 },
    { id: 'marble_wall', name: 'Marble / Stone', tl: 50 },
    { id: 'iso_wall', name: 'Sound Isolation Wall', tl: 65 }
  ],
  floor: [
    { id: 'wood_floor', name: 'Hardwood Floor', tl: 30 },
    { id: 'tile', name: 'Ceramic Tile', tl: 45 },
    { id: 'polished_concrete', name: 'Polished Concrete', tl: 55 },
    { id: 'vinyl', name: 'Vinyl / Linoleum', tl: 35 },
    { id: 'carpet_thin', name: 'Thin Carpet on Concrete', tl: 55 },
    { id: 'carpet_thick', name: 'Thick Carpet on Concrete', tl: 55 },
    { id: 'carpet_padded', name: 'Carpet on Padding', tl: 40 },
    { id: 'concrete_floor', name: 'Rough Concrete', tl: 55 },
    { id: 'raised_access', name: 'Raised Access Floor', tl: 35 },
    { id: 'cork', name: 'Cork Flooring', tl: 32 },
    { id: 'iso_floor', name: 'Floating Floor', tl: 60 }
  ],
  ceiling: [
    { id: 'drywall_ceil', name: 'Gypsum Board / Drywall', tl: 35 },
    { id: 'stonewool', name: 'Stonewool Acoustic Tiles', tl: 25 },
    { id: 'stonewool_thick', name: 'Thick Stonewool Tiles', tl: 28 },
    { id: 'acoustic_tile', name: 'Fiberglass Acoustic Tile', tl: 20 },
    { id: 'acoustic_cloud', name: 'Suspended Acoustic Clouds', tl: 15 },
    { id: 'exposed_concrete', name: 'Exposed Concrete Deck', tl: 55 },
    { id: 'exposed_deck', name: 'Exposed Metal Deck', tl: 30 },
    { id: 'wood_ceil', name: 'Wood Slat Ceiling', tl: 25 },
    { id: 'coffered_plaster', name: 'Coffered Plaster', tl: 40 },
    { id: 'perforated_metal', name: 'Perforated Metal Panels', tl: 15 },
    { id: 'iso_ceil', name: 'Isolated Ceiling', tl: 60 }
  ]
};

// Single-number compatibility view. The authoritative per-band absorption
// data lives in absorption.ts; this view deliberately uses the 500 Hz band so
// the UI, analytical RT60 code, and FDTD solver do not silently disagree.
import { ABSORPTION as ABSORPTION_COEFFICIENTS } from './absorption';

export const ABSORPTION: Record<string, number> = Object.fromEntries(
  Object.entries(ABSORPTION_COEFFICIENTS).map(([id, coeff]) => [id, coeff.hz500]),
);

export function getAbsorption(materialId: string | null | undefined, fallback = 0.1): number {
  if (!materialId) return fallback;
  return ABSORPTION[materialId] ?? fallback;
}

export const ABSORPTION_OCTAVE: Record<string, Record<number, number | 'N/A'>> =
  Object.fromEntries(Object.entries(ABSORPTION_COEFFICIENTS).map(([id, coeff]) => [id, {
    125: coeff.hz125,
    250: coeff.hz250,
    500: coeff.hz500,
    1000: coeff.hz1000,
    2000: coeff.hz2000,
    4000: coeff.hz4000,
    8000: coeff.hz8000 ?? 'N/A',
  }]));

export function getOctaveAbsorption(materialId: string | null | undefined, freq: number): number | 'N/A' {
  if (!materialId) return 'N/A';
  const c = ABSORPTION_COEFFICIENTS[materialId];
  if (!c) return 'N/A';
  if (freq === 125) return c.hz125;
  if (freq === 250) return c.hz250;
  if (freq === 500) return c.hz500;
  if (freq === 1000) return c.hz1000;
  if (freq === 2000) return c.hz2000;
  if (freq === 4000) return c.hz4000;
  if (freq === 8000) return c.hz8000 ?? 'N/A';
  return 'N/A';
}

export const MAT_COLORS: Record<string, string> = {
  drywall: '#e0e0e0', brick: '#b25d46', concrete: '#959595', cinder_block: '#b0b5b9',
  glass: '#a8d5e2', glass_double: '#90c0d0', wood_panel: '#c19a6b', plywood_panel: '#d4b581',
  acoustic_panel: '#4a4a4a', acoustic_panel_thick: '#333333', curtain_wall: '#800020',
  tile_wall: '#f4f4f4', wallpaper: '#eaddcf', marble_wall: '#e2e4e1', iso_wall: '#d0d0d0',
  wood_floor: '#8b5a2b', tile: '#f5f5f0', polished_concrete: '#a0a0a0', vinyl: '#c0b4a6',
  carpet_thin: '#5c6b73', carpet_thick: '#3d4e56', carpet_padded: '#2c3e45',
  concrete_floor: '#888888', raised_access: '#b8b8b8', cork: '#d2b48c', iso_floor: '#808080',
  drywall_ceil: '#f0f0f0', stonewool: '#e0d8c0', stonewool_thick: '#d0c8b0',
  acoustic_tile: '#ffffff', acoustic_cloud: '#f8f8f8', exposed_concrete: '#999999',
  exposed_deck: '#70757a', wood_ceil: '#a07850', coffered_plaster: '#eae6df',
  perforated_metal: '#b5b8ba', iso_ceil: '#e8e8e8',
};
