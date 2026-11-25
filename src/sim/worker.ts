/// <reference lib="webworker" />
import UNITS from '../config/units.json';
import { Battle } from './engine';
import type { BattleSetup, BattleStats } from './types';

export type SimIn =
  | { type: 'start'; setup: BattleSetup }
  | { type: 'speed'; speed: number } // 0 = paused
  | { type: 'stop' };

export type SimOut = {
  type: 'frame'; positions: Float32Array; colors: Uint8Array; count: number; blasts: number[]; stats: BattleStats;
  /** Shots this frame: x1, y1, x2, y2, shooter kind index. */
  shots: number[];
  /** Wall cells: x, y, hp 0..1, gate flag. */
  walls: Float32Array;
};

const FRAME_MS = 66;
let battle: Battle | null = null;
let speed = 1;
let carry = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const post = (m: SimOut, t: Transferable[]) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, t);

self.onmessage = (e: MessageEvent<SimIn>) => {
  const m = e.data;
  if (m.type === 'start') {
    battle = new Battle(m.setup);
    carry = 0;
    if (!timer) timer = setInterval(frame, FRAME_MS);
    frame();
  } else if (m.type === 'speed') speed = m.speed;
  else if (m.type === 'stop') { battle = null; if (timer) clearInterval(timer); timer = null; }
};

function frame() {
  if (!battle) return;
  // advance sim time by wall time x speed, in fixed ticks
  carry += (FRAME_MS / 1000) * speed;
  const blasts: number[] = [], shots: number[] = [];
  let guard = 0;
  while (carry >= UNITS.tick && !battle.outcome && guard++ < 200) {
    battle.step();
    blasts.push(...battle.blasts);
    // at high speed a frame covers many ticks: keep the most recent shots only
    for (let k = 0; k < battle.shots.length && shots.length < 2500; k++) shots.push(battle.shots[k]!);
    carry -= UNITS.tick;
  }
  if (battle.outcome) carry = 0;
  const snap = battle.snapshot();
  const walls = battle.wallState();
  post({ type: 'frame', ...snap, blasts, shots, walls, stats: battle.stats() }, [snap.positions.buffer, snap.colors.buffer, walls.buffer]);
}
