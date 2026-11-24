import PROCGEN from '../config/procgen.json';
import { LAND, maskAt, type Raster } from './context';
import {
  clipHalfPlane, minAreaRect, orientedRect, pointInRing, ringArea, ringCentroid, simplifyRing,
  type Rect, type Ring,
} from './geom';
import { SALT, rngFor, unit } from './rng';
import type { Building, DistrictType } from './types';

/**
 * Blocks = connected land regions left after roads are burned into the chunk
 * raster. Each region's boundary is traced on the cell-corner lattice, then
 * simplified. Roads were drawn at their real width, so blocks come out already
 * inset by road width and clipped at water and at the chunk edge.
 */
export function extractBlocks(r: Raster, chunk: Rect): Ring[] {
  const { grid, mask } = r;
  const W = grid.width, cell = grid.cell;
  const c0 = Math.round((chunk[0] - grid.minX) / cell), c1 = Math.round((chunk[2] - grid.minX) / cell);
  const r0 = Math.round((grid.maxY - chunk[3]) / cell), r1 = Math.round((grid.maxY - chunk[1]) / cell);
  const labels = new Int32Array(mask.length).fill(-1);
  const queue = new Int32Array(mask.length);
  const minCells = PROCGEN.blocks.minAreaM2 / (cell * cell);
  const inside = (c: number, row: number) => c >= c0 && c < c1 && row >= r0 && row < r1;
  const out: Ring[] = [];
  let next = 0;

  for (let row = r0; row < r1; row++) {
    for (let c = c0; c < c1; c++) {
      const idx = row * W + c;
      if (mask[idx] !== LAND || labels[idx] !== -1) continue;
      const id = next++;
      let head = 0, tail = 0;
      queue[tail++] = idx;
      labels[idx] = id;
      while (head < tail) {
        const k = queue[head++]!;
        const kc = k % W, kr = (k - kc) / W;
        const nb = [[kc + 1, kr], [kc - 1, kr], [kc, kr + 1], [kc, kr - 1]] as const;
        for (const [nc, nr] of nb) {
          if (!inside(nc, nr)) continue;
          const ni = nr * W + nc;
          if (mask[ni] === LAND && labels[ni] === -1) { labels[ni] = id; queue[tail++] = ni; }
        }
      }
      if (tail < minCells) continue;
      const ring = traceOuter(queue.subarray(0, tail), labels, id, W, inside, grid.minX, grid.maxY, cell);
      if (!ring) continue;
      const simple = simplifyRing(ring, PROCGEN.blocks.simplifyMeters);
      if (simple.length >= 3 && Math.abs(ringArea(simple)) >= PROCGEN.blocks.minAreaM2) out.push(simple);
    }
  }
  return out;
}

function traceOuter(
  cells: Int32Array, labels: Int32Array, id: number, W: number, inside: (c: number, r: number) => boolean,
  minX: number, maxY: number, cell: number,
): Ring | null {
  const CW = W + 1;
  const edges = new Map<number, number[]>();
  const add = (ai: number, aj: number, bi: number, bj: number) => {
    const a = aj * CW + ai;
    const list = edges.get(a);
    if (list) list.push(bj * CW + bi);
    else edges.set(a, [bj * CW + bi]);
  };
  const same = (c: number, r: number) => inside(c, r) && labels[r * W + c] === id;
  for (const k of cells) {
    const c = k % W, r = (k - c) / W;
    if (!same(c, r - 1)) add(c, r, c + 1, r);
    if (!same(c + 1, r)) add(c + 1, r, c + 1, r + 1);
    if (!same(c, r + 1)) add(c + 1, r + 1, c, r + 1);
    if (!same(c - 1, r)) add(c, r + 1, c, r);
  }
  let best: Ring | null = null, bestArea = 0;
  for (const startKey of [...edges.keys()]) {
    while ((edges.get(startKey)?.length ?? 0) > 0) {
      const loop: number[] = [startKey];
      let cur = edges.get(startKey)!.pop()!;
      let guard = 0;
      while (cur !== startKey && guard++ < 1e6) {
        loop.push(cur);
        const list = edges.get(cur);
        if (!list || list.length === 0) break;
        cur = list.pop()!;
      }
      if (loop.length < 4) continue;
      // keep only corners where direction changes
      const ring: Ring = [];
      for (let i = 0; i < loop.length; i++) {
        const p = loop[(i - 1 + loop.length) % loop.length]!, q = loop[i]!, n = loop[(i + 1) % loop.length]!;
        const pi = p % CW, pj = (p - pi) / CW, qi = q % CW, qj = (q - qi) / CW, ni = n % CW, nj = (n - ni) / CW;
        if ((qi - pi) * (nj - qj) - (qj - pj) * (ni - qi) !== 0) ring.push([minX + qi * cell, maxY - qj * cell]);
      }
      const area = Math.abs(ringArea(ring));
      if (area > bestArea) { bestArea = area; best = ring; }
    }
  }
  return best;
}

type LotParams = { targetArea: number; minWidth: number };
const LOTS = PROCGEN.lots as unknown as Record<string, LotParams | undefined> & { splitJitter: number; maxDepth: number };

/** Recursive oriented-bounding-box split: cut across the long axis until lots reach target size. */
export function splitLots(seed: number, ring: Ring, type: DistrictType, depth = 0): Ring[] {
  const p = LOTS[type];
  if (!p) return [ring];
  const area = Math.abs(ringArea(ring));
  if (area <= p.targetArea * 1.5 || depth >= LOTS.maxDepth) return [ring];
  const obb = minAreaRect(ring);
  if (obb.halfL * 2 < p.minWidth * 2) return [ring];
  const [ccx, ccy] = ringCentroid(ring);
  const t = (unit(seed, SALT.lot, Math.round(ccx), Math.round(ccy), depth) - 0.5) * 2 * LOTS.splitJitter * obb.halfL;
  const px = obb.cx + obb.ux * t, py = obb.cy + obb.uy * t;
  const a = clipHalfPlane(ring, px, py, obb.ux, obb.uy);
  const b = clipHalfPlane(ring, px, py, -obb.ux, -obb.uy);
  if (a.length < 3 || b.length < 3) return [ring];
  return [...splitLots(seed, a, type, depth + 1), ...splitLots(seed, b, type, depth + 1)];
}

type BuildingParams = { chance: number; coverage: number[]; maxSide: number };
const BUILDINGS = PROCGEN.buildings as unknown as Record<string, BuildingParams | undefined>;

/** One flat rectangular footprint inside a lot, aligned to the lot's OBB. */
export function buildingFor(seed: number, lot: Ring, type: DistrictType, raster: Raster, force?: { coverage: number; maxSide: number }): Building | null {
  const p = BUILDINGS[type];
  if (!p && !force) return null;
  const [lx, ly] = ringCentroid(lot);
  const rng = rngFor(seed, SALT.building, Math.round(lx * 2), Math.round(ly * 2));
  if (!force && rng() >= p!.chance) return null;
  const obb = minAreaRect(lot);
  const minW = LOTS[type]?.minWidth ?? 10;
  if (obb.halfW * 2 < minW * 0.5) return null;
  const cov = force ? force.coverage : p!.coverage[0]! + (p!.coverage[1]! - p!.coverage[0]!) * rng();
  const maxHalf = (force ? force.maxSide : p!.maxSide) / 2;
  // Setback from the lot edge: blocks are traced on a 2 m raster and simplified,
  // so a footprint flush with the lot boundary would clip the road raster.
  const SET = PROCGEN.buildings.setbackMeters;
  let hl = Math.min((obb.halfL - SET) * cov, maxHalf);
  let hw = Math.min((obb.halfW - SET) * Math.min(0.95, cov + 0.05), maxHalf);
  const slackL = obb.halfL - hl, slackW = obb.halfW - hw;
  const offL = (rng() - 0.5) * slackL, offW = (rng() - 0.5) * slackW;
  const shade = rng();
  for (let attempt = 0; attempt < 5; attempt++) {
    const cx = obb.cx + obb.ux * offL - obb.uy * offW, cy = obb.cy + obb.uy * offL + obb.ux * offW;
    const ring = orientedRect(cx, cy, obb.ux, obb.uy, hl, hw);
    const ok = ring.every(([x, y]) => pointInRing(x, y, lot) && maskAt(raster, x, y) === LAND) && maskAt(raster, cx, cy) === LAND;
    if (ok && hl > 2 && hw > 2) return { ring, shade };
    hl *= 0.84;
    hw *= 0.84;
  }
  return null;
}
