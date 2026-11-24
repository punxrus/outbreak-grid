import type { Pt, Rect, Ring } from './geom';
import type { ChunkData, DistrictType, LandmarkType, RoadKind } from './types';

/** Line classes of the wireframe, drawn in pixel widths. */
export const Wire = { Block: 0, Building: 1, Park: 2, Forest: 3, Landmark: 4 } as const;
export type Wire = (typeof Wire)[keyof typeof Wire];

export interface WireChunk {
  key: string;
  rect: Rect;
  /** Outline polylines with chunk-border segments removed, so seams never show. */
  lines: { path: Pt[]; cls: Wire; shade: number }[];
  /** Road features drawn in meters: bridges, ferries, arterial/collector centerlines. */
  roads: { path: Pt[]; kind: RoadKind; width: number; chokepoint: boolean }[];
  landmarks: { x: number; y: number; type: LandmarkType }[];
  districts: { ring: Ring; type: DistrictType }[];
  stats: ChunkData['stats'];
}

const EPS = 1e-6;
const onBorder = (p: Pt, r: Rect, side: number) =>
  side === 0 ? Math.abs(p[0] - r[0]) < EPS : side === 1 ? Math.abs(p[0] - r[2]) < EPS : side === 2 ? Math.abs(p[1] - r[1]) < EPS : Math.abs(p[1] - r[3]) < EPS;
const edgeOnBorder = (a: Pt, b: Pt, r: Rect) => [0, 1, 2, 3].some((s) => onBorder(a, r, s) && onBorder(b, r, s));

/** Closed ring → open polylines, skipping edges that lie on the chunk rectangle. */
export function ringToWire(ring: Ring, r: Rect): Pt[][] {
  const n = ring.length;
  if (n < 2) return [];
  const keep = ring.map((p, i) => !edgeOnBorder(p, ring[(i + 1) % n]!, r));
  if (keep.every(Boolean)) return [[...ring, ring[0]!]];
  if (!keep.some(Boolean)) return [];
  // start right after a dropped edge so runs do not wrap
  const start = (keep.findIndex((k) => !k) + 1) % n;
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  for (let s = 0; s < n; s++) {
    const i = (start + s) % n;
    if (keep[i]) {
      if (cur.length === 0) cur.push(ring[i]!);
      cur.push(ring[(i + 1) % n]!);
    } else if (cur.length) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

export function chunkWire(c: ChunkData): WireChunk {
  const lines: WireChunk['lines'] = [];
  const add = (rings: Ring[], cls: Wire, shade = 0) => {
    for (const ring of rings) for (const path of ringToWire(ring, c.rect)) lines.push({ path, cls, shade });
  };
  add(c.forests, Wire.Forest);
  add(c.parks, Wire.Park);
  add(c.blocks, Wire.Block);
  for (const b of c.buildings) {
    // buildings are inside lots, never on the border: close the loop
    lines.push({ path: [...b.ring, b.ring[0]!], cls: b.landmark ? Wire.Landmark : Wire.Building, shade: b.shade });
  }
  const roads: WireChunk['roads'] = [];
  for (const r of c.roads) {
    if (r.kind === 'bridge' || r.kind === 'ferry' || r.kind === 'arterial' || r.kind === 'collector') {
      roads.push({ path: r.pts, kind: r.kind, width: r.width, chokepoint: !!r.chokepoint });
    }
  }
  return {
    key: c.key,
    rect: c.rect,
    lines,
    roads,
    landmarks: c.landmarks.map((l) => ({ x: l.x, y: l.y, type: l.type })),
    districts: c.districts.map((d) => ({ ring: d.ring, type: d.type })),
    stats: c.stats,
  };
}
