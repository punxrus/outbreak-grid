import type { Layer } from '@deck.gl/core';
import { PathStyleExtension } from '@deck.gl/extensions';
import { PathLayer, PolygonLayer, TextLayer } from '@deck.gl/layers';
import RENDER from '../config/render.json';
import { Wire, type WireChunk } from '../procgen/wire';
import { hex, type RGBA } from './color';

const W = RENDER.wire;
const dash = new PathStyleExtension({ dash: true });
const [aLo, aHi] = W.buildingAlpha as [number, number];

const LINE_COLOR: Record<Wire, RGBA> = {
  [Wire.Block]: hex(W.block, 210),
  [Wire.Building]: hex(W.building, aHi),
  [Wire.Park]: hex(W.park, 200),
  [Wire.Forest]: hex(W.forest, 220),
  [Wire.Landmark]: hex(W.landmark, 255),
};
const LINE_WIDTH: Record<Wire, number> = {
  [Wire.Block]: W.widthPx.block,
  [Wire.Building]: W.widthPx.building,
  [Wire.Park]: W.widthPx.park,
  [Wire.Forest]: W.widthPx.forest,
  [Wire.Landmark]: W.widthPx.landmark,
};

const LANDMARK_TEXT: Record<string, string> = {
  hospital: '+ HOSP', police: 'POLICE', gas_station: 'FUEL', armory: 'ARMORY', school: 'SCHOOL',
  radio_tower: 'RADIO', helipad: 'H', ferry_terminal: 'FERRY',
};

type Line = WireChunk['lines'][number];
type Road = WireChunk['roads'][number];

/**
 * Wireframe layers for generated chunks. One layer set per chunk, so deck.gl
 * keeps GPU buffers for chunks that stay on screen.
 */
export function buildProcLayers(chunks: WireChunk[], opts: { districts: boolean; zoom: number }): Layer[] {
  const layers: Layer[] = [];
  for (const c of chunks) {
    layers.push(
      new PathLayer<Road>({
        id: `pg-road-${c.key}`,
        data: c.roads,
        getPath: (d: Road) => d.path,
        getColor: (d: Road) => d.kind === 'ferry' ? hex(W.ferry, 200) : d.kind === 'bridge' ? hex(d.chokepoint ? W.chokepoint : W.bridge, 230)
          : d.kind === 'arterial' ? hex(W.arterial, 150) : hex(W.collector, 120),
        // bridges are drawn at deck width; road centerlines as thin dashed guides
        getWidth: (d: Road) => (d.kind === 'bridge' ? d.width : d.kind === 'ferry' ? 3 : 1.2),
        widthUnits: 'meters',
        widthMinPixels: 1,
        getDashArray: (d: Road) => (d.kind === 'bridge' ? [0, 0] : d.kind === 'ferry' ? [6, 5] : [8, 6]),
        dashJustified: false,
        extensions: [dash],
      } as never),
      new PathLayer<Line>({
        id: `pg-wire-${c.key}`,
        data: c.lines,
        getPath: (d) => d.path,
        getColor: (d) => d.cls === Wire.Building ? withAlpha(LINE_COLOR[Wire.Building], aLo + (aHi - aLo) * d.shade) : LINE_COLOR[d.cls],
        getWidth: (d) => LINE_WIDTH[d.cls],
        widthUnits: 'pixels',
        jointRounded: false,
        capRounded: false,
        miterLimit: 2,
      }),
    );
    if (opts.districts) {
      layers.push(
        new PolygonLayer<WireChunk['districts'][number]>({
          id: `pg-district-${c.key}`,
          data: c.districts,
          getPolygon: (d) => d.ring,
          filled: true,
          stroked: false,
          getFillColor: (d) => hex((W.districtDebug as Record<string, string>)[d.type] ?? '#ffffff', 38),
          }),
      );
    }
  }
  const lms = chunks.flatMap((c) => c.landmarks);
  layers.push(
    new TextLayer<(typeof lms)[number]>({
      id: 'pg-landmarks',
      data: lms,
      getPosition: (d) => [d.x, d.y],
      getText: (d) => LANDMARK_TEXT[d.type] ?? d.type,
      getColor: hex(W.landmark, 240),
      getSize: 11,
      fontFamily: RENDER.labels.font,
      fontWeight: 700,
      characterSet: 'auto',
      fontSettings: { sdf: true },
      outlineWidth: 3,
      outlineColor: hex(RENDER.colors.land, 255),
      visible: opts.zoom >= -1.6,
    }),
  );
  if (opts.districts) {
    layers.push(
      new PathLayer<WireChunk>({
        id: 'pg-chunk-grid',
        data: chunks,
        getPath: (c) => [[c.rect[0], c.rect[1]], [c.rect[2], c.rect[1]], [c.rect[2], c.rect[3]], [c.rect[0], c.rect[3]], [c.rect[0], c.rect[1]]],
        getColor: [255, 255, 255, 40],
        getWidth: 1,
        widthUnits: 'pixels',
      }),
    );
  }
  return layers;
}

const withAlpha = (c: RGBA, a: number): RGBA => [c[0], c[1], c[2], Math.round(a)];
