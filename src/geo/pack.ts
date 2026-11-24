import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { DensityGrid } from './density';
import type { CountyLabel, PackManifest, Place, StrategicLayers, TacticalLayers } from './types';

/**
 * Loads a region pack produced by tools/geo-build. Everything is a local file
 * shipped with the app; nothing is fetched from outside the app's own origin.
 */
export class RegionPack {
  private tacticalPromise: Promise<TacticalLayers> | null = null;
  private fineDensityPromise: Promise<DensityGrid> | null = null;

  private constructor(
    readonly baseUrl: string,
    readonly manifest: PackManifest,
    readonly strategic: StrategicLayers,
    readonly places: Place[],
    readonly counties: CountyLabel[],
    readonly coarseDensity: DensityGrid,
  ) {}

  static async load(stateCode: string, root = `${import.meta.env.BASE_URL}packs`): Promise<RegionPack> {
    const base = `${root}/${stateCode.toLowerCase()}`;
    const manifest = await getJson<PackManifest>(`${base}/manifest.json`);
    const [strategicTopo, places, counties, coarse] = await Promise.all([
      getJson<Topology>(`${base}/strategic.topo.json`),
      getJson<Place[]>(`${base}/places.json`),
      getJson<CountyLabel[]>(`${base}/counties.json`),
      getBytes(`${base}/${manifest.density.coarse.file}`),
    ]);
    const strategic = decodeTopo(strategicTopo, manifest.layers.strategic) as unknown as StrategicLayers;
    const coarseDensity = new DensityGrid(manifest.density.coarse, coarse, manifest.density.maxPeoplePerKm2);
    return new RegionPack(base, manifest, strategic, places, counties, coarseDensity);
  }

  /** Fine (tactical) geometry, fetched and decoded on first use. */
  tactical(): Promise<TacticalLayers> {
    this.tacticalPromise ??= getJson<Topology>(`${this.baseUrl}/tactical.topo.json`).then(
      (t) => decodeTopo(t, this.manifest.layers.tactical) as unknown as TacticalLayers,
    );
    return this.tacticalPromise;
  }

  fineDensity(): Promise<DensityGrid> {
    this.fineDensityPromise ??= getBytes(`${this.baseUrl}/${this.manifest.density.fine.file}`).then(
      (b) => new DensityGrid(this.manifest.density.fine, b, this.manifest.density.maxPeoplePerKm2),
    );
    return this.fineDensityPromise;
  }

  /** Approximate lon/lat for display only (tangent-plane inverse, good to ~0.1% near the origin). */
  approxLonLat(x: number, y: number): [number, number] {
    const { originLat, originLon } = this.manifest.projection;
    const lat = originLat + y / 111_132;
    const lon = originLon + x / (111_320 * Math.cos((lat * Math.PI) / 180));
    return [lon, lat];
  }
}

export function decodeTopo(topo: Topology, names: string[]): Record<string, GeoJSON.FeatureCollection> {
  const out: Record<string, GeoJSON.FeatureCollection> = {};
  for (const name of names) {
    const obj = topo.objects[name] as GeometryCollection | undefined;
    if (!obj) throw new Error(`pack is missing layer "${name}"`);
    out[name] = feature(topo, obj) as GeoJSON.FeatureCollection;
  }
  return out;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`failed to load ${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function getBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`failed to load ${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
