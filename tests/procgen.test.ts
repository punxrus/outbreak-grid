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
    // urban pairs must actually exercise the check
    if (pa[0] < -100) expect(ea.length).toBeGreaterThan(0);
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

describe('nav export', () => {
  const largestShare = (n: number, adj: (i: number, visit: (j: number) => void) => void, include: (i: number) => boolean) => {
    const seen = new Uint8Array(n);
    let total = 0, best = 0;
    for (let i = 0; i < n; i++) {
      if (!include(i) || seen[i]) continue;
      let size = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const k = stack.pop()!;
        size++;
        adj(k, (j) => { if (include(j) && !seen[j]) { seen[j] = 1; stack.push(j); } });
      }
      total += size;
      best = Math.max(best, size);
    }
    return total ? best / total : 1;
  };

  it.each(PAIRS)('border nodes match across the seam %j | %j', (pa, pb) => {
    const a = generateChunk(ctx, ...pa).nav, b = generateChunk(ctx, ...pb).nav;
    const vertical = pa[1] === pb[1];
    const edge = vertical ? (pa[0] + 1) * 1000 : (pa[1] + 1) * 1000;
    const on = (n: typeof a) => [...n.border].map((i) => [n.nodes[2 * i]!, n.nodes[2 * i + 1]!] as [number, number])
      .filter((p) => Math.abs((vertical ? p[0] : p[1]) - edge) < 1e-6)
      .map((p) => p.map((v) => (Number(v.toFixed(3)) + 0).toFixed(3)).join(',')).sort(); // +0 folds -0
    expect(on(a)).toEqual(on(b));
  }, 30_000);

  it('downtown walk grid and road graph are connected networks', () => {
    const c = generateChunk(ctx, -134, 25);
    const { grid, width: w, height: h } = c.nav;
    expect(w).toBe(250);
    const roadShare = largestShare(w * h, (i, visit) => {
      const x = i % w, y = (i - x) / w;
      if (x > 0) visit(i - 1); if (x < w - 1) visit(i + 1); if (y > 0) visit(i - w); if (y < h - 1) visit(i + w);
    }, (i) => grid[i] === 2);
    expect(roadShare).toBeGreaterThan(0.95);
    const nn = c.nav.nodes.length / 2, adj: number[][] = Array.from({ length: nn }, () => []);
    for (let e = 0; e < c.nav.edges.length; e += 2) { adj[c.nav.edges[e]!]!.push(c.nav.edges[e + 1]!); adj[c.nav.edges[e + 1]!]!.push(c.nav.edges[e]!); }
    expect(largestShare(nn, (i, visit) => adj[i]!.forEach(visit), () => true)).toBeGreaterThan(0.85);
    // buildings block, roads do not
    expect(grid.filter((v) => v === 3).length).toBeGreaterThan(1000);
  }, 30_000);
});
