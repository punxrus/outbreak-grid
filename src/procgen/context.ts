import type { DensityGrid } from '../geo/density';
import { buildEdgeBands, drawThickPolyline, fillBanded, fillPolygon, makeGrid, polygonsOf, type EdgeBands, type Grid } from '../geo/rasterize';
import type { TacticalLayers } from '../geo/types';
import { bboxOf, pointInPolygon, rectContains, rectsOverlap, ringArea, ringCentroid, type Rect } from './geom';
import PROCGEN from '../config/procgen.json';

interface PolyEntry { rings: number[][][]; bbox: Rect; areaM2: number; name: string | null; bands?: EdgeBands; pop?: number; cx?: number; cy?: number }

/** Polygons above this many vertices get a band index for fast small rasters. */
const BAND_MIN_VERTS = 4000;
const BAND_SIZE = 500;
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
/** A real place's center and population (Census internal point). */
export interface PlaceCenter { x: number; y: number; pop: number; geoid?: string }

export class GeoContext {
  readonly islands: PolyEntry[];

  constructor(
    readonly seed: number,
    readonly land: PolyEntry[],
    readonly streams: LineEntry[],
    readonly places: PolyEntry[],
    readonly density: DensityGrid,
    islandMaxAreaM2: number,
    readonly centers: PlaceCenter[] = [],
  ) {
    this.islands = land.filter((l) => l.areaM2 <= islandMaxAreaM2);
  }

  static fromTactical(
    t: TacticalLayers, density: DensityGrid, seed: number, streamWidths: Record<string, number>, islandMaxAreaM2: number,
    centers: PlaceCenter[] = [],
  ) {
    const land: PolyEntry[] = [];
    for (const f of t.land.features) {
      for (const rings of polygonsOf(f.geometry as never)) {
        const verts = rings.reduce((a, r) => a + r.length, 0);
        const bands = verts >= BAND_MIN_VERTS ? buildEdgeBands(rings, BAND_SIZE) : undefined;
        land.push({ rings, bbox: bboxOf(rings[0]!), areaM2: f.properties.areaM2, name: f.properties.islandName, bands });
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
        // rings[0] outer, the rest holes
        const areaM2 = Math.abs(ringArea(rings[0] as never)) - rings.slice(1).reduce((a, r) => a + Math.abs(ringArea(r as never)), 0);
        const [pcx, pcy] = ringCentroid(rings[0] as never);
        places.push({ rings, bbox: bboxOf(rings[0]!), areaM2, name: f.properties.NAME, pop: f.properties.pop, cx: pcx, cy: pcy });
      }
    }
    return new GeoContext(seed, land, streams, places, density, islandMaxAreaM2, centers);
  }

  /** Land/water mask for a rectangle. Streams are burned in as water when `withStreams`. */
  rasterize(rect: Rect, cell: number, withStreams: boolean): Raster {
    const grid = makeGrid(rect, cell);
    const mask = new Uint8Array(grid.width * grid.height);
    const r: Rect = [grid.minX, grid.minY, grid.maxX, grid.maxY];
    for (const l of this.land) {
      if (!rectsOverlap(l.bbox, r)) continue;
      if (l.bands) fillBanded(grid, l.bands, mask, LAND, 'set');
      else fillPolygon(grid, l.rings, mask, LAND, 'set');
    }
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

  private readonly tiles = new Map<string, Raster>();

  /**
   * Land/water at the 10 m district resolution anywhere in the state, from
   * cached 1 km tiles. Tiles share the region rasters' lattice, so this agrees
   * with them exactly; use it where a sample may fall outside the region.
   */
  coarseMaskAt(x: number, y: number): number {
    const T = 1000, cell = 10;
    const tx = Math.floor(x / T), ty = Math.floor(y / T), key = `${tx},${ty}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = this.rasterize([tx * T, ty * T, (tx + 1) * T, (ty + 1) * T], cell, false);
      if (this.tiles.size >= 1024) this.tiles.delete(this.tiles.keys().next().value!);
      this.tiles.set(key, t);
    }
    return maskAt(t, x, y);
  }

  inCity(x: number, y: number): boolean {
    return this.placeAt(x, y) !== null;
  }

  /** The incorporated place / CDP containing a point (largest population wins). */
  placeAt(x: number, y: number): PolyEntry | null {
    let best: PolyEntry | null = null;
    for (const p of this.places) {
      if (!rectContains(p.bbox, x, y) || !pointInPolygon(x, y, p.rings)) continue;
      if (!best || (p.pop ?? 0) > (best.pop ?? 0)) best = p;
    }
    return best;
  }

  /**
   * Density (0..1, same log scale as the grid) at a point, raised to the
   * containing place's own pop/area. Rural tracts are huge, so a small town
   * like Forks averages out to forest without this.
   */
  densityAt(x: number, y: number): { density: number; place: PolyEntry | null } {
    const tract = this.density.sample(x, y);
    const place = this.placeAt(x, y);
    if (!place || !place.pop || place.areaM2 <= 0) return { density: tract, place };
    const norm = (ppk: number) => Math.log1p(ppk) / Math.log1p(this.density.maxPeoplePerKm2);
    const D = PROCGEN.districts;
    if (place.pop < D.smallTownMaxPop) {
      // Small towns are compact: pack the population into a core at town
      // density; the rest of the limits (airports, fields) keeps tract density.
      const r = Math.sqrt(place.pop / D.townPeoplePerKm2 / Math.PI) * 1000;
      const d = Math.hypot(x - place.cx!, y - place.cy!);
      return { density: d < r ? Math.max(tract, norm(D.townPeoplePerKm2)) : tract, place };
    }
    return { density: Math.max(tract, norm(place.pop / (place.areaM2 / 1e6))), place };
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
