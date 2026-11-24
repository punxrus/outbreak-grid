import type { Pt, Ring } from './geom';
import type { ChunkNav } from './nav';

export type DistrictType = 'downtown' | 'commercial' | 'residential' | 'suburban' | 'town' | 'industrial' | 'rural' | 'forest' | 'park';

export type RoadKind = 'arterial' | 'collector' | 'street' | 'rural' | 'bridge' | 'ferry';

export type LandmarkType =
  | 'hospital' | 'police' | 'gas_station' | 'armory' | 'school' | 'radio_tower' | 'helipad' | 'ferry_terminal';

export interface Site {
  id: number;
  x: number;
  y: number;
  density: number; // 0..1 from the Census grid
  type: DistrictType;
  inCity: boolean;
  angle: number; // street grid orientation (radians)
}

export interface Road {
  kind: RoadKind;
  width: number;
  pts: Pt[];
  /** for bridges: the road class carried; true if wide enough to be a gameplay chokepoint */
  carries?: RoadKind;
  chokepoint?: boolean;
}

export interface Building {
  ring: Ring;
  shade: number; // 0..1 for color variation
  landmark?: LandmarkType;
}

export interface Landmark {
  id: number;
  type: LandmarkType;
  x: number;
  y: number;
  districtType: DistrictType;
}

export interface DistrictPatch {
  id: number;
  type: DistrictType;
  ring: Ring; // Voronoi cell clipped to the chunk
}

export interface ChunkData {
  key: string;
  cx: number;
  cy: number;
  seed: number;
  rect: [number, number, number, number];
  roads: Road[];
  culDeSacs: Pt[];
  blocks: Ring[];
  parks: Ring[];
  forests: Ring[];
  lots: Ring[];
  buildings: Building[];
  landmarks: Landmark[];
  districts: DistrictPatch[];
  nav: ChunkNav;
  stats: { ms: number; sites: number; roads: number; blocks: number; lots: number; buildings: number; navNodes: number; navEdges: number };
}
