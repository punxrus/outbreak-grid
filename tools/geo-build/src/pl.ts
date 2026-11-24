import { readFileSync } from 'node:fs';

/**
 * One row of the 2020 Census P.L. 94-171 geographic header file (<st>geo2020.pl).
 * The geo header already carries POP100 (total population, = table P1_001N),
 * so the segment files are not needed for density.
 */
export interface PlGeoRow {
  sumlev: string;   // 040 state, 050 county, 140 tract, 160 place
  geocode: string;  // matches TIGER GEOID for that summary level
  name: string;
  basename: string;
  lsadc: string;    // legal/statistical area description code (25 city, 43 town, 57 CDP...)
  arealandM2: number;
  pop: number;
  lat: number;
  lon: number;
}

const WANTED = new Set(['040', '050', '140', '160']);

export function parsePlGeo(path: string): PlGeoRow[] {
  const text = readFileSync(path, 'latin1');
  const rows: PlGeoRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const f = line.split('|');
    const sumlev = f[2]!;
    // GEOCOMP 00 = the whole geography (not a urban/rural component).
    if (!WANTED.has(sumlev) || f[4] !== '00') continue;
    const n = f.length;
    // Fields are read from the end: AREALAND … NAME … POP100, HU100, INTPTLAT, INTPTLON, LSADC, PARTFLAG, UGA.
    rows.push({
      sumlev,
      geocode: f[9]!,
      arealandM2: Number(f[n - 13]),
      basename: f[n - 11]!,
      name: f[n - 10]!,
      pop: Number(f[n - 7]),
      lat: Number(f[n - 5]),
      lon: Number(f[n - 4]),
      lsadc: f[n - 3]!,
    });
  }
  return rows;
}

export function placeKind(lsadc: string): 'city' | 'town' | 'cdp' | 'other' {
  if (lsadc === '25') return 'city';
  if (lsadc === '43') return 'town';
  if (lsadc === '57') return 'cdp';
  return 'other';
}
