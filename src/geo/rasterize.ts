/**
 * Grid helpers for the density raster. Row 0 is the NORTH edge (image order):
 *   cell (c, r) center = (minX + (c + 0.5) * cell, maxY - (r + 0.5) * cell)
 */
export interface Grid {
  minX: number; minY: number; maxX: number; maxY: number;
  cell: number; width: number; height: number;
}

export function makeGrid(bbox: [number, number, number, number], cell: number): Grid {
  const minX = Math.floor(bbox[0] / cell) * cell;
  const minY = Math.floor(bbox[1] / cell) * cell;
  const maxX = Math.ceil(bbox[2] / cell) * cell;
  const maxY = Math.ceil(bbox[3] / cell) * cell;
  return { minX, minY, maxX, maxY, cell, width: Math.round((maxX - minX) / cell), height: Math.round((maxY - minY) / cell) };
}

export type Ring = number[][];

/**
 * Scanline-fill one polygon (outer ring + holes, even-odd rule) into `out`,
 * writing `value` into every cell whose center is inside. Uses a per-row
 * crossing table so cost is O(edges + crossings), safe for huge coastlines.
 */
export function fillPolygon(grid: Grid, rings: Ring[], out: Float32Array | Uint8Array, value: number, mode: 'max' | 'set' = 'max'): void {
  let yMin = Infinity, yMax = -Infinity;
  for (const ring of rings) for (const p of ring) { if (p[1]! < yMin) yMin = p[1]!; if (p[1]! > yMax) yMax = p[1]!; }
  if (!(yMax > yMin)) return;
  const { cell, maxY, minX, width, height } = grid;
  const r0 = Math.max(0, Math.floor((maxY - yMax) / cell - 0.5));
  const r1 = Math.min(height - 1, Math.ceil((maxY - yMin) / cell - 0.5));
  if (r1 < r0) return;
  const rows: number[][] = Array.from({ length: r1 - r0 + 1 }, () => []);
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = ring[j]![0]!, ay = ring[j]![1]!, bx = ring[i]![0]!, by = ring[i]![1]!;
      if (ay === by) continue;
      const lo = Math.min(ay, by), hi = Math.max(ay, by);
      // rows whose center y lies in [lo, hi)
      const ra = Math.max(r0, Math.ceil((maxY - hi) / cell - 0.5));
      const rb = Math.min(r1, Math.floor((maxY - lo) / cell - 0.5));
      for (let r = ra; r <= rb; r++) {
        const y = maxY - (r + 0.5) * cell;
        if (y < lo || y >= hi) continue;
        rows[r - r0]!.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    }
  }
  for (let k = 0; k < rows.length; k++) {
    const xs = rows[k]!;
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const base = (r0 + k) * width;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const c0 = Math.max(0, Math.ceil((xs[i]! - minX) / cell - 0.5));
      const c1 = Math.min(width - 1, Math.floor((xs[i + 1]! - minX) / cell - 0.5));
      for (let c = c0; c <= c1; c++) {
        const idx = base + c;
        if (mode === 'set' || value > out[idx]!) out[idx] = value;
      }
    }
  }
}

/** Separable Gaussian blur in place. */
export function gaussianBlur(grid: Grid, data: Float32Array, sigma: number): void {
  if (sigma <= 0) return;
  const radius = Math.ceil(sigma * 3);
  const k: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(w); sum += w; }
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  const { width: w, height: h } = grid;
  const tmp = new Float32Array(data.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -radius; i <= radius; i++) { const xx = Math.min(w - 1, Math.max(0, x + i)); acc += data[y * w + xx]! * k[i + radius]!; }
    tmp[y * w + x] = acc;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -radius; i <= radius; i++) { const yy = Math.min(h - 1, Math.max(0, y + i)); acc += tmp[yy * w + x]! * k[i + radius]!; }
    data[y * w + x] = acc;
  }
}

/** Polygon / MultiPolygon GeoJSON geometry → list of polygons (each a ring list). */
export function polygonsOf(geom: { type: string; coordinates: unknown } | null): Ring[][] {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates as Ring[]];
  if (geom.type === 'MultiPolygon') return geom.coordinates as Ring[][];
  return [];
}

/** Draw a polyline of the given width (meters) as quads + round-ish joins. */
export function drawThickPolyline(grid: Grid, pts: number[][], width: number, out: Float32Array | Uint8Array, value: number): void {
  const h = Math.max(width / 2, grid.cell * 0.5);
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i]![0]!, ay = pts[i]![1]!, bx = pts[i + 1]![0]!, by = pts[i + 1]![1]!;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const nx = (-dy / len) * h, ny = (dx / len) * h;
    fillPolygon(grid, [[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny], [ax + nx, ay + ny]]], out, value, 'set');
  }
  for (const p of pts) fillDisc(grid, p[0]!, p[1]!, h, out, value);
}

/** Fill a disc (as an octagon, plenty at road scale). */
export function fillDisc(grid: Grid, x: number, y: number, r: number, out: Float32Array | Uint8Array, value: number): void {
  const ring: number[][] = [];
  for (let k = 0; k <= 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    ring.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
  }
  fillPolygon(grid, [ring], out, value, 'set');
}

/** Cell index of a point, or -1 outside the grid. */
export function cellIndex(grid: Grid, x: number, y: number): number {
  const c = Math.floor((x - grid.minX) / grid.cell);
  const r = Math.floor((grid.maxY - y) / grid.cell);
  if (c < 0 || r < 0 || c >= grid.width || r >= grid.height) return -1;
  return r * grid.width + c;
}
