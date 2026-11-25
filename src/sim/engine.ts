import UNITS from '../config/units.json';
import type { BattleSetup, BattleStats, BattleWorld, Placement, UnitKind } from './types';
import { gateCells, wallCells, zoneCells } from './walls';

export const KINDS: UnitKind[] = ['zombie', 'survivor', 'militia', 'police', 'hunter', 'paratrooper', 'eod', 'mortar', 'artillery', 'drone', 'fpv', 'helicopter'];
const Z = 0, S = 1;
const idx = (k: UnitKind) => KINDS.indexOf(k);

interface Spec {
  hp: number; speed: number; chaseSpeed?: number; sight?: number; smell?: number; reach?: number; scentSpeedFactor?: number; melee?: number; range?: number; minRange?: number; damage?: number;
  cooldown?: number; accuracy?: number; dots?: number; blast?: number; charges?: number; flies?: boolean;
  leash?: number; orbit?: number; endurance?: number; hunt?: number; roams?: boolean; ranges?: boolean; travelSpeed?: number; patrol?: number; ownAmmo?: boolean; radio?: { delay: number; driveSpeed: number }; cost?: Record<string, number>; fpv?: { stock: number; every: number; range: number }; color: string;
}
const SPEC: Spec[] = KINDS.map((k) => (UNITS.units as Record<string, Spec>)[k]!);
const RGB = SPEC.map((s) => [parseInt(s.color.slice(1, 3), 16), parseInt(s.color.slice(3, 5), 16), parseInt(s.color.slice(5, 7), 16)]);
const DT = UNITS.tick;
const MAX_TIME = 60 * 60; // stalemate guard only: a battle still running after an hour is scored where it stands
const HASH = 24; // spatial hash cell (m)
const FCELL = 4; // flow-field cell (m): the walk grid itself, so every route it shows is walkable
const FIELD_EVERY = 20; // ticks between flow-field rebuilds (2 s)
const FAR = 0xffff;
const MAX_HUNT = 600; // longest squad hunt leash (m): bounds the zombie-field search
const SEP_R = 12; // zombie separation radius (m): packs fan out along their front
const T_ZOMBIE = 0, T_SURVIVOR = 1, T_GUARD = 2;
const teamOf = (k: number) => (k === 0 ? T_ZOMBIE : k === 1 ? T_SURVIVOR : T_GUARD);

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The auto-battle. Fixed timestep, typed arrays, deterministic for a given
 * setup: the same placements and seed always play out the same way.
 */
export class Battle {
  n = 0;
  x: Float32Array; y: Float32Array; hp: Float32Array; cool: Float32Array; life: Float32Array;
  ax: Float32Array; ay: Float32Array; hx: Float32Array; hy: Float32Array;
  kind: Uint8Array; alive: Uint8Array; charges: Uint8Array;
  /** Rounds each person carries: a squad's issued ammo split among its people. */
  ammoOf: Float32Array;
  /** Time of the first infection: police hear it on the radio. */
  firstBite = -1;
  time = 0; ammo: number; killed = 0; survivorsStart = 0;
  /** Explosions this tick (x, y, radius), for the renderer. */
  blasts: number[] = [];
  outcome: BattleStats['outcome'] = null;
  private readonly rand: () => number;
  private readonly w: BattleWorld;
  // One spatial hash per team, so a search only walks the team it is looking for.
  private hashes: { head: Int32Array; next: Int32Array }[];
  private hw: number; private hh: number;
  private stationSpawned: number[]; private nextPolice: number;
  // Flow field: walking distance (in 8 m cells) from every cell to the nearest person.
  private fw: number; private fh: number; private fwalk: Uint8Array; private dist: Uint16Array; private queue: Int32Array;
  /** Second field: walking distance to the nearest zombie (squads hunt along it). */
  private zdist: Uint16Array;
  /** Third field: walking distance to the safe zone (survivors head for it). */
  private sdist: Uint16Array | null = null;
  // Walls: hit points per cell (0 = no wall / breached), gates open for people only.
  private wallHp: Float32Array; private gate: Uint8Array; private wallList: number[] = [];
  private zoneMask: Uint8Array | null = null;
  /** Passability for zombie pathing (walls count: zombies route to them) and for people (gates open, walls closed). */
  private zpass: Uint8Array; private hpass: Uint8Array;
  /** Drone-team launch points: each holds a stock of FPV kamikaze drones. */
  private launchers: { x: number; y: number; left: number; next: number }[] = [];
  /** Shots fired this tick (x1, y1, x2, y2, shooter kind), for tracers. */
  shots: number[] = [];
  private ticks = 0;
  private readonly endless: boolean;

  constructor(setup: BattleSetup, cap = 0) {
    this.w = setup.world;
    this.endless = !!setup.endless;
    this.rand = rng(setup.seed);
    this.ammo = setup.ammo; // the reserve
    const dots = setup.placements.reduce((a, p) => a + (SPEC[idx(p.kind)]!.dots ?? 1), 0);
    cap = Math.max(cap, setup.survivors + setup.zombies + dots + setup.world.police.length * UNITS.policeStation.max + 16);
    this.x = new Float32Array(cap); this.y = new Float32Array(cap); this.hp = new Float32Array(cap);
    this.cool = new Float32Array(cap); this.life = new Float32Array(cap);
    this.ax = new Float32Array(cap); this.ay = new Float32Array(cap); this.hx = new Float32Array(cap); this.hy = new Float32Array(cap);
    this.kind = new Uint8Array(cap); this.alive = new Uint8Array(cap); this.charges = new Uint8Array(cap);
    this.ammoOf = new Float32Array(cap);
    this.hw = Math.ceil((setup.world.width * setup.world.cell) / HASH);
    this.hh = Math.ceil((setup.world.height * setup.world.cell) / HASH);
    this.hashes = [0, 1, 2].map(() => ({ head: new Int32Array(this.hw * this.hh), next: new Int32Array(cap) }));
    this.stationSpawned = setup.world.police.map(() => 0);
    this.fw = Math.ceil((setup.world.width * setup.world.cell) / FCELL);
    this.fh = Math.ceil((setup.world.height * setup.world.cell) / FCELL);
    this.fwalk = new Uint8Array(this.fw * this.fh);
    this.dist = new Uint16Array(this.fw * this.fh).fill(FAR);
    this.zdist = new Uint16Array(this.fw * this.fh).fill(FAR);
    this.wallHp = new Float32Array(this.fw * this.fh);
    this.gate = new Uint8Array(this.fw * this.fh);
    this.queue = new Int32Array(this.fw * this.fh);
    const k = FCELL / setup.world.cell;
    for (let r = 0; r < setup.world.height; r++) for (let c = 0; c < setup.world.width; c++) {
      const v = setup.world.grid[r * setup.world.width + c];
      if (v === 1 || v === 2) this.fwalk[Math.floor(r / k) * this.fw + Math.floor(c / k)] = 1;
    }
    // Safe zones: wall cells (buildings already block and stand in for wall), gates, interior.
    for (const z of setup.zones ?? []) {
      if (z.ring.length < 3) continue;
      const wall = wallCells(setup.world, z.ring).cells;
      const gates = gateCells(setup.world, wall, z.gates);
      for (const c of wall) { this.wallHp[c] = UNITS.walls.hp; if (gates.has(c)) this.gate[c] = 1; this.wallList.push(c); }
      const inside = zoneCells(setup.world, z.ring);
      if (!this.zoneMask) this.zoneMask = inside;
      else { const zm = this.zoneMask; for (let i = 0; i < inside.length; i++) zm[i] = zm[i]! | inside[i]!; }
    }
    this.zpass = this.fwalk.slice();
    this.hpass = this.fwalk.slice();
    for (const c of this.wallList) { this.zpass[c] = 1; if (!this.gate[c]) this.hpass[c] = 0; }
    if (this.zoneMask) {
      this.sdist = new Uint16Array(this.fw * this.fh).fill(FAR);
      this.bfsFrom(this.sdist, this.hpass, FAR - 1, (push) => { for (let c = 0; c < this.zoneMask!.length; c++) if (this.zoneMask![c] && this.hpass[c]) push(c); });
    }
    this.nextPolice = UNITS.policeStation.every;

    // Survivors at homes, zombies at one outbreak point, then the player's squads.
    const homes = setup.world.homes;
    const nh = homes.length / 2;
    // Most people live in town, not out on the farms: of three random homes,
    // a survivor starts at the one with the most neighbors (100 m buckets).
    const B = 100, bucketCount = new Map<number, number>();
    const bkey = (x: number, y: number) => Math.floor(x / B) * 100003 + Math.floor(y / B);
    for (let j = 0; j < nh; j++) { const k = bkey(homes[2 * j]!, homes[2 * j + 1]!); bucketCount.set(k, (bucketCount.get(k) ?? 0) + 1); }
    for (let i = 0; i < setup.survivors && nh > 0; i++) {
      let h = 0, best = -1;
      for (let t = 0; t < 3; t++) {
        const c = Math.floor(this.rand() * nh), n = bucketCount.get(bkey(homes[2 * c]!, homes[2 * c + 1]!)) ?? 0;
        if (n > best) { best = n; h = c; }
      }
      const p = this.walkableNear(homes[2 * h]!, homes[2 * h + 1]!);
      if (p) this.spawn(S, p[0], p[1]);
    }
    this.survivorsStart = this.count(S);
    if (nh > 0 && setup.zombies > 0) {
      // Ground zero: of a few random homes, the one with the most neighbors
      // within 150 m (an outbreak starts where people are packed together).
      let h = 0, bestN = -1;
      for (let t = 0; t < 24; t++) {
        const c = Math.floor(this.rand() * nh);
        let nn = 0;
        for (let j = 0; j < nh; j += 3) if (Math.abs(homes[2 * j]! - homes[2 * c]!) < 150 && Math.abs(homes[2 * j + 1]! - homes[2 * c + 1]!) < 150) nn++;
        if (nn > bestN) { bestN = nn; h = c; }
      }
      const ox = homes[2 * h]!, oy = homes[2 * h + 1]!;
      // the first infected are scattered across nearby homes, not one blob
      const near: number[] = [];
      for (let j = 0; j < nh; j++) if (Math.hypot(homes[2 * j]! - ox, homes[2 * j + 1]! - oy) < 300) near.push(j);
      for (let i = 0; i < setup.zombies; i++) {
        const j = near.length ? near[Math.floor(this.rand() * near.length)]! : h;
        const p = this.walkableNear(homes[2 * j]!, homes[2 * j + 1]!);
        if (p) this.spawn(Z, p[0], p[1]);
      }
    }
    for (const pl of setup.placements) this.placeSquad(pl);
    // Without a safe zone there is no depot: share the reserve out among the squads now.
    if (!this.zoneMask && this.ammo > 0) {
      const shooters: number[] = [];
      for (let i = 0; i < this.n; i++) if (this.kind[i] !== Z && this.kind[i] !== S && SPEC[this.kind[i]!]!.cost?.ammo) shooters.push(i);
      // capped at 1.5x each person's normal issue, so a reserve can't turn two hunters into an army
      if (shooters.length) {
        const each = this.ammo / shooters.length;
        for (const i of shooters) {
          const sp = SPEC[this.kind[i]!]!, cap = (sp.cost!.ammo! / (sp.dots ?? 1)) * 1.5;
          const add = Math.max(0, Math.min(each, cap - this.ammoOf[i]!));
          this.ammoOf[i]! += add; this.ammo -= add;
        }
      }
    }
  }

  /** Squads: `dots` people in a tight cluster around the placement point. */
  placeSquad(pl: Placement) {
    const k = idx(pl.kind), sp = SPEC[k]!;
    if (sp.fpv) this.launchers.push({ x: pl.x, y: pl.y, left: sp.fpv.stock, next: 3 + this.launchers.length });
    const dots = sp.dots ?? 1, each = (sp.cost?.ammo ?? 0) / dots;
    for (let d = 0; d < dots; d++) {
      const a = (d / dots) * Math.PI * 2, r = d === 0 ? 0 : 4;
      const tx = pl.x + Math.cos(a) * r, ty = pl.y + Math.sin(a) * r;
      const p = sp.flies ? [tx, ty] : this.walkableNear(tx, ty);
      if (p) { const j = this.spawn(k, p[0]!, p[1]!, pl.x, pl.y); if (j >= 0) this.ammoOf[j] = each; }
    }
  }

  /** Double every per-agent array (police, FPV drones and tests spawn mid-battle). */
  private grow() {
    const cap = this.x.length * 2;
    const f32 = (a: Float32Array) => { const b = new Float32Array(cap); b.set(a); return b; };
    const u8 = (a: Uint8Array) => { const b = new Uint8Array(cap); b.set(a); return b; };
    this.x = f32(this.x); this.y = f32(this.y); this.hp = f32(this.hp); this.cool = f32(this.cool); this.life = f32(this.life);
    this.ax = f32(this.ax); this.ay = f32(this.ay); this.hx = f32(this.hx); this.hy = f32(this.hy);
    this.kind = u8(this.kind); this.alive = u8(this.alive); this.charges = u8(this.charges);
    this.ammoOf = f32(this.ammoOf);
    for (const h of this.hashes) { const nx = new Int32Array(cap); nx.set(h.next); h.next = nx; }
  }

  spawn(k: number, x: number, y: number, ax = x, ay = y): number {
    if (this.n >= this.x.length) this.grow();
    const i = this.n++, sp = SPEC[k]!;
    this.x[i] = x; this.y[i] = y; this.ax[i] = ax; this.ay[i] = ay;
    this.hx[i] = this.rand() * 2 - 1; this.hy[i] = this.rand() * 2 - 1;
    this.kind[i] = k; this.alive[i] = 1; this.hp[i] = sp.hp; this.cool[i] = this.rand() * (sp.cooldown ?? 1);
    this.life[i] = sp.endurance ?? Infinity; this.charges[i] = sp.charges ?? 0; this.ammoOf[i] = 0;
    return i;
  }

  count(k: number): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.alive[i] && this.kind[i] === k) c++;
    return c;
  }

  // ---------------- world ----------------
  cellAt(x: number, y: number): number {
    const c = Math.floor((x - this.w.minX) / this.w.cell), r = Math.floor((this.w.maxY - y) / this.w.cell);
    if (c < 0 || r < 0 || c >= this.w.width || r >= this.w.height) return 0;
    return this.w.grid[r * this.w.width + c]!;
  }
  private cellIndex(x: number, y: number): number {
    const c = Math.floor((x - this.w.minX) / this.w.cell), r = Math.floor((this.w.maxY - y) / this.w.cell);
    return c < 0 || r < 0 || c >= this.w.width || r >= this.w.height ? -1 : r * this.w.width + c;
  }
  /** Open ground or road with no standing wall. */
  walkable(x: number, y: number): boolean {
    const c = this.cellIndex(x, y);
    if (c < 0) return false;
    const v = this.w.grid[c];
    return (v === 1 || v === 2) && this.wallHp[c]! <= 0;
  }
  /** People pass gates; zombies do not. */
  private passable(k: number, x: number, y: number): boolean {
    const c = this.cellIndex(x, y);
    if (c < 0) return false;
    const v = this.w.grid[c];
    if (v !== 1 && v !== 2) return false;
    return this.wallHp[c]! <= 0 || (k !== Z && this.gate[c] === 1);
  }
  /** A zombie pressing into a wall cell wears it down; at zero it is a breach. */
  private batter(x: number, y: number) {
    const c = this.cellIndex(x, y);
    if (c < 0 || this.wallHp[c]! <= 0) return;
    this.wallHp[c]! -= UNITS.walls.zombieDamagePerSecond * DT;
    if (this.wallHp[c]! <= 0) { this.wallHp[c] = 0; this.hpass[c] = 1; this.breaches++; }
  }
  breaches = 0;
  private containedSince = -1;
  /** True if an intact wall (or gate) stands between two nearby points: no biting through it. */
  private wallBetween(x1: number, y1: number, x2: number, y2: number): boolean {
    if (!this.wallList.length) return false;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const c = this.cellIndex(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      if (c >= 0 && this.wallHp[c]! > 0) return true;
    }
    return false;
  }
  walkableNear(x: number, y: number): [number, number] | null {
    if (this.walkable(x, y)) return [x, y];
    for (let r = this.w.cell; r <= 40; r += this.w.cell) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2, px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (this.walkable(px, py)) return [px, py];
      }
    }
    return null;
  }
  private move(i: number, dx: number, dy: number) {
    const k = this.kind[i]!;
    if (SPEC[k]!.flies) { this.x[i]! += dx; this.y[i]! += dy; return; }
    const nx = this.x[i]! + dx, ny = this.y[i]! + dy;
    if (this.passable(k, nx, ny)) { this.x[i] = nx; this.y[i] = ny; return; }
    if (k === Z) this.batter(nx, ny);
    if (this.passable(k, nx, this.y[i]!)) { this.x[i] = nx; return; } // slide along walls
    if (this.passable(k, this.x[i]!, ny)) { this.y[i] = ny; return; }
    this.hx[i] = this.rand() * 2 - 1; this.hy[i] = this.rand() * 2 - 1; // stuck: pick a new heading
  }
  private steer(i: number, tx: number, ty: number, speed: number) {
    const dx = tx - this.x[i]!, dy = ty - this.y[i]!, d = Math.hypot(dx, dy);
    if (d < 1e-3) return;
    const s = Math.min(d, speed * DT);
    this.move(i, (dx / d) * s, (dy / d) * s);
  }

  // ---------------- spatial hash ----------------
  private rebuildHash() {
    for (const h of this.hashes) h.head.fill(-1);
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i] || SPEC[this.kind[i]!]!.flies) continue; // flyers can't be touched or blasted
      const b = this.bucket(this.x[i]!, this.y[i]!);
      if (b < 0) continue;
      const h = this.hashes[teamOf(this.kind[i]!)]!;
      h.next[i] = h.head[b]!; h.head[b] = i;
    }
  }
  private bucket(x: number, y: number) {
    const c = Math.floor((x - this.w.minX) / HASH), r = Math.floor((this.w.maxY - y) / HASH);
    return c < 0 || r < 0 || c >= this.hw || r >= this.hh ? -1 : r * this.hw + c;
  }
  /** Nearest live grounded agent of the given teams within `rad`. */
  nearest(x: number, y: number, rad: number, teams: number[]): number {
    let best = -1, bd = rad * rad;
    for (const t of teams) this.forNear(x, y, rad, t, (j, d2) => { if (d2 < bd) { bd = d2; best = j; } });
    return best;
  }
  private forNear(x: number, y: number, rad: number, team: number, fn: (j: number, d2: number) => void) {
    const { head, next } = this.hashes[team]!;
    const c0 = Math.floor((x - rad - this.w.minX) / HASH), c1 = Math.floor((x + rad - this.w.minX) / HASH);
    const r0 = Math.floor((this.w.maxY - y - rad) / HASH), r1 = Math.floor((this.w.maxY - y + rad) / HASH);
    const r2 = rad * rad;
    for (let r = Math.max(0, r0); r <= Math.min(this.hh - 1, r1); r++) {
      for (let c = Math.max(0, c0); c <= Math.min(this.hw - 1, c1); c++) {
        for (let j = head[r * this.hw + c]!; j !== -1; j = next[j]!) {
          if (!this.alive[j]) continue;
          const d2 = (this.x[j]! - x) ** 2 + (this.y[j]! - y) ** 2;
          if (d2 <= r2) fn(j, d2);
        }
      }
    }
  }
  private forNearAll(x: number, y: number, rad: number, fn: (j: number, d2: number) => void) {
    for (let t = 0; t < 3; t++) this.forNear(x, y, rad, t, fn);
  }

  // ---------------- flow field ----------------
  private fcell(x: number, y: number) {
    const c = Math.floor((x - this.w.minX) / FCELL), r = Math.floor((this.w.maxY - y) / FCELL);
    return c < 0 || r < 0 || c >= this.fw || r >= this.fh ? -1 : r * this.fw + c;
  }
  /** Last flow-field rebuild time (ms), for profiling. */
  fieldMs = 0;
  /** Both live fields: to the nearest person (zombies follow it; walls count, so they route to them) and to the nearest zombie (squads hunt along it; gates open, walls closed). */
  private rebuildField() {
    const t0 = performance.now();
    this.bfs(this.dist, this.zpass, (k) => k !== Z, Math.ceil(SPEC[Z]!.smell! / FCELL));
    this.bfs(this.zdist, this.hpass, (k) => k === Z, this.hasRoamers() ? FAR - 1 : Math.ceil(MAX_HUNT / FCELL));
    this.fieldMs = performance.now() - t0;
  }
  private bfs(dist: Uint16Array, pass: Uint8Array, src: (k: number) => boolean, maxD: number) {
    this.bfsFrom(dist, pass, maxD, (push) => {
      for (let i = 0; i < this.n; i++) {
        if (!this.alive[i] || !src(this.kind[i]!) || SPEC[this.kind[i]!]!.flies) continue;
        const c = this.fcell(this.x[i]!, this.y[i]!);
        if (c >= 0) push(c);
      }
    });
  }
  /** Multi-source BFS over cells with pass[c] set, up to maxD steps. */
  private bfsFrom(dist: Uint16Array, pass: Uint8Array, maxD: number, seed: (push: (c: number) => void) => void) {
    const { queue, fw, fh } = this;
    dist.fill(FAR);
    let head = 0, tail = 0;
    seed((c) => { if (dist[c] !== 0) { dist[c] = 0; queue[tail++] = c; } });
    while (head < tail) {
      const c = queue[head++]!, d = dist[c]! + 1;
      if (d > maxD) break;
      const col = c % fw, row = (c - col) / fw;
      if (col > 0 && pass[c - 1] && dist[c - 1]! > d) { dist[c - 1] = d; queue[tail++] = c - 1; }
      if (col < fw - 1 && pass[c + 1] && dist[c + 1]! > d) { dist[c + 1] = d; queue[tail++] = c + 1; }
      if (row > 0 && pass[c - fw] && dist[c - fw]! > d) { dist[c - fw] = d; queue[tail++] = c - fw; }
      if (row < fh - 1 && pass[c + fw] && dist[c + fw]! > d) { dist[c + fw] = d; queue[tail++] = c + fw; }
    }
  }
  private fieldDist(x: number, y: number, field = this.dist): number {
    const c = this.fcell(x, y);
    return c < 0 ? FAR : field[c]!;
  }
  /**
   * Unit vector toward the center of the lowest-distance neighbor cell, or null
   * at a minimum. Diagonals only when both sides are open (no corner cutting,
   * which jams bodies against buildings).
   */
  private downhill(x: number, y: number, field = this.dist, pass = field === this.dist ? this.zpass : this.hpass): [number, number] | null {
    const c = this.fcell(x, y);
    if (c < 0) return null;
    const fw = this.fw, col = c % fw, row = (c - col) / fw;
    let best = field[c]!, bc = -1;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nc = col + dc, nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= fw || nr >= this.fh) continue;
      if (dr && dc && (!pass[row * fw + nc] || !pass[nr * fw + col])) continue;
      const v = field[nr * fw + nc]!;
      if (v < best) { best = v; bc = nr * fw + nc; }
    }
    if (bc < 0) return null;
    const tc = bc % fw, tr = (bc - tc) / fw;
    const tx = this.w.minX + (tc + 0.5) * FCELL, ty = this.w.maxY - (tr + 0.5) * FCELL;
    const dx = tx - x, dy = ty - y, l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }

  /** Units that track zombies beyond the short hunt leash: hunters, police on a radio call. */
  private hasRoamers(): boolean {
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const sp = SPEC[this.kind[i]!]!;
      if (sp.roams || sp.ranges || (sp.radio && this.firstBite >= 0)) return true;
    }
    return false;
  }

  /** Way back to the placement point (direct; squads never stray far). */
  private downhillTo(i: number): [number, number] | null {
    const dx = this.ax[i]! - this.x[i]!, dy = this.ay[i]! - this.y[i]!, l = Math.hypot(dx, dy);
    return l < 1e-3 ? null : [dx / l, dy / l];
  }

  // ---------------- combat ----------------
  private hurtZombie(j: number, dmg: number) {
    if (!this.alive[j] || this.kind[j] !== Z) return;
    this.hp[j]! -= dmg;
    if (this.hp[j]! <= 0) { this.alive[j] = 0; this.killed++; }
  }
  /** Explosions hit everyone on the ground in the radius, people included. */
  private blast(x: number, y: number, r: number, dmg: number) {
    this.blasts.push(x, y, r);
    this.forNearAll(x, y, r, (j) => {
      if (this.kind[j] === Z) this.hurtZombie(j, dmg);
      else if (this.kind[j] === S) this.alive[j] = 0;
      else { this.hp[j]! -= dmg * 0.5; if (this.hp[j]! <= 0) this.alive[j] = 0; }
    });
  }
  /** Best shell target in [minR, maxR]: most zombies in the blast, people weigh heavily against. */
  private pickCluster(i: number, minR: number, maxR: number, r: number): [number, number] | null {
    let best: [number, number] | null = null, bestScore = 1.5;
    for (let t = 0; t < 14; t++) {
      const j = this.randomZombieWithin(this.x[i]!, this.y[i]!, minR, maxR);
      if (j < 0) break;
      let z = 0, h = 0;
      this.forNear(this.x[j]!, this.y[j]!, r, T_ZOMBIE, () => { z++; });
      this.forNear(this.x[j]!, this.y[j]!, r, T_SURVIVOR, () => { h++; });
      this.forNear(this.x[j]!, this.y[j]!, r, T_GUARD, () => { h++; });
      const score = z - 4 * h;
      if (score > bestScore) { bestScore = score; best = [this.x[j]!, this.y[j]!]; }
    }
    return best;
  }
  private zombieList: number[] = [];
  private randomZombieWithin(x: number, y: number, minR: number, maxR: number): number {
    for (let tries = 0; tries < 8 && this.zombieList.length; tries++) {
      const j = this.zombieList[Math.floor(this.rand() * this.zombieList.length)]!;
      if (!this.alive[j]) continue;
      const d = Math.hypot(this.x[j]! - x, this.y[j]! - y);
      if (d >= minR && d <= maxR) return j;
    }
    return -1;
  }
  private shoot(i: number, j: number, sp: Spec): boolean {
    // everyone fires what they carry: squads what they were issued, officers their own rounds
    if (this.cool[i]! > 0 || (!sp.ownAmmo && this.ammoOf[i]! < 1)) return false;
    if (!sp.ownAmmo) this.ammoOf[i]!--;
    this.cool[i] = sp.cooldown!;
    this.shots.push(this.x[i]!, this.y[i]!, this.x[j]! + (this.rand() - 0.5) * 2, this.y[j]! + (this.rand() - 0.5) * 2, this.kind[i]!);
    if (this.rand() < sp.accuracy!) {
      if (sp.blast) this.blast(this.x[j]!, this.y[j]!, sp.blast, sp.damage!);
      else this.hurtZombie(j, sp.damage!);
    }
    return true;
  }

  // ---------------- tick ----------------
  step(): void {
    if (this.outcome) return;
    this.time += DT;
    this.blasts = [];
    this.shots = [];
    this.rebuildHash();
    if (this.ticks++ % FIELD_EVERY === 0) this.rebuildField();
    this.zombieList = [];
    for (let i = 0; i < this.n; i++) if (this.alive[i] && this.kind[i] === Z) this.zombieList.push(i);
    const isHuman = [T_SURVIVOR, T_GUARD], isZombie = [T_ZOMBIE], isGuard = [T_GUARD];

    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const k = this.kind[i]!, sp = SPEC[k]!;
      if (this.cool[i]! > 0) this.cool[i]! -= DT;

      if (k === Z) {
        const t = this.nearest(this.x[i]!, this.y[i]!, 14, isHuman);
        if (t >= 0) {
          const d = Math.hypot(this.x[t]! - this.x[i]!, this.y[t]! - this.y[i]!);
          if (d < sp.reach! && !this.wallBetween(this.x[i]!, this.y[i]!, this.x[t]!, this.y[t]!)) {
            if (this.firstBite < 0) this.firstBite = this.time;
            if (this.kind[t] === S) { this.kind[t] = Z; this.hp[t] = SPEC[Z]!.hp; } // bitten: turns
            else {
              this.hp[t]! -= sp.melee! * DT;
              if (this.hp[t]! <= 0) { this.kind[t] = Z; this.hp[t] = SPEC[Z]!.hp; } // overrun: turns
            }
          } else this.steer(i, this.x[t]!, this.y[t]!, sp.chaseSpeed ?? sp.speed); // lunge
          continue;
        }
        // Follow the flow field around buildings and water toward the nearest
        // people: at a run within sight, at a shamble within smell, else wander.
        const fd = this.fieldDist(this.x[i]!, this.y[i]!) * FCELL;
        if (fd <= sp.smell!) {
          const dir = this.downhill(this.x[i]!, this.y[i]!);
          if (dir) {
            // separation: a horde spreads along its front instead of moving as one blob
            let sx = 0, sy = 0;
            this.forNear(this.x[i]!, this.y[i]!, SEP_R, T_ZOMBIE, (j, d2) => {
              if (j === i || d2 < 1e-4) return;
              const d = Math.sqrt(d2), w = (SEP_R - d) / SEP_R; // linear falloff
              sx += ((this.x[i]! - this.x[j]!) / d) * w; sy += ((this.y[i]! - this.y[j]!) / d) * w;
            });
            const dx = dir[0] + this.hx[i]! * 0.3 + sx * 0.9, dy = dir[1] + this.hy[i]! * 0.3 + sy * 0.9;
            const l = Math.hypot(dx, dy) || 1;
            const v = (fd <= sp.sight! ? (sp.chaseSpeed ?? sp.speed) : sp.speed * (sp.scentSpeedFactor ?? 0.7)) * DT;
            this.move(i, (dx / l) * v, (dy / l) * v);
            continue;
          }
        }
                if (this.rand() < 0.02) { this.hx[i] = this.rand() * 2 - 1; this.hy[i] = this.rand() * 2 - 1; }
        this.move(i, this.hx[i]! * sp.speed * 0.35 * DT, this.hy[i]! * sp.speed * 0.35 * DT);
        continue;
      }

      if (k === S) {
        const z = this.nearest(this.x[i]!, this.y[i]!, sp.sight!, isZombie);
        const safe = this.sdist ? this.downhill(this.x[i]!, this.y[i]!, this.sdist, this.hpass) : null;
        const inZone = this.zoneMask ? this.zoneMask[this.cellIndex(this.x[i]!, this.y[i]!)] === 1 : false;
        const g = safe || inZone ? -1 : this.nearest(this.x[i]!, this.y[i]!, 220, isGuard);
        if (z >= 0) {
          let dx = this.x[i]! - this.x[z]!, dy = this.y[i]! - this.y[z]!;
          const dl = Math.hypot(dx, dy) || 1;
          dx /= dl; dy /= dl;
          if (safe) { dx += safe[0] * 1.2; dy += safe[1] * 1.2; } // run for the walls
          else if (g >= 0) { // flee, bending toward the nearest squad
            const gx = this.x[g]! - this.x[i]!, gy = this.y[g]! - this.y[i]!, gl = Math.hypot(gx, gy) || 1;
            dx += (gx / gl) * 0.8; dy += (gy / gl) * 0.8;
          }
          const l = Math.hypot(dx, dy) || 1;
          this.move(i, (dx / l) * sp.speed * DT, (dy / l) * sp.speed * DT);
        } else if (safe && !inZone) {
          // flock to the safe zone: drive / run while far, walk the last stretch
          const far = this.fieldDist(this.x[i]!, this.y[i]!, this.sdist!) * FCELL > 200;
          const v = (far ? sp.travelSpeed ?? sp.speed : sp.speed * 0.8) * DT;
          this.move(i, safe[0] * v, safe[1] * v);
        } else if (inZone) {
          if (this.rand() < 0.02) { this.hx[i] = this.rand() * 2 - 1; this.hy[i] = this.rand() * 2 - 1; }
          this.move(i, this.hx[i]! * 0.2 * DT, this.hy[i]! * 0.2 * DT);
        } else if (g >= 0 && Math.hypot(this.x[g]! - this.x[i]!, this.y[g]! - this.y[i]!) > 14) {
          this.steer(i, this.x[g]!, this.y[g]!, sp.speed * 0.5); // gather under protection
        }
        continue;
      }

      // ---- the player's forces ----
      if (sp.endurance !== undefined) {
        this.life[i]! -= DT;
        if (this.life[i]! <= 0) { this.alive[i] = 0; continue; } // out of fuel / battery: returns to base
      }
      const kindName = KINDS[k]!;
      // The safe zone is the depot: restock inside it; run dry outside and head back.
      if (this.zoneMask && sp.cost?.ammo && !sp.flies) {
        const inZone = this.zoneMask[this.cellIndex(this.x[i]!, this.y[i]!)] === 1;
        const full = (sp.cost.ammo / (sp.dots ?? 1)) * 1.5;
        if (inZone && this.ammo > 0 && this.ammoOf[i]! < full) {
          const take = Math.min(this.ammo, UNITS.resupply.roundsPerSecond * DT, full - this.ammoOf[i]!);
          this.ammoOf[i]! += take; this.ammo -= take;
        } else if (!inZone && this.ammoOf[i]! < 1 && this.ammo >= 1 && this.sdist && sp.speed > 0) {
          const home = this.downhill(this.x[i]!, this.y[i]!, this.sdist, this.hpass);
          if (home) { this.move(i, home[0] * sp.speed * DT, home[1] * sp.speed * DT); continue; }
        }
      }
      if (kindName === 'mortar' || kindName === 'artillery') {
        if (this.cool[i]! <= 0 && this.ammoOf[i]! >= 2) {
          const t = this.pickCluster(i, sp.minRange!, sp.range!, sp.blast!);
          if (t) {
            this.ammoOf[i]! -= 2;
            this.cool[i] = sp.cooldown!;
            const scatter = sp.blast! * (kindName === 'artillery' ? 0.6 : 0.35);
            const ix = t[0] + (this.rand() - 0.5) * scatter, iy = t[1] + (this.rand() - 0.5) * scatter;
            this.shots.push(this.x[i]!, this.y[i]!, ix, iy, k);
            this.blast(ix, iy, sp.blast!, sp.damage!);
          }
        }
        continue;
      }
      if (kindName === 'eod') {
        if (this.charges[i]! > 0 && this.cool[i]! <= 0) {
          const t = this.pickCluster(i, 8, sp.range!, sp.blast!);
          if (t) { this.charges[i]!--; this.cool[i] = sp.cooldown!; this.shots.push(this.x[i]!, this.y[i]!, t[0], t[1], k); this.blast(t[0], t[1], sp.blast!, sp.damage!); }
        }
        this.steer(i, this.ax[i]!, this.ay[i]!, sp.speed);
        continue;
      }
      if (kindName === 'fpv') {
        // kamikaze: fly to the strike point and detonate
        const d = Math.hypot(this.ax[i]! - this.x[i]!, this.ay[i]! - this.y[i]!);
        if (d < 3) { this.alive[i] = 0; this.blast(this.ax[i]!, this.ay[i]!, sp.blast!, sp.damage!); }
        else this.steer(i, this.ax[i]!, this.ay[i]!, sp.speed);
        continue;
      }
      if (kindName === 'helicopter') {
        const a = this.time * (sp.speed / sp.orbit!) + i;
        this.steer(i, this.ax[i]! + Math.cos(a) * sp.orbit!, this.ay[i]! + Math.sin(a) * sp.orbit!, sp.speed);
        const t = this.nearest(this.x[i]!, this.y[i]!, sp.range!, isZombie);
        if (t >= 0) this.shoot(i, t, sp);
        continue;
      }
      if (kindName === 'drone') {
        const t = this.nearest(this.ax[i]!, this.ay[i]!, sp.leash!, isZombie);
        if (t >= 0) {
          const d = Math.hypot(this.x[t]! - this.x[i]!, this.y[t]! - this.y[i]!);
          if (d <= sp.range!) this.shoot(i, t, sp); else this.steer(i, this.x[t]!, this.y[t]!, sp.speed);
        } else this.steer(i, this.ax[i]!, this.ay[i]!, sp.speed);
        continue;
      }
      // riflemen: militia, police, hunters, paratroopers
      const t = this.nearest(this.x[i]!, this.y[i]!, sp.range!, isZombie);
      if (t >= 0) {
        if (!this.shoot(i, t, sp) && !sp.ownAmmo && this.ammoOf[i]! < 1) {
          const d = Math.hypot(this.x[t]! - this.x[i]!, this.y[t]! - this.y[i]!);
          if (d < 1.6) this.hurtZombie(t, 0.6 * DT); // out of ammo: fighting hand to hand
        }
      } else if (sp.patrol) {
        // Police: once the outbreak is on the radio, drive to it; before that,
        // patrol around the station and chase anything nearby.
        const zd = this.fieldDist(this.x[i]!, this.y[i]!, this.zdist) * FCELL;
        const fromHome = Math.hypot(this.x[i]! - this.ax[i]!, this.y[i]! - this.ay[i]!);
        const called = sp.radio && this.firstBite >= 0 && this.time >= this.firstBite + sp.radio.delay;
        const dir = (called && zd < FAR * FCELL) || zd <= (sp.hunt ?? 0) ? this.downhill(this.x[i]!, this.y[i]!, this.zdist) : null;
        if (dir && (called || fromHome < sp.patrol)) {
          const v = (called && zd > 150 ? sp.radio!.driveSpeed : sp.speed) * DT;
          this.move(i, dir[0] * v, dir[1] * v);
        } else {
          if (fromHome > sp.patrol * 0.8) { // turn back toward the station
            const l = fromHome || 1;
            this.hx[i] = (this.ax[i]! - this.x[i]!) / l; this.hy[i] = (this.ay[i]! - this.y[i]!) / l;
          } else if (this.rand() < 0.01) { this.hx[i] = this.rand() * 2 - 1; this.hy[i] = this.rand() * 2 - 1; }
          const l = Math.hypot(this.hx[i]!, this.hy[i]!) || 1;
          this.move(i, (this.hx[i]! / l) * sp.speed * 0.7 * DT, (this.hy[i]! / l) * sp.speed * 0.7 * DT);
        }
      } else if (sp.roams || sp.ranges) {
        // Hunters: track zombies along the field within a long leash of where
        // they were placed; with nothing to track, range around their ground.
        const fromHome = Math.hypot(this.x[i]! - this.ax[i]!, this.y[i]! - this.ay[i]!);
        const zdM = this.fieldDist(this.x[i]!, this.y[i]!, this.zdist) * FCELL;
        const inReach = sp.roams || (zdM <= (sp.hunt ?? 0) && fromHome < (sp.hunt ?? 0));
        const dir = inReach ? this.downhill(this.x[i]!, this.y[i]!, this.zdist) : null;
        if (!dir && !sp.roams && fromHome > (sp.hunt ?? 0) * 0.8) { const l = fromHome || 1; this.hx[i] = (this.ax[i]! - this.x[i]!) / l; this.hy[i] = (this.ay[i]! - this.y[i]!) / l; }
        // drive (trucks, ATVs) while the quarry is far, stalk on foot for the shot
        const far = this.fieldDist(this.x[i]!, this.y[i]!, this.zdist) * FCELL > 150;
        const v = (far ? sp.travelSpeed ?? sp.speed : sp.speed) * DT;
        if (dir) this.move(i, dir[0] * v, dir[1] * v);
        else {
          if (this.rand() < 0.01) { this.hx[i] = this.rand() * 2 - 1; this.hy[i] = this.rand() * 2 - 1; }
          this.move(i, this.hx[i]! * sp.speed * 0.6 * DT, this.hy[i]! * sp.speed * 0.6 * DT);
        }
      } else {
        // Nothing in range: hunt along the zombie field, but never further than
        // the squad's leash from where it was placed. Placement still matters.
        const zd = this.fieldDist(this.x[i]!, this.y[i]!, this.zdist) * FCELL;
        const fromAnchor = Math.hypot(this.x[i]! - this.ax[i]!, this.y[i]! - this.ay[i]!);
        const dir = zd <= (sp.hunt ?? 0) ? this.downhill(this.x[i]!, this.y[i]!, this.zdist) : null;
        if (dir && fromAnchor < (sp.hunt ?? 0)) this.move(i, dir[0] * sp.speed * DT, dir[1] * sp.speed * DT);
        else if (fromAnchor > 6) {
          const home = this.downhillTo(i);
          if (home) this.move(i, home[0] * sp.speed * DT, home[1] * sp.speed * DT);
        }
      }
    }

    // Drone teams launch FPV kamikaze drones at the best cluster in range
    const fpvSpec = SPEC[idx('drone')]!.fpv!;
    for (const L of this.launchers) {
      if (L.left <= 0 || this.time < L.next) continue;
      L.next = this.time + fpvSpec.every;
      const probe = this.spawn(idx('fpv'), L.x, L.y);
      if (probe < 0) continue;
      const t = this.pickCluster(probe, 0, fpvSpec.range, SPEC[idx('fpv')]!.blast!);
      if (!t) { this.alive[probe] = 0; continue; } // nothing worth a drone: keep it
      L.left--;
      this.ax[probe] = t[0]; this.ay[probe] = t[1];
      this.shots.push(L.x, L.y, t[0], t[1], idx('fpv'));
    }

    // Police stations call in officers
    if (this.time >= this.nextPolice) {
      this.nextPolice += UNITS.policeStation.every;
      this.w.police.forEach(([px, py], s) => {
        for (let b = 0; b < UNITS.policeStation.batch && this.stationSpawned[s]! < UNITS.policeStation.max; b++) {
          const p = this.walkableNear(px + (this.rand() - 0.5) * 10, py + (this.rand() - 0.5) * 10);
          const j = p ? this.spawn(idx('police'), p[0], p[1]) : -1;
          if (j >= 0) { this.ammoOf[j] = UNITS.policeStation.ammoEach; this.stationSpawned[s]!++; } // officers bring their own rounds
        }
      });
    }
    if (this.n > 256 && this.deadShare() > 0.4) this.compact();
    if (!this.endless) this.outcome = this.judge();
  }

  private deadShare() {
    let d = 0;
    for (let i = 0; i < this.n; i++) if (!this.alive[i]) d++;
    return d / this.n;
  }
  private compact() {
    let w = 0;
    const arrs = [this.x, this.y, this.hp, this.cool, this.life, this.ax, this.ay, this.hx, this.hy, this.kind, this.alive, this.charges, this.ammoOf];
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      if (w !== i) for (const a of arrs) a[w] = a[i]!;
      w++;
    }
    this.n = w;
  }

  /** Scored on the share of survivors saved; below the minimum the stage is lost. */
  private judge(): BattleStats['outcome'] {
    const zombies = this.count(Z), alive = this.count(S);
    const pct = this.survivorsStart ? (alive / this.survivorsStart) * 100 : 100;
    const min = UNITS.outcome.securedMinSavedPct;
    const grade = UNITS.outcome.grades.find((g) => pct >= g.minPct)!.label;
    if (pct < min) return { secured: false, savedPct: pct, grade: 'Lost' };
    if (zombies === 0) return { secured: true, savedPct: pct, grade };
    // Contained: every living survivor inside an unbreached zone with no zombies in it, for a while.
    if (this.zoneMask && alive > 0 && this.breaches === 0) {
      let out = 0, zin = 0;
      for (let i = 0; i < this.n; i++) {
        if (!this.alive[i]) continue;
        const inside = this.zoneMask[this.cellIndex(this.x[i]!, this.y[i]!)] === 1;
        if (this.kind[i] === S && !inside) out++;
        if (this.kind[i] === Z && inside) zin++;
      }
      if (out === 0 && zin === 0) {
        if (this.containedSince < 0) this.containedSince = this.time;
        if (this.time - this.containedSince >= UNITS.resupply.containHoldSeconds) return { secured: true, savedPct: pct, grade, contained: true };
      } else this.containedSince = -1;
    }
    // With no forces left the battle still plays out: the score is survivors
    // saved, so it ends when they fall below the minimum or time runs out.
    // Out of time: judged on survivors saved, like every other outcome.
    if (this.time >= MAX_TIME) return { secured: pct >= min, savedPct: pct, grade };
    return null;
  }

  stats(): BattleStats {
    let guards = 0;
    for (let i = 0; i < this.n; i++) if (this.alive[i] && this.kind[i] !== Z && this.kind[i] !== S) guards++;
    return {
      time: this.time, zombies: this.count(Z), survivors: this.count(S), survivorsStart: this.survivorsStart,
      defenders: guards, ammo: Math.round(this.carriedAmmo()), reserve: Math.round(this.ammo), killed: this.killed, outcome: this.outcome,
    };
  }

  /** Wall cells for the renderer: x, y, hit points (0..1, 0 = breached), gate flag. */
  wallState(): Float32Array {
    const out = new Float32Array(this.wallList.length * 4);
    this.wallList.forEach((c, k) => {
      const col = c % this.w.width, row = (c - col) / this.w.width;
      out[4 * k] = this.w.minX + (col + 0.5) * this.w.cell;
      out[4 * k + 1] = this.w.maxY - (row + 0.5) * this.w.cell;
      out[4 * k + 2] = this.wallHp[c]! / UNITS.walls.hp;
      out[4 * k + 3] = this.gate[c]!;
    });
    return out;
  }

  private carriedAmmo(): number {
    let a = 0;
    for (let i = 0; i < this.n; i++) if (this.alive[i]) a += this.ammoOf[i]!;
    return a;
  }

  /** Live agents as flat arrays for the renderer. */
  snapshot(): { positions: Float32Array; colors: Uint8Array; count: number } {
    let m = 0;
    for (let i = 0; i < this.n; i++) if (this.alive[i]) m++;
    const positions = new Float32Array(m * 2), colors = new Uint8Array(m * 4);
    let v = 0;
    // zombies drawn last so the horde reads on top
    for (const pass of [false, true]) {
      for (let i = 0; i < this.n; i++) {
        if (!this.alive[i] || (this.kind[i] === Z) !== pass) continue;
        positions[2 * v] = this.x[i]!; positions[2 * v + 1] = this.y[i]!;
        const c = RGB[this.kind[i]!]!;
        colors[4 * v] = c[0]!; colors[4 * v + 1] = c[1]!; colors[4 * v + 2] = c[2]!; colors[4 * v + 3] = 255;
        v++;
      }
    }
    return { positions, colors, count: m };
  }
}
