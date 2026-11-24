/**
 * Deterministic randomness for procgen and sim. Never use Math.random() here.
 * Everything is keyed: the same (seed, ...keys) always yields the same values,
 * so any chunk can be regenerated independently of generation order.
 */

/** Murmur3-style integer hash of a list of ints. */
export function hash32(...ns: number[]): number {
  let h = 0x9e3779b9 ^ ns.length;
  for (const n of ns) {
    let k = Math.imul(n | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform [0, 1) from keys. */
export function unit(...keys: number[]): number {
  return hash32(...keys) / 4294967296;
}

export type Rng = () => number;

/** mulberry32 stream PRNG. */
export function mulberry32(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngFor(...keys: number[]): Rng {
  return mulberry32(hash32(...keys));
}

export const range = (rng: Rng, a: number, b: number) => a + (b - a) * rng();

/** Salts keep independent random decisions from correlating. */
export const SALT = {
  site: 11,
  siteAccept: 12,
  siteType: 13,
  park: 14,
  angle: 15,
  edge: 21,
  edgeCurve: 22,
  ferry: 23,
  street: 31,
  streetDrop: 32,
  lot: 41,
  building: 51,
  landmark: 61,
  plaza: 71,
  noise: 81,
} as const;

/** Smooth 2D value noise in [0, 1). */
export function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const v00 = unit(seed, SALT.noise, x0, y0), v10 = unit(seed, SALT.noise, x0 + 1, y0);
  const v01 = unit(seed, SALT.noise, x0, y0 + 1), v11 = unit(seed, SALT.noise, x0 + 1, y0 + 1);
  return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
}
