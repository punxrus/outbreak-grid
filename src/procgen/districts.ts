import { Delaunay } from 'd3-delaunay';
import PROCGEN from '../config/procgen.json';
import { LAND, type GeoContext } from './context';
import type { Rect } from './geom';
import { SALT, unit, valueNoise } from './rng';
import type { DistrictType, Site } from './types';

const D = PROCGEN.districts;
const C = PROCGEN.chunkSize;

/** Density (0..1, log-scaled Census people/km²) → district type, before jitter/biases. */
export function districtTypeFor(density: number): DistrictType {
  for (const tier of D.tiers) if (density >= tier.min) return tier.type as DistrictType;
  return 'forest';
}

/** Expected district sites per km² at a density; exponential between min and max. */
export function siteRate(density: number): number {
  const t = Math.max(0, Math.min(1, density)) ** D.densityExponent;
  return D.minSitesPerKm2 * (D.maxSitesPerKm2 / D.minSitesPerKm2) ** t;
}

/**
 * District seed points for one chunk: density-weighted Poisson thinning of a
 * fixed candidate set, keyed only on (seed, cx, cy). Any neighbor chunk that
 * asks for these sites gets exactly the same answer.
 */
const siteCache = new WeakMap<GeoContext, Map<string, Site[]>>();

export function chunkSites(ctx: GeoContext, cx: number, cy: number): Site[] {
  let cache = siteCache.get(ctx);
  if (!cache) siteCache.set(ctx, (cache = new Map()));
  const key = `${cx},${cy}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (cache.size > 4096) cache.delete(cache.keys().next().value!);
  const out: Site[] = [];
  const n = Math.ceil(D.maxSitesPerKm2 * (C / 1000) ** 2);
  const maxRate = D.maxSitesPerKm2;
  for (let i = 0; i < n; i++) {
    const x = (cx + unit(ctx.seed, SALT.site, cx, cy, i, 0)) * C;
    const y = (cy + unit(ctx.seed, SALT.site, cx, cy, i, 1)) * C;
    if (ctx.coarseMaskAt(x, y) !== LAND) continue;
    const density = Math.max(ctx.density.sample(x, y), 1 / 255);
    if (unit(ctx.seed, SALT.siteAccept, cx, cy, i) >= siteRate(density) / maxRate) continue;
    const inCity = ctx.inCity(x, y);
    const id = hashId(cx, cy, i);
    out.push({ id, x, y, density, inCity, type: assignType(ctx.seed, id, density, inCity), angle: 0 });
  }
  cache.set(key, out);
  return out;
}

function assignType(seed: number, id: number, density: number, inCity: boolean): DistrictType {
  const jitter = (unit(seed, SALT.siteType, id) - 0.5) * 2 * D.typeJitter;
  const t = density + jitter - (inCity ? 0 : D.outsideCityPenalty);
  const type = districtTypeFor(t);
  const parkP = (D.parkChance as Record<string, number>)[type] ?? 0;
  if (parkP > 0 && unit(seed, SALT.park, id) < parkP) return 'park';
  return type;
}

/** Stable 31-bit id for a site. */
export function hashId(cx: number, cy: number, i: number): number {
  return ((cx & 0x7ff) << 20) ^ ((cy & 0x7ff) << 9) ^ (i & 0x1ff);
}

export interface DistrictSet {
  sites: Site[];
  delaunay: Delaunay<Site>;
  bounds: Rect;
  /** Voronoi vertices (triangle circumcenters), flat [x0, y0, x1, y1, ...]. */
  circumcenters: Float64Array | null;
  cell(i: number): [number, number][] | null;
}

/**
 * Sites from the (2k+1)² chunk neighborhood + their Voronoi diagram. k covers
 * the longest arterial, so every cell and edge that can reach this chunk is
 * decided by sites that are all present: neighbors compute identical answers.
 * Sites are copied (angle is per-chunk scratch state).
 */
export function buildDistricts(ctx: GeoContext, cx: number, cy: number): DistrictSet {
  const k = siteRadiusChunks();
  const sites: Site[] = [];
  for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) for (const s of chunkSites(ctx, cx + dx, cy + dy)) sites.push({ ...s });
  const bounds: Rect = [(cx - k) * C, (cy - k) * C, (cx + k + 1) * C, (cy + k + 1) * C];
  const delaunay = Delaunay.from(sites, (s) => s.x, (s) => s.y);
  const voronoi = sites.length >= 2 ? delaunay.voronoi(bounds) : null;
  return {
    sites,
    delaunay,
    bounds,
    circumcenters: voronoi ? (voronoi.circumcenters as Float64Array) : null,
    cell: (i) => {
      if (!voronoi) return sites.length === 1 ? rectRing(bounds) : null;
      const poly = voronoi.cellPolygon(i) as [number, number][] | null;
      return poly ? poly.slice(0, -1) : null;
    },
  };
}

/** Chunks of sites needed around a chunk: margin + longest arterial. */
export function siteRadiusChunks(): number {
  return Math.ceil((PROCGEN.raster.marginMeters + PROCGEN.arterials.maxLengthMeters) / C);
}

function rectRing(r: Rect): [number, number][] {
  return [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
}

/** Low-frequency orientation field so neighboring districts share grid directions. */
export function fieldAngle(seed: number, x: number, y: number): number {
  const s = D.angleFieldScaleMeters;
  return valueNoise(seed, x / s, y / s) * Math.PI;
}
