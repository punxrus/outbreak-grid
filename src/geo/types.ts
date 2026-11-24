import type { Feature, FeatureCollection, Geometry } from 'geojson';

export type BBox = [minX: number, minY: number, maxX: number, maxY: number];

export interface GridMeta {
  file: string;
  minX: number; minY: number; maxX: number; maxY: number;
  cell: number; width: number; height: number;
}

export interface PackManifest {
  formatVersion: number;
  state: { fips: string; usps: string; name: string; population2020: number };
  projection: { proj4: string; originLon: number; originLat: number; units: 'm' };
  boundsMeters: BBox;
  boundsLonLat: BBox;
  density: { encoding: string; maxPeoplePerKm2: number; rowOrder: 'north-to-south'; fine: GridMeta; coarse: GridMeta };
  layers: { tactical: string[]; strategic: string[] };
  streamWidthMeters: Record<string, number>;
  files: Record<string, { bytes: number; gzipBytes: number }>;
  credits: string;
}

export interface Place {
  geoid: string; name: string; fullName: string; kind: 'city' | 'town' | 'cdp' | 'other';
  pop: number; areaKm2: number; lon: number; lat: number; x: number; y: number;
}

export interface CountyLabel { geoid: string; name: string; pop: number; areaKm2: number; x: number; y: number }

export interface LandProps { areaM2: number; islandName: string | null; county: string; id: number }
export interface WaterProps { HYDROID?: string; FULLNAME?: string; MTFCC?: string; AWATER?: number }
export interface StreamProps { FULLNAME: string; MTFCC: string }
export interface CountyProps { GEOID: string; NAME: string; NAMELSAD?: string }
export interface PlaceProps { GEOID: string; NAME: string; LSAD: string; pop: number }
export interface NeighborProps { NAME: string; STUSPS: string }

export type FC<P> = FeatureCollection<Geometry, P>;
export type F<P> = Feature<Geometry, P>;

export interface TacticalLayers {
  land: FC<LandProps>; water: FC<WaterProps>; streams: FC<StreamProps>; counties: FC<CountyProps>; places: FC<PlaceProps>;
}
export interface StrategicLayers {
  land: FC<{ NAME?: string }>; water: FC<{ FULLNAME?: string }>; counties: FC<CountyProps>; neighbors: FC<NeighborProps>;
}
