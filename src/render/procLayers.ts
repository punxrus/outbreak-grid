import type { Layer } from '@deck.gl/core';
import { PathStyleExtension } from '@deck.gl/extensions';
import { PathLayer, PolygonLayer, TextLayer } from '@deck.gl/layers';
import RENDER from '../config/render.json';
import type { WireChunk } from '../procgen/wire';
import { hex } from './color';
import { declutter } from './labels';

const W = RENDER.wire;
const L = RENDER.labels;
const dash = new PathStyleExtension({ dash: true });

const LANDMARK_TEXT: Record<string, string> = {
  hospital: '+ HOSPITAL', police: 'POLICE', gas_station: 'FUEL', armory: 'ARMORY', school: 'SCHOOL',
  radio_tower: 'RADIO', helipad: 'HELIPAD', ferry_terminal: 'FERRY',
};

type Road = WireChunk['roads'][number];
type Landmark = WireChunk['landmarks'][number];

/** Which label wins when two overlap (gameplay value first). */
const PRIORITY: Record<string, number> = {
  hospital: 0, armory: 1, police: 2, helipad: 3, ferry_terminal: 4, radio_tower: 5, gas_station: 6, school: 7,
};

/**
 * Wireframe layers for generated chunks. One layer set per chunk with stable
 * data references, so deck.gl keeps GPU buffers for chunks that stay on screen
 * and only uploads the new ones. Outlines arrive as binary buffers from the
 * worker: no per-path JS objects on the main thread.
 */
export function buildProcLayers(chunks: WireChunk[], opts: { districts: boolean; showLabels: boolean; zoom: number }): Layer[] {
  const layers: Layer[] = [];
  for (const c of chunks) {
    const lines = c.lines;
    layers.push(
      new PathLayer<Road>({
        id: `pg-road-${c.key}`,
        data: c.roads,
        getPath: (d: Road) => d.path,
        getColor: (d: Road) => d.kind === 'ferry' ? hex(W.ferry, 200) : d.kind === 'bridge' ? hex(d.chokepoint ? W.chokepoint : W.bridge, 230)
          : d.kind === 'arterial' ? hex(W.arterial, 150) : hex(W.collector, 120),
        // bridges at deck width; road centerlines as thin dashed guides
        getWidth: (d: Road) => (d.kind === 'bridge' ? d.width : d.kind === 'ferry' ? 3 : 1.2),
        widthUnits: 'meters',
        widthMinPixels: 1,
        getDashArray: (d: Road) => (d.kind === 'bridge' ? [0, 0] : d.kind === 'ferry' ? [6, 5] : [8, 6]),
        dashJustified: false,
        extensions: [dash],
      } as never),
      new PathLayer({
        id: `pg-wire-${c.key}`,
        data: {
          length: lines.length,
          startIndices: lines.startIndices,
          attributes: {
            getPath: { value: lines.positions, size: 2 },
            getColor: { value: lines.colors, size: 4, normalized: true },
            getWidth: { value: lines.widths, size: 1 },
          },
        },
        _pathType: 'open',
        positionFormat: 'XY',
        widthUnits: 'pixels',
        jointRounded: false,
        capRounded: false,
        miterLimit: 2,
      } as never),
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
  const all = chunks.flatMap((c) => c.landmarks).sort((a, b) => (PRIORITY[a.type] ?? 9) - (PRIORITY[b.type] ?? 9));
  const lms = opts.showLabels
    ? declutter(all.map((d) => ({ item: d, x: d.x, y: d.y, text: LANDMARK_TEXT[d.type] ?? d.type, anchor: 'middle' as const, size: L.landmarkSizePx + 4 })), opts.zoom).map((k) => k.item)
    : [];
  layers.push(
    new TextLayer<Landmark>({
      id: 'pg-landmarks',
      data: lms,
      getPosition: (d) => [d.x, d.y],
      getText: (d) => LANDMARK_TEXT[d.type] ?? d.type,
      getColor: hex(W.landmark, 255),
      getSize: L.landmarkSizePx,
      fontFamily: L.font,
      fontWeight: 700,
      characterSet: 'auto',
      // solid label plates: text stays readable on top of the dense wireframe
      background: true,
      getBackgroundColor: hex(L.plate, 235),
      getBorderColor: hex(W.landmark, 200),
      getBorderWidth: 1,
      backgroundPadding: [5, 3, 5, 2],
      visible: opts.showLabels,
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
