import PROCGEN from '../config/procgen.json';
import { drawThickPolyline, fillDisc } from '../geo/rasterize';
import { buildingFor, extractBlocks, splitLots } from './blocks';
import { LAND, ROAD, maskAt, type GeoContext } from './context';
import { buildDistricts } from './districts';
import { buildRoadGraph, buildWalkGrid } from './nav';
import {
  bboxOf, clipPolylineToRect, clipRingToRect, rectContains, rectsOverlap, ringArea, ringCentroid, simplifyLine,
  type Pt, type Rect, type Ring,
} from './geom';
import { buildArterials, buildCollectors, buildStreets, districtAngle, splitByWater } from './roads';
import { SALT, unit } from './rng';
import type { Building, ChunkData, DistrictPatch, DistrictType, ForcedSite, Landmark, LandmarkType, Road, RoadKind } from './types';

const C = PROCGEN.chunkSize;

export const chunkKey = (cx: number, cy: number) => `${cx},${cy}`;

/**
 * Generate one 1 km chunk: districts → arterials (+bridges/ferries) → collectors
 * → local streets → blocks → lots → buildings → landmarks. Pure function of
 * (ctx.seed, real geography, cx, cy).
 */
export function generateChunk(ctx: GeoContext, cx: number, cy: number, forced: ForcedSite[] = []): ChunkData {
  const t0 = performance.now();
  const seed = ctx.seed;
  const rect: Rect = [cx * C, cy * C, (cx + 1) * C, (cy + 1) * C];
  const M = PROCGEN.raster.marginMeters;
  const outer: Rect = [rect[0] - M, rect[1] - M, rect[2] + M, rect[3] + M];

  // 1. Districts (sites out to the longest arterial; 10 m land tiles)
  const ds = buildDistricts(ctx, cx, cy);
  const cells: (Ring | null)[] = ds.sites.map((_, i) => ds.cell(i) as Ring | null);

  // 2. Street orientation (needed first: same-grid arterials follow the lattice), then arterials
  for (const s of ds.sites) s.angle = districtAngle(seed, s, []);
  const arterials = buildArterials(ctx, ds, outer, cells);

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
  for (const pts of buildCollectors(seed, ds, outer)) raw.push({ kind: 'collector', width: PROCGEN.collectors.width, pts });
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
    const roll = unit(seed, SALT.plaza, Math.round(bx), Math.round(by));
    const plaza = type === 'downtown' && roll < PROCGEN.blocks.plazaChance;
    const pocketPark = roll < ((PROCGEN.blocks.parkChance as Record<string, number>)[type] ?? 0);
    if (type === 'park' || plaza || pocketPark) { parks.push(block); continue; }
    blocks.push(block);
    for (const lot of splitLots(seed, block, type)) {
      lots.push(lot);
      lotTypes.push(type);
      buildings.push(buildingFor(seed, lot, type, chunkR));
    }
  }

  // 7. Landmarks: at most one per district, placed by the chunk that owns the site
  // Spacing: a site keeps its landmark only if no same-type site within the
  // type's radius rolled lower. Radii stay well inside the site neighborhood,
  // so every chunk reaches the same verdict.
  const landmarks: Landmark[] = [];
  const landmarkLots = new Set<number>();
  const picks = ds.sites.map((s) => pickLandmark(seed, s.type, s.id));
  const SPACING = PROCGEN.landmarkSpacingMeters as Record<string, number>;
  ds.sites.forEach((s, si) => {
    const pick = picks[si]!.type;
    if (!pick || !rectContains(rect, s.x, s.y)) return;
    const r2 = (SPACING[pick] ?? 0) ** 2, mine = picks[si]!.roll;
    const beaten = ds.sites.some((o, oi) => oi !== si && picks[oi]!.type === pick &&
      (o.x - s.x) ** 2 + (o.y - s.y) ** 2 < r2 && (picks[oi]!.roll < mine || (picks[oi]!.roll === mine && o.id < s.id)));
    if (beaten) return;
    let best = -1, bestD = 300 * 300;
    lots.forEach((lot, i) => {
      if (Math.abs(ringArea(lot)) < 300) return;
      const [x, y] = ringCentroid(lot);
      const d = (x - s.x) ** 2 + (y - s.y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) return;
    placeLandmark(best, pick, s.id, s.type);
  });
  function placeLandmark(lot: number, type: LandmarkType, id: number, districtType: DistrictType) {
    const [lx, ly] = ringCentroid(lots[lot]!);
    const size = type === 'radio_tower' ? { coverage: 0.3, maxSide: 14 } : type === 'gas_station' ? { coverage: 0.5, maxSide: 26 } : { coverage: 0.85, maxSide: 90 };
    const b = type === 'helipad' ? null : buildingFor(seed, lots[lot]!, lotTypes[lot]!, chunkR, size);
    buildings[lot] = b ? { ...b, landmark: type } : null;
    landmarkLots.add(lot);
    landmarks.push({ id, type, x: lx, y: ly, districtType });
  }
  // Sites a campaign stage requires (e.g. Forks' hospital): the largest free
  // lot near the requested point, chosen by the one chunk containing the point.
  for (const f of forced) {
    if (!rectContains(rect, f.x, f.y)) continue;
    if (f.type === 'cooling_tower') { placeTower(f); continue; }
    let best = -1, bestScore = Infinity;
    lots.forEach((lot, i) => {
      const area = Math.abs(ringArea(lot));
      if (landmarkLots.has(i) || area < PROCGEN.forcedSiteMinLotM2) return;
      const [x, y] = ringCentroid(lot);
      const score = Math.hypot(x - f.x, y - f.y) - Math.sqrt(area); // near, and big
      if (score < bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) placeLandmark(best, f.type, (unit(seed, SALT.landmark, Math.round(f.x), Math.round(f.y), 1) * 1e9) | 0, typeAt(f.x, f.y));
  }
  // A setpiece structure at an exact real location, independent of lots:
  // clears whatever was generated under it. Seen from above, a natural-draft
  // tower is a ring (base) around a smaller ring (throat).
  function placeTower(f: ForcedSite) {
    const R = PROCGEN.coolingTowerRadiusMeters;
    buildings.forEach((b, i) => {
      if (!b) return;
      const [x, y] = ringCentroid(b.ring);
      if (Math.hypot(x - f.x, y - f.y) < R + 15) buildings[i] = null;
    });
    const circle = (r: number): Ring => Array.from({ length: 48 }, (_, k) => [f.x + Math.cos((k / 48) * Math.PI * 2) * r, f.y + Math.sin((k / 48) * Math.PI * 2) * r] as Pt);
    buildings.push({ ring: circle(R), shade: 1, landmark: 'cooling_tower' }, { ring: circle(R * 0.62), shade: 1, landmark: 'cooling_tower' });
    landmarks.push({ id: (unit(seed, SALT.landmark, Math.round(f.x), Math.round(f.y), 2) * 1e9) | 0, type: 'cooling_tower', x: f.x, y: f.y, districtType: typeAt(f.x, f.y) });
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
  // Clip, then simplify: Douglas-Peucker keeps endpoints, so seam crossings stay exact.
  for (const r of roads) for (const pts of clipPolylineToRect(r.pts, rect)) outRoads.push({ ...r, pts: simplifyLine(pts, 0.6) });
  const districts: DistrictPatch[] = [];
  ds.sites.forEach((s, i) => {
    const cell = cells[i];
    if (!cell || !rectsOverlap(bboxOf(cell), rect)) return;
    const ring = clipRingToRect(cell, rect);
    if (ring.length >= 3) districts.push({ id: s.id, type: s.type, ring });
  });
  const finalBuildings = buildings.filter((b): b is Building => b !== null);
  const nav = { ...buildWalkGrid(chunkR, rect, finalBuildings), ...buildRoadGraph(outRoads, rect) };

  return {
    key: chunkKey(cx, cy),
    cx, cy, seed, rect,
    roads: outRoads,
    culDeSacs: culDeSacs.filter((p) => rectContains(rect, p[0], p[1])),
    blocks, parks, forests, lots,
    buildings: finalBuildings,
    landmarks,
    districts,
    nav,
    stats: {
      ms: Math.round(performance.now() - t0),
      sites: ds.sites.filter((s) => rectContains(rect, s.x, s.y)).length,
      roads: outRoads.length,
      blocks: blocks.length,
      lots: lots.length,
      buildings: finalBuildings.length,
      navNodes: nav.nodes.length / 2,
      navEdges: nav.edgeKind.length,
    },
  };
}

const TABLE = PROCGEN.landmarks as Record<string, Record<string, number> | undefined>;

/** Landmark a district site would host, from (seed, id) alone. */
export function pickLandmark(seed: number, type: DistrictType, id: number): { type: LandmarkType | null; roll: number } {
  const table = TABLE[type];
  const roll = unit(seed, SALT.landmark, id);
  if (!table) return { type: null, roll };
  let acc = 0;
  for (const [t, p] of Object.entries(table)) { acc += p; if (roll < acc) return { type: t as LandmarkType, roll }; }
  return { type: null, roll };
}

/** Stable content hash of a chunk (ignores timing), for determinism tests. */
export function chunkHash(c: ChunkData): string {
  const { stats, nav, ...rest } = c;
  const { ms: _ms, ...counts } = stats;
  const json = JSON.stringify({ ...rest, counts }, (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) { h ^= json.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  for (const arr of [nav.grid, nav.edges, nav.edgeKind, nav.border, new Uint8Array(nav.nodes.buffer)]) {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]!; h = Math.imul(h, 0x01000193); }
  }
  return (h >>> 0).toString(16).padStart(8, '0') + ':' + json.length;
}

/** Chunk index containing a point. */
export function chunkOf(x: number, y: number): [number, number] {
  return [Math.floor(x / C), Math.floor(y / C)];
}
