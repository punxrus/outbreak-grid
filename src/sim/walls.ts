import UNITS from '../config/units.json';
import { fillPolygon, makeGrid } from '../geo/rasterize';
import type { BattleWorld } from './types';

export type Pt = [number, number];

/** A drawn safe zone: a closed ring of points, with gates on its wall. */
export interface SafeZone { ring: Pt[]; gates: Pt[] }

const W = () => UNITS.walls;

/**
 * Wall cells along a closed ring, 4-connected so nothing slips through a
 * diagonal. Cells that are already buildings stay buildings: the building
 * takes the place of that wall section, and it costs nothing.
 */
export function wallCells(world: BattleWorld, ring: Pt[]): { cells: number[]; paidMeters: number; freeMeters: number } {
  const set = new Set<number>();
  const order: number[] = [];
  const add = (c: number) => { if (c >= 0 && !set.has(c)) { set.add(c); order.push(c); } };
  const cellOf = (x: number, y: number) => {
    const c = Math.floor((x - world.minX) / world.cell), r = Math.floor((world.maxY - y) / world.cell);
    return c < 0 || r < 0 || c >= world.width || r >= world.height ? -1 : r * world.width + c;
  };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / (world.cell / 4)));
    let prev = -1;
    for (let k = 0; k <= n; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / n, y = a[1] + ((b[1] - a[1]) * k) / n;
      const c = cellOf(x, y);
      if (c < 0 || c === prev) continue;
      if (prev >= 0) {
        // diagonal step: fill the corner so the wall stays 4-connected
        const pc = prev % world.width, pr = (prev - pc) / world.width, cc = c % world.width, cr = (c - cc) / world.width;
        if (pc !== cc && pr !== cr) add(pr * world.width + cc);
      }
      add(c);
      prev = c;
    }
  }
  let paid = 0, free = 0;
  const cells: number[] = [];
  for (const c of order) {
    const v = world.grid[c];
    if (v === 3) { free += world.cell; continue; } // a building stands in for the wall
    if (v === 0) continue; // water / outside: nothing to build on
    cells.push(c);
    paid += world.cell;
  }
  return { cells, paidMeters: paid, freeMeters: free };
}

/** Cells inside a ring (the zone survivors head for). */
export function zoneCells(world: BattleWorld, ring: Pt[]): Uint8Array {
  const grid = makeGrid([world.minX, world.maxY - world.height * world.cell, world.minX + world.width * world.cell, world.maxY], world.cell);
  const mask = new Uint8Array(world.width * world.height);
  fillPolygon(grid, [[...ring, ring[0]!]], mask, 1, 'set');
  return mask;
}

/** Wall cells within gate width of each gate point. */
export function gateCells(world: BattleWorld, wall: number[], gates: Pt[]): Set<number> {
  const out = new Set<number>();
  const half = W().gateWidthMeters / 2;
  for (const [gx, gy] of gates) {
    for (const c of wall) {
      const col = c % world.width, row = (c - col) / world.width;
      const x = world.minX + (col + 0.5) * world.cell, y = world.maxY - (row + 0.5) * world.cell;
      if (Math.hypot(x - gx, y - gy) <= half + world.cell / 2) out.add(c);
    }
  }
  return out;
}

/** Nearest point on the ring's wall to (x, y), if within `tol` meters. */
export function snapToWall(ring: Pt[], x: number, y: number, tol: number): Pt | null {
  let best: Pt | null = null, bd = tol;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
    const px = a[0] + dx * t, py = a[1] + dy * t, d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; best = [px, py]; }
  }
  return best;
}

export function zoneCost(world: BattleWorld, z: SafeZone): { money: number; paidMeters: number; freeMeters: number } {
  const w = wallCells(world, z.ring);
  return { money: Math.round(w.paidMeters * W().costPerMeter + z.gates.length * W().gateCost), paidMeters: w.paidMeters, freeMeters: w.freeMeters };
}
