import type { GridMeta } from './types';

/**
 * Quantized population-density grid (row 0 = north).
 * Byte 0 = water / outside the state; 1..255 = log-scaled people/km².
 */
export class DensityGrid {
  constructor(readonly meta: GridMeta, readonly data: Uint8Array, readonly maxPeoplePerKm2: number) {
    if (data.length !== meta.width * meta.height) {
      throw new Error(`density grid size mismatch: ${data.length} != ${meta.width}x${meta.height}`);
    }
  }

  /** Cell index for a point in meters, or -1 if outside the grid. */
  indexAt(x: number, y: number): number {
    const { minX, maxY, cell, width, height } = this.meta;
    const c = Math.floor((x - minX) / cell);
    const r = Math.floor((maxY - y) / cell);
    if (c < 0 || r < 0 || c >= width || r >= height) return -1;
    return r * width + c;
  }

  /** Raw byte at a point (0 = water/outside). */
  byteAt(x: number, y: number): number {
    const i = this.indexAt(x, y);
    return i < 0 ? 0 : this.data[i]!;
  }

  /** Normalized density 0..1 (0 also for water). */
  sample(x: number, y: number): number {
    return this.byteAt(x, y) / 255;
  }

  isLand(x: number, y: number): boolean {
    return this.byteAt(x, y) > 0;
  }

  /** Approximate people/km² (inverse of the log1p encoding). */
  peoplePerKm2(x: number, y: number): number {
    const b = this.byteAt(x, y);
    if (b <= 1) return 0;
    return Math.expm1((b / 255) * Math.log1p(this.maxPeoplePerKm2));
  }
}

/** Colorize a density grid into RGBA pixels for the debug overlay. */
export function densityToImageData(grid: DensityGrid, alpha: number): ImageData {
  const { width, height } = grid.meta;
  const img = new ImageData(width, height);
  const px = img.data;
  for (let i = 0; i < grid.data.length; i++) {
    const v = grid.data[i]!;
    if (v === 0) continue;
    const t = v / 255;
    const [r, g, b] = heat(t);
    const o = i * 4;
    px[o] = r;
    px[o + 1] = g;
    px[o + 2] = b;
    px[o + 3] = Math.round(alpha * (0.25 + 0.75 * t));
  }
  return img;
}

// Dark blue -> teal -> green -> yellow -> hot white (reads well over charcoal land).
const STOPS: [number, number, number, number][] = [
  [0.0, 20, 30, 70],
  [0.35, 20, 120, 140],
  [0.6, 120, 200, 60],
  [0.8, 250, 200, 40],
  [1.0, 255, 250, 230],
];

function heat(t: number): [number, number, number] {
  for (let i = 1; i < STOPS.length; i++) {
    const a = STOPS[i - 1]!;
    const b = STOPS[i]!;
    if (t <= b[0]) {
      const k = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
    }
  }
  const l = STOPS[STOPS.length - 1]!;
  return [l[1], l[2], l[3]];
}
