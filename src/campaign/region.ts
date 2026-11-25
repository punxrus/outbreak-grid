import CAMPAIGN from '../config/campaign.json';
import PROCGEN from '../config/procgen.json';
import { fillPolygon, makeGrid, polygonsOf, type Grid } from '../geo/rasterize';
import type { TacticalLayers } from '../geo/types';
import { bboxOf, clipPolylineToRect, clipRingToRect, rectsOverlap, type Pt, type Rect } from '../procgen/geom';
import type { ForcedSite, LandmarkType } from '../procgen/types';

export type Stage = (typeof CAMPAIGN.stages)[number];
export const STAGES: Stage[] = CAMPAIGN.stages;

/** Region membership raster (1 = inside), row 0 = north. Plain data: posts to workers as-is. */
export interface RegionMask { grid: Grid; mask: Uint8Array }

export interface Region {
  stage: Stage;
  /** Real boundary (city limits / county) polygons, for drawing. */
  polygons: number[][][][];
  /** Bounds of boundary + margin. */
  bbox: Rect;
  mask: RegionMask;
  /** Chunks that touch the region, nearest to its center first. */
  chunks: [number, number][];
  center: Pt;
  /** Sites the stage requires: stage sites at the place's Census center, zone sites at their zone. */
  forced: ForcedSite[];
  /** Named parts of the stage (e.g. "The Battle for Satsop"). */
  zones: Zone[];
}

export interface Zone { id: string; label: string; x: number; y: number; radiusMeters: number }

export function stageById(id: string | null | undefined): Stage {
  return STAGES.find((s) => s.id === id) ?? STAGES[0]!;
}

/** Resolve a stage to its real boundary and build the membership mask + chunk list. */
export function buildRegion(stage: Stage, t: TacticalLayers, anchor?: Pt): Region | null {
  const place = (name: string) => t.places.features.filter((f) => f.properties.NAME === name).sort((a, b) => b.properties.pop - a.properties.pop).slice(0, 1);
  const feats = stage.kind === 'county'
    ? t.counties.features.filter((f) => f.properties.NAME === stage.name)
    : place(stage.name);
  // Neighboring places folded into the stage (Montesano + Satsop)
  for (const extra of stage.extraPlaces as string[]) feats.push(...place(extra));
  const polygons = feats.flatMap((f) => polygonsOf(f.geometry as never));
  if (!polygons.length) return null;
  const zones: Zone[] = (stage.zones as Zone[]).map((z) => ({ id: z.id, label: z.label, x: z.x, y: z.y, radiusMeters: z.radiusMeters }));
  // A zone's disc is part of the region even outside any city limits.
  const discs = zones.map((z) => [Array.from({ length: 64 }, (_, k) => [z.x + Math.cos((k / 64) * Math.PI * 2) * z.radiusMeters, z.y + Math.sin((k / 64) * Math.PI * 2) * z.radiusMeters])]);

  let b = bboxOf([...polygons, ...discs].flatMap((p) => p[0]!));
  const m = stage.marginMeters;
  b = [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
  // coarsest cell that keeps the mask under the size cap
  let cell = 25;
  while (((b[2] - b[0]) / cell) * ((b[3] - b[1]) / cell) > CAMPAIGN.maskMaxCells) cell *= 2;
  const grid = makeGrid(b, cell);
  const mask = new Uint8Array(grid.width * grid.height);
  for (const rings of [...polygons, ...discs]) fillPolygon(grid, rings, mask, 1, 'max');
  dilate(mask, grid.width, grid.height, Math.round(m / cell));

  const C = PROCGEN.chunkSize;
  const set = new Set<string>();
  const chunks: [number, number][] = [];
  for (let r = 0; r < grid.height; r++) for (let c = 0; c < grid.width; c++) {
    if (!mask[r * grid.width + c]) continue;
    const x = grid.minX + (c + 0.5) * cell, y = grid.maxY - (r + 0.5) * cell;
    const cx = Math.floor(x / C), cy = Math.floor(y / C), k = `${cx},${cy}`;
    if (!set.has(k)) { set.add(k); chunks.push([cx, cy]); }
  }
  const center: Pt = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  chunks.sort((p, q) => dist2(p, center, C) - dist2(q, center, C));
  const at = anchor ?? center;
  const forced: ForcedSite[] = (stage.sites as string[]).map((type) => ({ type: type as LandmarkType, x: at[0], y: at[1] }));
  for (const z of stage.zones as (Zone & { sites: { type: string; dx: number; dy: number }[] })[]) {
    for (const st of z.sites) forced.push({ type: st.type as LandmarkType, x: z.x + st.dx, y: z.y + st.dy });
  }
  return { stage, polygons, bbox: [grid.minX, grid.minY, grid.maxX, grid.maxY], mask: { grid, mask }, chunks, center, forced, zones };
}

const dist2 = (p: [number, number], c: Pt, C: number) => ((p[0] + 0.5) * C - c[0]) ** 2 + ((p[1] + 0.5) * C - c[1]) ** 2;

export function inRegion(m: RegionMask, x: number, y: number): boolean {
  const { grid } = m;
  const c = Math.floor((x - grid.minX) / grid.cell), r = Math.floor((grid.maxY - y) / grid.cell);
  return c >= 0 && r >= 0 && c < grid.width && r < grid.height && m.mask[r * grid.width + c] === 1;
}

/** Square dilation by `rad` cells (separable running max). */
function dilate(mask: Uint8Array, w: number, h: number, rad: number) {
  if (rad <= 0) return;
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    for (let x = 0; x < w; x++) { if (mask[y * w + x]) last = x; if (x - last <= rad) tmp[y * w + x] = 1; }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) { if (mask[y * w + x]) last = x; if (last - x <= rad) tmp[y * w + x] = 1; }
  }
  mask.fill(0);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= rad) mask[y * w + x] = 1; }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= rad) mask[y * w + x] = 1; }
  }
}

/**
 * Real geography clipped to a rectangle. The full-state tactical polygons are
 * never handed to deck.gl: triangulating the 305k-vertex mainland (with
 * hundreds of lake holes) blocked the main thread for over a minute.
 */
export function clipCollection(fc: GeoJSON.FeatureCollection, rect: Rect): GeoJSON.FeatureCollection {
  const out: GeoJSON.Feature[] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const polys: number[][][][] = [];
      for (const rings of polygonsOf(g as never)) {
        if (!rectsOverlap(bboxOf(rings[0]!), rect)) continue;
        const outer = clipRingToRect(rings[0] as Pt[], rect);
        if (outer.length < 3) continue;
        const holes = rings.slice(1).filter((h) => rectsOverlap(bboxOf(h), rect))
          .map((h) => clipRingToRect(h as Pt[], rect)).filter((h) => h.length >= 3);
        polys.push([outer, ...holes].map((r) => [...r, r[0]!]));
      }
      if (polys.length) out.push({ type: 'Feature', properties: f.properties, geometry: { type: 'MultiPolygon', coordinates: polys } });
    } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
      const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      const parts: number[][][] = [];
      for (const l of lines) {
        if (!rectsOverlap(bboxOf(l), rect)) continue;
        parts.push(...clipPolylineToRect(l as Pt[], rect));
      }
      if (parts.length) out.push({ type: 'Feature', properties: f.properties, geometry: { type: 'MultiLineString', coordinates: parts } });
    }
  }
  return { type: 'FeatureCollection', features: out };
}
