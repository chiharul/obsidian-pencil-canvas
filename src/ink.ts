import { setIcon } from "obsidian";
import type PencilCanvasPlugin from "./main";
import { Stroke, Tool } from "./types";
import { cutStroke, strokeHit } from "./geometry";

const UNDO_MAX = 100;

/** What the pen engine needs to know about the surface it is drawing on. */
export interface InkHost {
  /** pointer position → drawing units */
  toWorld(e: { clientX: number; clientY: number }): { x: number; y: number };
  /** screen pixels per drawing unit */
  zoom(): number;
  /** pixels per drawing unit before any outer zoom; used when pen size is not fixed to the drawing */
  baseScale(): number;
  /** strokes changed and should be saved */
  changed(): void;
  /** the stroke in progress changed */
  live(): void;
  /** everything needs redrawing */
  redraw(): void;
}

interface InkAct {
  kind: "stroke" | "erase";
  id: number;
  st?: Stroke;
  smooth: number;
  dec: number;
  sx: number;
  sy: number;
  sp: number;
  rawX: number;
  rawY: number;
  lx: number;
  ly: number;
  before: Stroke[];
  changed: boolean;
}

/**
 * Pen, highlighter and eraser with undo, for the places where drawing happens outside the
 * full drawing view: on a Canvas card and on the Canvas annotation layer. Sizes, colours and
 * the brush come from the plugin settings, so they match whatever was last picked in the full view.
 */
export class Ink {
  /** the tool is shared by every card and annotation layer */
  static tool: Tool = "pen";

  strokes: Stroke[] = [];
  private act: InkAct | null = null;
  private undoStack: Stroke[][] = [];
  private redoStack: Stroke[][] = [];

  constructor(private plugin: PencilCanvasPlugin, private host: InkHost) {}

  get busy() {
    return !!this.act;
  }
  get pointerId() {
    return this.act ? this.act.id : null;
  }
  /** the stroke being drawn, if any */
  get liveStroke(): Stroke | null {
    const st = this.act?.st;
    return st && st.p.length >= 3 ? st : null;
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** Replace the strokes from outside (file loaded or changed elsewhere). */
  load(strokes: Stroke[]) {
    this.strokes = strokes;
  }

  private pressure(e: PointerEvent) {
    if (e.pointerType !== "pen") return 0.5;
    return e.pressure > 0 ? Math.min(1, e.pressure) : 0.5;
  }

  down(e: PointerEvent) {
    if (this.act) return;
    const s = this.plugin.settings;
    const tool = Ink.tool;
    const isPen = e.pointerType === "pen";
    // pens with an eraser end or a barrel button erase while it is held
    const erasing = tool === "eraser" || (isPen && (e.button === 5 || (e.buttons & 32) !== 0 || (e.buttons & 2) !== 0));
    const w = this.host.toWorld(e);
    const base = { id: e.pointerId, smooth: 0, dec: 2, sx: w.x, sy: w.y, sp: 0.5, rawX: w.x, rawY: w.y, lx: w.x, ly: w.y, before: this.strokes, changed: false };
    if (erasing) {
      this.act = { ...base, kind: "erase" };
      this.erase(w.x, w.y);
      return;
    }
    const k = s.fixedSize ? 1 : 1 / this.host.baseScale(); // slider size → drawing units
    const hl = tool === "highlighter";
    const brush = hl ? null : this.plugin.lib.get(s.pen.brush);
    const st: Stroke = hl
      ? { t: "h", b: "", c: s.highlighter.color, s: s.highlighter.size * k, o: 0.4, p: [], r: (Math.random() * 1e9) | 0 }
      : { t: "p", b: brush!.id, c: s.pen.color, s: s.pen.size * k, o: s.pen.opacity, p: [], r: (Math.random() * 1e9) | 0 };
    this.act = {
      ...base,
      kind: "stroke",
      st,
      smooth: Math.min(0.97, (hl ? 0.35 : brush!.streamline) + (s.pen.smoothing || 0)),
      dec: Math.max(1, Math.min(7, Math.ceil(Math.log10(this.host.zoom())) + 2)),
    };
    this.addPoint(this.act, w.x, w.y, this.pressure(e), true);
    this.host.live();
  }

  private addPoint(a: InkAct, wx: number, wy: number, p: number, force = false) {
    const st = a.st!;
    const n = st.p.length;
    if (n && !force) {
      const k = 1 - a.smooth * 0.8;
      a.sx += (wx - a.sx) * k;
      a.sy += (wy - a.sy) * k;
      a.sp += (p - a.sp) * 0.6;
    } else {
      a.sx = wx;
      a.sy = wy;
      if (!n) a.sp = p;
    }
    a.rawX = wx;
    a.rawY = wy;
    if (n && Math.hypot(a.sx - st.p[n - 3], a.sy - st.p[n - 2]) * this.host.zoom() < 0.4) return;
    const q = Math.pow(10, a.dec);
    st.p.push(Math.round(a.sx * q) / q, Math.round(a.sy * q) / q, Math.round(a.sp * 1000) / 1000);
  }

  /** Returns true when the event belonged to the stroke in progress. */
  move(e: PointerEvent): boolean {
    const a = this.act;
    if (!a || a.id !== e.pointerId) return false;
    const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    for (const c of list.length ? list : [e]) {
      const w = this.host.toWorld(c);
      if (a.kind === "erase") this.erase(w.x, w.y);
      else this.addPoint(a, w.x, w.y, this.pressure(c));
    }
    if (a.kind === "stroke") this.host.live();
    return true;
  }

  up(e: PointerEvent, cancelled: boolean): boolean {
    const a = this.act;
    if (!a || a.id !== e.pointerId) return false;
    this.finish(cancelled);
    return true;
  }

  finish(cancelled: boolean) {
    const a = this.act;
    if (!a) return;
    this.act = null;
    if (a.kind === "stroke") {
      const st = a.st!;
      if (!cancelled && st.p.length >= 3) {
        // let the smoothed line catch up with where the pen actually ended
        if (a.smooth > 0) this.addPoint(a, a.rawX, a.rawY, a.sp, true);
        this.commit(a.before, this.strokes.concat(st));
      }
    } else if (a.changed) {
      if (cancelled) this.strokes = a.before;
      else this.commit(a.before, this.strokes);
    }
    this.host.redraw();
  }

  private erase(wx: number, wy: number) {
    const a = this.act!;
    const s = this.plugin.settings.eraser;
    const R = s.size / 2 / this.host.zoom();
    const ax = a.lx, ay = a.ly;
    a.lx = wx;
    a.ly = wy;
    const x0 = Math.min(ax, wx) - R, x1 = Math.max(ax, wx) + R;
    const y0 = Math.min(ay, wy) - R, y1 = Math.max(ay, wy) + R;
    const lib = this.plugin.lib;
    let out: Stroke[] | null = null;
    const src = this.strokes;
    for (let i = 0; i < src.length; i++) {
      const st = src[i];
      const b = lib.geoOf(st).bbox;
      let repl: Stroke[] | null = null;
      if (!(b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1)) {
        if (s.mode === "stroke") repl = strokeHit(st, ax, ay, wx, wy, R) ? [] : null;
        else repl = cutStroke(st, ax, ay, wx, wy, R);
      }
      if (repl) {
        if (!out) out = src.slice(0, i);
        for (const piece of repl) out.push(piece);
      } else if (out) out.push(st);
    }
    if (out) {
      this.strokes = out;
      a.changed = true;
      this.host.redraw();
    }
  }

  private commit(before: Stroke[], after: Stroke[]) {
    this.undoStack.push(before);
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
    this.redoStack = [];
    this.strokes = after;
    this.host.changed();
  }

  private step(from: Stroke[][], to: Stroke[][]) {
    if (this.act) return;
    const prev = from.pop();
    if (!prev) return;
    to.push(this.strokes);
    this.strokes = prev;
    this.host.changed();
    this.host.redraw();
  }

  undo() {
    this.step(this.undoStack, this.redoStack);
  }

  redo() {
    this.step(this.redoStack, this.undoStack);
  }
}

export interface InkBar {
  el: HTMLElement;
  sync(): void;
}

/** The small pen / highlighter / eraser / undo / redo bar. `extra` buttons follow, e.g. "open in a tab" and "done". */
export function buildInkBar(parent: HTMLElement, ink: Ink, extra: { icon: string; label: string; key: string; run: () => void }[]): InkBar {
  const el = parent.createDiv("pc-card-bar");
  // nothing pressed here may reach Canvas (it would drag, deselect or draw)
  for (const t of ["pointerdown", "pointerup", "click", "dblclick", "mousedown", "touchstart", "contextmenu"] as const) {
    el.addEventListener(t, (e) => e.stopPropagation());
  }
  const btn = (icon: string, label: string, key: string, fn: () => void) => {
    const b = el.createDiv({ cls: "pc-card-btn", attr: { "aria-label": label, role: "button", "data-key": key } });
    setIcon(b, icon);
    b.addEventListener("click", fn);
  };
  const tool = (t: Tool, icon: string, label: string) =>
    btn(icon, label, t, () => {
      Ink.tool = t;
      document.querySelectorAll(".pc-card-bar").forEach((x) => x.dispatchEvent(new Event("pc-sync")));
    });
  const sync = () => {
    el.querySelectorAll<HTMLElement>(".pc-card-btn").forEach((b) => {
      const key = b.dataset.key;
      b.toggleClass("is-active", key === Ink.tool);
      if (key === "undo") b.toggleClass("is-disabled", !ink.canUndo);
      if (key === "redo") b.toggleClass("is-disabled", !ink.canRedo);
    });
  };
  tool("pen", "pencil", "Pen");
  tool("highlighter", "highlighter", "Highlighter");
  tool("eraser", "eraser", "Eraser");
  el.createDiv("pc-card-sep");
  btn("undo-2", "Undo", "undo", () => ink.undo());
  btn("redo-2", "Redo", "redo", () => ink.redo());
  if (extra.length) el.createDiv("pc-card-sep");
  for (const x of extra) btn(x.icon, x.label, x.key, x.run);
  el.addEventListener("pc-sync", sync);
  sync();
  return { el, sync };
}
