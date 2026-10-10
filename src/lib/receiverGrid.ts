// Pure planning for the "Receiver Grid Generator". Receiver x/y are FRACTIONS of the room footprint (0..1,
// the same convention the API and solver validate); z is a height in metres. Every input is parsed strictly:
// blank, non-numeric, or non-finite text is an error with a message that names the field, never a silent 0.

export interface GridTextInput { xMin: string; xMax: string; yMin: string; yMax: string; z: string; spacing: string }

export type GridPlan =
  | { ok: true; xs: number[]; ys: number[]; z: number; count: number }
  | { ok: false; error: string };

/** Strict number parser: rejects blank text and anything Number() would coerce loosely (parseFloat('1abc') === 1). */
export function strictNumber(text: string): number | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

const EPS = 1e-9;

function axisCount(min: number, max: number, spacing: number): number {
  // EPS absorbs binary floating-point error such as (0.7 - 0.1) / 0.1 === 5.999999999999999.
  return Math.floor((max - min) / spacing + EPS) + 1;
}

function axisValues(min: number, max: number, spacing: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.min(max, Number((min + i * spacing).toFixed(9))));
  return out;
}

export function planReceiverGrid(input: GridTextInput, roomHeightM: number, maxReceivers: number): GridPlan {
  if (!Number.isFinite(roomHeightM) || roomHeightM <= 0) return { ok: false, error: 'Room height is not valid.' };
  const fields: Array<[keyof GridTextInput, string]> = [
    ['xMin', 'X Min'], ['xMax', 'X Max'], ['yMin', 'Y Min'], ['yMax', 'Y Max'], ['z', 'Z Height'], ['spacing', 'Spacing'],
  ];
  const v: Partial<Record<keyof GridTextInput, number>> = {};
  for (const [key, label] of fields) {
    const n = strictNumber(input[key]);
    if (n === null) return { ok: false, error: `${label} must be a number.` };
    v[key] = n;
  }
  const { xMin, xMax, yMin, yMax, z, spacing } = v as Record<keyof GridTextInput, number>;
  for (const [label, n] of [['X Min', xMin], ['X Max', xMax], ['Y Min', yMin], ['Y Max', yMax]] as const) {
    if (n < 0 || n > 1) return { ok: false, error: `${label} must be between 0 and 1 (a fraction of the room).` };
  }
  if (xMin > xMax) return { ok: false, error: 'X Min must not exceed X Max.' };
  if (yMin > yMax) return { ok: false, error: 'Y Min must not exceed Y Max.' };
  if (!(spacing > 0)) return { ok: false, error: 'Spacing must be greater than 0.' };
  if (z < 0 || z > roomHeightM) return { ok: false, error: `Z Height must be between 0 and the room height (${roomHeightM} m).` };

  // Count first, as plain numbers, and only build arrays once the limit is satisfied.
  const nx = axisCount(xMin, xMax, spacing);
  const ny = axisCount(yMin, yMax, spacing);
  const count = nx * ny;
  if (!Number.isFinite(count)) return { ok: false, error: 'Spacing is too small for this range.' };
  if (count > maxReceivers) return { ok: false, error: `This grid would create ${count} receivers; the maximum is ${maxReceivers}.` };
  return { ok: true, xs: axisValues(xMin, xMax, spacing, nx), ys: axisValues(yMin, yMax, spacing, ny), z, count };
}
