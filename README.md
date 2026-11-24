# Outbreak Grid (working title)

Zombie auto-battler on real US geography, flat top-down 2D. The land comes from
U.S. Census Bureau public-domain data. Everything built on it will be
procedurally generated from a seed (from M2 on).

**Status: Milestone 1** (skeleton, Census pack pipeline, 2D map with both LODs, density debug overlay).

## Run it

```powershell
npm install
npm run geo-build -- --state WA   # one-time: downloads Census data (cached), writes public/packs/wa/
npm run dev                       # http://localhost:5180
npm test                          # unit + pack integrity tests
```

Controls: drag to pan, wheel to zoom, `/` search places, `D` density overlay,
`L` cycle LOD (auto / strategic / tactical), `F` fit state.

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
| `src/render/` | deck.gl map (`GameMap`), layer stack, label declutter, view fitting |
| `src/ui/` | HUD pieces (place search) and styles |
| `src/config/render.json` | Colors, LOD thresholds, label rules, line styles |
| `src-tauri/` | Tauri 2 shell (no network, no shell permissions) |
| `tests/` | Vitest: PL parsing, rasterizer, density grid, labels, pack integrity |

Empty module folders (`procgen/`, `sim/`, `economy/`, `progression/`, `save/`) get created in the milestones that fill them.

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
- deck.gl's `CollisionFilterExtension` hid labels in this deck.gl/luma
  version, so labels use a small CPU declutter instead (`src/render/labels.ts`).

## Credits

Boundary, water and population data: U.S. Census Bureau (TIGER/Line,
Cartographic Boundary Files, 2020 Census P.L. 94-171). Public domain.
