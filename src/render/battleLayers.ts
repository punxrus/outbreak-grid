import type { Layer } from '@deck.gl/core';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import RENDER from '../config/render.json';
import UNITS from '../config/units.json';
import type { Placement } from '../sim/types';
import { hex } from './color';

export interface Frame { positions: Float32Array; colors: Uint8Array; count: number }
export interface Flash { x: number; y: number; r: number; t: number }

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

/** Battle phase: every person as a colored dot, plus fading blast rings. */
export function battleLayers(frame: Frame | null, flashes: Flash[], now: number): Layer[] {
  if (!frame) return [];
  return [
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
