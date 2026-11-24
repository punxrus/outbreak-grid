/** Small planar geometry kit (meters). Rings are open: first point is not repeated. */
export type Pt = [number, number];
export type Ring = Pt[];
export type Rect = [x0: number, y0: number, x1: number, y1: number];

export function pointInRing(x: number, y: number, ring: ArrayLike<ArrayLike<number>>): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!, xj = ring[j]![0]!, yj = ring[j]![1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Even-odd test across all rings (outer + holes). */
export function pointInPolygon(x: number, y: number, rings: ArrayLike<ArrayLike<ArrayLike<number>>>): boolean {
  let inside = false;
  for (let k = 0; k < rings.length; k++) if (pointInRing(x, y, rings[k]!)) inside = !inside;
  return inside;
}

export function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] - r[i]![0]) * (r[j]![1] + r[i]![1]);
  return a / 2;
}

export function ringCentroid(r: Ring): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j]![0] * r[i]![1] - r[i]![0] * r[j]![1];
    a += f;
    cx += (r[j]![0] + r[i]![0]) * f;
    cy += (r[j]![1] + r[i]![1]) * f;
  }
  if (Math.abs(a) < 1e-9) return [r[0]![0], r[0]![1]];
  return [cx / (3 * a), cy / (3 * a)];
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
}

export function bboxOf(pts: ArrayLike<ArrayLike<number>>): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i]![0]!, y = pts[i]![1]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Andrew monotone chain convex hull (CCW). */
export function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Minimum-area oriented bounding box. `u` is the long axis (unit vector). */
export interface Obb { cx: number; cy: number; ux: number; uy: number; halfL: number; halfW: number }

export function minAreaRect(pts: Pt[]): Obb {
  const h = convexHull(pts);
  let best: Obb = { cx: h[0]?.[0] ?? 0, cy: h[0]?.[1] ?? 0, ux: 1, uy: 0, halfL: 0, halfW: 0 };
  let bestArea = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i]!, b = h[(i + 1) % h.length]!;
    let ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    ex /= len;
    ey /= len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of h) {
      const dx = p[0] - a[0], dy = p[1] - a[1];
      const u = dx * ex + dy * ey, v = -dx * ey + dy * ex;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < bestArea) {
      bestArea = area;
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      const cx = a[0] + ex * cu - ey * cv, cy = a[1] + ey * cu + ex * cv;
      const hu = (u1 - u0) / 2, hv = (v1 - v0) / 2;
      best = hu >= hv ? { cx, cy, ux: ex, uy: ey, halfL: hu, halfW: hv } : { cx, cy, ux: -ey, uy: ex, halfL: hv, halfW: hu };
    }
  }
  return best;
}

/** Keep the part of `ring` where (p - P) · n >= 0 (Sutherland–Hodgman, one plane). */
export function clipHalfPlane(ring: Ring, px: number, py: number, nx: number, ny: number): Ring {
  const out: Ring = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[(i + 1) % n]!;
    const da = (a[0] - px) * nx + (a[1] - py) * ny;
    const db = (b[0] - px) * nx + (b[1] - py) * ny;
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

export function clipRingToRect(ring: Ring, r: Rect): Ring {
  let out = clipHalfPlane(ring, r[0], 0, 1, 0);
  out = clipHalfPlane(out, r[2], 0, -1, 0);
  out = clipHalfPlane(out, 0, r[1], 0, 1);
  out = clipHalfPlane(out, 0, r[3], 0, -1);
  return out;
}

/** Clip a polyline to a rectangle, returning the inside runs. */
export function clipPolylineToRect(pts: Pt[], r: Rect): Pt[][] {
  const runs: Pt[][] = [];
  let cur: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = clipSegment(pts[i]!, pts[i + 1]!, r);
    if (!seg) {
      if (cur.length > 1) runs.push(cur);
      cur = [];
      continue;
    }
    const [a, b, aIn, bIn] = seg;
    if (!aIn || cur.length === 0) {
      if (cur.length > 1) runs.push(cur);
      cur = [a];
    }
    cur.push(b);
    if (!bIn) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

/** Liang–Barsky. Returns clipped endpoints and whether each is the original point. */
function clipSegment(a: Pt, b: Pt, r: Rect): [Pt, Pt, boolean, boolean] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - r[0], r[2] - a[0], a[1] - r[1], r[3] - a[1]];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i]! < 0) return null;
    } else {
      const t = q[i]! / p[i]!;
      if (p[i]! < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
  }
  return [[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1], t0 === 0, t1 === 1];
}

/** Resample a polyline so consecutive points are at most `step` apart. */
export function densify(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts.slice();
  const out: Pt[] = [pts[0]!];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

export function polylineLength(pts: Pt[]): number {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i++) l += Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
  return l;
}

/** Douglas–Peucker for open polylines. */
export function simplifyLine(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const a = pts[i0]!, b = pts[i1]!;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const p = pts[i]!;
      let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = a[0] + dx * t - p[0], ey = a[1] + dy * t - p[1];
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([i0, idx], [idx, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Douglas–Peucker for closed rings (split at the farthest pair). */
export function simplifyRing(ring: Ring, tol: number): Ring {
  if (ring.length < 4) return ring.slice();
  let far = 0, best = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i]![0] - ring[0]![0]) ** 2 + (ring[i]![1] - ring[0]![1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = simplifyLine(ring.slice(0, far + 1), tol);
  const b = simplifyLine([...ring.slice(far), ring[0]!], tol);
  return a.concat(b.slice(1, -1));
}

/** Rectangle polygon for an OBB-oriented box. */
export function orientedRect(cx: number, cy: number, ux: number, uy: number, halfL: number, halfW: number): Ring {
  const vx = -uy, vy = ux;
  return [
    [cx + ux * halfL + vx * halfW, cy + uy * halfL + vy * halfW],
    [cx - ux * halfL + vx * halfW, cy - uy * halfL + vy * halfW],
    [cx - ux * halfL - vx * halfW, cy - uy * halfL - vy * halfW],
    [cx + ux * halfL - vx * halfW, cy + uy * halfL - vy * halfW],
  ];
}
