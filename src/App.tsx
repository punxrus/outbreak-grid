import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PROCGEN from './config/procgen.json';
import RENDER from './config/render.json';
import { densityToImageData, type DensityGrid } from './geo/density';
import { RegionPack } from './geo/pack';
import { ChunkStore } from './procgen/chunkStore';
import CAMPAIGN from './config/campaign.json';
import { STAGES, buildRegion, clipCollection, stageById } from './campaign/region';
import { availableStages, enter, isSecured, loadCampaign, newCampaign, saveCampaign, secure, type Holding } from './campaign/state';
import type { LandmarkType } from './procgen/types';
import type { Place, TacticalLayers } from './geo/types';
import { GameMap, type FlyTarget } from './render/GameMap';
import type { Lod, RegionGeo } from './render/layers';
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

  // ---- Campaign region: the playable area (a town, a city, then a county) ----
  // Campaign progress. ?dev=1 unlocks every stage; ?stage= jumps there (dev).
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const dev = query.get('dev') === '1' || query.has('stage');
  const [campaign, setCampaign] = useState(() => {
    const c = loadCampaign();
    return query.has('stage') ? enter(c, stageById(query.get('stage')).id, true) : c;
  });
  useEffect(() => saveCampaign(campaign), [campaign]);
  const stage = stageById(campaign.current);
  const open = useMemo(() => availableStages(campaign), [campaign]);
  const setStage = (id: string) => setCampaign((c) => enter(c, id, dev));
  const holdings = Object.values(campaign.holdings).sort((a, b) => a.securedAt - b.securedAt);
  // Regions need the fine geometry, so it loads at startup (decode only: the
  // full-state polygons are never triangulated, see clipCollection).
  useEffect(() => {
    setLoadingTactical(true);
    const t0 = performance.now();
    Promise.all([pack.tactical(), pack.fineDensity()]).then(([t, d]) => {
      console.info(`[pack] tactical LOD decoded in ${Math.round(performance.now() - t0)} ms`);
      setTactical(t);
      setFineDensity(d);
      setLoadingTactical(false);
    });
  }, [pack]);
  const region = useMemo(() => {
    if (!tactical) return null;
    const place = pack.places.filter((p) => p.name === stage.name).sort((a, b) => b.pop - a.pop)[0];
    return buildRegion(stage, tactical, place ? [place.x, place.y] : undefined);
  }, [stage, tactical, pack]);
  const regionGeo = useMemo<RegionGeo | null>(() => {
    if (!region || !tactical) return null;
    const m = CAMPAIGN.displayMarginMeters, b = region.bbox;
    const rect: [number, number, number, number] = [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
    return {
      rect,
      land: clipCollection(tactical.land, rect),
      water: clipCollection(tactical.water, rect),
      streams: clipCollection(tactical.streams, rect),
      outline: region.polygons.map((p) => p[0]!),
    };
  }, [region, tactical]);

  const fitRegion = useCallback((instant = false) => {
    if (!region) return;
    const el = document.querySelector('.map-host')!;
    const v = fitBounds(region.bbox as [number, number, number, number], el.clientWidth, el.clientHeight);
    const [tx, ty] = v.target as [number, number, number];
    setFlyTo({ x: tx, y: ty, zoom: v.zoom as number, key: Date.now(), instant });
  }, [region]);

  // Fit the camera once per region change (StrictMode re-runs effects in dev;
  // a ?place= deep link keeps its own view for the first region).
  const fittedRegion = useRef<string | null>(null);
  useEffect(() => {
    if (!store || !region) return;
    store.setRegion(region);
    if (fittedRegion.current === region.stage.id) return;
    const first = fittedRegion.current === null;
    fittedRegion.current = region.stage.id;
    if (first && new URLSearchParams(window.location.search).has('place')) return;
    fitRegion(first);
  }, [store, region, fitRegion]);

  const genMinZoom = store?.pregenerated ? PROCGEN.regionMinZoom : PROCGEN.minZoom;
  const procgenOn = lod === 'tactical' && zoom >= genMinZoom;

  const [tooWide, setTooWide] = useState(false);
  useEffect(() => {
    if (!viewRect || !store || store.pregenerated) { setTooWide(false); return; }
    setTooWide(procgenOn ? !store.setView(viewRect) : false);
    if (!procgenOn) store.setView([0, 0, -1, -1]);
  }, [viewRect, procgenOn, store, chunkVersion]);
  // Rebuild generated-city layers only when the drawable chunk set or a toggle
  // changes. Panning alone must not rebuild layers every frame.
  const visibleKey = procgenOn && store ? store.visibleKey() : '';
  const showLandmarks = zoom >= RENDER.labels.landmarkMinZoom;
  const labelZoom = Math.round(zoom * 2) / 2; // landmark declutter only on half-zoom steps
  const procLayers = useMemo(
    () => (procgenOn && store ? buildProcLayers(store.visible(), { districts: showDistricts, showLabels: showLandmarks, zoom: labelZoom }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visibleKey captures store.visible()
    [procgenOn, visibleKey, showDistricts, showLandmarks, labelZoom, store],
  );
  const gen = store?.progress() ?? { done: 0, total: 0 };
  const genComplete = !!store?.pregenerated && gen.total > 0 && gen.done === gen.total;

  /** Snapshot the region as a holding: the asset that outlives the visit. */
  const secureRegion = useCallback(() => {
    if (!store || !region) return;
    const sites: Partial<Record<LandmarkType, number>> = {};
    let buildings = 0;
    for (const c of store.visible()) {
      buildings += c.bldg.length;
      for (const l of c.landmarks) sites[l.type] = (sites[l.type] ?? 0) + 1;
    }
    const place = pack.places.filter((p) => p.name === region.stage.name).sort((a, b) => b.pop - a.pop)[0];
    const h: Holding = { stageId: region.stage.id, label: region.stage.label, securedAt: Date.now(), population: place?.pop ?? 0, buildings, sites };
    setCampaign((c) => secure(c, h));
  }, [store, region, pack]);

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
      else if (k === 'f') fitRegion();
      else if (k === 's') fit();
      else if (k === '/') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fit, fitRegion]);

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
        region={regionGeo}
        onView={setViewRect}
      />

      <header className="topbar">
        <div className="brand">OUTBREAK GRID</div>
        <div className="stat">
          <label>REGION</label>
          <select className="stage" value={stage.id} onChange={(e) => setStage(e.target.value)} title={dev ? 'Campaign region (dev: all unlocked)' : 'Campaign region'}>
            {[...new Set(STAGES.map((st) => st.leg))].map((leg) => (
              <optgroup key={leg} label={leg}>
                {STAGES.map((st, i) => {
                  if (st.leg !== leg) return null;
                  const locked = !open.has(st.id);
                  const mark = isSecured(campaign, st.id) ? ' [secured]' : locked ? ' [locked]' : '';
                  return <option key={st.id} value={st.id} disabled={locked && !dev}>{i + 1}. {st.label}{mark}</option>;
                })}
              </optgroup>
            ))}
          </select>
        </div>
        <div className={`stat lod ${lod}`}>
          <label>VIEW</label>
          {lod.toUpperCase()}
          {lodMode !== 'auto' && <span className="muted"> (locked)</span>}
          {loadingTactical && <span className="muted"> loading...</span>}
        </div>
        <div className="stat"><label>SCALE</label>{formatScale(metersPerPx)}</div>
        {store && region && (
          <div className="stat">
            <label>CITY GEN</label>
            {store.pregenerated
              ? gen.done < gen.total
                ? <span>{gen.done}/{gen.total} <span className="muted">building...</span></span>
                : <span>{gen.total} chunks</span>
              : tooWide || !procgenOn ? <span className="muted">zoom in</span> : <span>{gen.done}/{gen.total}</span>}
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
        <button onClick={() => fitRegion()} title="Fit the campaign region (F)">
          Fit region <kbd>F</kbd>
        </button>
        <button onClick={fit} title="Fit the whole state (S)">
          Fit state <kbd>S</kbd>
        </button>
        <button onClick={() => setShowCredits((v) => !v)} title="Data credits">Credits</button>
        <button
          className={isSecured(campaign, stage.id) ? 'on' : ''}
          disabled={!genComplete || isSecured(campaign, stage.id)}
          onClick={secureRegion}
          title="Dev stand-in for winning the stage: record this region as a holding and open the next stages"
        >
          {isSecured(campaign, stage.id) ? 'Secured' : 'Secure region (dev)'}
        </button>
      </aside>

      {holdings.length > 0 && (
        <aside className="holdings">
          <h3>HOLDINGS</h3>
          {holdings.map((h) => (
            <div key={h.stageId} className="holding">
              <div className="name">{h.label}</div>
              <div className="muted">pop {h.population.toLocaleString()} · {h.buildings.toLocaleString()} bldgs</div>
              <div className="sites">{Object.entries(h.sites).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(' · ') || 'no key sites'}</div>
            </div>
          ))}
          <button className="reset" onClick={() => setCampaign(newCampaign())} title="Start the campaign over (clears holdings)">Reset campaign</button>
        </aside>
      )}

      <footer className="readout">
        {hoverInfo ? (
          <>
            <span>{hoverInfo.lonlat[1].toFixed(4)}°, {hoverInfo.lonlat[0].toFixed(4)}° (approx)</span>
            <span>x {hover![0].toFixed(0)} m · y {hover![1].toFixed(0)} m</span>
            <span>{hoverInfo.land ? `land · ~${Math.round(hoverInfo.ppk).toLocaleString()} ppl/km² · density ${hoverInfo.norm.toFixed(2)}` : 'water / outside'}</span>
          </>
        ) : (
          <span className="muted">Drag to pan · wheel to zoom · / search · F fit region · S fit state · D density · G districts · L LOD</span>
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
