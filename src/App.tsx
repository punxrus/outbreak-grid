import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PROCGEN from './config/procgen.json';
import RENDER from './config/render.json';
import { densityToImageData, type DensityGrid } from './geo/density';
import { RegionPack } from './geo/pack';
import { ChunkStore } from './procgen/chunkStore';
import type { Place, TacticalLayers } from './geo/types';
import { GameMap, type FlyTarget } from './render/GameMap';
import type { Lod } from './render/layers';
import { buildProcLayers } from './render/procLayers';
import { fitBounds } from './render/view';
import { PlaceSearch } from './ui/PlaceSearch';

type LodMode = 'auto' | Lod;
const STATE = 'WA';

export function App() {
  const [pack, setPack] = useState<RegionPack | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    RegionPack.load(STATE).then(setPack, (e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="splash error">Failed to load region pack: {error}<br />Run <code>npm run geo-build -- --state {STATE}</code> first.</div>;
  if (!pack) return <div className="splash">Loading {STATE} region pack...</div>;
  return <Game pack={pack} />;
}

function Game({ pack }: { pack: RegionPack }) {
  const [zoom, setZoom] = useState(-9);
  const [lodMode, setLodMode] = useState<LodMode>('auto');
  const [tactical, setTactical] = useState<TacticalLayers | null>(null);
  const [loadingTactical, setLoadingTactical] = useState(false);
  const [showDensity, setShowDensity] = useState(false);
  const [fineDensity, setFineDensity] = useState<DensityGrid | null>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [flyTo, setFlyTo] = useState<FlyTarget | null>(null);
  const [showCredits, setShowCredits] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [showDistricts, setShowDistricts] = useState(false);
  const [chunkVersion, setChunkVersion] = useState(0);
  const [viewRect, setViewRect] = useState<[number, number, number, number] | null>(null);
  // Created in an effect (not useMemo) so StrictMode's mount/unmount/mount
  // in dev does not leave us holding a store whose workers were terminated.
  const [store, setStore] = useState<ChunkStore | null>(null);
  useEffect(() => {
    const s = new ChunkStore(STATE, setChunkVersion);
    setStore(s);
    (window as unknown as { __chunks?: ChunkStore }).__chunks = s; // debug hook
    return () => s.dispose();
  }, []);

  const autoLod: Lod = zoom >= RENDER.lod.tacticalMinZoom ? 'tactical' : 'strategic';
  const lod: Lod = lodMode === 'auto' ? autoLod : lodMode;
  const procgenOn = lod === 'tactical' && zoom >= PROCGEN.minZoom;

  const [tooWide, setTooWide] = useState(false);
  useEffect(() => {
    if (!viewRect || !store) return;
    if (procgenOn) setTooWide(!store.setView(viewRect));
    else { store.setView([0, 0, -1, -1]); setTooWide(false); }
  }, [viewRect, procgenOn, store]);
  // Rebuild generated-city layers only when the drawable chunk set or a toggle
  // changes. Panning alone must not recreate ~160 layers every frame.
  const visibleKey = procgenOn && store ? store.visibleKey() : '';
  const showLandmarks = zoom >= RENDER.labels.landmarkMinZoom;
  const labelZoom = Math.round(zoom * 2) / 2; // landmark declutter only on half-zoom steps
  const procLayers = useMemo(
    () => (procgenOn && store ? buildProcLayers(store.visible(), { districts: showDistricts, showLabels: showLandmarks, zoom: labelZoom }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visibleKey captures store.visible()
    [procgenOn, visibleKey, showDistricts, showLandmarks, labelZoom, store],
  );

  // Lazy-load the fine LOD the first time it is needed.
  useEffect(() => {
    if (lod !== 'tactical' || tactical || loadingTactical) return;
    setLoadingTactical(true);
    const t0 = performance.now();
    Promise.all([pack.tactical(), pack.fineDensity()]).then(([t, d]) => {
      console.info(`[pack] tactical LOD decoded in ${Math.round(performance.now() - t0)} ms`);
      setTactical(t);
      setFineDensity(d);
      setLoadingTactical(false);
    });
  }, [lod, tactical, loadingTactical, pack]);

  // Density overlay: coarse grid in strategic, fine grid in tactical.
  const coarseImg = useMemo(() => densityImage(pack.coarseDensity), [pack]);
  const fineImg = useMemo(() => (fineDensity ? densityImage(fineDensity) : null), [fineDensity]);
  const density = showDensity ? (lod === 'tactical' && fineImg ? fineImg : coarseImg) : null;

  const fit = useCallback(() => {
    const el = document.querySelector('.map-host')!;
    const v = fitBounds(pack.manifest.boundsMeters, el.clientWidth, el.clientHeight);
    const [tx, ty] = v.target as [number, number, number];
    setFlyTo({ x: tx, y: ty, zoom: v.zoom as number, key: Date.now() });
  }, [pack]);

  const goToPlace = useCallback((p: Place) => {
    setFlyTo({ x: p.x, y: p.y, zoom: RENDER.view.flyToZoom, key: Date.now() });
  }, []);

  // Dev deep links: ?place=Seattle&zoom=-2&density=1&lod=tactical
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const name = q.get('place')?.toLowerCase();
    const p = name ? pack.places.find((pl) => pl.name.toLowerCase() === name) : undefined;
    if (p) {
      const z = Number(q.get('zoom') ?? RENDER.view.flyToZoom);
      setFlyTo({ x: p.x + Number(q.get('dx') ?? 0), y: p.y + Number(q.get('dy') ?? 0), zoom: z, key: Date.now(), instant: true });
    }
    if (q.get('density') === '1') setShowDensity(true);
    if (q.get('districts') === '1') setShowDistricts(true);
    const lodQ = q.get('lod');
    if (lodQ === 'strategic' || lodQ === 'tactical') setLodMode(lodQ);
  }, [pack]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (k === 'd') setShowDensity((v) => !v);
      else if (k === 'g') setShowDistricts((v) => !v);
      else if (k === 'l') setLodMode((m) => (m === 'auto' ? 'strategic' : m === 'strategic' ? 'tactical' : 'auto'));
      else if (k === 'f') fit();
      else if (k === '/') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fit]);

  const metersPerPx = 1 / 2 ** zoom;
  const grid = lod === 'tactical' && fineDensity ? fineDensity : pack.coarseDensity;
  const hoverInfo = hover
    ? {
        lonlat: pack.approxLonLat(hover[0], hover[1]),
        land: grid.isLand(hover[0], hover[1]),
        ppk: grid.peoplePerKm2(hover[0], hover[1]),
        norm: grid.sample(hover[0], hover[1]),
      }
    : null;

  return (
    <div className="app">
      <GameMap
        pack={pack}
        tactical={tactical}
        lod={lod}
        zoom={zoom}
        density={density}
        flyTo={flyTo}
        onZoom={setZoom}
        onHover={setHover}
        procgen={procLayers}
        onView={setViewRect}
      />

      <header className="topbar">
        <div className="brand">OUTBREAK GRID</div>
        <div className="stat"><label>REGION</label>{pack.manifest.state.name}</div>
        <div className="stat"><label>POP 2020</label>{pack.manifest.state.population2020.toLocaleString()}</div>
        <div className={`stat lod ${lod}`}>
          <label>VIEW</label>
          {lod.toUpperCase()}
          {lodMode !== 'auto' && <span className="muted"> (locked)</span>}
          {loadingTactical && <span className="muted"> loading...</span>}
        </div>
        <div className="stat"><label>SCALE</label>{formatScale(metersPerPx)}</div>
        {procgenOn && store && (
          <div className="stat">
            <label>CITY GEN</label>
            {tooWide ? <span className="muted">zoom in</span> : <>{store.visible().length} chunks{store.pending() > 0 && <span className="muted"> +{store.pending()}</span>}</>}
          </div>
        )}
        <div className="spacer" />
        <PlaceSearch places={pack.places} onPick={goToPlace} inputRef={searchRef} />
      </header>

      <aside className="toolbar">
        <button className={showDensity ? 'on' : ''} onClick={() => setShowDensity((v) => !v)} title="Toggle population density debug overlay (D)">
          Density <kbd>D</kbd>
        </button>
        <button onClick={() => setLodMode((m) => (m === 'auto' ? 'strategic' : m === 'strategic' ? 'tactical' : 'auto'))} title="Cycle level of detail: auto / strategic / tactical (L)">
          LOD: {lodMode} <kbd>L</kbd>
        </button>
        <button className={showDistricts ? 'on' : ''} onClick={() => setShowDistricts((v) => !v)} title="Toggle generated district + chunk debug overlay (G)">
          Districts <kbd>G</kbd>
        </button>
        <button onClick={fit} title="Fit the whole state (F)">
          Fit state <kbd>F</kbd>
        </button>
        <button onClick={() => setShowCredits((v) => !v)} title="Data credits">Credits</button>
      </aside>

      <footer className="readout">
        {hoverInfo ? (
          <>
            <span>{hoverInfo.lonlat[1].toFixed(4)}°, {hoverInfo.lonlat[0].toFixed(4)}° (approx)</span>
            <span>x {hover![0].toFixed(0)} m · y {hover![1].toFixed(0)} m</span>
            <span>{hoverInfo.land ? `land · ~${Math.round(hoverInfo.ppk).toLocaleString()} ppl/km² · density ${hoverInfo.norm.toFixed(2)}` : 'water / outside'}</span>
          </>
        ) : (
          <span className="muted">Drag to pan · wheel to zoom · / search · D density · G districts · L LOD · F fit</span>
        )}
        <span className="credit">Boundary and population data: U.S. Census Bureau</span>
      </footer>

      {showDensity && (
        <div className="legend">
          <div className="ramp" />
          <div className="ticks"><span>rural</span><span>{pack.manifest.density.maxPeoplePerKm2.toLocaleString()}+ /km²</span></div>
          <div className="muted">2020 Census tracts · {lod === 'tactical' ? pack.manifest.density.fine.cell : pack.manifest.density.coarse.cell} m cells</div>
        </div>
      )}

      {showCredits && (
        <div className="modal" onClick={() => setShowCredits(false)}>
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h2>Credits</h2>
            <p>Boundary and population data: U.S. Census Bureau.</p>
            <p className="muted">{pack.manifest.credits}</p>
            <p className="muted">Streets, blocks and buildings are procedurally generated and do not depict real locations.</p>
            <button onClick={() => setShowCredits(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function densityImage(grid: DensityGrid) {
  const { minX, minY, maxX, maxY } = grid.meta;
  return { image: densityToImageData(grid, RENDER.alpha.densityOverlay), bounds: [minX, minY, maxX, maxY] as [number, number, number, number] };
}

function formatScale(mpp: number): string {
  return mpp >= 1000 ? `${(mpp / 1000).toFixed(1)} km/px` : mpp >= 1 ? `${mpp.toFixed(1)} m/px` : `${(1 / mpp).toFixed(1)} px/m`;
}
