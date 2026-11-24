import { describe, expect, it } from 'vitest';
import { DensityGrid } from '../src/geo/density';
import { declutter, placeMinPop } from '../src/render/labels';

describe('DensityGrid', () => {
  const meta = { file: 'x', minX: 0, minY: 0, maxX: 300, maxY: 200, cell: 100, width: 3, height: 2 };
  // row 0 = north (y 100..200), row 1 = south (y 0..100)
  const data = new Uint8Array([0, 10, 20, 255, 128, 1]);
  const g = new DensityGrid(meta, data, 10_000);

  it('indexes rows north-to-south', () => {
    expect(g.byteAt(50, 150)).toBe(0); // NW
    expect(g.byteAt(250, 150)).toBe(20); // NE
    expect(g.byteAt(50, 50)).toBe(255); // SW
    expect(g.indexAt(-1, 50)).toBe(-1);
    expect(g.indexAt(50, 201)).toBe(-1);
  });

  it('treats byte 0 as water and inverts the log encoding', () => {
    expect(g.isLand(50, 150)).toBe(false);
    expect(g.isLand(150, 150)).toBe(true);
    expect(g.peoplePerKm2(50, 50)).toBeCloseTo(10_000, 0);
    expect(g.peoplePerKm2(250, 50)).toBe(0); // byte 1 = land, ~empty
    expect(g.sample(150, 50)).toBeCloseTo(128 / 255);
  });

  it('rejects mismatched sizes', () => {
    expect(() => new DensityGrid(meta, new Uint8Array(5), 1)).toThrow();
  });
});

describe('labels', () => {
  it('shows more places as you zoom in', () => {
    expect(placeMinPop(-10)).toBeGreaterThan(placeMinPop(-7));
    expect(placeMinPop(-7)).toBeGreaterThan(placeMinPop(-3));
    expect(placeMinPop(0)).toBe(0);
  });

  it('declutter drops lower-priority overlapping labels', () => {
    const c = (text: string, x: number) => ({ item: text, x, y: 0, text, anchor: 'start' as const, size: 12 });
    // zoom 0 => 1 m per px; "Seattle" box ~ 58 px wide
    const kept = declutter([c('Seattle', 0), c('Bellevue', 20), c('Spokane', 500)], 0);
    expect(kept.map((k) => k.item)).toEqual(['Seattle', 'Spokane']);
    // zoomed far in, nothing collides
    expect(declutter([c('Seattle', 0), c('Bellevue', 20)], 4)).toHaveLength(2);
  });
});
