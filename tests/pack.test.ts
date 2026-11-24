import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { describe, expect, it } from 'vitest';
import type { PackManifest, Place } from '../src/geo/types';

/**
 * Integrity checks on the generated WA pack. Skipped when the pack has not
 * been built yet (run `npm run geo-build -- --state WA`).
 */
const DIR = join(__dirname, '..', 'public', 'packs', 'wa');
const built = existsSync(join(DIR, 'manifest.json'));

describe.skipIf(!built)('WA region pack', () => {
  const manifest = built ? (JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as PackManifest) : null!;

  it('stays under the 50 MB size budget', () => {
    expect(manifest.state.usps).toBe('WA');
    expect((manifest as unknown as { totalBytes: number }).totalBytes).toBeLessThan(50e6);
  });

  it('density grids match their metadata', () => {
    for (const g of [manifest.density.fine, manifest.density.coarse]) {
      const bytes = readFileSync(join(DIR, g.file));
      expect(bytes.length).toBe(g.width * g.height);
    }
  });

  it('density land area matches the real state land area within 2%', () => {
    const g = manifest.density.fine;
    const bytes = readFileSync(join(DIR, g.file));
    let land = 0;
    for (const b of bytes) if (b > 0) land++;
    const km2 = (land * g.cell * g.cell) / 1e6;
    // Census 2020: Washington land area 172,118 km2
    expect(Math.abs(km2 - 172_118) / 172_118).toBeLessThan(0.02);
  });

  it('projection origin lies inside the state bounds (small coords, float32-safe)', () => {
    const [minX, minY, maxX, maxY] = manifest.boundsMeters;
    expect(minX).toBeLessThan(0);
    expect(maxX).toBeGreaterThan(0);
    expect(minY).toBeLessThan(0);
    expect(maxY).toBeGreaterThan(0);
    expect(Math.max(-minX, maxX, -minY, maxY)).toBeLessThan(1_000_000);
  });

  it('tactical topology has all layers, with named islands', () => {
    const topo = JSON.parse(readFileSync(join(DIR, 'tactical.topo.json'), 'utf8')) as Topology;
    for (const name of manifest.layers.tactical) expect(topo.objects[name]).toBeDefined();
    const land = (topo.objects.land as GeometryCollection<{ islandName: string | null }>).geometries;
    const names = new Set(land.map((g) => (g.properties as { islandName?: string | null } | undefined)?.islandName).filter(Boolean));
    for (const n of ['Whidbey Island', 'Bainbridge Island', 'Vashon Island', 'Orcas Island']) expect(names.has(n)).toBe(true);
    expect((topo.objects.counties as GeometryCollection).geometries).toHaveLength(39);
  });

  it('places are sorted by population with Seattle first and in bounds', () => {
    const places = JSON.parse(readFileSync(join(DIR, 'places.json'), 'utf8')) as Place[];
    expect(places[0]!.name).toBe('Seattle');
    for (let i = 1; i < places.length; i++) expect(places[i - 1]!.pop).toBeGreaterThanOrEqual(places[i]!.pop);
    const [minX, minY, maxX, maxY] = manifest.boundsMeters;
    for (const p of places) {
      expect(p.x).toBeGreaterThanOrEqual(minX);
      expect(p.x).toBeLessThanOrEqual(maxX);
      expect(p.y).toBeGreaterThanOrEqual(minY);
      expect(p.y).toBeLessThanOrEqual(maxY);
    }
  });
});
