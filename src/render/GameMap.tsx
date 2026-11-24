import { Deck, LinearInterpolator, type Layer, OrthographicView, type OrthographicViewState } from '@deck.gl/core';
import { useEffect, useMemo, useRef } from 'react';
import RENDER from '../config/render.json';
import type { RegionPack } from '../geo/pack';
import type { TacticalLayers } from '../geo/types';
import { buildLayers, type Lod, type RegionGeo } from './layers';
import { fitBounds } from './view';

export interface FlyTarget { x: number; y: number; zoom: number; key: number; instant?: boolean }

interface Props {
  pack: RegionPack;
  tactical: TacticalLayers | null;
  lod: Lod;
  zoom: number;
  density: { image: ImageData; bounds: [number, number, number, number] } | null;
  flyTo: FlyTarget | null;
  onZoom: (zoom: number) => void;
  onHover: (coord: [number, number] | null) => void;
  procgen: Layer[];
  region: RegionGeo | null;
  /** Visible world rectangle in meters, on every view change. */
  onView: (rect: [number, number, number, number]) => void;
}

function viewRect(target: number[], zoom: number, el: HTMLElement): [number, number, number, number] {
  const s = 2 ** zoom, hw = el.clientWidth / 2 / s, hh = el.clientHeight / 2 / s;
  return [target[0]! - hw, target[1]! - hh, target[0]! + hw, target[1]! + hh];
}

const VIEW = new OrthographicView({ id: 'map', flipY: false, controller: true });
const interp = new LinearInterpolator(['target', 'zoom']);

/** Flat top-down 2D map: deck.gl standalone with an orthographic (no pitch, no bearing) view in meters. */
export function GameMap({ pack, tactical, lod, zoom, density, flyTo, onZoom, onHover, procgen, region, onView }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const deck = useRef<Deck<OrthographicView> | null>(null);
  const cb = useRef({ onZoom, onHover, onView });
  cb.current = { onZoom, onHover, onView };

  useEffect(() => {
    const el = host.current!;
    const initial = fitBounds(pack.manifest.boundsMeters, el.clientWidth, el.clientHeight);
    cb.current.onZoom(initial.zoom as number);
    cb.current.onView(viewRect(initial.target as number[], initial.zoom as number, el));
    const d = new Deck<OrthographicView>({
      parent: el,
      views: VIEW,
      initialViewState: initial,
      controller: { scrollZoom: { speed: 0.01, smooth: true }, dragRotate: false, touchRotate: false, inertia: 250 },
      useDevicePixels: true,
      onViewStateChange: ({ viewState }) => {
        const vs = viewState as OrthographicViewState;
        cb.current.onZoom(vs.zoom as number);
        cb.current.onView(viewRect(vs.target as number[], vs.zoom as number, el));
        return viewState;
      },
      onHover: (info) => cb.current.onHover(info.coordinate ? [info.coordinate[0]!, info.coordinate[1]!] : null),
      getCursor: ({ isDragging }) => (isDragging ? 'grabbing' : 'crosshair'),
    });
    deck.current = d;
    (window as unknown as { __deck?: Deck }).__deck = d as unknown as Deck; // debug hook
    return () => {
      const canvas = d.getCanvas();
      d.finalize();
      canvas?.remove(); // finalize() leaves the canvas it created in the DOM
      deck.current = null;
    };
  }, [pack]);

  // Zoom is bucketed so label filtering does not rebuild every wheel tick.
  const zoomBucket = Math.round(zoom * 4) / 4;
  const layers = useMemo(
    () => buildLayers({ pack, tactical, lod, zoom: zoomBucket, density, procgen, region }),
    [pack, tactical, lod, zoomBucket, density, procgen, region],
  );

  useEffect(() => {
    deck.current?.setProps({ layers });
  }, [layers]);

  useEffect(() => {
    if (!flyTo || !deck.current) return;
    deck.current.setProps({
      initialViewState: {
        target: [flyTo.x, flyTo.y, 0],
        zoom: flyTo.zoom,
        minZoom: RENDER.view.minZoom,
        maxZoom: RENDER.view.maxZoom,
        transitionDuration: flyTo.instant ? 0 : RENDER.view.flyToDurationMs,
        transitionInterpolator: interp,
      } as OrthographicViewState,
    });
    // An instant jump fires no onViewStateChange, so report the new zoom ourselves.
    if (flyTo.instant) {
      cb.current.onZoom(flyTo.zoom);
      cb.current.onView(viewRect([flyTo.x, flyTo.y], flyTo.zoom, host.current!));
    }
  }, [flyTo]);

  return <div ref={host} className="map-host" />;
}
