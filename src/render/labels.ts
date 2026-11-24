import RENDER from '../config/render.json';

/** Minimum population for a place label at this zoom (step table in config). */
export function placeMinPop(zoom: number): number {
  const table = RENDER.labels.placeMinPopByZoom as [number, number][];
  let pop = table[0]![1];
  for (const [z, p] of table) if (zoom >= z) pop = p;
  return pop;
}

export interface LabelCandidate<T> { item: T; x: number; y: number; text: string; anchor: 'start' | 'middle'; size: number }

/**
 * Greedy label placement: candidates are taken in order (highest priority
 * first) and kept only if their approximate screen box does not overlap an
 * already-kept box. Boxes are computed in world meters for this zoom.
 */
export function declutter<T>(cands: LabelCandidate<T>[], zoom: number): LabelCandidate<T>[] {
  const mpp = 1 / 2 ** zoom;
  const kept: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const out: LabelCandidate<T>[] = [];
  for (const c of cands) {
    const w = (c.text.length * c.size * 0.6 + 8) * mpp;
    const h = (c.size + 4) * mpp;
    const x0 = c.anchor === 'start' ? c.x : c.x - w / 2;
    const box = { x0, y0: c.y - h / 2, x1: x0 + w, y1: c.y + h / 2 };
    if (kept.some((k) => box.x0 < k.x1 && box.x1 > k.x0 && box.y0 < k.y1 && box.y1 > k.y0)) continue;
    kept.push(box);
    out.push(c);
  }
  return out;
}
