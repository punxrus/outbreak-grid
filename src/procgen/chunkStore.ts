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
  private readonly workers: { w: Worker; busy: number; jobs: Set<string>; dead: boolean }[] = [];
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cache = new Map<string, WireChunk>(); // insertion order = LRU
  private readonly inflight = new Set<string>();
  private readonly failed = new Set<string>(); // never retried in this session
  private wanted: [number, number][] = [];
  private version = 0;
  ready = false;
  lastMs: number[] = [];

  // Each worker decodes its own copy of the state geometry (~300 MB), so keep the pool small.
  constructor(state: string, private readonly onChange: (version: number) => void, workers = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))) {
    let readyCount = 0;
    for (let i = 0; i < workers; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const slot = { w, busy: 0, jobs: new Set<string>(), dead: false };
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        const m = e.data;
        if (m.type === 'ready') {
          if (++readyCount === 1) console.info(`[procgen] worker ready in ${m.ms} ms (${workers} workers)`);
          this.ready = true;
          this.pump();
        } else if (m.type === 'chunk') {
          slot.busy--;
          const key = chunkKey(m.cx, m.cy);
          slot.jobs.delete(key);
          this.inflight.delete(key);
          this.cache.set(key, m.wire);
          this.lastMs = [...this.lastMs.slice(-49), m.wire.stats.ms];
          while (this.cache.size > PROCGEN.maxCachedChunks) this.cache.delete(this.cache.keys().next().value!);
          this.bump();
          this.pump();
        } else {
          slot.busy = Math.max(0, slot.busy - 1);
          const errKey = /chunk (-?\d+),(-?\d+)/.exec(m.message);
          if (errKey) { const k = chunkKey(+errKey[1]!, +errKey[2]!); slot.jobs.delete(k); this.inflight.delete(k); this.failed.add(k); }
          console.error('[procgen]', m.message);
          this.pump();
        }
      };
      w.onerror = (e) => {
        // A crashed worker must not leave its chunks "in flight" forever.
        console.error('[procgen] worker failed:', e.message || e);
        slot.dead = true;
        for (const k of slot.jobs) this.inflight.delete(k);
        slot.jobs.clear();
        slot.busy = 0;
        this.pump();
      };
      w.postMessage({ type: 'init', state, seed: PROCGEN.seed } satisfies WorkerIn);
      this.workers.push(slot);
    }
  }

  /** Set the view; returns false when the view is too large to generate. */
  setView(rect: [number, number, number, number]): boolean {
    const x0 = Math.floor(rect[0] / C), x1 = Math.floor(rect[2] / C), y0 = Math.floor(rect[1] / C), y1 = Math.floor(rect[3] / C);
    const n = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (n > PROCGEN.maxVisibleChunks) {
      if (this.wanted.length) { this.wanted = []; this.bump(); }
      return false;
    }
    const mx = (rect[0] + rect[2]) / 2 / C, my = (rect[1] + rect[3]) / 2 / C;
    const list: [number, number][] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) list.push([x, y]);
    list.sort((a, b) => (a[0] + 0.5 - mx) ** 2 + (a[1] + 0.5 - my) ** 2 - ((b[0] + 0.5 - mx) ** 2 + (b[1] + 0.5 - my) ** 2));
    const before = this.visibleKey();
    this.wanted = list;
    for (const [x, y] of list) { // refresh LRU position of visible chunks
      const k = chunkKey(x, y), c = this.cache.get(k);
      if (c) { this.cache.delete(k); this.cache.set(k, c); }
    }
    if (this.visibleKey() !== before) this.bump(); // cached chunks came into view
    this.pump();
    return true;
  }

  visible(): WireChunk[] {
    const out: WireChunk[] = [];
    for (const [x, y] of this.wanted) { const c = this.cache.get(chunkKey(x, y)); if (c) out.push(c); }
    return out;
  }

  pending(): number {
    return this.wanted.filter(([x, y]) => { const k = chunkKey(x, y); return !this.cache.has(k) && !this.failed.has(k); }).length;
  }

  dispose() {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    for (const s of this.workers) s.w.terminate();
  }

  /** Coalesce chunk arrivals: at most one React update per ~120 ms. */
  private bump() {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => { this.notifyTimer = null; this.onChange(++this.version); }, 120);
  }

  /** Changes only when the set of drawable chunks changes (not on every pan). */
  visibleKey(): string {
    return this.visible().map((c) => c.key).join(';');
  }

  private pump() {
    if (!this.ready) return;
    for (const [x, y] of this.wanted) {
      const k = chunkKey(x, y);
      if (this.cache.has(k) || this.inflight.has(k) || this.failed.has(k)) continue;
      const live = this.workers.filter((w) => !w.dead);
      if (!live.length) return;
      const slot = live.reduce((a, b) => (b.busy < a.busy ? b : a));
      if (slot.busy >= 2) return; // keep a short queue per worker so view changes re-prioritize
      slot.busy++;
      slot.jobs.add(k);
      this.inflight.add(k);
      slot.w.postMessage({ type: 'gen', cx: x, cy: y } satisfies WorkerIn);
    }
  }
}
