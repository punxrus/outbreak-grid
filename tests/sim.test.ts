import { describe, expect, it } from 'vitest';
import { Battle } from '../src/sim/engine';
import { wallCells } from '../src/sim/walls';
import type { BattleSetup, BattleWorld, Placement } from '../src/sim/types';

/** 600 m x 600 m of open ground, homes in a 200 m town square in the middle. */
function world(): BattleWorld {
  const cell = 4, width = 150, height = 150;
  const grid = new Uint8Array(width * height).fill(1);
  const homes: number[] = [];
  for (let i = 0; i < 120; i++) homes.push(200 + (i % 12) * 17, 200 + Math.floor(i / 12) * 20);
  return { minX: 0, maxY: 600, cell, width, height, grid, homes: Float32Array.from(homes), police: [] };
}
const setup = (placements: Placement[], seed = 7, zombies = 25): BattleSetup => ({ seed, world: world(), placements, survivors: 300, zombies, ammo: 5000 });
const run = (b: Battle, seconds: number) => { for (let t = 0; t < seconds / 0.1 && !b.outcome; t++) b.step(); return b.stats(); };

describe('battle sim', () => {
  it('is deterministic for the same setup', () => {
    const p: Placement[] = [{ kind: 'militia', x: 300, y: 300 }];
    expect(run(new Battle(setup(p)), 120)).toEqual(run(new Battle(setup(p)), 120));
  });

  it('an undefended town falls below the survivor minimum and is lost', { timeout: 60_000 }, () => {
    const s = run(new Battle(setup([])), 1200);
    expect(s.outcome?.secured).toBe(false);
    expect(s.outcome!.savedPct).toBeLessThan(50);
  });

  it('a well-defended town is secured, scored by survivors saved', { timeout: 60_000 }, () => {
    const p: Placement[] = [
      { kind: 'paratrooper', x: 250, y: 250 }, { kind: 'paratrooper', x: 350, y: 250 },
      { kind: 'paratrooper', x: 250, y: 350 }, { kind: 'paratrooper', x: 350, y: 350 },
      { kind: 'helicopter', x: 300, y: 300 }, { kind: 'drone', x: 300, y: 300 },
    ];
    const s = run(new Battle(setup(p, 3, 15)), 1200);
    expect(s.outcome?.secured).toBe(true);
    expect(s.zombies).toBe(0);
    expect(s.outcome!.savedPct).toBeGreaterThanOrEqual(50);
    expect(s.killed).toBeGreaterThan(0);
  });

  it('artillery refuses a target when people would be in the blast', () => {
    const b = new Battle({ ...setup([{ kind: 'artillery', x: 50, y: 50 }]), zombies: 0, survivors: 200 });
    const gun = b.n - 1;
    // a lone zombie standing inside the crowd of survivors
    b.spawn(0, b.x[0]!, b.y[0]!);
    b.step(); // builds the spatial hash and zombie list
    const pick = (b as unknown as { pickCluster: (i: number, a: number, c: number, r: number) => unknown }).pickCluster.bind(b);
    expect(pick(gun, 150, 3000, 26)).toBeNull();
    // the same zombie alone in an empty field is a valid target... once it has company
    for (let k = 0; k < 4; k++) b.spawn(0, 560, 560 + k);
    b.step();
    expect(pick(gun, 150, 3000, 26)).not.toBeNull();
  });
});

describe('safe zones', () => {
  const ring: [number, number][] = [[260, 260], [340, 260], [340, 340], [260, 340]];

  it('survivors flock inside through the gate; zombies cannot use it', { timeout: 60_000 }, () => {
    const b = new Battle({ seed: 5, world: world(), placements: [], survivors: 120, zombies: 0, ammo: 0, endless: true, zones: [{ ring, gates: [[300, 260]] }] });
    for (let t = 0; t < 3000; t++) b.step();
    let inside = 0;
    for (let i = 0; i < b.n; i++) if (b.alive[i] && b.kind[i] === 1 && b.x[i]! > 260 && b.x[i]! < 340 && b.y[i]! > 260 && b.y[i]! < 340) inside++;
    expect(inside / b.count(1)).toBeGreaterThan(0.8);
    // a zombie right at the gate stays outside (the gate is shut to it)
    const z = b.spawn(0, 300, 252);
    for (let t = 0; t < 30; t++) b.step();
    expect(b.y[z]!).toBeLessThan(259);
  });

  it('a mass of zombies breaches the wall', { timeout: 60_000 }, () => {
    const b = new Battle({ seed: 2, world: world(), placements: [], survivors: 0, zombies: 0, ammo: 0, endless: true, zones: [{ ring, gates: [] }] });
    // people inside to draw them, a horde outside the west wall
    for (let k = 0; k < 20; k++) b.spawn(1, 300 + (k % 5) * 3, 300 + Math.floor(k / 5) * 3);
    for (let k = 0; k < 40; k++) b.spawn(0, 240 + (k % 4) * 2, 280 + Math.floor(k / 4) * 4);
    for (let t = 0; t < 6000 && !b.breaches; t++) b.step();
    expect(b.breaches).toBeGreaterThan(0);
  });

  it('wall through a building is free', () => {
    const w = world();
    // a building block across part of the north wall line
    for (let c = 70; c < 80; c++) w.grid[Math.floor((600 - 340) / 4) * w.width + c] = 3;
    const plain = wallCells(world(), ring), built = wallCells(w, ring);
    expect(built.freeMeters).toBeGreaterThan(0);
    expect(built.paidMeters).toBeLessThan(plain.paidMeters);
  });
});

describe('drone teams', () => {
  it('launch FPV kamikaze drones that kill zombies', { timeout: 60_000 }, () => {
    const b = new Battle({ seed: 4, world: world(), placements: [{ kind: 'drone', x: 100, y: 100 }], survivors: 0, zombies: 0, ammo: 0, endless: true });
    for (let k = 0; k < 12; k++) b.spawn(0, 400 + (k % 4) * 2, 400 + Math.floor(k / 4) * 2); // a pack 400 m away
    for (let t = 0; t < 300; t++) b.step();
    expect(b.killed).toBeGreaterThan(3);
  });
});

describe('unit speeds', () => {
  it('zombies are faster than every human on the ground', async () => {
    const UNITS = (await import('../src/config/units.json')).default as { units: Record<string, Record<string, unknown>> };
    const z = UNITS.units.zombie!;
    const slowestZombie = Math.min(z.speed as number, z.chaseSpeed as number);
    for (const [k, u] of Object.entries(UNITS.units)) {
      if (k === 'zombie' || u.flies) continue;
      const fastest = Math.max(u.speed as number, (u.travelSpeed as number) ?? 0, ((u.radio as { driveSpeed?: number })?.driveSpeed) ?? 0);
      expect(fastest, k).toBeLessThan(slowestZombie);
    }
  });
});
