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
  radio_tower: 'RADIO', helipad: 'HELIPAD', ferry_terminal: 'FERRY', cooling_tower: 'COOLING TOWER',
};

type Road = WireChunk['roads'][number];
type Landmark = WireChunk['landmarks'][number];

/** Which label wins when two overlap (gameplay value first). */
const PRIORITY: Record<string, number> = {
  cooling_tower: -1, hospital: 0, armory: 1, police: 2, helipad: 3, ferry_terminal: 4, radio_tower: 5, gas_station: 6, school: 7,
};

/**
 * Wireframe layers for generated chunks. One layer set per chunk with stable
 * data references, so deck.gl keeps GPU buffers for chunks that stay on screen
 * and only uploads the new ones. Outlines arrive as binary buffers from the
 * worker: no per-path JS objects on the main thread.
 */
function binaryPaths(id: string, b: WireChunk['lines'], opacity: number, visible = true): Layer {
  return new PathLayer({
    id,
    data: {
      length: b.length,
      startIndices: b.startIndices,
      attributes: {
        getPath: { value: b.positions, size: 2 },
        getColor: { value: b.colors, size: 4, normalized: true },
        getWidth: { value: b.widths, size: 1 },
      },
    },
    _pathType: 'open',
    positionFormat: 'XY',
    widthUnits: 'pixels',
    jointRounded: false,
    capRounded: false,
    miterLimit: 2,
    opacity,
    visible,
  } as never);
}

interface Group { key: string; lines: WireChunk['lines']; bldg: WireChunk['bldg']; roads: Road[]; districts: WireChunk['districts'] }

const GROUP = 4; // chunks per group side
const groupCache = new Map<string, Group>(); // content key -> merged group (stable refs keep GPU buffers)

/** Concatenate chunk path buffers into one (offsetting start indices). */
function mergeLines(parts: WireChunk['lines'][]): WireChunk['lines'] {
  let paths = 0, verts = 0;
  for (const p of parts) { paths += p.length; verts += p.widths.length; }
  const startIndices = new Uint32Array(paths), positions = new Float32Array(verts * 2), colors = new Uint8Array(verts * 4), widths = new Float32Array(verts);
  let pi = 0, vi = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) startIndices[pi + i] = p.startIndices[i]! + vi;
    positions.set(p.positions, vi * 2); colors.set(p.colors, vi * 4); widths.set(p.widths, vi);
    pi += p.length; vi += p.widths.length;
  }
  return { length: paths, startIndices, positions, colors, widths };
}

function groupsOf(chunks: WireChunk[]): Group[] {
  const by = new Map<string, WireChunk[]>();
  for (const c of chunks) {
    const [cx, cy] = c.key.split(',').map(Number) as [number, number];
    const gk = `${Math.floor(cx / GROUP)},${Math.floor(cy / GROUP)}`;
    const list = by.get(gk);
    if (list) list.push(c); else by.set(gk, [c]);
  }
  const out: Group[] = [];
  for (const [gk, list] of by) {
    list.sort((a, b) => (a.key < b.key ? -1 : 1));
    const key = `${gk}|${list.map((c) => c.key).join(';')}`;
    let g = groupCache.get(key);
    if (!g) {
      g = { key: gk, lines: mergeLines(list.map((c) => c.lines)), bldg: mergeLines(list.map((c) => c.bldg)), roads: list.flatMap((c) => c.roads), districts: list.flatMap((c) => c.districts) };
      groupCache.set(key, g);
      if (groupCache.size > 512) groupCache.delete(groupCache.keys().next().value!);
    }
    out.push(g);
  }
  return out;
}

/**
 * Wireframe layers for generated chunks, merged into 4x4-chunk groups so a
 * whole city is a few dozen layers. Group objects are cached by content, so
 * when one chunk arrives only its group is re-merged and re-uploaded.
 * Outlines are binary buffers from the worker: no per-path JS objects.
 */
export function buildProcLayers(chunks: WireChunk[], opts: { districts: boolean; showLabels: boolean; zoom: number }): Layer[] {
  const layers: Layer[] = [];
  // Zoomed far out, thousands of 1 px outlines merge into a solid mass:
  // hide buildings and dim the block outlines so the street structure reads.
  const farOpacity = opts.zoom >= W.buildingMinZoom ? 1 : W.farBlockOpacity;
  for (const g of groupsOf(chunks)) {
    layers.push(
      new PathLayer<Road>({
        id: `pg-road-${g.key}`,
        data: g.roads,
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
      binaryPaths(`pg-wire-${g.key}`, g.lines, farOpacity),
      binaryPaths(`pg-bldg-${g.key}`, g.bldg, 1, opts.zoom >= W.buildingMinZoom),
    );
    if (opts.districts) {
      layers.push(
        new PolygonLayer<WireChunk['districts'][number]>({
          id: `pg-district-${g.key}`,
          data: g.districts,
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
      // structures drawn large (cooling towers) get their label below the ring
      getPosition: (d) => (d.type === 'cooling_tower' ? [d.x, d.y - 75] : [d.x, d.y]),
      getAlignmentBaseline: (d) => (d.type === 'cooling_tower' ? 'top' : 'center'),
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
