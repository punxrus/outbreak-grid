import PROCGEN from '../config/procgen.json';
import { inRegion, type Region } from '../campaign/region';
import type { WireChunk } from '../procgen/wire';
import type { BattleWorld } from './types';

/**
 * Stitch a region's chunk walk grids into one battlefield raster (row 0 =
 * north). Cells outside the region become water, so the battle stays inside.
 */
export function assembleWorld(region: Region, chunks: WireChunk[]): BattleWorld {
  const C = PROCGEN.chunkSize;
  const cell = chunks[0]!.nav.cell, per = C / cell;
  const coords = chunks.map((c) => c.key.split(',').map(Number) as [number, number]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [cx, cy] of coords) { x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy); }
  const width = (x1 - x0 + 1) * per, height = (y1 - y0 + 1) * per;
  const grid = new Uint8Array(width * height); // 0 = water / outside
  const minX = x0 * C, maxY = (y1 + 1) * C;
  const homes: number[] = [];
  chunks.forEach((c, i) => {
    const [cx, cy] = coords[i]!;
    const col0 = (cx - x0) * per, row0 = (y1 - cy) * per;
    for (let r = 0; r < per; r++) grid.set(c.nav.grid.subarray(r * per, (r + 1) * per), (row0 + r) * width + col0);
    for (let k = 0; k < c.homes.length; k++) homes.push(c.homes[k]!);
  });
  for (let r = 0; r < height; r++) for (let col = 0; col < width; col++) {
    if (!inRegion(region.mask, minX + (col + 0.5) * cell, maxY - (r + 0.5) * cell)) grid[r * width + col] = 0;
  }
  const police = chunks.flatMap((c) => c.landmarks.filter((l) => l.type === 'police').map((l) => [l.x, l.y] as [number, number]));
  return { minX, maxY, cell, width, height, grid, homes: Float32Array.from(homes), police };
}
