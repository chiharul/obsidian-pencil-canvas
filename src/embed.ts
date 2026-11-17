import { Component, TFile, setIcon } from "obsidian";
import type PencilCanvasPlugin from "./main";
import { DrawingFile, Img, Stroke, Tool } from "./types";
import { cutStroke, strokeHit } from "./geometry";
import { drawingBounds, parseDrawing, serializeDrawing } from "./doc";

/** Longest side of the preview bitmap, in device pixels. */
const MAX_PX = 3072;
const UNDO_MAX = 100;

interface CardAct {
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
 * A drawing shown wherever Obsidian embeds a file: a card in Canvas, or ![[drawing.pencil]]
 * in a note. It always shows the whole drawing, follows edits to the file, and is redrawn
 * sharper when its host zooms in. On a Canvas card you can also draw: the pencil draws
 * straight onto the card, and double-clicking it lets the mouse draw too.
 */
export class PencilEmbed extends Component {
  /** the tool is shared by every card */
  static tool: Tool = "pen";

  private root!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private live!: HTMLCanvasElement;
  private emptyEl!: HTMLElement;
  private strokes: Stroke[] = [];
  private images: Img[] = [];
  private view: DrawingFile["view"] | null = null;
  private readable = true;
  private imgs = new Map<string, HTMLImageElement>();
  private inCanvas = false;
  private nodeEl: HTMLElement | null = null;
  private boxEl: HTMLElement | null = null;
  /** on-screen width the bitmap was last drawn for */
  private drawnW = 0;
  private queued = false;
  private libListener = () => this.queue();

  /** world → card mapping, in layout pixels; held still while drawing so nothing jumps under the pen */
  private frame = { k: 1, ox: 0, oy: 0 };
  private res = 1;
  private editing = false;
  private bar: HTMLElement | null = null;
  private act: CardAct | null = null;
  private liveQueued = false;
  private undoStack: Stroke[][] = [];
  private redoStack: Stroke[][] = [];
  private saveTimer = 0;
  private dirty = false;
  private lastSaved: string | null = null;

  constructor(private plugin: PencilCanvasPlugin, private containerEl: HTMLElement, private file: TFile) {
    super();
  }

  onload() {
    const el = this.containerEl;
    this.nodeEl = el.closest(".canvas-node") as HTMLElement | null;
    this.boxEl = el.closest(".canvas-node-container") as HTMLElement | null;
    this.inCanvas = !!this.nodeEl && !!this.boxEl;
    el.addClass("pc-embed-host");
    this.root = el.createDiv({ cls: "pc-embed" + (this.inCanvas ? " is-card" : "") });
    this.canvas = this.root.createEl("canvas");
    this.live = this.root.createEl("canvas");
    this.emptyEl = this.root.createDiv({ cls: "pc-embed-empty" });

    if (this.inCanvas) this.wireCard(this.boxEl!);
    else {
      this.registerDomEvent(this.root, "dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.plugin.openDrawing(this.file);
      });
    }

    this.registerEvent(
      this.plugin.app.vault.on("modify", (f) => {
        if (f === this.file) this.read();
      })
    );
    this.plugin.lib.listeners.add(this.libListener);
    this.register(() => this.plugin.lib.listeners.delete(this.libListener));

    const ro = new ResizeObserver(() => this.queue());
    ro.observe(this.root);
    this.register(() => ro.disconnect());
    // Canvas zooms its cards with a CSS transform, which no observer reports: check the real size now and then
    this.registerInterval(
      window.setInterval(() => {
        const r = this.root.getBoundingClientRect();
        if (!r.width) {
          // zoomed so far out that Canvas has stopped showing the card's contents
          if (this.editing && !this.act) this.endSession(false);
          return;
        }
        this.placeBar();
        if (!this.drawnW) return;
        const k = r.width / this.drawnW;
        if (k > 1.2 || k < 0.6) this.queue();
      }, 350)
    );
  }

  onunload() {
    this.finishAct(true);
    this.endSession(false);
    this.flush();
    this.root?.remove();
    this.containerEl.removeClass("pc-embed-host");
  }

  /** Called by Obsidian once the embed is in place. */
  async loadFile() {
    await this.read();
  }

  private async read() {
    let data = "";
    try {
      data = await this.plugin.app.vault.cachedRead(this.file);
    } catch {
      /* deleted meanwhile */
    }
    if (this.lastSaved !== null && data === this.lastSaved) return; // our own save coming back
    if (this.dirty) return; // newer strokes here are about to be written
    const doc = parseDrawing(data);
    this.readable = !!doc;
    this.strokes = doc?.strokes ?? [];
    this.images = doc?.images ?? [];
    this.view = doc?.view ?? null;
    if (doc) for (const id of Object.keys(doc.brushes)) this.plugin.lib.addDoc({ ...doc.brushes[id], id });
    this.emptyEl.setText(!doc ? "This drawing could not be read" : this.inCanvas ? "Empty drawing · draw here with the pencil, or double-click" : "Empty drawing");
    this.render();
  }

  private queue() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  private img(src: string): HTMLImageElement | null {
    let el = this.imgs.get(src);
    if (!el) {
      el = new Image();
      this.imgs.set(src, el);
      el.onload = () => this.queue();
      el.src = this.plugin.app.vault.adapter.getResourcePath(src);
    }
    return el.complete && el.naturalWidth > 0 ? el : null;
  }

  private render() {
    if (!this.root?.isConnected) return;
    const lib = this.plugin.lib;
    const b = drawingBounds(this.strokes, this.images, lib);
    this.root.toggleClass("is-empty", !b && !this.editing);
    let bw = 4, bh = 3, bx = 0, by = 0;
    if (b) {
      // a little air around the drawing
      const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.04 + 2;
      bx = b[0] - pad;
      by = b[1] - pad;
      bw = b[2] - b[0] + pad * 2;
      bh = b[3] - b[1] + pad * 2;
      // in a note the box takes the drawing's own proportions; a Canvas card keeps whatever size it was given
      if (!this.inCanvas) this.root.style.aspectRatio = `${+bw.toFixed(2)} / ${+bh.toFixed(2)}`;
    } else if (!this.inCanvas) this.root.style.removeProperty("aspect-ratio");

    // layout size, and the size it really has on screen (Canvas scales cards with a transform)
    const lw = this.root.clientWidth, lh = this.root.clientHeight;
    const r = this.root.getBoundingClientRect();
    if (!lw || !lh || !r.width) return;
    if (!this.editing) {
      if (b) {
        const k = Math.min(lw / bw, lh / bh);
        this.frame = { k, ox: (lw - bw * k) / 2 - bx * k, oy: (lh - bh * k) / 2 - by * k };
      } else this.frame = { k: 1, ox: lw / 2, oy: lh / 2 }; // blank: one unit per pixel, origin in the middle
    }
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    let res = Math.max(0.5, r.width / lw) * dpr;
    res = Math.min(res, MAX_PX / Math.max(lw, lh));
    this.res = res;
    const W = Math.max(1, Math.round(lw * res)), H = Math.max(1, Math.round(lh * res));
    for (const c of [this.canvas, this.live]) {
      if (c.width !== W) c.width = W;
      if (c.height !== H) c.height = H;
    }
    this.drawnW = r.width;

    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this.applyFrame(ctx);
    for (const im of this.images) {
      const el = this.img(im.src);
      ctx.save();
      ctx.translate(im.x, im.y);
      if (im.r) ctx.rotate(im.r);
      if (el) ctx.drawImage(el, -im.w / 2, -im.h / 2, im.w, im.h);
      else {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = "#888";
        ctx.fillRect(-im.w / 2, -im.h / 2, im.w, im.h);
      }
      ctx.restore();
    }
    const scale = this.frame.k * res;
    for (const st of this.strokes) lib.draw(ctx, st, scale);
    this.drawLive();
  }

  private applyFrame(ctx: CanvasRenderingContext2D) {
    const f = this.frame, r = this.res;
    ctx.setTransform(f.k * r, 0, 0, f.k * r, f.ox * r, f.oy * r);
  }

  // ------------------------------------------------------------- drawing on a Canvas card

  private wireCard(box: HTMLElement) {
    // Capture phase, so the pencil reaches the drawing before Canvas turns it into a card drag.
    const opts = { capture: true };
    this.registerDomEvent(box, "pointerdown", (e) => this.onDown(e), opts);
    this.registerDomEvent(box, "pointermove", (e) => this.onMove(e), opts);
    this.registerDomEvent(box, "pointerup", (e) => this.onUp(e, false), opts);
    this.registerDomEvent(box, "pointercancel", (e) => this.onUp(e, true), opts);
    this.registerDomEvent(box, "dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.startSession();
    });
    // keep the pencil's own touch events away from Canvas's pan / zoom handling
    const stylus = (e: TouchEvent) => {
      const t = e.changedTouches[0] as (Touch & { touchType?: string }) | undefined;
      if (t?.touchType === "stylus" && this.penAllowed()) e.stopPropagation();
    };
    for (const type of ["touchstart", "touchmove", "touchend"] as const) this.registerDomEvent(box, type, stylus, opts);
    // tapping anywhere outside the card, or Escape, finishes the drawing session
    this.registerDomEvent(
      document,
      "pointerdown",
      (e) => {
        if (this.editing && !this.act && !this.nodeEl!.contains(e.target as Node)) this.endSession();
      },
      opts
    );
    this.registerDomEvent(document, "keydown", (e) => {
      if (this.editing && e.key === "Escape") this.endSession();
    });
  }

  private readonlyCanvas(): boolean {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("canvas")) {
      const v = leaf.view as any;
      if (v?.contentEl?.contains(this.root)) return !!v.canvas?.readonly;
    }
    return false;
  }

  private penAllowed() {
    return this.readable && this.plugin.settings.cardDraw !== false;
  }

  private draws(e: PointerEvent): boolean {
    if (!this.readable) return false;
    if (e.pointerType === "pen") return this.editing || this.penAllowed();
    if (!this.editing) return false;
    if (e.pointerType === "touch") return this.plugin.settings.fingerDraw;
    return e.button === 0;
  }

  /** Double-click, the card menu, or the first pencil stroke: the picture stops refitting and the toolbar appears. */
  startSession() {
    if (this.editing || !this.inCanvas || !this.readable || this.readonlyCanvas()) return;
    this.render(); // settle the frame before it is held still
    this.editing = true;
    this.root.removeClass("is-empty");
    this.nodeEl!.addClass("pc-card-drawing");
    this.buildBar();
  }

  endSession(refit = true) {
    if (!this.editing) return;
    this.finishAct(false);
    this.editing = false;
    this.nodeEl?.removeClass("pc-card-drawing");
    this.bar?.remove();
    this.bar = null;
    this.flush();
    if (refit) this.render();
  }

  private toWorld(e: { clientX: number; clientY: number }) {
    const r = this.root.getBoundingClientRect();
    const lx = ((e.clientX - r.left) * this.root.clientWidth) / (r.width || 1);
    const ly = ((e.clientY - r.top) * this.root.clientHeight) / (r.height || 1);
    return { x: (lx - this.frame.ox) / this.frame.k, y: (ly - this.frame.oy) / this.frame.k };
  }

  /** screen pixels per world unit, counting Canvas's own zoom */
  private zoom() {
    const r = this.root.getBoundingClientRect();
    return (this.frame.k * r.width) / (this.root.clientWidth || 1);
  }

  private pressure(e: PointerEvent) {
    if (e.pointerType !== "pen") return 0.5;
    return e.pressure > 0 ? Math.min(1, e.pressure) : 0.5;
  }

  private onDown(e: PointerEvent) {
    if (this.act || !this.draws(e)) return;
    if (!this.editing) {
      if (this.readonlyCanvas()) return;
      this.startSession();
      if (!this.editing) return;
    }
    e.stopPropagation();
    e.preventDefault();
    try {
      this.boxEl!.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already released */
    }
    const s = this.plugin.settings;
    const tool = PencilEmbed.tool;
    const isPen = e.pointerType === "pen";
    const erasing = tool === "eraser" || (isPen && (e.button === 5 || (e.buttons & 32) !== 0 || (e.buttons & 2) !== 0));
    const w = this.toWorld(e);
    const base = { id: e.pointerId, smooth: 0, dec: 2, sx: w.x, sy: w.y, sp: 0.5, rawX: w.x, rawY: w.y, lx: w.x, ly: w.y, before: this.strokes, changed: false };
    if (erasing) {
      this.act = { ...base, kind: "erase" };
      this.erase(w.x, w.y);
      return;
    }
    const k = s.fixedSize ? 1 : 1 / this.frame.k; // slider size → drawing units
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
      dec: Math.max(1, Math.min(7, Math.ceil(Math.log10(this.zoom())) + 2)),
    };
    this.addPoint(this.act, w.x, w.y, this.pressure(e), true);
    this.requestLive();
  }

  private addPoint(a: CardAct, wx: number, wy: number, p: number, force = false) {
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
    if (n && Math.hypot(a.sx - st.p[n - 3], a.sy - st.p[n - 2]) * this.zoom() < 0.4) return;
    const q = Math.pow(10, a.dec);
    st.p.push(Math.round(a.sx * q) / q, Math.round(a.sy * q) / q, Math.round(a.sp * 1000) / 1000);
  }

  private onMove(e: PointerEvent) {
    const a = this.act;
    if (!a || a.id !== e.pointerId) return;
    e.stopPropagation();
    e.preventDefault();
    const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    for (const c of list.length ? list : [e]) {
      const w = this.toWorld(c);
      if (a.kind === "erase") this.erase(w.x, w.y);
      else this.addPoint(a, w.x, w.y, this.pressure(c));
    }
    if (a.kind === "stroke") this.requestLive();
  }

  private onUp(e: PointerEvent, cancelled: boolean) {
    const a = this.act;
    if (!a || a.id !== e.pointerId) return;
    e.stopPropagation();
    this.finishAct(cancelled);
  }

  private finishAct(cancelled: boolean) {
    const a = this.act;
    if (!a) return;
    this.act = null;
    if (a.kind === "stroke") {
      const st = a.st!;
      if (!cancelled && st.p.length >= 3) {
        if (a.smooth > 0) this.addPoint(a, a.rawX, a.rawY, a.sp, true);
        this.commit(a.before, this.strokes.concat(st));
      }
    } else if (a.changed) {
      if (cancelled) this.strokes = a.before;
      else this.commit(a.before, this.strokes);
    }
    this.render();
  }

  private erase(wx: number, wy: number) {
    const a = this.act!;
    const s = this.plugin.settings.eraser;
    const R = s.size / 2 / this.zoom();
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
      this.queue();
    }
  }

  private requestLive() {
    if (this.liveQueued) return;
    this.liveQueued = true;
    requestAnimationFrame(() => {
      this.liveQueued = false;
      this.drawLive();
    });
  }

  /** The stroke being drawn lives on its own layer until the pen lifts. */
  private drawLive() {
    const ctx = this.live.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    const st = this.act?.st;
    if (!st || st.p.length < 3) return;
    this.applyFrame(ctx);
    this.plugin.lib.draw(ctx, st, this.frame.k * this.res, true);
  }

  private commit(before: Stroke[], after: Stroke[]) {
    this.undoStack.push(before);
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
    this.redoStack = [];
    this.strokes = after;
    this.changed();
  }

  private changed() {
    this.dirty = true;
    this.syncBar();
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), 500);
  }

  /** Write the drawing back to its file (which also refreshes any other place it is shown). */
  private flush() {
    window.clearTimeout(this.saveTimer);
    if (!this.dirty || !this.readable) return;
    this.dirty = false;
    const data = serializeDrawing(this.strokes, this.images, this.view, this.plugin.lib);
    this.lastSaved = data;
    this.plugin.app.vault.modify(this.file, data).catch((e) => console.error("Pencil Canvas: could not save the drawing", e));
  }

  private step(from: Stroke[][], to: Stroke[][]) {
    const prev = from.pop();
    if (!prev || this.act) return;
    to.push(this.strokes);
    this.strokes = prev;
    this.changed();
    this.render();
  }

  // ------------------------------------------------------------- the card's toolbar

  private buildBar() {
    const bar = (this.bar = this.nodeEl!.createDiv("pc-card-bar"));
    // nothing pressed here may reach Canvas (it would drag or deselect the card)
    for (const t of ["pointerdown", "pointerup", "click", "dblclick", "mousedown", "touchstart", "contextmenu"] as const) {
      bar.addEventListener(t, (e) => e.stopPropagation());
    }
    const btn = (icon: string, label: string, key: string, fn: () => void) => {
      const b = bar.createDiv({ cls: "pc-card-btn", attr: { "aria-label": label, role: "button", "data-key": key } });
      setIcon(b, icon);
      b.addEventListener("click", fn);
      return b;
    };
    const tool = (t: Tool, icon: string, label: string) =>
      btn(icon, label, t, () => {
        PencilEmbed.tool = t;
        document.querySelectorAll(".pc-card-bar").forEach((el) => el.dispatchEvent(new Event("pc-sync")));
      });
    tool("pen", "pencil", "Pen");
    tool("highlighter", "highlighter", "Highlighter");
    tool("eraser", "eraser", "Eraser");
    bar.createDiv("pc-card-sep");
    btn("undo-2", "Undo", "undo", () => this.step(this.undoStack, this.redoStack));
    btn("redo-2", "Redo", "redo", () => this.step(this.redoStack, this.undoStack));
    bar.createDiv("pc-card-sep");
    btn("maximize-2", "Open in a tab (all tools)", "open", () => {
      this.endSession();
      this.plugin.openDrawing(this.file);
    });
    btn("check", "Done", "done", () => this.endSession());
    bar.addEventListener("pc-sync", () => this.syncBar());
    this.syncBar();
    this.placeBar();
  }

  private syncBar() {
    if (!this.bar) return;
    this.bar.querySelectorAll<HTMLElement>(".pc-card-btn").forEach((b) => {
      const key = b.dataset.key;
      b.toggleClass("is-active", key === PencilEmbed.tool);
      if (key === "undo") b.toggleClass("is-disabled", !this.undoStack.length);
      if (key === "redo") b.toggleClass("is-disabled", !this.redoStack.length);
    });
  }

  /** Canvas shrinks its cards when zoomed out; keep the toolbar finger-sized regardless. */
  private placeBar() {
    if (!this.bar) return;
    const r = this.root.getBoundingClientRect();
    const k = r.width ? this.root.clientWidth / r.width : 1;
    this.bar.style.transform = `translateX(-50%) scale(${+k.toFixed(4)})`;
  }
}
