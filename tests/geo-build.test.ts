import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePlGeo, placeKind } from '../tools/geo-build/src/pl';
import { fillPolygon, gaussianBlur, makeGrid } from '../src/geo/rasterize';
import { lookupState } from '../tools/geo-build/src/states';

describe('P.L. 94-171 geo header parsing', () => {
  // Real rows from wageo2020.pl (state + one tract); POP100 sits 7 fields from the end.
  const rows = [
    'PLST|WA|040|00|00|000|00|0000001|0400000US53|53|4|9|53|01779804|||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||172117960159|12549742084|Washington|Washington|A||7705281|3202241|+47.4073238|-120.5757999|00||',
    'PLST|WA|140|00|00|000|00|0000283|1400000US53001950100|53001950100|4|9|53|01779804|001|H1|01531601||||||||||||||||950100|||||||||||||||||36830|2|393|99999||||||||||||||||||||||||||||||||1615246453|7701924|9501|Census Tract 9501|S||2579|1184|+47.1505125|-118.3983272|CT||',
    'PLST|WA|140|00|01|000|00|0000999|1400100US53001950100|53001950100|4|9|53|01779804|001|H1|01531601||||||||||||||||950100|||||||||||||||||36830|2|393|99999||||||||||||||||||||||||||||||||1|1|9501|Census Tract 9501|S||9|9|+47.1|-118.3|CT||',
  ];
  const dir = mkdtempSync(join(tmpdir(), 'pl-'));
  const file = join(dir, 'xxgeo2020.pl');
  writeFileSync(file, rows.join('\n'), 'latin1');
  const parsed = parsePlGeo(file);

  it('keeps whole geographies only (GEOCOMP 00)', () => {
    expect(parsed).toHaveLength(2);
  });
  it('reads population, land area and internal point', () => {
    const tract = parsed.find((r) => r.sumlev === '140')!;
    expect(tract.geocode).toBe('53001950100');
    expect(tract.pop).toBe(2579);
    expect(tract.arealandM2).toBe(1615246453);
    expect(tract.lat).toBeCloseTo(47.1505125);
    expect(tract.lon).toBeCloseTo(-118.3983272);
    expect(parsed[0]!.pop).toBe(7705281);
    expect(parsed[0]!.name).toBe('Washington');
  });
  it('maps place LSAD codes', () => {
    expect(placeKind('25')).toBe('city');
    expect(placeKind('57')).toBe('cdp');
  });
});

describe('state lookup', () => {
  it('accepts USPS or FIPS codes', () => {
    expect(lookupState('wa').fips).toBe('53');
    expect(lookupState('53').usps).toBe('WA');
    expect(() => lookupState('XX')).toThrow();
  });
});

describe('scanline rasterizer', () => {
  const grid = makeGrid([0, 0, 1000, 1000], 100); // 10 x 10 cells

  it('fills exactly the cells whose centers are inside', () => {
    const out = new Float32Array(grid.width * grid.height);
    // 300 m square from (100,100) to (400,400): centers 150,250,350 on each axis -> 9 cells
    fillPolygon(grid, [[[100, 100], [400, 100], [400, 400], [100, 400], [100, 100]]], out, 5);
    expect(out.filter((v) => v === 5).length).toBe(9);
    // row 0 is north: cell center (150, 150) is in row 8 (y = 1000 - 8.5*100)
    expect(out[8 * 10 + 1]).toBe(5);
    expect(out[1 * 10 + 1]).toBe(0);
  });

  it('respects holes (even-odd)', () => {
    const out = new Float32Array(grid.width * grid.height);
    const outer = [[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]];
    const hole = [[400, 400], [600, 400], [600, 600], [400, 600], [400, 400]];
    fillPolygon(grid, [outer, hole], out, 1);
    expect(out.reduce((s, v) => s + v, 0)).toBe(100 - 4);
  });

  it('max mode keeps the larger value where polygons overlap', () => {
    const out = new Float32Array(grid.width * grid.height);
    const sq = [[0, 0], [500, 0], [500, 500], [0, 500], [0, 0]];
    fillPolygon(grid, [sq], out, 3);
    fillPolygon(grid, [sq], out, 1);
    expect(Math.max(...out)).toBe(3);
  });

  it('gaussian blur roughly conserves mass away from the edges', () => {
    const g = makeGrid([0, 0, 3000, 3000], 100);
    const d = new Float32Array(g.width * g.height);
    d[15 * g.width + 15] = 100;
    gaussianBlur(g, d, 1.5);
    const sum = d.reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(100, 3);
    expect(d[15 * g.width + 15]!).toBeLessThan(100);
  });
});
