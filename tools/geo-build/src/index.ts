/**
 * geo-build: offline Census → region-pack pipeline.
 *
 *   npm run geo-build -- --state WA [--cache <dir>] [--out <dir>] [--clean]
 *
 * Downloads (once, cached) US Census Bureau public-domain data, projects it to a
 * state-local transverse Mercator plane in meters, clips / erases / simplifies
 * with mapshaper, and writes a compact pack the game loads fully offline:
 *
 *   tactical.topo.json   land, water, streams, counties, places   (fine LOD)
 *   strategic.topo.json  land, water, counties, neighbors         (coarse LOD)
 *   places.json          cities / towns / CDPs with population + coordinates
 *   counties.json        county label points + population
 *   density.bin          Uint8 people/km² grid (fine), density_coarse.bin
 *   manifest.json        projection, bounds, grid metadata, file sizes, credits
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import mapshaper from 'mapshaper';
import { fetchCached, mapLimit, unzipCached } from './download.js';
import { parsePlGeo, placeKind, type PlGeoRow } from './pl.js';
import { fillPolygon, gaussianBlur, makeGrid, polygonsOf, type Grid } from '../../../src/geo/rasterize.js';
import { lookupState, type StateInfo } from './states.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const CONFIG = JSON.parse(readFileSync(join(HERE, '../config.json'), 'utf8')) as BuildConfig;

interface BuildConfig {
  tigerYear: number;
  cacheDir: string;
  outDir: string;
  simplify: { tacticalMeters: number; strategicMeters: number };
  filters: {
    tacticalMinWaterAreaM2: number;
    strategicMinWaterAreaM2: number;
    streamMtfcc: string[];
    streamsNamedOnly: boolean;
    streamWidthMeters: Record<string, number>;
  };
  density: { cellMeters: number; coarseCellMeters: number; maxPeoplePerKm2: number; blurSigmaCells: number; logScale: boolean };
  topojsonQuantization: number;
}

// ---------------------------------------------------------------- args
function parseArgs(argv: string[]) {
  const a: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { a[k.slice(2)] = next; i++; } else a[k.slice(2)] = true;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (typeof args.state !== 'string') {
  console.error('usage: geo-build --state <USPS code> [--cache dir] [--out dir] [--clean]');
  process.exit(1);
}
const STATE: StateInfo = lookupState(args.state);
const CACHE = resolve(
  typeof args.cache === 'string' ? args.cache : CONFIG.cacheDir.replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA ?? join(ROOT, '.geo-cache')),
);
const OUT = resolve(ROOT, typeof args.out === 'string' ? args.out : CONFIG.outDir, STATE.usps.toLowerCase());
const WORK = join(CACHE, 'build', STATE.usps);
const Y = CONFIG.tigerYear;
const fwd = (p: string) => p.replace(/\\/g, '/');

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);

async function ms(cmd: string): Promise<void> {
  await mapshaper.runCommands(cmd);
}

// ---------------------------------------------------------------- sources
const SRC = {
  cbState: `https://www2.census.gov/geo/tiger/GENZ${Y}/shp/cb_${Y}_us_state_500k.zip`,
  cbCounty: `https://www2.census.gov/geo/tiger/GENZ${Y}/shp/cb_${Y}_us_county_500k.zip`,
  tlCounty: `https://www2.census.gov/geo/tiger/TIGER${Y}/COUNTY/tl_${Y}_us_county.zip`,
  tlPlace: `https://www2.census.gov/geo/tiger/TIGER${Y}/PLACE/tl_${Y}_${STATE.fips}_place.zip`,
  tlTract: `https://www2.census.gov/geo/tiger/TIGER${Y}/TRACT/tl_${Y}_${STATE.fips}_tract.zip`,
  tlArealm: `https://www2.census.gov/geo/tiger/TIGER${Y}/AREALM/tl_${Y}_${STATE.fips}_arealm.zip`,
  areawater: (c: string) => `https://www2.census.gov/geo/tiger/TIGER${Y}/AREAWATER/tl_${Y}_${c}_areawater.zip`,
  linearwater: (c: string) => `https://www2.census.gov/geo/tiger/TIGER${Y}/LINEARWATER/tl_${Y}_${c}_linearwater.zip`,
  pl: `https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/${STATE.name.replace(/ /g, '_')}/${STATE.usps.toLowerCase()}2020.pl.zip`,
};

/** Download + unzip, returning the path of the single .shp (or the folder). */
async function getShp(url: string): Promise<string> {
  const dir = unzipCached(await fetchCached(url, CACHE));
  const base = url.split('/').pop()!.replace(/\.zip$/, '');
  return fwd(join(dir, `${base}.shp`));
}

// ---------------------------------------------------------------- main
async function main() {
  console.log(`geo-build → ${STATE.name} (${STATE.usps}, FIPS ${STATE.fips})\n  cache: ${CACHE}\n  out:   ${OUT}`);
  if (args.clean && existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const W = fwd(WORK);

  // 1. Population (P.L. 94-171 geo header: POP100 = P1 total population)
  log('population: P.L. 94-171 2020');
  const plDir = unzipCached(await fetchCached(SRC.pl, CACHE));
  const pl = parsePlGeo(join(plDir, `${STATE.usps.toLowerCase()}geo2020.pl`));
  const plState = pl.find((r) => r.sumlev === '040')!;
  const plCounties = pl.filter((r) => r.sumlev === '050');
  const plTracts = new Map(pl.filter((r) => r.sumlev === '140').map((r) => [r.geocode, r]));
  const plPlaces = pl.filter((r) => r.sumlev === '160');
  log(`  ${plCounties.length} counties, ${plTracts.size} tracts, ${plPlaces.length} places, state pop ${plState.pop.toLocaleString()}`);

  // State-local transverse Mercator centered on the state's internal point.
  // Keeps coordinates small (float32-safe on the GPU) and distortion < 0.2% for most states.
  const PROJ = `+proj=tmerc +lat_0=${plState.lat} +lon_0=${plState.lon} +k=1 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs`;
  const P = `-proj "${PROJ}" no-densify`;

  // 2. Downloads
  log('downloading TIGER/Line + cartographic boundary files (cached)');
  const countyFips = plCounties.map((c) => c.geocode);
  const [cbState, cbCounty, tlCounty, tlPlace, tlTract, tlArealm] = await mapLimit(
    [SRC.cbState, SRC.cbCounty, SRC.tlCounty, SRC.tlPlace, SRC.tlTract, SRC.tlArealm], 1, getShp,
  );
  const aw = await mapLimit(countyFips.map(SRC.areawater), 1, getShp);
  const lw = await mapLimit(countyFips.map(SRC.linearwater), 1, getShp);
  const q = (files: string[]) => files.map((f) => `"${f}"`).join(' ');

  // 3. Tactical geometry
  const SF = `STATEFP=='${STATE.fips}'`;
  log('counties (TIGER, legal extent incl. water)');
  await ms(`-i "${tlCounty}" -filter "${SF}" -filter-fields GEOID,NAME,NAMELSAD ${P} -o "${W}/counties.shp"`);
  await ms(`-i "${W}/counties.shp" -dissolve2 -o "${W}/state.shp"`);

  log(`water: ${aw.length} AREAWATER files`);
  await ms(
    `-i ${q(aw)} combine-files -merge-layers force -filter "AWATER >= ${CONFIG.filters.tacticalMinWaterAreaM2}" ` +
      `-filter-fields HYDROID,FULLNAME,MTFCC,AWATER ${P} -o "${W}/water.shp"`,
  );

  log('islands: named area landmarks (MTFCC C3023)');
  await ms(`-i "${tlArealm}" -filter "MTFCC=='C3023'" -points inner -filter-fields FULLNAME,ALAND ${P} -o "${W}/islands.shp"`);

  log('land = state − water (islands preserved, tagged)');
  await ms(
    `-i "${W}/state.shp" -erase "${W}/water.shp" -explode -each "areaM2=Math.round(this.area)" -filter "areaM2 >= 2000" ` +
      `-join "${W}/islands.shp" calc="islandName=first(FULLNAME), islandAland=first(ALAND)" ` +
      `-join "${W}/counties.shp" largest-overlap fields=NAME ` +
      `-each "county=NAME; delete NAME; var r = islandAland ? areaM2 / islandAland : 0; islandName = islandName && r > 0.33 && r < 3 ? islandName.replace(/ Is$/, ' Island') : null; delete islandAland; id=this.id" ` +
      `-o "${W}/land.shp"`,
  );

  log(`streams: ${lw.length} LINEARWATER files`);
  const mt = CONFIG.filters.streamMtfcc.map((m) => `MTFCC=='${m}'`).join(' || ');
  const named = CONFIG.filters.streamsNamedOnly ? ' && !!FULLNAME' : '';
  await ms(`-i ${q(lw)} combine-files -merge-layers force -filter "(${mt})${named}" -filter-fields FULLNAME,MTFCC ${P} -o "${W}/streams.shp"`);

  log('places (city limits + CDPs) with population');
  const popCsv = 'GEOID,pop\n' + plPlaces.map((p) => `${p.geocode},${p.pop}`).join('\n');
  writeFileSync(join(WORK, 'place_pop.csv'), popCsv);
  await ms(
    `-i "${tlPlace}" -filter-fields GEOID,NAME,LSAD ${P} -join "${W}/place_pop.csv" keys=GEOID,GEOID string-fields=GEOID ` +
      `-o "${W}/places.shp"`,
  );

  log(`tactical pack: simplify ${CONFIG.simplify.tacticalMeters} m, TopoJSON`);
  await ms(
    `-i "${W}/land.shp" "${W}/water.shp" "${W}/streams.shp" "${W}/counties.shp" "${W}/places.shp" combine-files ` +
      `-simplify dp interval=${CONFIG.simplify.tacticalMeters} keep-shapes ` +
      `-o format=topojson quantization=${CONFIG.topojsonQuantization} "${fwd(OUT)}/tactical.topo.json"`,
  );

  // 4. Strategic geometry (1:500k cartographic boundaries)
  log('strategic: cartographic boundary 1:500k');
  const geoBox = await bboxOf(`-i "${cbState}" -filter "${SF}"`);
  const pad = 1.5;
  const clipGeo = [geoBox[0] - pad, geoBox[1] - pad, geoBox[2] + pad, geoBox[3] + pad].join(',');
  await ms(`-i "${W}/water.shp" -filter "AWATER >= ${CONFIG.filters.strategicMinWaterAreaM2}" -filter-fields FULLNAME -o "${W}/water_big.shp"`);
  await ms(
    `-i "${cbState}" -filter "${SF}" -filter-fields NAME ${P} -o "${W}/state_cb.shp"`,
  );
  await ms(`-i "${W}/state_cb.shp" -erase "${W}/water_big.shp" -explode -filter "this.area >= 1e6" -o "${W}/land_coarse.shp"`);
  await ms(`-i "${cbCounty}" -filter "${SF}" -filter-fields GEOID,NAME ${P} -o "${W}/counties_coarse.shp"`);
  await ms(
    `-i "${cbState}" -filter "!(${SF}) && +STATEFP < 60" -clip bbox=${clipGeo} -filter-fields NAME,STUSPS ${P} -o "${W}/neighbors.shp"`,
  );
  await ms(
    `-i "${W}/land_coarse.shp" "${W}/water_big.shp" "${W}/counties_coarse.shp" "${W}/neighbors.shp" combine-files ` +
      `-rename-layers land,water,counties,neighbors ` +
      `-simplify dp interval=${CONFIG.simplify.strategicMeters} keep-shapes ` +
      `-o format=topojson quantization=100000 "${fwd(OUT)}/strategic.topo.json"`,
  );

  // 5. Points: places + county labels (projected with the same CRS)
  log('places.json + counties.json');
  const placePts = await projectPoints(plPlaces, PROJ);
  const places = plPlaces
    .map((p, i) => ({
      geoid: p.geocode,
      name: p.basename,
      fullName: p.name,
      kind: placeKind(p.lsadc),
      pop: p.pop,
      areaKm2: +(p.arealandM2 / 1e6).toFixed(2),
      lon: p.lon,
      lat: p.lat,
      x: placePts[i]![0],
      y: placePts[i]![1],
    }))
    .sort((a, b) => b.pop - a.pop);
  writeFileSync(join(OUT, 'places.json'), JSON.stringify(places));
  const countyPts = await projectPoints(plCounties, PROJ);
  const counties = plCounties.map((c, i) => ({
    geoid: c.geocode, name: c.name, pop: c.pop, areaKm2: +(c.arealandM2 / 1e6).toFixed(1), x: countyPts[i]![0], y: countyPts[i]![1],
  }));
  writeFileSync(join(OUT, 'counties.json'), JSON.stringify(counties));

  // 6. Density grid
  log('density: rasterize 2020 tract population density');
  const stateBox = await bboxOf(`-i "${W}/state.shp"`);
  const density = await buildDensity(stateBox, tlTract!, plTracts, `${W}/land.shp`, P);

  // 7. Manifest + size report
  const files = ['tactical.topo.json', 'strategic.topo.json', 'places.json', 'counties.json', 'density.bin', 'density_coarse.bin'];
  const sizes = Object.fromEntries(
    files.map((f) => {
      const buf = readFileSync(join(OUT, f));
      return [f, { bytes: buf.length, gzipBytes: gzipSync(buf, { level: 6 }).length }];
    }),
  );
  const total = Object.values(sizes).reduce((s, v) => s + v.bytes, 0);
  const totalGz = Object.values(sizes).reduce((s, v) => s + v.gzipBytes, 0);
  const manifest = {
    formatVersion: 1,
    state: { ...STATE, population2020: plState.pop },
    projection: { proj4: PROJ, originLon: plState.lon, originLat: plState.lat, units: 'm' },
    boundsMeters: stateBox,
    boundsLonLat: geoBox,
    density,
    layers: {
      tactical: ['land', 'water', 'streams', 'counties', 'places'],
      strategic: ['land', 'water', 'counties', 'neighbors'],
    },
    streamWidthMeters: CONFIG.filters.streamWidthMeters,
    files: sizes,
    totalBytes: total,
    totalGzipBytes: totalGz,
    sources: { tigerYear: Y, urls: { ...SRC, areawater: SRC.areawater('<county>'), linearwater: SRC.linearwater('<county>') } },
    credits: 'Boundary, water and population data: U.S. Census Bureau (TIGER/Line, Cartographic Boundary Files, 2020 Census P.L. 94-171). Public domain.',
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('\nPack contents:');
  for (const [f, s] of Object.entries(sizes)) {
    console.log(`  ${f.padEnd(22)} ${(s.bytes / 1e6).toFixed(2).padStart(7)} MB   (gzip ${(s.gzipBytes / 1e6).toFixed(2)} MB)`);
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${(total / 1e6).toFixed(2).padStart(7)} MB   (gzip ${(totalGz / 1e6).toFixed(2)} MB)`);
  log('done');
}

// ---------------------------------------------------------------- helpers
async function bboxOf(inputCmd: string): Promise<[number, number, number, number]> {
  const out = await mapshaper.applyCommands(`${inputCmd} -dissolve -o format=geojson bbox out.json`);
  const gj = JSON.parse(String(out['out.json'])) as { bbox: [number, number, number, number] };
  return gj.bbox;
}

async function projectPoints(rows: PlGeoRow[], proj: string): Promise<[number, number][]> {
  const fc = {
    type: 'FeatureCollection',
    features: rows.map((r, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: [r.lon, r.lat] } })),
  };
  const out = await mapshaper.applyCommands(`-i pts.json -proj init=EPSG:4269 "${proj}" -o format=geojson precision=0.1 out.json`, {
    'pts.json': fc,
  });
  const gj = JSON.parse(String(out['out.json'])) as { features: { properties: { i: number }; geometry: { coordinates: [number, number] } }[] };
  const res: [number, number][] = new Array(rows.length);
  for (const f of gj.features) res[f.properties.i] = f.geometry.coordinates;
  return res;
}

async function buildDensity(
  stateBox: [number, number, number, number],
  tractShp: string,
  plTracts: Map<string, PlGeoRow>,
  landShp: string,
  P: string,
) {
  const D = CONFIG.density;
  const grid = makeGrid(stateBox, D.cellMeters);
  log(`  grid ${grid.width}×${grid.height} @ ${D.cellMeters} m`);

  // Tract polygons, lightly simplified (density is coarse anyway)
  const tOut = await mapshaper.applyCommands(`-i "${tractShp}" -filter-fields GEOID ${P} -simplify dp interval=20 -o format=geojson precision=1 out.json`);
  const tracts = JSON.parse(String(tOut['out.json'])) as { features: { properties: { GEOID: string }; geometry: { type: string; coordinates: unknown } }[] };
  const dens = new Float32Array(grid.width * grid.height);
  let missing = 0;
  for (const f of tracts.features) {
    const row = plTracts.get(f.properties.GEOID);
    if (!row) { missing++; continue; }
    const km2 = row.arealandM2 / 1e6;
    const d = km2 > 0 ? row.pop / km2 : 0;
    for (const poly of polygonsOf(f.geometry)) fillPolygon(grid, poly, dens, d);
  }
  if (missing) log(`  warning: ${missing} tracts without population rows`);

  // Land mask (water cells = 0 so density never bleeds over the Sound)
  const lOut = await mapshaper.applyCommands(`-i "${landShp}" -simplify dp interval=${D.cellMeters / 4} -o format=geojson precision=1 out.json`);
  const land = JSON.parse(String(lOut['out.json'])) as { features: { geometry: { type: string; coordinates: unknown } }[] };
  const mask = new Float32Array(grid.width * grid.height);
  for (const f of land.features) for (const poly of polygonsOf(f.geometry)) fillPolygon(grid, poly, mask, 1, 'set');

  gaussianBlur(grid, dens, D.blurSigmaCells);

  const toByte = (d: number) => {
    const v = D.logScale ? Math.log1p(d) / Math.log1p(D.maxPeoplePerKm2) : d / D.maxPeoplePerKm2;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  const fine = new Uint8Array(grid.width * grid.height);
  let landCells = 0;
  for (let i = 0; i < fine.length; i++) {
    if (mask[i]! > 0) { fine[i] = Math.max(1, toByte(dens[i]!)); landCells++; } // 0 reserved for water / outside
  }
  writeFileSync(join(OUT, 'density.bin'), fine);

  // Coarse grid: average of land cells per block
  const f = Math.round(D.coarseCellMeters / D.cellMeters);
  const cg: Grid = { ...grid, cell: grid.cell * f, width: Math.ceil(grid.width / f), height: Math.ceil(grid.height / f) };
  cg.maxX = cg.minX + cg.width * cg.cell;
  cg.minY = cg.maxY - cg.height * cg.cell;
  const coarse = new Uint8Array(cg.width * cg.height);
  for (let r = 0; r < cg.height; r++) for (let c = 0; c < cg.width; c++) {
    let s = 0, n = 0;
    for (let rr = r * f; rr < Math.min(grid.height, (r + 1) * f); rr++) for (let cc = c * f; cc < Math.min(grid.width, (c + 1) * f); cc++) {
      const v = fine[rr * grid.width + cc]!;
      if (v > 0) { s += v; n++; }
    }
    coarse[r * cg.width + c] = n ? Math.max(1, Math.round(s / n)) : 0;
  }
  writeFileSync(join(OUT, 'density_coarse.bin'), coarse);
  log(`  ${landCells.toLocaleString()} land cells`);

  return {
    encoding: D.logScale ? 'log1p(people_per_km2)/log1p(max)*255; 0 = water/outside, min 1 on land' : 'linear',
    maxPeoplePerKm2: D.maxPeoplePerKm2,
    rowOrder: 'north-to-south',
    fine: { file: 'density.bin', ...grid },
    coarse: { file: 'density_coarse.bin', ...cg },
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
