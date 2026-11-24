import PROCGEN from '../config/procgen.json';
import { fillPolygon, makeGrid } from '../geo/rasterize';
import { LAND, ROAD, type Raster } from './context';
import type { Pt, Rect } from './geom';
import type { Building, Road, RoadKind } from './types';

/** Walk-grid cell values. */
export const NAV = { Water: 0, Open: 1, Road: 2, Blocked: 3 } as const;

const KIND_CODE: Record<RoadKind, number> = { arterial: 0, collector: 1, street: 2, rural: 3, bridge: 4, ferry: 5 };
export const KIND_OF_CODE = Object.keys(KIND_CODE) as RoadKind[];

export interface ChunkNav {
  /** Walk grid over the chunk rect, row 0 = north. */
  cell: number; width: number; height: number; grid: Uint8Array;
  /** Road graph. nodes: x,y pairs. edges: a,b node pairs. */
  nodes: Float64Array; edges: Uint32Array; edgeKind: Uint8Array; edgeLen: Float32Array; edgeChoke: Uint8Array;
  /** Nodes on the chunk border; neighbors share them by exact coordinates. */
  border: Uint32Array;
}

/**
 * Walk grid: downsample the chunk's 2 m land/road/water raster, then stamp
 * building footprints as blocked. Road wins over land inside a cell, so
 * narrow streets stay connected at the coarser resolution.
 */
export function buildWalkGrid(r: Raster, rect: Rect, buildings: Building[]): Pick<ChunkNav, 'cell' | 'width' | 'height' | 'grid'> {
  const cell = PROCGEN.nav.gridCell;
  const g = makeGrid(rect, cell);
  const grid = new Uint8Array(g.width * g.height);
  const src = r.grid, k = Math.round(cell / src.cell);
  const c0 = Math.round((rect[0] - src.minX) / src.cell), r0 = Math.round((src.maxY - rect[3]) / src.cell);
  for (let row = 0; row < g.height; row++) {
    for (let col = 0; col < g.width; col++) {
      let land = 0, road = 0;
      for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
        const m = r.mask[(r0 + row * k + dy) * src.width + c0 + col * k + dx];
        if (m === ROAD) road++; else if (m === LAND) land++;
      }
      grid[row * g.width + col] = road > 0 ? NAV.Road : land * 2 >= k * k ? NAV.Open : NAV.Water;
    }
  }
  for (const b of buildings) fillPolygon(g, [b.ring], grid, NAV.Blocked, 'set');
  return { cell, width: g.width, height: g.height, grid };
}

interface Seg { a: Pt; b: Pt; road: number; ts: number[] }

/**
 * Road graph: split every road segment at proper crossings and at T-junctions
 * (a road end within snap distance of another road), then key nodes by
 * quantized position so shared points merge.
 */
export function buildRoadGraph(roads: Road[], rect: Rect): Omit<ChunkNav, 'cell' | 'width' | 'height' | 'grid'> {
  const segs: Seg[] = [];
  roads.forEach((r, ri) => { for (let i = 0; i + 1 < r.pts.length; i++) segs.push({ a: r.pts[i]!, b: r.pts[i + 1]!, road: ri, ts: [0, 1] }); });

  const H = 40;
  const hash = new Map<number, number[]>();
  const keyOf = (cx: number, cy: number) => cx * 73856093 ^ cy * 19349663;
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / H), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / H);
    const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / H), y1 = Math.floor(Math.max(s.a[1], s.b[1]) / H);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = keyOf(x, y), l = hash.get(k);
      if (l) l.push(i); else hash.set(k, [i]);
    }
  });
  const near = (x: number, y: number, rad: number) => {
    const out = new Set<number>();
    for (let gy = Math.floor((y - rad) / H); gy <= Math.floor((y + rad) / H); gy++)
      for (let gx = Math.floor((x - rad) / H); gx <= Math.floor((x + rad) / H); gx++)
        for (const i of hash.get(keyOf(gx, gy)) ?? []) out.add(i);
    return out;
  };

  // proper crossings (ferries cross nothing)
  for (const l of hash.values()) {
    for (let p = 0; p < l.length; p++) for (let q = p + 1; q < l.length; q++) {
      const s = segs[l[p]!]!, t = segs[l[q]!]!;
      if (s.road === t.road || roads[s.road]!.kind === 'ferry' || roads[t.road]!.kind === 'ferry') continue;
      const hit = intersect(s.a, s.b, t.a, t.b);
      if (hit) { s.ts.push(hit[0]); t.ts.push(hit[1]); }
    }
  }
  // T-junctions: a road end that stops short of (or just past) another road
  const SNAP = PROCGEN.nav.snapMeters;
  roads.forEach((r, ri) => {
    if (r.kind === 'ferry' || r.pts.length < 2) return;
    for (const end of [r.pts[0]!, r.pts[r.pts.length - 1]!]) {
      // an end on the chunk border is a clip cut, not a dead end: never snap it
      if (onRect(end, rect)) continue;
      let best = -1, bestT = 0, bestD = SNAP + (r.width / 2);
      for (const i of near(end[0], end[1], bestD)) {
        const s = segs[i]!;
        if (s.road === ri || roads[s.road]!.kind === 'ferry') continue;
        const [t, d] = project(end, s.a, s.b);
        if (d < bestD) { bestD = d; best = i; bestT = t; }
      }
      if (best >= 0) {
        const s = segs[best]!;
        s.ts.push(bestT);
        // move the end onto the other road so both share the node
        const p: Pt = [s.a[0] + (s.b[0] - s.a[0]) * bestT, s.a[1] + (s.b[1] - s.a[1]) * bestT];
        for (const own of segs) if (own.road === ri) {
          if (own.a === end) own.a = p;
          if (own.b === end) own.b = p;
        }
      }
    }
  });

  const Q = 4; // 0.25 m
  const ids = new Map<string, number>();
  const nodes: number[] = [];
  const node = (x: number, y: number) => {
    const k = `${Math.round(x * Q)},${Math.round(y * Q)}`;
    let id = ids.get(k);
    if (id === undefined) { id = nodes.length / 2; ids.set(k, id); nodes.push(x, y); }
    return id;
  };
  const edges: number[] = [], kind: number[] = [], len: number[] = [], choke: number[] = [];
  const seen = new Set<string>();
  for (const s of segs) {
    const r = roads[s.road]!;
    const ts = [...new Set(s.ts)].sort((a, b) => a - b);
    let prev = node(s.a[0] + (s.b[0] - s.a[0]) * ts[0]!, s.a[1] + (s.b[1] - s.a[1]) * ts[0]!);
    for (let i = 1; i < ts.length; i++) {
      const x = s.a[0] + (s.b[0] - s.a[0]) * ts[i]!, y = s.a[1] + (s.b[1] - s.a[1]) * ts[i]!;
      const cur = node(x, y);
      if (cur !== prev) {
        const key = prev < cur ? `${prev}-${cur}` : `${cur}-${prev}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push(prev, cur);
          kind.push(KIND_CODE[r.kind]);
          len.push(Math.hypot(nodes[2 * cur]! - nodes[2 * prev]!, nodes[2 * cur + 1]! - nodes[2 * prev + 1]!));
          choke.push(r.chokepoint ? 1 : 0);
        }
      }
      prev = cur;
    }
  }
  const border: number[] = [];
  for (let i = 0; i < nodes.length / 2; i++) if (onRect([nodes[2 * i]!, nodes[2 * i + 1]!], rect)) border.push(i);
  return {
    nodes: Float64Array.from(nodes), edges: Uint32Array.from(edges), edgeKind: Uint8Array.from(kind),
    edgeLen: Float32Array.from(len), edgeChoke: Uint8Array.from(choke), border: Uint32Array.from(border),
  };
}

const onRect = (p: Pt, r: Rect) =>
  Math.abs(p[0] - r[0]) < 1e-6 || Math.abs(p[0] - r[2]) < 1e-6 || Math.abs(p[1] - r[1]) < 1e-6 || Math.abs(p[1] - r[3]) < 1e-6;

function intersect(a: Pt, b: Pt, c: Pt, d: Pt): [number, number] | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9 ? [t, u] : null;
}

function project(p: Pt, a: Pt, b: Pt): [number, number] {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return [t, Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1])];
}
