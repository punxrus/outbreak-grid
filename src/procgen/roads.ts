import PROCGEN from '../config/procgen.json';
import { LAND, maskAt, type GeoContext, type Raster } from './context';
import type { DistrictSet } from './districts';
import { fieldAngle } from './districts';
import {
  bboxOf, clipPolylineToRect, densify, pointInRing, polylineLength, rectContains, rectsOverlap, simplifyLine,
  type Pt, type Rect,
} from './geom';
import { SALT, unit } from './rng';
import type { DistrictType, Road, RoadKind } from './types';

const A = PROCGEN.arterials;
type StreetParams = (typeof PROCGEN.streets)['downtown'];
const STREETS = PROCGEN.streets as Record<string, StreetParams | undefined>;
const COLLECTOR_TYPES = new Set<DistrictType>(['downtown', 'commercial', 'residential', 'suburban']);

export interface ArterialEdge { i: number; j: number; rng: boolean; pieces: Road[] }

/**
 * Arterials connect district centers. The relative-neighborhood graph (which
 * contains the Euclidean MST) gives the backbone; Gabriel-graph edges add
 * loops, more often in dense areas. Both are local, so chunks agree.
 * Water crossings become bridges (narrow), ferries (island links), or are dropped.
 */
export function buildArterials(ctx: GeoContext, ds: DistrictSet, region: Raster): ArterialEdge[] {
  const { sites, delaunay } = ds;
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
    let rng = true, gabriel = true;
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    for (let k = 0; k < sites.length && (rng || gabriel); k++) {
      if (k === i || k === j) continue;
      const r = sites[k]!;
      const dp = Math.hypot(r.x - p.x, r.y - p.y), dq = Math.hypot(r.x - q.x, r.y - q.y);
      if (dp < d && dq < d) rng = false;
      if (Math.hypot(r.x - mx, r.y - my) < d / 2) gabriel = false;
    }
    const lo = Math.min(p.id, q.id), hi = Math.max(p.id, q.id);
    const loopP = A.loopChanceMin + (A.loopChanceMax - A.loopChanceMin) * ((p.density + q.density) / 2) ** 2;
    if (!rng && !(gabriel && unit(ctx.seed, SALT.edge, lo, hi) < loopP)) continue;

    // Gentle curve: quadratic Bezier with a hashed perpendicular offset.
    const off = (unit(ctx.seed, SALT.edgeCurve, lo, hi) - 0.5) * 2 * A.curve * d;
    const nx = -(q.y - p.y) / d, ny = (q.x - p.x) / d;
    const c: Pt = [mx + nx * off, my + ny * off];
    const n = Math.max(2, Math.ceil(d / A.sampleMeters));
    const pts: Pt[] = [];
    // Orient from lower id to higher id so both chunks sample identically.
    const [a, b] = p.id <= q.id ? [p, q] : [q, p];
    for (let s = 0; s <= n; s++) {
      const t = s / n, u = 1 - t;
      pts.push([u * u * a.x + 2 * u * t * c[0] + t * t * b.x, u * u * a.y + 2 * u * t * c[1] + t * t * b.y]);
    }
    const pieces = classifyWater(ctx, pts, region, rng, lo, hi, a, b);
    if (pieces) out.push({ i, j, rng, pieces });
  }
  return out;
}

function classifyWater(
  ctx: GeoContext, pts: Pt[], region: Raster, isRng: boolean, lo: number, hi: number,
  a: { x: number; y: number }, b: { x: number; y: number },
): Road[] | null {
  const step = region.grid.cell;
  const dense = densify(pts, step);
  const wet = dense.map((p) => maskAt(region, p[0], p[1]) !== LAND);
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
export function buildCollectors(ds: DistrictSet, region: Rect): Pt[][] {
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
  return fieldAngle(seed, site.x, site.y) + jitter;
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
  const ux = Math.cos(site.angle), uy = Math.sin(site.angle);
  const vx = -uy, vy = ux;
  const sx = p.spacing[0]! * (0.9 + 0.2 * unit(seed, SALT.street, site.id, 1));
  const sy = p.spacing[1]! * (0.9 + 0.2 * unit(seed, SALT.street, site.id, 2));
  const phaseU = unit(seed, SALT.street, site.id, 3) * sx;
  const phaseV = unit(seed, SALT.street, site.id, 4) * sy;
  // cell extent in (u, v)
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, y] of cell) {
    const dx = x - site.x, dy = y - site.y;
    const u = dx * ux + dy * uy, v = dx * vx + dy * vy;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const step = PROCGEN.streetSampleMeters;
  const kind: RoadKind = site.type === 'rural' ? 'rural' : 'street';
  const out: { kind: RoadKind; width: number; pts: Pt[] }[] = [];

  for (const fam of [0, 1] as const) {
    // fam 0: lines of constant u, running along v. fam 1: constant v along u.
    const [aMin, aMax, sA, phA, bMin, bMax, sB, phB] =
      fam === 0 ? [u0, u1, sx, phaseU, v0, v1, sy, phaseV] : [v0, v1, sy, phaseV, u0, u1, sx, phaseU];
    for (let k = Math.ceil((aMin - phA) / sA); k <= Math.floor((aMax - phA) / sA); k++) {
      const a = k * sA + phA;
      const phase = unit(seed, SALT.street, site.id, fam, k) * Math.PI * 2;
      let run: Pt[] = [];
      const flush = () => {
        if (run.length > 1 && polylineLength(run) >= PROCGEN.minRoadLengthMeters) out.push({ kind, width: p.width, pts: run });
        run = [];
      };
      for (let b = bMin; b <= bMax + 1e-6; b += step) {
        const warp = p.warpAmp * Math.sin((2 * Math.PI * b) / p.warpWavelength + phase);
        const aw = a + warp;
        const [u, v] = fam === 0 ? [aw, b] : [b, aw];
        const x = site.x + u * ux + v * vx, y = site.y + u * uy + v * vy;
        const interval = Math.floor((b - phB) / sB);
        const dropped = p.dropChance > 0 && unit(seed, SALT.streetDrop, site.id, fam, k, interval) < p.dropChance;
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
      out.push({ kind: road.kind, width: road.width, pts: simplifyLine(run, 0.6) });
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
