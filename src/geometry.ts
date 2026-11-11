import { Brush, Stroke } from "./types";

export const HL_BRUSH: Brush = {
  id: "__hl",
  name: "Highlighter",
  source: "builtin",
  spacing: 0.1,
  sizePressure: 0,
  opacityPressure: 0,
  minSize: 1,
  opacity: 1,
  jitter: 0,
  sizeJitter: 0,
  opacityJitter: 0,
  rotJitter: 0,
  followStroke: false,
  angle: 0,
  taperStart: 0,
  taperEnd: 0,
  streamline: 0.35,
};

export type BBox = [number, number, number, number];

export interface Geo {
  /** resampled centre line: x, y, radius, alpha per sample */
  samples: Float64Array;
  bbox: BBox;
  path?: Path2D;
  /** x, y, size, rotation, alpha per stamp */
  stamps?: Float32Array;
}

function rng(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pressure 0.5 (mouse / finger) always gives exactly the nominal width. */
function sizeFactor(b: Brush, p: number) {
  const f = b.minSize + (1 - b.minSize) * Math.min(1.6, p * 2);
  return 1 + (f - 1) * b.sizePressure;
}

function opacityFactor(b: Brush, p: number) {
  const g = Math.min(1, p * 1.5);
  return 1 + (g - 1) * b.opacityPressure;
}

const ease = (t: number) => 0.1 + 0.9 * Math.sin((Math.max(0, Math.min(1, t)) * Math.PI) / 2);

/** Smooth the raw points with a Catmull-Rom spline and compute width / alpha along it. */
export function sampleStroke(st: Stroke, b: Brush): Float64Array {
  const P = st.p;
  const n = (P.length / 3) | 0;
  const s = st.s;
  if (n === 0) return new Float64Array(0);
  const step = Math.max(s * 0.25, 1e-9);
  const tmp: number[] = [P[0], P[1], P[2], 0];
  let d = 0;
  let px = P[0];
  let py = P[1];
  for (let i = 0; i < n - 1; i++) {
    const i0 = Math.max(i - 1, 0) * 3;
    const i1 = i * 3;
    const i2 = (i + 1) * 3;
    const i3 = Math.min(i + 2, n - 1) * 3;
    const x0 = P[i0], y0 = P[i0 + 1];
    const x1 = P[i1], y1 = P[i1 + 1], p1 = P[i1 + 2];
    const x2 = P[i2], y2 = P[i2 + 1], p2 = P[i2 + 2];
    const x3 = P[i3], y3 = P[i3 + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const k = Math.min(8, Math.max(1, Math.ceil(len / step)));
    for (let j = 1; j <= k; j++) {
      const t = j / k;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (2 * x1 + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3);
      const y = 0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
      d += Math.hypot(x - px, y - py);
      px = x;
      py = y;
      tmp.push(x, y, p1 + (p2 - p1) * t, d);
    }
  }
  const m = tmp.length / 4;
  const total = d;
  const flags = st.k ?? 0;
  let ls = flags & 1 ? 0 : b.taperStart * s * 6;
  let le = flags & 2 ? 0 : b.taperEnd * s * 6;
  if (ls + le > total) {
    const q = ls + le > 0 ? total / (ls + le) : 0;
    ls *= q;
    le *= q;
  }
  const out = new Float64Array(m * 4);
  for (let i = 0; i < m; i++) {
    const p = tmp[i * 4 + 2];
    const di = tmp[i * 4 + 3];
    let f = 1;
    if (ls > 0 && di < ls) f *= ease(di / ls);
    if (le > 0 && total - di < le) f *= ease((total - di) / le);
    out[i * 4] = tmp[i * 4];
    out[i * 4 + 1] = tmp[i * 4 + 1];
    out[i * 4 + 2] = Math.max(s * 0.5 * sizeFactor(b, p) * f, s * 0.03);
    out[i * 4 + 3] = opacityFactor(b, p);
  }
  return out;
}

/**
 * Variable-width outline as a union of circles and quads. Every sub-path has the
 * same winding so a non-zero fill gives one solid shape with uniform opacity.
 */
function outline(S: Float64Array, circle: (x: number, y: number, r: number) => void, quad: (q: number[]) => void) {
  const m = S.length / 4;
  for (let i = 0; i < m; i++) {
    const x = S[i * 4], y = S[i * 4 + 1], r = S[i * 4 + 2];
    circle(x, y, r);
    if (i + 1 < m) {
      const x2 = S[i * 4 + 4], y2 = S[i * 4 + 5], r2 = S[i * 4 + 6];
      const dx = x2 - x, dy = y2 - y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) continue;
      const nx = dy / len, ny = -dx / len;
      quad([x + nx * r, y + ny * r, x2 + nx * r2, y2 + ny * r2, x2 - nx * r2, y2 - ny * r2, x - nx * r, y - ny * r]);
    }
  }
}

export function buildPath(S: Float64Array): Path2D {
  const path = new Path2D();
  outline(
    S,
    (x, y, r) => {
      path.moveTo(x + r, y);
      path.arc(x, y, r, 0, Math.PI * 2);
    },
    (q) => {
      path.moveTo(q[0], q[1]);
      path.lineTo(q[2], q[3]);
      path.lineTo(q[4], q[5]);
      path.lineTo(q[6], q[7]);
      path.closePath();
    }
  );
  return path;
}

export function svgPath(S: Float64Array, f: (v: number) => string): string {
  const parts: string[] = [];
  outline(
    S,
    (x, y, r) => {
      const R = f(r);
      parts.push(`M${f(x + r)} ${f(y)}A${R} ${R} 0 1 1 ${f(x - r)} ${f(y)}A${R} ${R} 0 1 1 ${f(x + r)} ${f(y)}Z`);
    },
    (q) => parts.push(`M${f(q[0])} ${f(q[1])}L${f(q[2])} ${f(q[3])}L${f(q[4])} ${f(q[5])}L${f(q[6])} ${f(q[7])}Z`)
  );
  return parts.join("");
}

const MAX_STAMPS = 30000;

/** Place brush-tip stamps along the centre line. Deterministic per stroke. */
export function buildStamps(S: Float64Array, st: Stroke, b: Brush): Float32Array {
  const m = S.length / 4;
  const out: number[] = [];
  const rand = rng(st.r ?? 1);
  const emit = (x: number, y: number, r: number, a: number, dir: number) => {
    let size = 2 * r;
    if (b.sizeJitter) size *= 1 - b.sizeJitter * rand();
    if (b.jitter) {
      const ang = rand() * Math.PI * 2;
      const mag = rand() * b.jitter * 2 * r;
      x += Math.cos(ang) * mag;
      y += Math.sin(ang) * mag;
    }
    let rot = b.angle + (b.followStroke ? dir : 0);
    if (b.rotJitter) rot += (rand() - 0.5) * Math.PI * 2 * b.rotJitter;
    let alpha = b.opacity * a;
    if (b.opacityJitter) alpha *= 1 - b.opacityJitter * rand();
    out.push(x, y, size, rot, alpha);
  };
  if (m === 1) {
    emit(S[0], S[1], S[2], S[3], 0);
    return new Float32Array(out);
  }
  const minGap = st.s * 0.02;
  let dist = 0;
  let next = 0;
  for (let i = 0; i + 1 < m && out.length < MAX_STAMPS * 5; i++) {
    const x1 = S[i * 4], y1 = S[i * 4 + 1], r1 = S[i * 4 + 2], a1 = S[i * 4 + 3];
    const x2 = S[i * 4 + 4], y2 = S[i * 4 + 5], r2 = S[i * 4 + 6], a2 = S[i * 4 + 7];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1e-12) continue;
    const dir = Math.atan2(y2 - y1, x2 - x1);
    while (next <= dist + len && out.length < MAX_STAMPS * 5) {
      const t = (next - dist) / len;
      const r = r1 + (r2 - r1) * t;
      emit(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, r, a1 + (a2 - a1) * t, dir);
      next += Math.max(b.spacing * 2 * r, minGap);
    }
    dist += len;
  }
  return new Float32Array(out);
}

export function strokeBBox(st: Stroke, b: Brush): BBox {
  const P = st.p;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    if (P[i] < x0) x0 = P[i];
    if (P[i] > x1) x1 = P[i];
    if (P[i + 1] < y0) y0 = P[i + 1];
    if (P[i + 1] > y1) y1 = P[i + 1];
  }
  const pad = st.s * (1.1 + 2 * (b.jitter || 0));
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

export function makeGeo(st: Stroke, b: Brush): Geo {
  return { samples: sampleStroke(st, b), bbox: strokeBBox(st, b) };
}

// ---------------------------------------------------------------- eraser

function distPtSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function segSegDist(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(cx, cy, dx, dy, ax, ay);
  const d2 = o(cx, cy, dx, dy, bx, by);
  const d3 = o(ax, ay, bx, by, cx, cy);
  const d4 = o(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(
    distPtSeg(ax, ay, cx, cy, dx, dy),
    distPtSeg(bx, by, cx, cy, dx, dy),
    distPtSeg(cx, cy, ax, ay, bx, by),
    distPtSeg(dx, dy, ax, ay, bx, by)
  );
}

/** Does the eraser sweep a→b (radius R) touch this stroke? */
export function strokeHit(st: Stroke, ax: number, ay: number, bx: number, by: number, R: number): boolean {
  const P = st.p;
  const n = P.length / 3;
  const reach = R + st.s * 0.4;
  if (n === 1) return distPtSeg(P[0], P[1], ax, ay, bx, by) <= reach;
  for (let i = 0; i + 1 < n; i++) {
    if (segSegDist(P[i * 3], P[i * 3 + 1], P[i * 3 + 3], P[i * 3 + 4], ax, ay, bx, by) <= reach) return true;
  }
  return false;
}

/**
 * Vector erase: remove the part of the stroke under the eraser sweep and return
 * the remaining pieces as new strokes. Returns null when nothing was touched.
 */
export function cutStroke(st: Stroke, ax: number, ay: number, bx: number, by: number, R: number): Stroke[] | null {
  if (!strokeHit(st, ax, ay, bx, by, R)) return null;
  const P = st.p;
  const n = P.length / 3;
  const reach = R + st.s * 0.25;
  const step = Math.max(R * 0.4, st.s * 0.1, 1e-9);
  // densify so the cut edge is precise
  const D: number[] = [P[0], P[1], P[2]];
  for (let i = 0; i + 1 < n; i++) {
    const x1 = P[i * 3], y1 = P[i * 3 + 1], p1 = P[i * 3 + 2];
    const x2 = P[i * 3 + 3], y2 = P[i * 3 + 4], p2 = P[i * 3 + 5];
    const k = Math.min(64, Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step)));
    for (let j = 1; j <= k; j++) {
      const t = j / k;
      D.push(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, p1 + (p2 - p1) * t);
    }
  }
  const m = D.length / 3;
  const pieces: Stroke[] = [];
  let run: number[] = [];
  let runStart = 0;
  let any = false;
  const flush = (end: number) => {
    if (run.length >= 6) {
      let k = st.k ?? 0;
      if (runStart > 0) k |= 1;
      if (end < m) k |= 2;
      pieces.push({ ...st, p: run, k });
    }
    run = [];
  };
  for (let i = 0; i < m; i++) {
    const erased = distPtSeg(D[i * 3], D[i * 3 + 1], ax, ay, bx, by) <= reach;
    if (erased) {
      any = true;
      flush(i);
    } else {
      if (!run.length) runStart = i;
      run.push(D[i * 3], D[i * 3 + 1], D[i * 3 + 2]);
    }
  }
  if (!any) return null;
  flush(m);
  return pieces;
}
