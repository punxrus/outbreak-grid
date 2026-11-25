import type { Layer } from '@deck.gl/core';
import { LineLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { KINDS } from '../sim/engine';
import type { SafeZone } from '../sim/walls';
import RENDER from '../config/render.json';
import UNITS from '../config/units.json';
import type { Placement } from '../sim/types';
import { hex } from './color';

export interface Frame { positions: Float32Array; colors: Uint8Array; count: number }
export interface Flash { x: number; y: number; r: number; t: number }
export interface Tracer { x1: number; y1: number; x2: number; y2: number; kind: number; t: number }

const KIND_RGB = KINDS.map((k) => hex((UNITS.units as Record<string, { color: string }>)[k]!.color));
const SAFE = hex(RENDER.colors.safeZone);

const unitColor = (k: string) => hex((UNITS.units as Record<string, { color: string }>)[k]!.color);
const unitLabel = (k: string) => (UNITS.units as Record<string, { label: string }>)[k]!.label;

/** Prep phase: where each squad will deploy. */
export function placementLayers(placements: Placement[]): Layer[] {
  return [
    new ScatterplotLayer<Placement>({
      id: 'placements',
      data: placements,
      getPosition: (p) => [p.x, p.y],
      getRadius: 9,
      radiusUnits: 'pixels',
      stroked: true,
      filled: true,
      getFillColor: (p) => [...unitColor(p.kind).slice(0, 3), 90] as [number, number, number, number],
      getLineColor: (p) => unitColor(p.kind),
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
    }),
    new TextLayer<Placement>({
      id: 'placement-labels',
      data: placements,
      getPosition: (p) => [p.x, p.y],
      getText: (p) => unitLabel(p.kind).toUpperCase(),
      getColor: (p) => unitColor(p.kind),
      getSize: 12,
      getPixelOffset: [0, -18],
      fontFamily: RENDER.labels.font,
      fontWeight: 700,
      characterSet: 'auto',
      background: true,
      getBackgroundColor: hex(RENDER.labels.plate, 220),
      backgroundPadding: [4, 2, 4, 1],
    }),
  ];
}

/** A safe zone being drawn or placed: fill, wall (paid solid, the rest faint), gates. */
export function zoneLayers(zones: SafeZone[], draft: [number, number][] | null, hover: [number, number] | null): Layer[] {
  const out: Layer[] = [
    new PolygonLayer<SafeZone>({
      id: 'zones-fill',
      data: zones,
      getPolygon: (z) => z.ring,
      filled: true,
      stroked: true,
      getFillColor: [SAFE[0], SAFE[1], SAFE[2], 28],
      getLineColor: [SAFE[0], SAFE[1], SAFE[2], 230],
      lineWidthUnits: 'meters',
      getLineWidth: 4,
      lineWidthMinPixels: 2,
    }),
    new ScatterplotLayer<[number, number]>({
      id: 'zones-gates',
      data: zones.flatMap((z) => z.gates),
      getPosition: (g) => g,
      getRadius: 5,
      radiusUnits: 'meters',
      radiusMinPixels: 4,
      getFillColor: [255, 255, 255, 255],
    }),
  ];
  if (draft && draft.length) {
    const path = hover ? [...draft, hover] : draft;
    out.push(
      new PathLayer<[number, number][]>({
        id: 'zone-draft',
        data: [path],
        getPath: (p) => p,
        getColor: [SAFE[0], SAFE[1], SAFE[2], 255],
        getWidth: 2,
        widthUnits: 'pixels',
      }),
      new ScatterplotLayer<[number, number]>({
        id: 'zone-draft-points',
        data: draft,
        getPosition: (p) => p,
        getRadius: 4,
        radiusUnits: 'pixels',
        getFillColor: (_p, { index }) => (index === 0 ? [255, 255, 255, 255] : [SAFE[0], SAFE[1], SAFE[2], 255]),
      }),
    );
  }
  return out;
}

/** Battle phase: every person as a colored dot, tracers, walls, fading blast rings. */
export function battleLayers(frame: Frame | null, flashes: Flash[], now: number, tracers: Tracer[] = [], walls: Float32Array | null = null): Layer[] {
  if (!frame) return [];
  const wallData = walls ? { length: walls.length / 4 } : { length: 0 };
  return [
    new ScatterplotLayer({
      id: 'battle-walls',
      data: wallData,
      getPosition: (_: unknown, { index }: { index: number }) => [walls![4 * index]!, walls![4 * index + 1]!],
      getFillColor: (_: unknown, { index }: { index: number }) => {
        const hp = walls![4 * index + 2]!, gate = walls![4 * index + 3]!;
        if (hp <= 0) return [255, 70, 60, 255]; // breach
        if (gate) return [255, 255, 255, 255];
        return [Math.round(SAFE[0] + (255 - SAFE[0]) * (1 - hp)), Math.round(SAFE[1] * hp + 80 * (1 - hp)), Math.round(SAFE[2] * hp), 255];
      },
      getRadius: 2.2,
      radiusUnits: 'meters',
      radiusMinPixels: 1.5,
      updateTriggers: { getFillColor: now },
    } as never),
    new LineLayer<Tracer>({
      id: 'battle-tracers',
      data: tracers,
      getSourcePosition: (t) => [t.x1, t.y1],
      getTargetPosition: (t) => [t.x2, t.y2],
      getColor: (t) => { const c = KIND_RGB[t.kind]!; return [c[0], c[1], c[2], Math.max(0, 255 - (now - t.t) * 0.55)]; },
      getWidth: 1.8,
      widthUnits: 'pixels',
      updateTriggers: { getColor: now },
    }),
    new ScatterplotLayer({
      id: 'battle-dots',
      data: {
        length: frame.count,
        attributes: {
          getPosition: { value: frame.positions, size: 2 },
          getFillColor: { value: frame.colors, size: 4, normalized: true },
        },
      },
      getRadius: 1.6,
      radiusUnits: 'meters',
      radiusMinPixels: 1.8,
      radiusMaxPixels: 7,
    } as never),
    new ScatterplotLayer<Flash>({
      id: 'battle-blasts',
      data: flashes,
      getPosition: (f) => [f.x, f.y],
      getRadius: (f) => f.r,
      radiusUnits: 'meters',
      radiusMinPixels: 3,
      stroked: true,
      filled: true,
      getFillColor: (f) => [255, 200, 90, Math.max(0, 140 - (now - f.t) * 0.25)],
      getLineColor: (f) => [255, 240, 200, Math.max(0, 255 - (now - f.t) * 0.4)],
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
      updateTriggers: { getFillColor: now, getLineColor: now },
    }),
  ];
}
