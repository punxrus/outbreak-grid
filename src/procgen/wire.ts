import RENDER from '../config/render.json';
import { inRegion, type RegionMask } from '../campaign/region';
import { ringCentroid, type Pt, type Rect, type Ring } from './geom';
import type { ChunkData, DistrictType, LandmarkType, RoadKind } from './types';

/** Line classes of the wireframe, drawn in pixel widths. */
export const Wire = { Block: 0, Building: 1, Park: 2, Forest: 3, Landmark: 4 } as const;
export type Wire = (typeof Wire)[keyof typeof Wire];

/**
 * Flat, transferable path set for deck.gl's binary PathLayer input:
 * positions are x,y float32 pairs (meters; float32-safe within the state),
 * startIndices mark where each path begins (in vertices).
 */
export interface PathBuffers {
  length: number;
  startIndices: Uint32Array;
  positions: Float32Array;
  colors: Uint8Array; // RGBA per vertex
  widths: Float32Array; // per vertex
}

export interface WireChunk {
  key: string;
  rect: Rect;
  /** Ground outlines (blocks, parks, forests) in pixel widths; chunk-border segments removed so seams never show. */
  lines: PathBuffers;
  /** Building and landmark footprints: a separate buffer so they can fade out when zoomed far out. */
  bldg: PathBuffers;
  /** Bridges, ferries, road centerlines; few, so kept as objects (dash styling). */
  roads: { path: Pt[]; kind: RoadKind; width: number; chokepoint: boolean }[];
  landmarks: { x: number; y: number; type: LandmarkType }[];
  districts: { ring: Ring; type: DistrictType }[];
  /** 4 m walk grid of the chunk (row 0 = north), for the battle sim. */
  nav: { cell: number; width: number; height: number; grid: Uint8Array };
  /** Centers of ordinary buildings inside the region (x,y pairs): where survivors start. */
  homes: Float32Array;
  stats: ChunkData['stats'];
}

const W = RENDER.wire;
const rgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const STYLE: Record<Wire, { rgb: [number, number, number]; a: number; w: number }> = {
  [Wire.Block]: { rgb: rgb(W.block), a: 210, w: W.widthPx.block },
  [Wire.Building]: { rgb: rgb(W.building), a: W.buildingAlpha[1]!, w: W.widthPx.building },
  [Wire.Park]: { rgb: rgb(W.park), a: 200, w: W.widthPx.park },
  [Wire.Forest]: { rgb: rgb(W.forest), a: 220, w: W.widthPx.forest },
  [Wire.Landmark]: { rgb: rgb(W.landmark), a: 255, w: W.widthPx.landmark },
};

function packPaths(paths: { path: Pt[]; cls: Wire; shade: number }[]): PathBuffers {
  let verts = 0;
  for (const p of paths) verts += p.path.length;
  const startIndices = new Uint32Array(paths.length);
  const positions = new Float32Array(verts * 2);
  const colors = new Uint8Array(verts * 4);
  const widths = new Float32Array(verts);
  let v = 0;
  const [aLo, aHi] = W.buildingAlpha as [number, number];
  paths.forEach((p, i) => {
    startIndices[i] = v;
    const st = STYLE[p.cls];
    const a = p.cls === Wire.Building ? Math.round(aLo + (aHi - aLo) * p.shade) : st.a;
    for (const [x, y] of p.path) {
      positions[2 * v] = x; positions[2 * v + 1] = y;
      colors[4 * v] = st.rgb[0]; colors[4 * v + 1] = st.rgb[1]; colors[4 * v + 2] = st.rgb[2]; colors[4 * v + 3] = a;
      widths[v] = st.w;
      v++;
    }
  });
  return { length: paths.length, startIndices, positions, colors, widths };
}

/** ArrayBuffers to transfer (not copy) when posting a WireChunk. */
export function wireTransferables(w: WireChunk): ArrayBuffer[] {
  return [...[w.lines, w.bldg].flatMap((l) => [l.startIndices.buffer, l.positions.buffer, l.colors.buffer, l.widths.buffer]), w.nav.grid.buffer, w.homes.buffer] as ArrayBuffer[];
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

/**
 * Render-ready chunk. With a region, only content inside it is kept: blocks
 * and buildings by centroid (so they stay whole), roads by segment midpoint.
 */
export function chunkWire(c: ChunkData, region?: RegionMask | null): WireChunk {
  const inside = (x: number, y: number) => !region || inRegion(region, x, y);
  const keepRing = (r: Ring) => { const [x, y] = ringCentroid(r); return inside(x, y); };
  const lines: { path: Pt[]; cls: Wire; shade: number }[] = [];
  const add = (rings: Ring[], cls: Wire, shade = 0) => {
    for (const ring of rings) {
      if (!keepRing(ring)) continue;
      for (const path of ringToWire(ring, c.rect)) lines.push({ path, cls, shade });
    }
  };
  add(c.forests, Wire.Forest);
  add(c.parks, Wire.Park);
  add(c.blocks, Wire.Block);
  const bldg: typeof lines = [];
  const homes: number[] = [];
  for (const b of c.buildings) {
    if (!keepRing(b.ring)) continue;
    if (!b.landmark) { const [hx, hy] = ringCentroid(b.ring); homes.push(hx, hy); }
    // buildings are inside lots, never on the border: close the loop
    bldg.push({ path: [...b.ring, b.ring[0]!], cls: b.landmark ? Wire.Landmark : Wire.Building, shade: b.shade });
  }
  const roads: WireChunk['roads'] = [];
  for (const r of c.roads) {
    if (r.kind !== 'bridge' && r.kind !== 'ferry' && r.kind !== 'arterial' && r.kind !== 'collector') continue;
    // split into runs of segments whose midpoint is inside the region
    let run: Pt[] = [];
    const flush = () => { if (run.length > 1) roads.push({ path: run, kind: r.kind, width: r.width, chokepoint: !!r.chokepoint }); run = []; };
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i]!, b = r.pts[i + 1]!;
      if (inside((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) { if (!run.length) run.push(a); run.push(b); } else flush();
    }
    flush();
  }
  return {
    key: c.key,
    rect: c.rect,
    lines: packPaths(lines),
    bldg: packPaths(bldg),
    roads,
    landmarks: c.landmarks.filter((l) => inside(l.x, l.y)).map((l) => ({ x: l.x, y: l.y, type: l.type })),
    districts: c.districts.map((d) => ({ ring: d.ring, type: d.type })),
    nav: { cell: c.nav.cell, width: c.nav.width, height: c.nav.height, grid: c.nav.grid.slice() },
    homes: Float32Array.from(homes),
    stats: c.stats,
  };
}
