import CAMPAIGN from '../config/campaign.json';
import PROCGEN from '../config/procgen.json';
import type { Region } from '../campaign/region';
import { assembleWorld } from '../sim/world';
import type { BattleWorld } from '../sim/types';
import { chunkKey } from './chunk';
import type { WireChunk } from './wire';
import type { WorkerIn, WorkerOut } from './worker';

const C = PROCGEN.chunkSize;

type Slot = { w: Worker; busy: number; jobs: Set<string>; dead: boolean };

/**
 * Generated chunks for the active region. Small regions (a town or city) are
 * generated whole, nearest the center first, and kept. Large regions (a
 * county) stream: only chunks in view, limited to the region. Generation runs
 * in a small worker pool; each worker builds its own GeoContext from the pack.
 */
export class ChunkStore {
  private readonly workers: Slot[] = [];
  private readonly cache = new Map<string, WireChunk>(); // insertion order = LRU
  private readonly inflight = new Set<string>();
  private readonly failed = new Set<string>(); // never retried in this region
  private regionSet = new Set<string>();
  private regionChunks: [number, number][] = [];
  private pregen = false;
  private rv = 0; // region version: results from an older region are dropped
  private wanted: [number, number][] = [];
  private version = 0;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  ready = false;

  // Each worker decodes its own copy of the state geometry, so keep the pool small.
  constructor(state: string, private readonly onChange: (version: number) => void, workers = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))) {
    let readyCount = 0;
    for (let i = 0; i < workers; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = { w, busy: 0, jobs: new Set(), dead: false };
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        const m = e.data;
        if (m.type === 'ready') {
          if (++readyCount === 1) console.info(`[procgen] worker ready in ${m.ms} ms (${workers} workers)`);
          this.ready = true;
          this.pump();
        } else if (m.type === 'chunk') {
          slot.busy = Math.max(0, slot.busy - 1);
          const key = chunkKey(m.cx, m.cy);
          slot.jobs.delete(key);
          if (m.rv === this.rv) {
            this.inflight.delete(key);
            this.cache.set(key, m.wire);
            this.trim();
            this.bump();
          }
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

  /** Switch the active region. Drops everything generated for the previous one. */
  setRegion(region: Region | null) {
    this.rv++;
    this.cache.clear();
    this.inflight.clear();
    this.failed.clear();
    for (const s of this.workers) { s.jobs.clear(); s.w.postMessage({ type: 'region', mask: region?.mask ?? null, forced: region?.forced ?? [], rv: this.rv } satisfies WorkerIn); }
    this.regionChunks = region?.chunks ?? [];
    this.regionSet = new Set(this.regionChunks.map(([x, y]) => chunkKey(x, y)));
    this.pregen = this.regionChunks.length > 0 && this.regionChunks.length <= CAMPAIGN.pregenMaxChunks;
    this.wanted = this.pregen ? this.regionChunks : [];
    this.bump();
    this.pump();
  }

  /** True when the whole region is generated up front (no view streaming). */
  get pregenerated() { return this.pregen; }

  /**
   * View change. Only matters for streamed (large) regions; returns false when
   * the view covers too many chunks to generate.
   */
  setView(rect: [number, number, number, number]): boolean {
    if (this.pregen) return true;
    const x0 = Math.floor(rect[0] / C), x1 = Math.floor(rect[2] / C), y0 = Math.floor(rect[1] / C), y1 = Math.floor(rect[3] / C);
    const before = this.visibleKey();
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > PROCGEN.maxVisibleChunks) {
      if (this.wanted.length) { this.wanted = []; this.bump(); }
      return false;
    }
    const mx = (rect[0] + rect[2]) / 2 / C, my = (rect[1] + rect[3]) / 2 / C;
    const list: [number, number][] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (this.regionSet.has(chunkKey(x, y))) list.push([x, y]);
    list.sort((a, b) => (a[0] + 0.5 - mx) ** 2 + (a[1] + 0.5 - my) ** 2 - ((b[0] + 0.5 - mx) ** 2 + (b[1] + 0.5 - my) ** 2));
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

  /** Changes only when the set of drawable chunks changes (not on every pan). */
  visibleKey(): string {
    return `${this.rv}|` + this.visible().map((c) => c.key).join(';');
  }

  progress(): { done: number; total: number } {
    let done = 0;
    for (const [x, y] of this.wanted) { const k = chunkKey(x, y); if (this.cache.has(k) || this.failed.has(k)) done++; }
    return { done, total: this.wanted.length };
  }

  /**
   * The region's walk grid as one raster (4 m cells, row 0 = north), with
   * everything outside the region marked as water so the battle stays inside.
   * Only for pre-generated regions, once every chunk is in.
   */
  world(region: Region): BattleWorld | null {
    if (!this.pregen) return null;
    const chunks = this.regionChunks.map(([x, y]) => this.cache.get(chunkKey(x, y)));
    if (chunks.some((c) => !c)) return null;
    return assembleWorld(region, chunks as WireChunk[]);
  }

  dispose() {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    for (const s of this.workers) s.w.terminate();
  }

  private trim() {
    const cap = Math.max(PROCGEN.maxCachedChunks, this.pregen ? this.regionChunks.length : 0);
    while (this.cache.size > cap) this.cache.delete(this.cache.keys().next().value!);
  }

  /** Coalesce updates: at most one React update per ~120 ms. */
  private bump() {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => { this.notifyTimer = null; this.onChange(++this.version); }, 120);
  }

  private pump() {
    if (!this.ready) return;
    for (const [x, y] of this.wanted) {
      const k = chunkKey(x, y);
      if (this.cache.has(k) || this.inflight.has(k) || this.failed.has(k)) continue;
      const live = this.workers.filter((w) => !w.dead);
      if (!live.length) return;
      const slot = live.reduce((a, b) => (b.busy < a.busy ? b : a));
      // Streaming: short queue per worker so view changes re-prioritize.
      // Pre-generation: queue everything, so workers never wait on a busy main thread.
      if (!this.pregen && slot.busy >= 2) return;
      slot.busy++;
      slot.jobs.add(k);
      this.inflight.add(k);
      slot.w.postMessage({ type: 'gen', cx: x, cy: y, rv: this.rv } satisfies WorkerIn);
    }
  }
}
