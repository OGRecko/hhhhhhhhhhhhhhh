/**
 * Inverse Distance Weighting (IDW) Interpolation
 */

export interface Point3D {
  x: number;
  y: number;
  z?: number;
  value: number;
}

/**
 * Interpolates a value at (x,y) using IDW based on a set of known points.
 * @param x The target X coordinate (normalized 0-1)
 * @param y The target Y coordinate (normalized 0-1)
 * @param points Known measurement points
 * @param p Power parameter (typically 2)
 * @param maxRadius Max distance to consider for interpolation (optimization)
 */
export function interpolateIDW(x: number, y: number, points: Point3D[], p: number = 2, maxRadius: number = Infinity): number | null {
  if (points.length === 0) return null;

  let sumWeight = 0;
  let sumWeightedValue = 0;

  for (const pt of points) {
    const dx = x - pt.x;
    const dy = y - pt.y;
    const distSq = dx * dx + dy * dy;

    // Exact match (avoid div by zero)
    if (distSq < 1e-10) {
      return pt.value;
    }

    const dist = Math.sqrt(distSq);
    
    if (dist <= maxRadius) {
      const weight = 1.0 / Math.pow(dist, p);
      sumWeight += weight;
      sumWeightedValue += pt.value * weight;
    }
  }

  if (sumWeight === 0) return null;

  return sumWeightedValue / sumWeight;
}

/**
 * Generates an interpolated 2D grid for a given metric.
 * @param points The measured receiver points
 * @param resolution The width/height of the output grid grid
 * @returns 1D array of length resolution*resolution containing interpolated values
 */
export function generateInterpolationGrid(points: Point3D[], resolution: number = 64): (number | null)[] {
  const grid = new Array(resolution * resolution).fill(null);
  
  if (points.length === 0) return grid;

  for (let gy = 0; gy < resolution; gy++) {
    for (let gx = 0; gx < resolution; gx++) {
      // Normalized coordinates from 0 to 1
      const nx = gx / (resolution - 1);
      const ny = gy / (resolution - 1);
      
      const val = interpolateIDW(nx, ny, points, 2.5); // Slightly higher power for acoustics feels more local
      grid[gy * resolution + gx] = val;
    }
  }

  return grid;
}
