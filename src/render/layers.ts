import type { Layer } from '@deck.gl/core';
import { PathStyleExtension } from '@deck.gl/extensions';
import { BitmapLayer, GeoJsonLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import RENDER from '../config/render.json';
import type { RegionPack } from '../geo/pack';
import type { CountyLabel, Place, TacticalLayers } from '../geo/types';
import { hex } from './color';
import { declutter, placeMinPop } from './labels';

export type Lod = 'strategic' | 'tactical';

export interface MapLayerInput {
  pack: RegionPack;
  tactical: TacticalLayers | null;
  lod: Lod;
  zoom: number;
  density: { image: ImageData; bounds: [number, number, number, number] } | null;
  /** Generated-city wireframe (drawn over real land/water, under overlays and labels). */
  procgen?: Layer[];
  /** Active region: real geography clipped around it, and its boundary. */
  region?: RegionGeo | null;
}

export interface RegionGeo {
  rect: [number, number, number, number];
  land: GeoJSON.FeatureCollection;
  water: GeoJSON.FeatureCollection;
  streams: GeoJSON.FeatureCollection;
  outline: number[][][]; // outer rings of the boundary
  zones: { label: string; x: number; y: number; radiusMeters: number }[];
}

const C = RENDER.colors;
const dash = new PathStyleExtension({ dash: true });
const DASH = RENDER.lines.dashArray as [number, number];

/**
 * Build the deck.gl layer stack for the current frame. Data references stay
 * stable between calls, so deck.gl only re-tessellates when a pack loads.
 */
export function buildLayers({ pack, tactical, lod, zoom, density, procgen, region }: MapLayerInput): Layer[] {
  const s = pack.strategic;
  // Tactical detail exists only around the active region (see clipCollection).
  const showTactical = lod === 'tactical' && tactical !== null && !!region;
  const layers: Layer[] = [];

  // Out-of-region context (neighboring US states), both LODs.
  layers.push(
    new GeoJsonLayer({
      id: 'neighbors',
      data: s.neighbors,
      filled: true,
      stroked: true,
      getFillColor: hex(C.neighborLand),
      getLineColor: hex(C.neighborBorder),
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
    }),
  );

  // ---- STRATEGIC (1:500k) ----
  layers.push(
    new GeoJsonLayer({
      id: 'strategic-land',
      data: s.land,
      filled: true,
      stroked: true,
      // outside the active region in tactical view: dimmed context
      getFillColor: showTactical ? hex(C.landOutside) : hex(C.landStrategic),
      updateTriggers: { getFillColor: showTactical },
      getLineColor: hex(C.stateLine, 70),
      lineWidthUnits: 'pixels',
      getLineWidth: 0.8,
    }),
    new GeoJsonLayer({
      id: 'strategic-water',
      data: s.water,
      filled: true,
      stroked: false,
      getFillColor: hex(C.waterInland),
    }),
  );

  // ---- TACTICAL (TIGER/Line fine), clipped to the active region ----
  if (showTactical && region) {
    const [x0, y0, x1, y1] = region.rect;
    layers.push(
      // water-colored backdrop hides the coarse strategic coast under the detail
      new SolidPolygonLayer<[number, number][]>({
        id: 'region-backdrop',
        data: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]],
        getPolygon: (d) => d,
        getFillColor: hex(C.water),
      }),
      new GeoJsonLayer({
        id: 'tactical-land',
        data: region.land,
        filled: true,
        stroked: false,
        getFillColor: hex(C.land),
      }),
      new GeoJsonLayer({
        id: 'tactical-water',
        data: region.water,
        filled: true,
        stroked: false,
        getFillColor: hex(C.waterInland),
      }),
      new GeoJsonLayer({
        id: 'tactical-streams',
        data: region.streams,
        filled: false,
        stroked: true,
        getLineColor: hex(C.stream),
        lineWidthUnits: 'meters',
        getLineWidth: (f: GeoJSON.Feature) =>
          pack.manifest.streamWidthMeters[(f.properties as { MTFCC: string }).MTFCC] ?? 6,
        lineWidthMinPixels: RENDER.lines.streamMinWidthPx,
      }),
    );
  }

  if (showTactical && procgen) layers.push(...procgen);
  if (showTactical && region) {
    type Z = RegionGeo['zones'][number];
    const ring = (z: Z) => Array.from({ length: 97 }, (_, k) => [z.x + Math.cos((k / 96) * Math.PI * 2) * z.radiusMeters, z.y + Math.sin((k / 96) * Math.PI * 2) * z.radiusMeters] as [number, number]);
    layers.push(
      new PathLayer<Z>({
        id: 'zone-rings',
        data: region.zones,
        getPath: ring,
        getColor: hex(C.zone, 220),
        getWidth: 2,
        widthUnits: 'pixels',
        extensions: [dash],
        getDashArray: [10, 6],
        dashJustified: true,
      } as never),
      new TextLayer<Z>({
        id: 'zone-labels',
        data: region.zones,
        // above the ring, so it never covers the setpiece inside
        getPosition: (z) => [z.x, z.y + z.radiusMeters],
        getText: (z) => z.label.toUpperCase(),
        getColor: hex(C.zone, 255),
        getSize: RENDER.labels.zoneSizePx,
        getPixelOffset: [0, -16],
        fontFamily: RENDER.labels.font,
        fontWeight: 700,
        characterSet: 'auto',
        background: true,
        getBackgroundColor: hex(RENDER.labels.plate, 235),
        getBorderColor: hex(C.zone, 220),
        getBorderWidth: 1,
        backgroundPadding: [8, 4, 8, 3],
      }),
      new PathLayer<number[][]>({
        id: 'region-outline',
        data: region.outline,
        getPath: (d) => d as [number, number][],
        getColor: hex(C.regionLine, 220),
        getWidth: 2,
        widthUnits: 'pixels',
      }),
    );
  }

  // ---- Debug: population density overlay ----
  if (density) {
    layers.push(
      new BitmapLayer({
        id: 'density',
        image: density.image,
        bounds: density.bounds,
        textureParameters: { minFilter: 'nearest', magFilter: 'nearest' },
      }),
    );
  }

  // ---- Real boundaries: faint dashed lines (the real-place anchor) ----
  const counties = showTactical ? tactical!.counties : s.counties;
  layers.push(
    new GeoJsonLayer({
      id: `county-lines-${showTactical ? 't' : 's'}`,
      data: counties,
      filled: false,
      stroked: true,
      getLineColor: hex(C.countyLine, RENDER.alpha.countyLine),
      lineWidthUnits: 'pixels',
      getLineWidth: RENDER.lines.countyWidthPx,
      extensions: [dash],
      getDashArray: DASH,
      dashJustified: true,
    } as never),
  );
  if (showTactical) {
    layers.push(
      new GeoJsonLayer({
        id: 'city-limits',
        data: tactical!.places,
        filled: false,
        stroked: true,
        getLineColor: hex(C.cityLimit, RENDER.alpha.cityLimit),
        lineWidthUnits: 'pixels',
        getLineWidth: RENDER.lines.cityLimitWidthPx,
        extensions: [dash],
        getDashArray: [3, 3],
        dashJustified: true,
      } as never),
    );
  }

  // ---- Labels (decluttered on the CPU; <700 items so this is cheap) ----
  const minPop = placeMinPop(zoom);
  const placeData = pack.places.filter((p) => p.pop >= minPop);
  const kept = declutter(
    [
      ...placeData.map((p) => ({ item: p as Place | CountyLabel, x: p.x, y: p.y, text: p.name, anchor: 'start' as const, size: placeSize(p) })),
      ...(zoom < -3
        ? pack.counties.map((c) => ({ item: c as Place | CountyLabel, x: c.x, y: c.y, text: countyText(c), anchor: 'middle' as const, size: RENDER.labels.countySizePx }))
        : []),
    ],
    zoom,
  );
  const placeLabels = kept.filter((k) => 'kind' in k.item).map((k) => k.item as Place);
  const countyLabels = kept.filter((k) => !('kind' in k.item)).map((k) => k.item as CountyLabel);
  layers.push(
    new TextLayer<{ name: string; x: number; y: number }>({
      id: 'neighbor-labels',
      data: s.neighbors.features.map((f) => ({ name: f.properties.NAME.toUpperCase(), ...centerOf(f.geometry) })),
      getPosition: (d) => [d.x, d.y],
      getText: (d) => d.name,
      getColor: hex(C.labelNeighbor),
      getSize: 14,
      fontFamily: RENDER.labels.font,
      fontWeight: 600,
      characterSet: 'auto',
    }),
    new TextLayer<CountyLabel>({
      id: 'county-labels',
      data: countyLabels,
      getPosition: (d) => [d.x, d.y],
      getText: countyText,
      getColor: hex(C.labelCounty, 220),
      getSize: RENDER.labels.countySizePx,
      fontFamily: RENDER.labels.font,
      fontWeight: 600,
      characterSet: 'auto',
      fontSettings: { sdf: true },
      outlineWidth: 3,
      outlineColor: hex(C.water, 255),
    }),
    new ScatterplotLayer<Place>({
      id: 'place-dots',
      data: placeData,
      getPosition: (d) => [d.x, d.y],
      radiusUnits: 'pixels',
      getRadius: (d) => (d.pop > 100_000 ? 4 : 3),
      getFillColor: hex(C.labelPlace, 200),
    }),
    new TextLayer<Place>({
      id: `place-labels-${showTactical ? 't' : 's'}`,
      data: placeLabels,
      getPosition: (d) => [d.x, d.y],
      getText: (d) => d.name,
      getColor: hex(C.labelPlace, 255),
      getSize: placeSize,
      getPixelOffset: [8, 0],
      getTextAnchor: 'start',
      getAlignmentBaseline: 'center',
      fontFamily: RENDER.labels.font,
      fontWeight: 600,
      characterSet: 'auto',
      // Over the tactical wireframe an outline is not enough: use solid plates.
      background: showTactical,
      getBackgroundColor: hex(RENDER.labels.plate, 225),
      backgroundPadding: [5, 2, 5, 2],
      fontSettings: { sdf: true },
      outlineWidth: showTactical ? 0 : 3,
      outlineColor: hex(C.water, 255),
      updateTriggers: { getBackgroundColor: showTactical },
    }),
  );

  return layers;
}

function centerOf(g: GeoJSON.Geometry): { x: number; y: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c: unknown): void => {
    if (typeof (c as number[])[0] === 'number') {
      const [x, y] = c as [number, number];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    } else for (const k of c as unknown[]) visit(k);
  };
  if ('coordinates' in g) visit(g.coordinates);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

const placeSize = (p: Place) => (p.pop > 100_000 ? RENDER.labels.placeSizePx + 3 : RENDER.labels.placeSizePx);
const countyText = (c: CountyLabel) => c.name.replace(/ County$/, '').toUpperCase();

