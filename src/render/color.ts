export type RGBA = [number, number, number, number];

/** "#rrggbb" + alpha (0-255) -> deck.gl color array. */
export function hex(h: string, a = 255): RGBA {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), a];
}
