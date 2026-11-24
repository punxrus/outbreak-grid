import PROCGEN from '../config/procgen.json';
import { chunkKey } from './chunk';
import type { WireChunk } from './wire';
import type { WorkerIn, WorkerOut } from './worker';

const C = PROCGEN.chunkSize;

/**
 * Streams generated chunks for the current view. Generation runs in a small
 * worker pool; each worker builds its own GeoContext from the pack. Chunks are
 * pure functions of (seed, cx, cy), so a cache miss just regenerates.
 */
export class ChunkStore {
  private readonly workers: { w: Worker; busy: number }[] = [];
  private readonly cache = new Map<string, WireChunk>(); // insertion order = LRU
  private readonly inflight = new Set<string>();
  private wanted: [number, number][] = [];
  private version = 0;
  ready = false;
  lastMs: number[] = [];

  constructor(state: string, private readonly onChange: (version: number) => void, workers = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 2))) {
    let readyCount = 0;
    for (let i = 0; i < workers; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const slot = { w, busy: 0 };
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        const m = e.data;
        if (m.type === 'ready') {
          if (++readyCount === 1) console.info(`[procgen] worker ready in ${m.ms} ms (${workers} workers)`);
          this.ready = true;
          this.pump();
        } else if (m.type === 'chunk') {
          slot.busy--;
          const key = chunkKey(m.cx, m.cy);
          this.inflight.delete(key);
          this.cache.set(key, m.wire);
          this.lastMs = [...this.lastMs.slice(-49), m.wire.stats.ms];
          while (this.cache.size > PROCGEN.maxCachedChunks) this.cache.delete(this.cache.keys().next().value!);
          this.bump();
          this.pump();
        } else {
          slot.busy = Math.max(0, slot.busy - 1);
          console.error('[procgen]', m.message);
          this.pump();
        }
      };
      w.onerror = (e) => console.error('[procgen] worker failed:', e.message || e);
      w.postMessage({ type: 'init', state, seed: PROCGEN.seed } satisfies WorkerIn);
      this.workers.push(slot);
    }
  }

  /** Set the view; returns false when the view is too large to generate. */
  setView(rect: [number, number, number, number]): boolean {
    const x0 = Math.floor(rect[0] / C), x1 = Math.floor(rect[2] / C), y0 = Math.floor(rect[1] / C), y1 = Math.floor(rect[3] / C);
    const n = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (n > PROCGEN.maxVisibleChunks) { this.wanted = []; return false; }
    const mx = (rect[0] + rect[2]) / 2 / C, my = (rect[1] + rect[3]) / 2 / C;
    const list: [number, number][] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) list.push([x, y]);
    list.sort((a, b) => (a[0] + 0.5 - mx) ** 2 + (a[1] + 0.5 - my) ** 2 - ((b[0] + 0.5 - mx) ** 2 + (b[1] + 0.5 - my) ** 2));
    this.wanted = list;
    for (const [x, y] of list) { // refresh LRU position of visible chunks
      const k = chunkKey(x, y), c = this.cache.get(k);
      if (c) { this.cache.delete(k); this.cache.set(k, c); }
    }
    this.pump();
    return true;
  }

  visible(): WireChunk[] {
    const out: WireChunk[] = [];
    for (const [x, y] of this.wanted) { const c = this.cache.get(chunkKey(x, y)); if (c) out.push(c); }
    return out;
  }

  pending(): number {
    return this.wanted.filter(([x, y]) => !this.cache.has(chunkKey(x, y))).length;
  }

  dispose() { for (const s of this.workers) s.w.terminate(); }

  private bump() { this.onChange(++this.version); }

  private pump() {
    if (!this.ready) return;
    for (const [x, y] of this.wanted) {
      const k = chunkKey(x, y);
      if (this.cache.has(k) || this.inflight.has(k)) continue;
      const slot = this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
      if (slot.busy >= 2) return; // keep a short queue per worker so view changes re-prioritize
      slot.busy++;
      this.inflight.add(k);
      slot.w.postMessage({ type: 'gen', cx: x, cy: y } satisfies WorkerIn);
    }
  }
}
