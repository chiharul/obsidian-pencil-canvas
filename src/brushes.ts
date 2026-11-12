import { Brush, Stroke } from "./types";
import { Geo, HL_BRUSH, buildLine, buildPath, buildStamps, makeGeo } from "./geometry";

const base: Omit<Brush, "id" | "name"> = {
  source: "builtin",
  spacing: 0.1,
  sizePressure: 0,
  opacityPressure: 0,
  minSize: 0.1,
  opacity: 1,
  jitter: 0,
  sizeJitter: 0,
  opacityJitter: 0,
  rotJitter: 0,
  followStroke: false,
  angle: 0,
  taperStart: 0,
  taperEnd: 0,
  streamline: 0.3,
};

export const BRUSH_DEFAULTS = base;

export const BUILTIN: Brush[] = [
  { ...base, id: "ink", name: "Ink pen", sizePressure: 0.75, minSize: 0.15, taperStart: 0.12, taperEnd: 0.25 },
  { ...base, id: "mono", name: "Monoline", streamline: 0.4 },
  { ...base, id: "brushpen", name: "Brush pen", sizePressure: 1, minSize: 0.04, taperStart: 0.5, taperEnd: 0.8, streamline: 0.45 },
  {
    ...base, id: "pencil", name: "Pencil", tip: "builtin:grain", spacing: 0.14, opacity: 0.55,
    sizePressure: 0.25, opacityPressure: 0.85, rotJitter: 1, jitter: 0.04, streamline: 0.15,
  },
  { ...base, id: "airbrush", name: "Airbrush", tip: "builtin:soft", spacing: 0.08, opacity: 0.14, opacityPressure: 0.7 },
];

const BUILTIN_MAP = new Map(BUILTIN.map((b) => [b.id, b]));

function proceduralTip(kind: string): HTMLCanvasElement {
  const n = 64;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(n, n);
  let seed = 1234567;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
      let a = 0;
      if (d < 1) {
        if (kind === "soft") a = Math.pow(1 - d, 1.6);
        else {
          const edge = Math.min(1, (1 - d) * 4);
          const r = rand();
          a = r > 0.42 ? edge * (0.35 + 0.65 * rand()) : 0;
        }
      }
      const i = (y * n + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function brushHash(b: Omit<Brush, "id">): string {
  const s = JSON.stringify(b);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export class BrushLibrary {
  user: Brush[] = [];
  private doc = new Map<string, Brush>();
  private tips = new Map<string, HTMLCanvasElement | null>();
  private tints = new Map<string, HTMLCanvasElement>();
  private geo = new WeakMap<Stroke, Geo>();
  listeners = new Set<() => void>();

  constructor() {
    this.tips.set("builtin:grain", proceduralTip("grain"));
    this.tips.set("builtin:soft", proceduralTip("soft"));
  }

  private changed() {
    this.geo = new WeakMap();
    this.tints.clear();
    this.listeners.forEach((f) => f());
  }

  all(): Brush[] {
    return [...BUILTIN, ...this.user];
  }

  has(id: string) {
    return BUILTIN_MAP.has(id) || this.user.some((b) => b.id === id);
  }

  get(id: string): Brush {
    return BUILTIN_MAP.get(id) ?? this.user.find((b) => b.id === id) ?? this.doc.get(id) ?? BUILTIN[0];
  }

  isBuiltin(id: string) {
    return BUILTIN_MAP.has(id);
  }

  setUser(list: Brush[]) {
    this.user = list;
    this.changed();
  }

  /** Returns how many were new. */
  add(list: Brush[]): number {
    let added = 0;
    for (const b of list) {
      if (this.has(b.id)) continue;
      this.user.push(b);
      added++;
    }
    if (added) this.changed();
    return added;
  }

  remove(id: string) {
    const b = this.user.find((x) => x.id === id);
    if (!b) return;
    // keep it available for drawings that are currently open
    this.doc.set(id, b);
    this.user = this.user.filter((x) => x.id !== id);
    this.changed();
  }

  /** Brushes embedded in a drawing file. */
  addDoc(b: Brush) {
    if (this.has(b.id) || this.doc.has(b.id)) return;
    this.doc.set(b.id, b);
  }

  /** The alpha-mask tip, or null when the brush is a pure vector outline (or still loading). */
  tip(b: Brush): HTMLCanvasElement | null {
    if (!b.tip) return null;
    const key = b.tip.startsWith("builtin:") ? b.tip : b.id;
    const c = this.tips.get(key);
    if (c !== undefined) return c;
    this.tips.set(key, null);
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth || 1;
      cv.height = img.naturalHeight || 1;
      cv.getContext("2d")!.drawImage(img, 0, 0);
      this.tips.set(key, cv);
      this.changed();
    };
    img.src = b.tip;
    return null;
  }

  private tinted(b: Brush, tip: HTMLCanvasElement, color: string): HTMLCanvasElement {
    const key = b.id + "|" + color;
    let c = this.tints.get(key);
    if (c) return c;
    if (this.tints.size > 80) this.tints.clear();
    c = document.createElement("canvas");
    c.width = tip.width;
    c.height = tip.height;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(tip, 0, 0);
    this.tints.set(key, c);
    return c;
  }

  brushOf(st: Stroke): Brush {
    return st.t === "h" ? HL_BRUSH : this.get(st.b);
  }

  geoOf(st: Stroke): Geo {
    let g = this.geo.get(st);
    if (!g) {
      g = makeGeo(st, this.brushOf(st));
      this.geo.set(st, g);
    }
    return g;
  }

  /**
   * Draw one stroke. `ctx` must already carry the world→screen transform;
   * `scale` is the number of device pixels per world unit.
   */
  draw(ctx: CanvasRenderingContext2D, st: Stroke, scale: number, live = false) {
    const b = this.brushOf(st);
    const g = live ? makeGeo(st, b) : this.geoOf(st);
    if (!g.samples.length) return;
    const tip = st.t === "p" ? this.tip(b) : null;
    if (tip && st.s * scale >= 1.5) {
      if (!g.stamps) g.stamps = buildStamps(g.samples, st, b);
      const img = this.tinted(b, tip, st.c);
      const S = g.stamps;
      const aspect = tip.height / tip.width;
      const rotates = b.followStroke || b.rotJitter > 0 || b.angle !== 0;
      for (let i = 0; i < S.length; i += 5) {
        const size = S[i + 2];
        const w = aspect > 1 ? size / aspect : size;
        const h = aspect > 1 ? size : size * aspect;
        ctx.globalAlpha = Math.min(1, st.o * S[i + 4]);
        if (rotates) {
          ctx.save();
          ctx.translate(S[i], S[i + 1]);
          ctx.rotate(S[i + 3]);
          ctx.drawImage(img, -w / 2, -h / 2, w, h);
          ctx.restore();
        } else {
          ctx.drawImage(img, S[i] - w / 2, S[i + 1] - h / 2, w, h);
        }
      }
    } else {
      const alpha = tip ? Math.min(1, st.o * Math.min(1, b.opacity * 2.5)) : st.o;
      // Parts of a stroke thinner than a screen pixel rasterise as a broken, speckled
      // line. Back them with a 1-pixel-wide centre line so the stroke stays solid.
      const hair = 1.15 / scale;
      const thin = g.minR * 2 < hair;
      if (thin) {
        if (!g.line) g.line = buildLine(g.samples);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = st.c;
      }
      if (thin && g.meanR * 2 < hair * 1.6) {
        // the whole stroke is hair-thin: one clean line, faded instead of narrowed
        ctx.lineWidth = Math.max(g.meanR * 2, hair);
        ctx.globalAlpha = alpha * Math.max(0.3, Math.min(1, (g.meanR * 2) / hair));
        ctx.stroke(g.line!);
      } else {
        ctx.globalAlpha = alpha;
        if (thin && alpha >= 0.99) {
          ctx.lineWidth = hair;
          ctx.stroke(g.line!);
        }
        if (!g.path) g.path = buildPath(g.samples);
        ctx.fillStyle = st.c;
        ctx.fill(g.path);
      }
    }
    ctx.globalAlpha = 1;
  }
}
