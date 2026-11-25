import { useCallback, useEffect, useRef, useState } from 'react';
import type { Flash, Frame } from '../render/battleLayers';
import type { BattleSetup, BattleStats } from './types';
import type { SimIn, SimOut } from './worker';

/** Runs one battle at a time in a worker and exposes its latest frame. */
export function useBattle() {
  const worker = useRef<Worker | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [stats, setStats] = useState<BattleStats | null>(null);
  const [flashes, setFlashes] = useState<Flash[]>([]);
  const [speed, setSpeedState] = useState(1);

  useEffect(() => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<SimOut>) => {
      const m = e.data;
      setFrame({ positions: m.positions, colors: m.colors, count: m.count });
      setStats(m.stats);
      const now = performance.now();
      setFlashes((old) => {
        const fresh: Flash[] = [];
        for (let i = 0; i < m.blasts.length; i += 3) fresh.push({ x: m.blasts[i]!, y: m.blasts[i + 1]!, r: m.blasts[i + 2]!, t: now });
        const kept = old.filter((f) => now - f.t < 700);
        return fresh.length || kept.length !== old.length ? [...kept, ...fresh] : old;
      });
    };
    worker.current = w;
    return () => { w.terminate(); worker.current = null; };
  }, []);

  const post = (m: SimIn) => worker.current?.postMessage(m);
  const start = useCallback((setup: BattleSetup) => { setFlashes([]); post({ type: 'speed', speed }); post({ type: 'start', setup }); }, [speed]);
  const stop = useCallback(() => { post({ type: 'stop' }); setFrame(null); setStats(null); setFlashes([]); }, []);
  const setSpeed = useCallback((s: number) => { setSpeedState(s); post({ type: 'speed', speed: s }); }, []);
  return { frame, stats, flashes, speed, start, stop, setSpeed };
}
