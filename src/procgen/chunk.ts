import PROCGEN from '../config/procgen.json';
import { drawThickPolyline, fillDisc } from '../geo/rasterize';
import { buildingFor, extractBlocks, splitLots } from './blocks';
import { LAND, ROAD, maskAt, type GeoContext } from './context';
import { buildDistricts } from './districts';
import {
  bboxOf, clipPolylineToRect, clipRingToRect, rectContains, rectsOverlap, ringArea, ringCentroid,
  type Pt, type Rect, type Ring,
} from './geom';
import { buildArterials, buildCollectors, buildStreets, districtAngle, splitByWater } from './roads';
import { SALT, unit } from './rng';
import type { Building, ChunkData, DistrictPatch, DistrictType, Landmark, LandmarkType, Road, RoadKind } from './types';

const C = PROCGEN.chunkSize;

export const chunkKey = (cx: number, cy: number) => `${cx},${cy}`;

/**
 * Generate one 1 km chunk: districts → arterials (+bridges/ferries) → collectors
 * → local streets → blocks → lots → buildings → landmarks. Pure function of
 * (ctx.seed, real geography, cx, cy).
 */
export function generateChunk(ctx: GeoContext, cx: number, cy: number): ChunkData {
  const t0 = performance.now();
  const seed = ctx.seed;
  const rect: Rect = [cx * C, cy * C, (cx + 1) * C, (cy + 1) * C];
  const k = PROCGEN.raster.neighborhoodChunks;
  const M = PROCGEN.raster.marginMeters;
  const outer: Rect = [rect[0] - M, rect[1] - M, rect[2] + M, rect[3] + M];

  // 1. Districts (5x5-chunk neighborhood, coarse 10 m water mask)
  const region = ctx.rasterize([(cx - k) * C, (cy - k) * C, (cx + k + 1) * C, (cy + k + 1) * C], PROCGEN.raster.regionCell, false);
  const ds = buildDistricts(ctx, cx, cy, region);

  // 2. Arterials, and street orientation from the longest incident arterial
  const arterials = buildArterials(ctx, ds, region);
  const longest = new Map<number, { len: number; angle: number }>();
  for (const e of arterials) {
    const a = ds.sites[e.i]!, b = ds.sites[e.j]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = ((Math.atan2(b.y - a.y, b.x - a.x) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    for (const s of [e.i, e.j]) if ((longest.get(s)?.len ?? 0) < len) longest.set(s, { len, angle });
  }
  ds.sites.forEach((s, i) => {
    const l = longest.get(i);
    s.angle = districtAngle(seed, s, l ? [l.angle] : []);
  });

  // 3. Chunk rasters at 2 m: land only (street placement) and land minus streams (bridges/blocks)
  const landOnly = ctx.rasterize(outer, PROCGEN.raster.cell, false);
  const chunkR = { grid: landOnly.grid, mask: landOnly.mask.slice() };
  ctx.burnStreams(chunkR);

  // 4. Collect raw roads that touch this chunk (+margin)
  const raw: { kind: RoadKind; width: number; pts: Pt[] }[] = [];
  const fixed: Road[] = [];
  for (const e of arterials) {
    for (const piece of e.pieces) {
      if (!rectsOverlap(bboxOf(piece.pts), outer)) continue;
      if (piece.kind === 'arterial') raw.push(piece);
      else fixed.push(piece);
    }
  }
  for (const pts of buildCollectors(ds, outer)) raw.push({ kind: 'collector', width: PROCGEN.collectors.width, pts });
  const cells: (Ring | null)[] = ds.sites.map((_, i) => ds.cell(i) as Ring | null);
  ds.sites.forEach((s, i) => {
    const cell = cells[i];
    if (cell) raw.push(...buildStreets(seed, s, cell, outer, landOnly));
  });

  const roads: Road[] = [...fixed];
  for (const r of raw) roads.push(...splitByWater(r, chunkR, PROCGEN.smallBridgeMaxMeters));

  // 5. Burn roads into the raster; cul-de-sac bulbs where suburban streets dead-end
  for (const r of roads) if (r.kind !== 'ferry') drawThickPolyline(chunkR.grid, r.pts, r.width, chunkR.mask, ROAD);
  const culDeSacs: Pt[] = [];
  const typeAt = (x: number, y: number): DistrictType => ds.sites[ds.delaunay.find(x, y)]?.type ?? 'forest';
  for (const r of roads) {
    if (r.kind !== 'street' || r.pts.length < 2) continue;
    for (const end of [0, 1]) {
      const p = end === 0 ? r.pts[0]! : r.pts[r.pts.length - 1]!;
      const q = end === 0 ? r.pts[1]! : r.pts[r.pts.length - 2]!;
      if (!rectContains(outer, p[0], p[1]) || typeAt(p[0], p[1]) !== 'suburban') continue;
      const dx = p[0] - q[0], dy = p[1] - q[1], l = Math.hypot(dx, dy) || 1;
      const probe = maskAt(chunkR, p[0] + (dx / l) * 14, p[1] + (dy / l) * 14);
      if (probe === LAND) culDeSacs.push(p);
    }
  }
  for (const p of culDeSacs) fillDisc(chunkR.grid, p[0], p[1], PROCGEN.culDeSacRadius, chunkR.mask, ROAD);

  // 6. Blocks → parks / forest / lots → buildings
  const blocks: Ring[] = [], parks: Ring[] = [], forests: Ring[] = [], lots: Ring[] = [];
  const lotTypes: DistrictType[] = [];
  const buildings: (Building | null)[] = [];
  for (const block of extractBlocks(chunkR, rect)) {
    const [bx, by] = ringCentroid(block);
    const type = typeAt(bx, by);
    if (type === 'forest') { forests.push(block); continue; }
    const plaza = (type === 'downtown' || type === 'commercial') &&
      unit(seed, SALT.plaza, Math.round(bx), Math.round(by)) < PROCGEN.blocks.plazaChance;
    if (type === 'park' || plaza) { parks.push(block); continue; }
    blocks.push(block);
    for (const lot of splitLots(seed, block, type)) {
      lots.push(lot);
      lotTypes.push(type);
      buildings.push(buildingFor(seed, lot, type, chunkR));
    }
  }

  // 7. Landmarks: at most one per district, placed by the chunk that owns the site
  const landmarks: Landmark[] = [];
  const TABLE = PROCGEN.landmarks as Record<string, Record<string, number> | undefined>;
  for (const s of ds.sites) {
    if (!rectContains(rect, s.x, s.y)) continue;
    const table = TABLE[s.type];
    if (!table) continue;
    const roll = unit(seed, SALT.landmark, s.id);
    let acc = 0, pick: LandmarkType | null = null;
    for (const [type, p] of Object.entries(table)) { acc += p; if (roll < acc) { pick = type as LandmarkType; break; } }
    if (!pick) continue;
    let best = -1, bestD = 300 * 300;
    lots.forEach((lot, i) => {
      if (Math.abs(ringArea(lot)) < 300) return;
      const [x, y] = ringCentroid(lot);
      const d = (x - s.x) ** 2 + (y - s.y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) continue;
    const [lx, ly] = ringCentroid(lots[best]!);
    const size = pick === 'radio_tower' ? { coverage: 0.3, maxSide: 14 } : pick === 'gas_station' ? { coverage: 0.5, maxSide: 26 } : { coverage: 0.85, maxSide: 90 };
    const b = pick === 'helipad' ? null : buildingFor(seed, lots[best]!, lotTypes[best]!, chunkR, size);
    buildings[best] = b ? { ...b, landmark: pick } : null;
    landmarks.push({ id: s.id, type: pick, x: lx, y: ly, districtType: s.type });
  }
  for (const r of fixed) {
    if (r.kind !== 'ferry') continue;
    for (const p of [r.pts[0]!, r.pts[r.pts.length - 1]!]) {
      if (!rectContains(rect, p[0], p[1])) continue;
      landmarks.push({ id: unit(seed, SALT.landmark, Math.round(p[0]), Math.round(p[1])) * 1e9 | 0, type: 'ferry_terminal', x: p[0], y: p[1], districtType: typeAt(p[0], p[1]) });
    }
  }

  // 8. Output, clipped to the chunk rectangle
  const outRoads: Road[] = [];
  for (const r of roads) for (const pts of clipPolylineToRect(r.pts, rect)) outRoads.push({ ...r, pts });
  const districts: DistrictPatch[] = [];
  ds.sites.forEach((s, i) => {
    const cell = cells[i];
    if (!cell || !rectsOverlap(bboxOf(cell), rect)) return;
    const ring = clipRingToRect(cell, rect);
    if (ring.length >= 3) districts.push({ id: s.id, type: s.type, ring });
  });
  const finalBuildings = buildings.filter((b): b is Building => b !== null);

  return {
    key: chunkKey(cx, cy),
    cx, cy, seed, rect,
    roads: outRoads,
    culDeSacs: culDeSacs.filter((p) => rectContains(rect, p[0], p[1])),
    blocks, parks, forests, lots,
    buildings: finalBuildings,
    landmarks,
    districts,
    stats: {
      ms: Math.round(performance.now() - t0),
      sites: ds.sites.filter((s) => rectContains(rect, s.x, s.y)).length,
      roads: outRoads.length,
      blocks: blocks.length,
      lots: lots.length,
      buildings: finalBuildings.length,
    },
  };
}

/** Stable content hash of a chunk (ignores timing), for determinism tests. */
export function chunkHash(c: ChunkData): string {
  const { stats, ...rest } = c;
  const { ms: _ms, ...counts } = stats;
  const json = JSON.stringify({ ...rest, counts }, (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) { h ^= json.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0') + ':' + json.length;
}

/** Chunk index containing a point. */
export function chunkOf(x: number, y: number): [number, number] {
  return [Math.floor(x / C), Math.floor(y / C)];
}
