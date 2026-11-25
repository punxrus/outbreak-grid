# Outbreak Grid (working title)

Zombie auto-battler on real US geography, flat top-down 2D. The land comes from
U.S. Census Bureau public-domain data. Everything built on it will be
procedurally generated from a seed (from M2 on).

**Status: Milestone 2, awaiting visual sign-off** (M1 plus seeded, seam-safe city generation drawn as a wireframe, nav export for the sim, and campaign regions starting in Forks).

## Run it

```powershell
npm install
npm run geo-build -- --state WA   # one-time: downloads Census data (cached), writes public/packs/wa/
npm run dev                       # http://localhost:5180
npm test                          # unit + pack integrity tests
```

Controls: drag to pan, wheel to zoom, `/` search places, `F` fit region, `S` fit state,
`D` density overlay, `G` generated districts + chunk grid, `L` cycle LOD (auto / strategic / tactical).
The **REGION** dropdown switches campaign stages (all unlocked for now).

Dev deep links: `?stage=tacoma&place=Tacoma&zoom=-1.6&dx=0&dy=0&density=1&districts=1&lod=tactical`.

Desktop build (needs the Rust toolchain, see Known issues):

```powershell
npx tauri icon src-tauri/app-icon.svg
npm run tauri dev
npm run tauri build               # → src-tauri/target/release/bundle/{msi,nsis}
```

## Layout

| Path | What |
|---|---|
| `tools/geo-build/` | Offline Node CLI: Census downloads → clip/erase/simplify (mapshaper) → region pack |
| `tools/geo-build/config.json` | All pipeline tunables (simplify tolerances, water filters, density grid) |
| `src/geo/` | Pack loading (`RegionPack`), `DensityGrid`, pack types |
| `src/procgen/` | City generation: districts, roads, blocks, lots, buildings, landmarks, nav export; worker + chunk store |
| `src/config/procgen.json` | All generation tunables (densities, street grids, lots, buildings, landmarks, nav) |
| `src/render/` | deck.gl map (`GameMap`), layer stack, wireframe layers (`procLayers.ts`), label declutter, view fitting |
| `src/ui/` | HUD pieces (place search) and styles |
| `src/config/render.json` | Colors, LOD thresholds, label rules, line styles |
| `src-tauri/` | Tauri 2 shell (no network, no shell permissions) |
| `tests/` | Vitest: PL parsing, rasterizer, density grid, labels, pack integrity, procgen determinism/seams/nav |
| `tools/procgen-smoke/` | Node loader for a built pack + `run.ts` smoke/timing script (`npx tsx tools/procgen-smoke/run.ts -v`) |

Empty module folders (`sim/`, `economy/`, `progression/`, `save/`) get created in the milestones that fill them.

## Region pack format (`public/packs/<state>/`)

All geometry is in **meters** on a state-local transverse Mercator centered on
the state's Census internal point (`manifest.projection.proj4`). Coordinates
stay within about ±400 km, which is float32-safe on the GPU. Sim and procgen
work in the same space.

| File | Contents |
|---|---|
| `tactical.topo.json` | TopoJSON, ~6 m simplification: `land` (state minus water, one polygon per island/piece, tagged `islandName`, `county`, `areaM2`), `water` (AREAWATER), `streams` (named LINEARWATER lines), `counties`, `places` (city limits + CDPs with `pop`) |
| `strategic.topo.json` | 1:500k cartographic boundaries, ~250 m: `land`, `water` (≥3 km²), `counties`, `neighbors` (adjacent states, context only) |
| `places.json` | 639 places: name, kind, 2020 pop, lon/lat, x/y meters, sorted by population |
| `counties.json` | County label points + population |
| `density.bin` / `density_coarse.bin` | Uint8 grids (250 m / 1 km), row 0 = north. 0 = water/outside, 1–255 = `log1p(ppl/km²)/log1p(12000)` |
| `manifest.json` | Projection, bounds, grid metadata, file sizes, sources, credits |

**WA pack: 18.9 MB on disk (5.0 MB gzipped).** Tactical 14.0 MB, strategic 0.8 MB, density 3.75 MB + 0.23 MB, places 0.1 MB.

## Decisions made in M1 (flag anything you want changed)

1. **Renderer: deck.gl** (as specced), `OrthographicView` in meters. No PixiJS
   switch yet. Zombie glow will be additive-blended soft sprites in M3, and
   I'll only propose a bloom pass if that doesn't look good enough.
2. **Population source: P.L. 94-171 bulk file**, not the Census API. The API
   now redirects keyless requests. The PL geo header already contains POP100
   (= P1_001N) and land area per tract and place, so one 37 MB download
   covers density and place populations.
3. **Streams stay lines, not buffered polygons.** Buffering 13.5k streams
   statewide would bloat the pack for features a few pixels wide. Each stream
   carries a width-per-type (`streamWidthMeters`). Procgen/nav will buffer
   them per chunk at runtime (M2/M3).
4. **Island names** come from TIGER area landmarks (MTFCC C3023), accepted
   only when the landmark's area matches the polygon's within 3×. 126 land
   pieces are named (Whidbey, Orcas, San Juan, Vashon, Bainbridge, Fidalgo…).
   Camano has no landmark record, so it is unnamed for now.
5. **Raw downloads are cached outside OneDrive** in
   `%LOCALAPPDATA%\outbreak-grid\geo-cache` (≈350 MB for WA). Downloads run
   one at a time because www2.census.gov rate-limits parallel requests (HTTP 429).
6. **Dev port 5180** (5173 is used by another project in this folder).

Design decisions from conversations are collected in [`docs/DESIGN.md`](docs/DESIGN.md).

## Campaign regions

The game is played one region at a time (`src/config/campaign.json`), along real highways:
- **Coast** (US-101 / US-12): Forks → Montesano → Olympia
- **I-5 North:** Tacoma → Seattle → Everett → Mount Vernon → Bellingham
- **I-5 South:** Centralia → Longview → Vancouver

Forks is the tutorial: a small, isolated town with a small outbreak, so the pace
can build and the systems can be taught before the scale ramps up.

**Branching:** each stage lists the stages it opens (`next`). Securing Olympia
opens both Tacoma (north) and Centralia (south); the player picks, and the other
direction stays open (`src/campaign/state.ts`).

**Holdings:** a secured region stays an asset after the player moves on, but
nothing is rendered or kept in memory for it. When it's secured, the game stores
a snapshot (population, building count, key sites such as fuel, police,
hospitals and armories). The economy milestone will turn those counts into
production. Campaign state lives in browser storage until the save system (M7).
For testing, **Secure region (dev)** stands in for winning a stage, and
`?dev=1` unlocks every stage.

**Required sites:** a stage can list sites that must exist (`"sites"` in
`campaign.json`; Forks: `["hospital"]`). Each one goes on the best large lot
near the place's Census center, on top of the usual random sites. Fuel is
deliberately not guaranteed.

**Design direction (not built yet):** the player starts with a fixed set of
resources and has to split them up to fight the outbreak. The resource list is
still to be agreed.

A region is the real boundary (city limits or county, from the pack) plus a
margin, rasterized to a mask (`src/campaign/region.ts`). The mask decides which
chunks to generate, and the worker uses it to trim content to the region.
- **Towns and cities** (≤ 500 chunks: Forks 73, Montesano 109, Olympia 123,
  Tacoma 243, Seattle 481; every stage on the route fits) are generated whole at load, nearest first, and drawn as 4×4-chunk
  merged layers. They take about 6–15 s after the pack loads.
- **Counties** (2,000–6,000 chunks) are supported (`"kind": "county"`) and
  stream by view, limited to the county. None are on the route right now.
- **Only the region's geography is drawn in detail.** Land, water and streams
  are clipped around the region; outside it the dim 1:500k map shows.
  Triangulating the full-state tactical land polygon (305k vertices, hundreds of
  lake holes) blocked the main thread for over a minute. It caused the "freezes,
  then comes back" behavior.
- **Level of detail:** below about 7 m/px, building outlines are hidden and block
  outlines dim, so a whole city reads as a street map.

### Small towns
Census tracts around rural towns are huge, so tract density alone made Forks
look like forest. Inside places under 20k people, the population is packed into
a compact core at about 1,000 people/km² (radius from population), drawn as a new
`town` district type (platted grid, big lots). Every place of 1,000+ gets a
district at its Census center, so it always has a main street (small towns) or
a downtown (cities).

## M2: city generation

Each 1 km chunk is a pure function of `(seed, real geography, cx, cy)`, made in
a Web Worker (`src/procgen/worker.ts`, 2–4 workers) at about 70–250 ms per chunk.

Pipeline (`src/procgen/chunk.ts`): district sites (density-weighted, keyed per
chunk) → Voronoi districts → arterials (relative-neighborhood graph + Gabriel
loops) → collectors (on district borders) → street grids → water crossings
(bridges, island ferries) → blocks from a 2 m raster → lots (recursive OBB
split) → buildings → landmarks → nav export.

**Seams are exact.** Tests check that every road and nav node crossing a chunk
edge meets its neighbor to the millimeter. What makes it work:
- The site set reaches the longest arterial (4 km) plus the margin, so every
  edge or cell a chunk uses is decided by sites that are all present.
- Roads are clipped to the chunk, *then* simplified (Douglas–Peucker keeps endpoints).
- Everything per edge is oriented by site id, never by Delaunay index.
- Land tests use a global 10 m tile cache on the same lattice as the region rasters.

### Decisions made in M2 (flag anything you want changed)

1. **Wireframe look** (your request): blocks, buildings, parks and forests are
   stroked outlines with no fill. Blocks are inset by road width, so the roads
   read as the gaps between block outlines. Arterials and collectors also get a
   faint dashed centerline. Bridges are solid; chokepoint bridges (≥25 m) are red.
2. **Coherent street grids**: grid districts take their angle from a shared
   low-frequency field, snapped to 6°. Their lattice is anchored to the world
   per (type, angle zone), so streets run straight through neighboring
   districts. Arterials inside a shared grid follow two lattice lines (an L),
   which turns existing streets into avenues instead of cutting diagonals.
   Suburbs and rural areas keep per-district curvy layouts.
3. **Downtown needs a city core.** Census density counts residents, so dense
   residential areas (Capitol Hill) look like downtowns while mid-size downtowns
   (Spokane) look residential. Downtown therefore requires being within
   `52 m × √(pop/1000)` of a real place's center (Seattle ≈ 1.4 km). Tiers step
   up inside cores and drop to commercial outside them.
4. **New district type `industrial`**: low residential density inside city
   limits, within 2.5 core radii of a city of 20k+ people (ports, rail yards).
   Warehouse-sized footprints.
5. **Parks are mostly block-level** (pocket parks). District-wide parks are rare
   (1–2%), because at 7 sites/km² a park district is about 0.15 km².
6. **Landmarks have per-type spacing** (hospital 2 km, police 1.5 km, school
   0.9 km, …), decided the same way in every chunk.
7. **Nav export** (`ChunkData.nav`, kept in the worker for the M3 sim): a 4 m
   walk grid (water / open / road / blocked by building) for flow fields, plus a
   road graph with real intersections, T-junction snapping, edge kind, length,
   chokepoint flag, and border nodes for stitching chunks together.
8. **Generation moved into workers now** instead of waiting for M3: on the
   main thread, a 100–250 ms chunk would freeze the UI. Outlines come back as
   transferable typed arrays (deck.gl binary PathLayer input). Layers rebuild
   only when the visible chunk set changes; there are 2 workers and a 200-chunk cache.
9. **Labels for legibility**: 14–17 px bold, solid plates under landmark and
   tactical city labels, landmark declutter by gameplay priority, and larger,
   higher-contrast HUD text.

## Known issues / risks

- **Tauri not verified yet**: Rust isn't installed on this machine. The
  `src-tauri/` scaffold is written but has never been compiled. Install with
  `winget install Rustlang.Rustup` (plus MSVC Build Tools if missing), then run
  the desktop commands above.
- **Canada is drawn as water.** Census data stops at the border, so the area
  around Victoria/Vancouver BC renders as ocean. The US-only scope is
  intentional, but a neutral "out of region" fill may read better.
- **The "mainland" is several polygons.** Wide rivers in AREAWATER (Columbia,
  Snake, Spokane) cut the state into a few big land pieces. That is correct
  for chokepoints. Milestone logic (M6) must treat "island" as "not touching
  the state boundary", not as "not the largest polygon".
- **Tactical LOD loads the whole state at once** (~1.1M vertices, decoded on
  the main thread on first zoom-in). This is fine for M1. M3 moves geometry
  to chunked, worker-decoded tiles.
- **Counties** still use the clipped-geometry path. Pierce/King county land
  clips to about 2 MB with many lake holes, so expect a short triangulation pause
  when switching to a county stage until that moves into a worker.
- **Wireframe performance on a real GPU hasn't been measured.** This was
  checked headless with software WebGL, where even the M1 tactical view runs
  at 0.3 fps. It needs a pass on real hardware: about 80 chunks × 2 path
  layers at the closest zoom-out.
- **Shoreline arterials** sometimes become a string of tiny bridges where a
  road runs along a ragged coast. Cosmetic for now; merge in M3.
- **Building fill downtown is about 85% of lots** (target 97%): footprints that
  can't fit an irregular lot after 5 shrink attempts are skipped.
- deck.gl's `CollisionFilterExtension` hid labels in this deck.gl/luma
  version, so labels use a small CPU declutter instead (`src/render/labels.ts`).

## Credits

Boundary, water and population data: U.S. Census Bureau (TIGER/Line,
Cartographic Boundary Files, 2020 Census P.L. 94-171). Public domain.
