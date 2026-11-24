import type { DensityGrid } from '../geo/density';
import { drawThickPolyline, fillPolygon, makeGrid, polygonsOf, type Grid } from '../geo/rasterize';
import type { TacticalLayers } from '../geo/types';
import { bboxOf, pointInPolygon, rectContains, rectsOverlap, type Rect } from './geom';

interface PolyEntry { rings: number[][][]; bbox: Rect; areaM2: number; name: string | null }
interface LineEntry { pts: number[][]; bbox: Rect; width: number }

export interface Raster { grid: Grid; mask: Uint8Array }

/** Mask values. */
export const WATER = 0;
export const LAND = 1;
export const ROAD = 2;

/**
 * Everything procgen needs from the real world, indexed for chunk-sized queries.
 * Pure data: the same object can later be rebuilt inside a Web Worker (M3).
 */
export class GeoContext {
  readonly islands: PolyEntry[];

  constructor(
    readonly seed: number,
    readonly land: PolyEntry[],
    readonly streams: LineEntry[],
    readonly places: PolyEntry[],
    readonly density: DensityGrid,
    islandMaxAreaM2: number,
  ) {
    this.islands = land.filter((l) => l.areaM2 <= islandMaxAreaM2);
  }

  static fromTactical(t: TacticalLayers, density: DensityGrid, seed: number, streamWidths: Record<string, number>, islandMaxAreaM2: number) {
    const land: PolyEntry[] = [];
    for (const f of t.land.features) {
      for (const rings of polygonsOf(f.geometry as never)) {
        land.push({ rings, bbox: bboxOf(rings[0]!), areaM2: f.properties.areaM2, name: f.properties.islandName });
      }
    }
    const streams: LineEntry[] = [];
    for (const f of t.streams.features) {
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      const width = streamWidths[f.properties.MTFCC] ?? 6;
      for (const pts of lines) streams.push({ pts, bbox: bboxOf(pts), width });
    }
    const places: PolyEntry[] = [];
    for (const f of t.places.features) {
      for (const rings of polygonsOf(f.geometry as never)) {
        places.push({ rings, bbox: bboxOf(rings[0]!), areaM2: 0, name: f.properties.NAME });
      }
    }
    return new GeoContext(seed, land, streams, places, density, islandMaxAreaM2);
  }

  /** Land/water mask for a rectangle. Streams are burned in as water when `withStreams`. */
  rasterize(rect: Rect, cell: number, withStreams: boolean): Raster {
    const grid = makeGrid(rect, cell);
    const mask = new Uint8Array(grid.width * grid.height);
    const r: Rect = [grid.minX, grid.minY, grid.maxX, grid.maxY];
    for (const l of this.land) if (rectsOverlap(l.bbox, r)) fillPolygon(grid, l.rings, mask, LAND, 'set');
    if (withStreams) {
      for (const s of this.streams) {
        if (!rectsOverlap(s.bbox, [r[0] - s.width, r[1] - s.width, r[2] + s.width, r[3] + s.width])) continue;
        drawThickPolyline(grid, s.pts, s.width, mask, WATER);
      }
    }
    return { grid, mask };
  }

  /** Burn streams (as water, at their nominal width) into an existing raster. */
  burnStreams(raster: Raster): void {
    const g = raster.grid;
    for (const s of this.streams) {
      if (!rectsOverlap(s.bbox, [g.minX - s.width, g.minY - s.width, g.maxX + s.width, g.maxY + s.width])) continue;
      drawThickPolyline(g, s.pts, s.width, raster.mask, WATER);
    }
  }

  inCity(x: number, y: number): boolean {
    for (const p of this.places) if (rectContains(p.bbox, x, y) && pointInPolygon(x, y, p.rings)) return true;
    return false;
  }

  /** Index into `islands` of the island containing the point, or -1 (mainland / water). */
  islandAt(x: number, y: number): number {
    for (let i = 0; i < this.islands.length; i++) {
      const l = this.islands[i]!;
      if (rectContains(l.bbox, x, y) && pointInPolygon(x, y, l.rings)) return i;
    }
    return -1;
  }
}

export function maskAt(r: Raster, x: number, y: number): number {
  const { grid } = r;
  const c = Math.floor((x - grid.minX) / grid.cell);
  const row = Math.floor((grid.maxY - y) / grid.cell);
  if (c < 0 || row < 0 || c >= grid.width || row >= grid.height) return -1;
  return r.mask[row * grid.width + c]!;
}
