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
    const at = ctx.densityAt(x, y);
    const density = Math.max(at.density, 1 / 255);
    if (unit(ctx.seed, SALT.siteAccept, cx, cy, i) >= siteRate(density) / maxRate) continue;
    const inCity = at.place !== null;
    const smallTown = inCity && (at.place!.pop ?? 0) < D.smallTownMaxPop;
    const id = hashId(cx, cy, i);
    out.push({ id, x, y, density, inCity, type: assignType(ctx.seed, id, density, inCity, coreness(ctx, x, y), smallTown), angle: 0 });
  }
  // Every town gets a district at its Census center, so it always has a
  // main street / downtown no matter where the random sites fell.
  for (const c of ctx.centers) {
    if (c.pop < D.downtownCore.minPop || Math.floor(c.x / C) !== cx || Math.floor(c.y / C) !== cy) continue;
    if (ctx.coarseMaskAt(c.x, c.y) !== LAND) continue;
    const at = ctx.densityAt(c.x, c.y);
    const density = Math.max(at.density, 1 / 255);
    const inCity = at.place !== null;
    const smallTown = inCity && (at.place!.pop ?? 0) < D.smallTownMaxPop;
    const id = (1 << 30) | (Number(c.geoid ?? 0) & 0x3fffffff);
    // a center is at least commercial: lift its density to that tier
    const lifted = Math.max(density, D.tiers.find((t) => t.type === 'commercial')!.min);
    out.push({ id, x: c.x, y: c.y, density: lifted, inCity, type: assignType(ctx.seed, id, lifted, inCity, 1, smallTown), angle: 0 });
  }
  cache.set(key, out);
  return out;
}

/**
 * How deep inside a city core a point is: 0 at the core radius, 1 at the center.
 * Census density counts residents, so dense residential areas look like a
 * downtown; the core radius (grows with sqrt(population)) separates them.
 */
export function coreness(ctx: GeoContext, x: number, y: number): number {
  const K = D.downtownCore, reach = D.industrialWithinCoreRadii;
  let best = 1 - reach - 1; // "far from every core"
  for (const c of ctx.centers) {
    if (c.pop < K.minPop) continue;
    const r = Math.max(K.minRadiusMeters, K.metersPerSqrtThousand * Math.sqrt(c.pop / 1000));
    const dx = x - c.x, dy = y - c.y;
    if (Math.abs(dx) > r * reach || Math.abs(dy) > r * reach) continue;
    best = Math.max(best, 1 - Math.hypot(dx, dy) / r);
  }
  return best; // 1 at a center, 0 at the core radius, 1 - reach at the industrial limit
}

function assignType(seed: number, id: number, density: number, inCity: boolean, core: number, smallTown: boolean): DistrictType {
  const jitter = (unit(seed, SALT.siteType, id) - 0.5) * 2 * D.typeJitter;
  const t = density + jitter - (inCity ? 0 : D.outsideCityPenalty);
  let type = districtTypeFor(t);
  // Mid-size downtowns have few residents, so inside a core, step up by tier.
  if (type === 'downtown' && core < 0) type = 'commercial';
  else if ((type === 'commercial' || type === 'residential') && core >= D.downtownCore.promoteWithin) type = 'downtown';
  else if ((type === 'residential' || type === 'suburban') && core >= 0) type = 'commercial';
  // Low residential density near a city core is rail yards, ports, warehouses
  // (big cities only: a small town's edge is just its edge).
  else if (inCity && !smallTown && (type === 'rural' || type === 'forest') && core > 1 - D.industrialWithinCoreRadii) type = 'industrial';
  // Small towns: a main street, never a downtown; homes on a platted grid.
  if (smallTown && type === 'downtown') type = 'commercial';
  if (smallTown && (type === 'residential' || type === 'suburban')) type = 'town';
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
