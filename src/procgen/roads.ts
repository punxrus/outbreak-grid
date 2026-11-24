import PROCGEN from '../config/procgen.json';
import { LAND, maskAt, type GeoContext, type Raster } from './context';
import type { DistrictSet } from './districts';
import { fieldAngle } from './districts';
import {
  bboxOf, clipPolylineToRect, densify, pointInRing, polylineLength, rectContains, rectsOverlap,
  type Pt, type Rect,
} from './geom';
import { SALT, unit } from './rng';
import type { DistrictType, Road, RoadKind } from './types';

const A = PROCGEN.arterials;
type StreetParams = (typeof PROCGEN.streets)['downtown'];
const STREETS = PROCGEN.streets as Record<string, StreetParams | undefined>;
const COLLECTOR_TYPES = new Set<DistrictType>(['downtown', 'commercial', 'residential', 'suburban', 'industrial']);
const TYPE_INDEX: Partial<Record<DistrictType, number>> = { downtown: 1, commercial: 2, residential: 3, suburban: 4, rural: 5, industrial: 6 };

export interface ArterialEdge { i: number; j: number; rng: boolean; pieces: Road[] }

/**
 * Arterials connect district centers. The relative-neighborhood graph (which
 * contains the Euclidean MST) gives the backbone; Gabriel-graph edges add
 * loops, more often in dense areas. Both are local, so chunks agree.
 * Water crossings become bridges (narrow), ferries (island links), or are dropped.
 */
export function buildArterials(ctx: GeoContext, ds: DistrictSet, near: Rect, cells: (Pt[] | null)[]): ArterialEdge[] {
  const { sites, delaunay } = ds;
  // Bucket grid for witness queries.
  const B = 1000;
  const buckets = new Map<string, number[]>();
  sites.forEach((s, i) => {
    const key = `${Math.floor(s.x / B)},${Math.floor(s.y / B)}`;
    const list = buckets.get(key);
    if (list) list.push(i); else buckets.set(key, [i]);
  });
  const relevantSite = cells.map((c) => c !== null && rectsOverlap(bboxOf(c), near));

  const pairs: [number, number][] = [];
  if (sites.length === 2) pairs.push([0, 1]);
  const { triangles, halfedges } = delaunay;
  for (let e = 0; e < triangles.length; e++) {
    const twin = halfedges[e]!;
    if (twin !== -1 && twin < e) continue;
    pairs.push([triangles[e]!, triangles[e % 3 === 2 ? e - 2 : e + 1]!]);
  }

  const out: ArterialEdge[] = [];
  for (const [i, j] of pairs) {
    const p = sites[i]!, q = sites[j]!;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d > A.maxLengthMeters || d < 1) continue;
    // Only edges that can reach this chunk, or that set a nearby district's street angle.
    const pad = A.curve * d + A.width;
    const eb: Rect = [Math.min(p.x, q.x) - pad, Math.min(p.y, q.y) - pad, Math.max(p.x, q.x) + pad, Math.max(p.y, q.y) + pad];
    if (!rectsOverlap(eb, near) && !relevantSite[i] && !relevantSite[j]) continue;
    let rng = true, gabriel = true;
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    const R = d * 0.87; // the RNG lune lies within this radius of the midpoint
    for (let by = Math.floor((my - R) / B); by <= Math.floor((my + R) / B) && (rng || gabriel); by++) {
      for (let bx = Math.floor((mx - R) / B); bx <= Math.floor((mx + R) / B) && (rng || gabriel); bx++) {
        for (const k of buckets.get(`${bx},${by}`) ?? []) {
          if (k === i || k === j) continue;
          const r = sites[k]!;
          const dp = Math.hypot(r.x - p.x, r.y - p.y), dq = Math.hypot(r.x - q.x, r.y - q.y);
          if (dp < d && dq < d) rng = false;
          if (Math.hypot(r.x - mx, r.y - my) < d / 2) gabriel = false;
        }
      }
    }
    const lo = Math.min(p.id, q.id), hi = Math.max(p.id, q.id);
    const loopP = A.loopChanceMin + (A.loopChanceMax - A.loopChanceMin) * ((p.density + q.density) / 2) ** 2;
    if (!rng && !(gabriel && unit(ctx.seed, SALT.edge, lo, hi) < loopP)) continue;

    // Everything is oriented lower id -> higher id (never by Delaunay index,
    // which differs between chunks), so both sides bend and sample identically.
    const [a, b] = p.id <= q.id ? [p, q] : [q, p];
    const grid = sameGrid(ctx.seed, a, b);
    if (grid) {
      const pieces = classifyWater(ctx, gridArterial(ctx.seed, grid, a, b, lo, hi), rng, lo, hi, a, b);
      if (pieces) out.push({ i, j, rng, pieces });
      continue;
    }
    // Gentle curve: quadratic Bezier with a hashed perpendicular offset.
    const off = (unit(ctx.seed, SALT.edgeCurve, lo, hi) - 0.5) * 2 * A.curve * d;
    const nx = -(b.y - a.y) / d, ny = (b.x - a.x) / d;
    const c: Pt = [mx + nx * off, my + ny * off];
    const n = Math.max(2, Math.ceil(d / A.sampleMeters));
    const pts: Pt[] = [];
    for (let s = 0; s <= n; s++) {
      const t = s / n, u = 1 - t;
      pts.push([u * u * a.x + 2 * u * t * c[0] + t * t * b.x, u * u * a.y + 2 * u * t * c[1] + t * t * b.y]);
    }
    const pieces = classifyWater(ctx, pts, rng, lo, hi, a, b);
    if (pieces) out.push({ i, j, rng, pieces });
  }
  return out;
}

function classifyWater(
  ctx: GeoContext, pts: Pt[], isRng: boolean, lo: number, hi: number,
  a: { x: number; y: number }, b: { x: number; y: number },
): Road[] | null {
  const dense = densify(pts, PROCGEN.raster.regionCell);
  const wet = dense.map((p) => ctx.coarseMaskAt(p[0], p[1]) !== LAND);
  const pieces: Road[] = [];
  let start = 0;
  for (let i = 1; i <= dense.length; i++) {
    if (i < dense.length && wet[i] === wet[start]) continue;
    const run = dense.slice(Math.max(0, start - 1), Math.min(dense.length, i + 1));
    if (!wet[start]) {
      pieces.push({ kind: 'arterial', width: A.width, pts: run });
    } else {
      const len = polylineLength(run);
      if (len > A.ferryMaxWaterMeters) return null;
      if (len > A.bridgeMaxWaterMeters) {
        const ia = ctx.islandAt(a.x, a.y), ib = ctx.islandAt(b.x, b.y);
        const islandLink = ia !== ib && (ia >= 0 || ib >= 0);
        if (!isRng || !islandLink || unit(ctx.seed, SALT.ferry, lo, hi) >= A.ferryChance) return null;
        pieces.push({ kind: 'ferry', width: 4, pts: [run[0]!, run[run.length - 1]!] });
      } else {
        pieces.push({ kind: 'bridge', width: A.width, pts: run, carries: 'arterial', chokepoint: len >= A.chokepointMinMeters });
      }
    }
    start = i;
  }
  return pieces;
}

/** Collectors follow Voronoi edges between two urban-ish districts. */
export function buildCollectors(seed: number, ds: DistrictSet, region: Rect): Pt[][] {
  const { sites, delaunay } = ds;
  const { triangles, halfedges } = delaunay;
  const cc = ds.circumcenters;
  const out: Pt[][] = [];
  if (!cc) return out;
  for (let e = 0; e < triangles.length; e++) {
    const twin = halfedges[e]!;
    if (twin === -1 || twin < e) continue;
    const si = sites[triangles[e]!]!, sj = sites[triangles[e % 3 === 2 ? e - 2 : e + 1]!]!;
    if (!COLLECTOR_TYPES.has(si.type) || !COLLECTOR_TYPES.has(sj.type)) continue;
    if (sameGrid(seed, si, sj)) continue; // the shared grid already runs through
    const t1 = Math.floor(e / 3), t2 = Math.floor(twin / 3);
    const seg: Pt[] = [[cc[2 * t1]!, cc[2 * t1 + 1]!], [cc[2 * t2]!, cc[2 * t2 + 1]!]];
    for (const run of clipPolylineToRect(seg, region)) if (polylineLength(run) > 1) out.push(densify(run, 25));
  }
  return out;
}

/** Street orientation for a district. */
export function districtAngle(seed: number, site: DistrictSet['sites'][number], arterialAngles: number[]): number {
  const p = STREETS[site.type];
  if (!p) return 0;
  const jitter = (unit(seed, SALT.angle, site.id) - 0.5) * 2 * ((p.angleJitterDeg * Math.PI) / 180);
  if (p.align === 'arterial' && arterialAngles.length) return arterialAngles[0]! + jitter;
  if (p.align === 'random') return unit(seed, SALT.angle, site.id, 7) * Math.PI;
  // Snap to a coarse step (mod 90 deg) so neighboring districts usually share an
  // exact orientation and their world-anchored grids line up.
  const step = (PROCGEN.districts.gridAngleStepDeg * Math.PI) / 180;
  const a = fieldAngle(seed, site.x, site.y) + jitter;
  return ((Math.round(a / step) * step) % (Math.PI / 2) + Math.PI / 2) % (Math.PI / 2);
}

/** Street lattice of a district: axes, spacing, phase, and whether it is world-anchored. */
export interface GridFrame {
  gid: number; world: boolean; ox: number; oy: number;
  ux: number; uy: number; vx: number; vy: number;
  sx: number; sy: number; phaseU: number; phaseV: number;
}

export function gridFrame(seed: number, site: DistrictSet['sites'][number]): GridFrame | null {
  const p = STREETS[site.type];
  if (!p) return null;
  const ux = Math.cos(site.angle), uy = Math.sin(site.angle);
  // Field-aligned grids are anchored to the world and keyed by (type, angle
  // zone), so the same street continues straight through neighboring districts.
  // Other grids (suburban curves, rural) are local to the district.
  const world = p.align === 'field';
  const step = (PROCGEN.districts.gridAngleStepDeg * Math.PI) / 180;
  const gid = world ? 0x40000000 + TYPE_INDEX[site.type]! * 4096 + Math.round(site.angle / step) : site.id;
  const sx = p.spacing[0]! * (0.9 + 0.2 * unit(seed, SALT.street, gid, 1));
  const sy = p.spacing[1]! * (0.9 + 0.2 * unit(seed, SALT.street, gid, 2));
  return {
    gid, world, ox: world ? 0 : site.x, oy: world ? 0 : site.y,
    ux, uy, vx: -uy, vy: ux, sx, sy,
    phaseU: unit(seed, SALT.street, gid, 3) * sx,
    phaseV: unit(seed, SALT.street, gid, 4) * sy,
  };
}

/**
 * Arterial between two districts on the same world grid: an L along two
 * lattice lines, so it widens existing streets instead of cutting diagonally.
 */
function gridArterial(seed: number, g: GridFrame, a: { x: number; y: number }, b: { x: number; y: number }, lo: number, hi: number): Pt[] {
  const toUV = (p: { x: number; y: number }) => [(p.x - g.ox) * g.ux + (p.y - g.oy) * g.uy, (p.x - g.ox) * g.vx + (p.y - g.oy) * g.vy] as const;
  const snap = (v: number, s: number, ph: number) => Math.round((v - ph) / s) * s + ph;
  const [ua, va] = toUV(a), [ub, vb] = toUV(b);
  const uFirst = unit(seed, SALT.edgeCurve, lo, hi, 9) < 0.5;
  // corner on (u line through a, v line through b) or the transpose
  const pts: [number, number][] = uFirst
    ? [[snap(ua, g.sx, g.phaseU), va], [snap(ua, g.sx, g.phaseU), snap(vb, g.sy, g.phaseV)], [ub, snap(vb, g.sy, g.phaseV)]]
    : [[ua, snap(va, g.sy, g.phaseV)], [snap(ub, g.sx, g.phaseU), snap(va, g.sy, g.phaseV)], [snap(ub, g.sx, g.phaseU), vb]];
  const world = pts.map(([u, v]) => [g.ox + u * g.ux + v * g.vx, g.oy + u * g.uy + v * g.vy] as Pt);
  return densify(world, A.sampleMeters);
}

/** True when two districts share one world-anchored street lattice. */
export function sameGrid(seed: number, p: DistrictSet['sites'][number], q: DistrictSet['sites'][number]): GridFrame | null {
  const gp = gridFrame(seed, p);
  if (!gp?.world) return null;
  const gq = gridFrame(seed, q);
  return gq && gq.gid === gp.gid ? gp : null;
}

/**
 * Warped street grid inside one district cell. Lines are defined relative to
 * the site, so every chunk that touches this district draws the same streets.
 */
export function buildStreets(
  seed: number, site: DistrictSet['sites'][number], cell: [number, number][], region: Rect, landOnly: Raster,
): { kind: RoadKind; width: number; pts: Pt[] }[] {
  const p = STREETS[site.type];
  if (!p) return [];
  const cb = bboxOf(cell);
  if (!rectsOverlap(cb, region)) return [];
  const { gid, ox, oy, ux, uy, vx, vy, sx, sy, phaseU, phaseV } = gridFrame(seed, site)!;
  // cell extent in (u, v)
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, y] of cell) {
    const dx = x - ox, dy = y - oy;
    const u = dx * ux + dy * uy, v = dx * vx + dy * vy;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const kind: RoadKind = site.type === 'rural' ? 'rural' : 'street';
  const out: { kind: RoadKind; width: number; pts: Pt[] }[] = [];

  for (const fam of [0, 1] as const) {
    // fam 0: lines of constant u, running along v. fam 1: constant v along u.
    const [aMin, aMax, sA, phA, bMin, bMax, sB, phB] =
      fam === 0 ? [u0, u1, sx, phaseU, v0, v1, sy, phaseV] : [v0, v1, sy, phaseV, u0, u1, sx, phaseU];
    for (let k = Math.ceil((aMin - phA) / sA); k <= Math.floor((aMax - phA) / sA); k++) {
      const a = k * sA + phA;
      const phase = unit(seed, SALT.street, gid, fam, k) * Math.PI * 2;
      let run: Pt[] = [];
      const flush = () => {
        if (run.length > 1 && polylineLength(run) >= PROCGEN.minRoadLengthMeters) out.push({ kind, width: p.width, pts: run });
        run = [];
      };
      // samples on a lattice anchored at b = 0, so every district walks the same points
      const sStep = PROCGEN.streetSampleMeters;
      for (let b = Math.ceil(bMin / sStep) * sStep; b <= bMax + 1e-6; b += sStep) {
        const warp = p.warpAmp * Math.sin((2 * Math.PI * b) / p.warpWavelength + phase);
        const aw = a + warp;
        const [u, v] = fam === 0 ? [aw, b] : [b, aw];
        const x = ox + u * ux + v * vx, y = oy + u * uy + v * vy;
        const interval = Math.floor((b - phB) / sB);
        const dropped = p.dropChance > 0 && unit(seed, SALT.streetDrop, gid, fam, k, interval) < p.dropChance;
        const inside = !dropped && rectContains(region, x, y) && pointInRing(x, y, cell) && maskAt(landOnly, x, y) === LAND;
        if (inside) run.push([x, y]);
        else flush();
      }
      flush();
    }
  }
  return out;
}

/**
 * Split a road where it crosses water (at chunk resolution, streams included):
 * short crossings become minor bridges, longer ones cut the road.
 */
export function splitByWater(road: { kind: RoadKind; width: number; pts: Pt[] }, raster: Raster, maxBridge: number): Road[] {
  const dense = densify(road.pts, raster.grid.cell);
  const wet = dense.map((p) => maskAt(raster, p[0], p[1]) === 0);
  const out: Road[] = [];
  let start = 0;
  for (let i = 1; i <= dense.length; i++) {
    if (i < dense.length && wet[i] === wet[start]) continue;
    const run = dense.slice(Math.max(0, start - 1), Math.min(dense.length, i + 1));
    if (!wet[start]) {
      // Not simplified here: chunks see different extents of the same road, and
      // simplifying before the chunk clip would move the seam crossing.
      out.push({ kind: road.kind, width: road.width, pts: run });
    } else {
      const len = polylineLength(run);
      const interior = start > 0 && i < dense.length;
      if (interior && len <= maxBridge) {
        out.push({ kind: 'bridge', width: road.width, pts: [run[0]!, run[run.length - 1]!], carries: road.kind, chokepoint: len >= A.chokepointMinMeters });
      }
    }
    start = i;
  }
  return out.filter((r) => r.kind === 'bridge' || polylineLength(r.pts) >= 2);
}
