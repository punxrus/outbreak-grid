import { describe, expect, it } from 'vitest';
import { Battle } from '../src/sim/engine';
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
