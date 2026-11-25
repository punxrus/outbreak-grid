// Run a battle on a real generated region in Node: npx tsx tools/procgen-smoke/battle.ts forks [zombies]
import { buildRegion, stageById } from '../../src/campaign/region';
import { generateChunk } from '../../src/procgen/chunk';
import { chunkWire } from '../../src/procgen/wire';
import { Battle } from '../../src/sim/engine';
import { assembleWorld } from '../../src/sim/world';
import type { Placement } from '../../src/sim/types';
import { loadContext } from './load';

const stage = stageById(process.argv[2] ?? 'forks');
const { ctx, tactical } = loadContext();
const region = buildRegion(stage, tactical)!;
const t0 = performance.now();
const chunks = region.chunks.map(([cx, cy]) => chunkWire(generateChunk(ctx, cx, cy, region.forced), region.mask));
const world = assembleWorld(region, chunks);
const counts = [0, 0, 0, 0];
for (const v of world.grid) counts[v]!++;
console.log(`${stage.label}: ${chunks.length} chunks in ${Math.round(performance.now() - t0)} ms; cells water/open/road/blocked`, counts, 'homes', world.homes.length / 2, 'police', world.police.length);
const placements: Placement[] = JSON.parse(process.env.PLACE ?? '[]');
const b = new Battle({ seed: 1, world, placements, survivors: 417, zombies: Number(process.argv[3] ?? 25), ammo: 2000 });
const start = { x: Float32Array.from(b.x.subarray(0, b.n)), y: Float32Array.from(b.y.subarray(0, b.n)) };
for (let t = 0; t <= 12000 && !b.outcome; t++) {
  b.step();
  if (t % 1500 === 0) {
    let moved = 0, zs = 0;
    for (let i = 0; i < Math.min(b.n, start.x.length); i++) if (b.alive[i] && b.kind[i] === 0) { zs++; if (Math.hypot(b.x[i]! - start.x[i]!, b.y[i]! - start.y[i]!) > 30) moved++; }
    const s = b.stats();
    console.log(`field ${b.fieldMs.toFixed(1)} ms · ${Math.round(s.time)}s zombies ${s.zombies} survivors ${s.survivors} forces ${s.defenders} kills ${s.killed} | original zombies that moved >30 m: ${moved}/${zs}`);
  }
}
console.log(b.stats().outcome);
