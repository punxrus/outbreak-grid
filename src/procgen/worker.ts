/// <reference lib="webworker" />
import PROCGEN from '../config/procgen.json';
import { RegionPack } from '../geo/pack';
import { generateChunk } from './chunk';
import { GeoContext } from './context';
import type { RegionMask } from '../campaign/region';
import { chunkWire, wireTransferables } from './wire';

export type WorkerIn =
  | { type: 'init'; state: string; seed: number }
  | { type: 'region'; mask: RegionMask | null; rv: number }
  | { type: 'gen'; cx: number; cy: number; rv: number };
export type WorkerOut =
  | { type: 'ready'; ms: number }
  | { type: 'chunk'; cx: number; cy: number; rv: number; wire: ReturnType<typeof chunkWire> }
  | { type: 'error'; message: string };

let ctx: GeoContext | null = null;
let region: RegionMask | null = null;
const queue: WorkerIn[] = [];
const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      const t0 = performance.now();
      const pack = await RegionPack.load(msg.state);
      const [tactical, density] = await Promise.all([pack.tactical(), pack.fineDensity()]);
      ctx = GeoContext.fromTactical(tactical, density, msg.seed, pack.manifest.streamWidthMeters, PROCGEN.arterials.islandMaxAreaKm2 * 1e6, pack.places);
      post({ type: 'ready', ms: Math.round(performance.now() - t0) });
      for (const q of queue.splice(0)) run(q);
    } catch (err) {
      post({ type: 'error', message: (err as Error).message });
    }
    return;
  }
  if (msg.type === 'region') { region = msg.mask; return; } // ordered before later 'gen' messages
  if (!ctx) queue.push(msg);
  else run(msg);
};

function run(msg: WorkerIn) {
  if (msg.type !== 'gen' || !ctx) return;
  try {
    const c = generateChunk(ctx, msg.cx, msg.cy);
    const wire = chunkWire(c, region);
    post({ type: 'chunk', cx: msg.cx, cy: msg.cy, rv: msg.rv, wire }, wireTransferables(wire));
  } catch (err) {
    post({ type: 'error', message: `chunk ${msg.cx},${msg.cy}: ${(err as Error).message}` });
  }
}
