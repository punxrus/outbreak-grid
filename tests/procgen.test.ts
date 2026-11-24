import { beforeAll, describe, expect, it } from 'vitest';
import { chunkHash, generateChunk } from '../src/procgen/chunk';
import type { GeoContext } from '../src/procgen/context';
import type { ChunkData } from '../src/procgen/types';
import { loadContext } from '../tools/procgen-smoke/load';

// Downtown Seattle, Bellevue (residential/suburban), Kent valley, rural.
const PAIRS: [[number, number], [number, number]][] = [
  [[-134, 25], [-133, 25]],
  [[-134, 25], [-134, 26]],
  [[-119, 22], [-118, 22]],
  [[-124, -1], [-124, 0]],
  [[-61, 19], [-60, 19]], // Cascades foothills: sparse, long arterials
  [[150, 30], [151, 30]], // eastern WA farmland
];

let ctx: GeoContext;
beforeAll(() => { ctx = loadContext().ctx; }, 30_000);

describe('procgen chunk', () => {
  it('is deterministic for a seed and changes with the seed', () => {
    const a = chunkHash(generateChunk(ctx, -134, 25));
    expect(chunkHash(generateChunk(ctx, -134, 25))).toBe(a);
    const other = loadContext('wa', 99).ctx;
    expect(chunkHash(generateChunk(other, -134, 25))).not.toBe(a);
  }, 30_000);

  it('does not depend on generation order', () => {
    const first = chunkHash(generateChunk(ctx, -119, 22));
    generateChunk(ctx, -118, 22);
    generateChunk(ctx, -120, 23);
    expect(chunkHash(generateChunk(ctx, -119, 22))).toBe(first);
  }, 30_000);

  it.each(PAIRS)('roads meet across the seam %j | %j', (pa, pb) => {
    const a = generateChunk(ctx, ...pa), b = generateChunk(ctx, ...pb);
    const vertical = pa[1] === pb[1];
    const edge = vertical ? a.rect[2] : a.rect[3];
    const ends = (c: ChunkData) => c.roads.flatMap((r) => [r.pts[0]!, r.pts[r.pts.length - 1]!].map((p) => ({ p, kind: r.kind })))
      .filter(({ p }) => Math.abs((vertical ? p[0] : p[1]) - edge) < 1e-6);
    const ea = ends(a), eb = ends(b);
    expect(ea.length).toBeGreaterThan(0);
    const unmatched = ea.filter(({ p, kind }) => !eb.some((q) => q.kind === kind && Math.hypot(q.p[0] - p[0], q.p[1] - p[1]) < 0.01));
    expect(unmatched).toEqual([]);
    expect(eb.length).toBe(ea.length);
  }, 30_000);

  it('produces a plausible downtown', () => {
    const c = generateChunk(ctx, -134, 25);
    expect(c.districts.some((d) => d.type === 'downtown')).toBe(true);
    expect(c.blocks.length).toBeGreaterThan(80);
    expect(c.buildings.length / c.lots.length).toBeGreaterThan(0.6);
    expect(c.landmarks.length).toBeLessThanOrEqual(4);
  }, 30_000);
});

describe('banded rasterizer', () => {
  it('matches the plain scanline fill on the real mainland, cell for cell', async () => {
    const { fillPolygon, makeGrid } = await import('../src/geo/rasterize');
    const main = ctx.land.find((l) => l.bands)!;
    expect(main).toBeDefined();
    const rects: [number, number, number, number][] = [
      [-136000, 23000, -131000, 28000], [-133040, 24960, -131960, 26040], [-140017, 30003, -139011, 31009], [0, 0, 1000, 1000],
    ];
    for (const rect of rects) for (const cell of [2, 10]) {
      const g = makeGrid(rect, cell);
      const a = new Uint8Array(g.width * g.height), b = new Uint8Array(g.width * g.height);
      fillPolygon(g, main.rings, a, 1, 'set');
      const { fillBanded } = await import('../src/geo/rasterize');
      fillBanded(g, main.bands!, b, 1, 'set');
      let diff = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
      expect(diff).toBe(0);
    }
  }, 30_000);
});
