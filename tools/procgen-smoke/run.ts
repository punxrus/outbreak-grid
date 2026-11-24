import { chunkHash, chunkOf, generateChunk } from '../../src/procgen/chunk';
import { loadContext } from './load';

const t0 = performance.now();
const { ctx } = loadContext();
console.log(`context ${Math.round(performance.now() - t0)} ms`);
const spots: Record<string, [number, number]> = {
  seattle: [-133487, 25100], bellevue: [-118871, 22392], kent: [-123592, -852], rural: [-60000, 20000],
};
for (const [name, [x, y]] of Object.entries(spots)) {
  const [cx, cy] = chunkOf(x, y);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const c = generateChunk(ctx, cx + dx, cy + dy);
    if (dx === 0 && dy === 0 || process.argv.includes('-v')) console.log(name, c.key, JSON.stringify(c.stats), 'parks', c.parks.length, 'landmarks', c.landmarks.map(l => l.type).join(','), 'types', [...new Set(c.districts.map(d => d.type))].join(','), chunkHash(c));
  }
}
