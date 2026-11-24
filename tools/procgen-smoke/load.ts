import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Topology } from 'topojson-specification';
import PROCGEN from '../../src/config/procgen.json';
import { DensityGrid } from '../../src/geo/density';
import { decodeTopo } from '../../src/geo/pack';
import type { PackManifest, TacticalLayers } from '../../src/geo/types';
import { GeoContext } from '../../src/procgen/context';

/** Node-side loader for a built pack (tests + tools). */
export function loadContext(state = 'wa', seed = PROCGEN.seed) {
  const dir = join(import.meta.dirname, '../../public/packs', state);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as PackManifest;
  const topo = JSON.parse(readFileSync(join(dir, 'tactical.topo.json'), 'utf8')) as Topology;
  const tactical = decodeTopo(topo, manifest.layers.tactical) as unknown as TacticalLayers;
  const density = new DensityGrid(manifest.density.fine, new Uint8Array(readFileSync(join(dir, manifest.density.fine.file))), manifest.density.maxPeoplePerKm2);
  const places = JSON.parse(readFileSync(join(dir, 'places.json'), 'utf8')) as { x: number; y: number; pop: number }[];
  const ctx = GeoContext.fromTactical(tactical, density, seed, manifest.streamWidthMeters, PROCGEN.arterials.islandMaxAreaKm2 * 1e6, places);
  return { ctx, manifest, tactical };
}
