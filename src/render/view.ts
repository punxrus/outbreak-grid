import type { OrthographicViewState } from '@deck.gl/core';
import RENDER from '../config/render.json';
import type { BBox } from '../geo/types';

/** View state that fits `bounds` (meters) inside a width x height viewport. */
export function fitBounds(bounds: BBox, width: number, height: number): OrthographicViewState {
  const [minX, minY, maxX, maxY] = bounds;
  const pad = RENDER.view.initialPaddingPx * 2;
  const zoom = Math.log2(Math.min(Math.max(1, width - pad) / (maxX - minX), Math.max(1, height - pad) / (maxY - minY)));
  return { target: [(minX + maxX) / 2, (minY + maxY) / 2, 0], zoom, minZoom: RENDER.view.minZoom, maxZoom: RENDER.view.maxZoom };
}
