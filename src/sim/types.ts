/** The battlefield: the region's walk grid plus where people and police start. */
export interface BattleWorld {
  minX: number; maxY: number; cell: number; width: number; height: number;
  /** 0 water/outside, 1 open ground, 2 road, 3 building (blocked). Row 0 = north. */
  grid: Uint8Array;
  homes: Float32Array; // x,y pairs
  police: [number, number][];
}

export type UnitKind =
  | 'zombie' | 'survivor' | 'militia' | 'police' | 'hunter' | 'paratrooper' | 'eod' | 'mortar' | 'artillery' | 'drone' | 'fpv' | 'helicopter';

export interface Placement { kind: UnitKind; x: number; y: number }

export interface BattleSetup {
  seed: number;
  world: BattleWorld;
  placements: Placement[];
  survivors: number; // dots
  zombies: number; // initial outbreak
  ammo: number;
  /** Player-drawn safe zones: walls (buildings stand in for wall) and gates. */
  zones?: { ring: [number, number][]; gates: [number, number][] }[];
  /** Never judge an outcome (tests, sandbox). */
  endless?: boolean;
}

export interface BattleStats {
  time: number;
  zombies: number;
  survivors: number;
  survivorsStart: number;
  defenders: number;
  ammo: number;
  killed: number;
  outcome: null | { secured: boolean; savedPct: number; grade: string };
}
