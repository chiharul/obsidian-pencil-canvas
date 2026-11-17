import { Component, TFile } from "obsidian";
import type PencilCanvasPlugin from "./main";
import { DrawingFile, Img, Stroke } from "./types";
import { drawingBounds, parseDrawing, serializeDrawing } from "./doc";
import { Ink, InkBar, buildInkBar } from "./ink";

/** Longest side of the preview bitmap, in device pixels. */
const MAX_PX = 3072;

/**
 * A drawing shown wherever Obsidian embeds a file: a card in Canvas, or ![[drawing.pencil]]
 * in a note. It always shows the whole drawing, follows edits to the file, and is redrawn
 * sharper when its host zooms in. On a Canvas card you can also draw: the pencil draws
 * straight onto the card, and double-clicking it lets the mouse draw too.
 */
export class PencilEmbed extends Component {
  private root!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private live!: HTMLCanvasElement;
  private emptyEl!: HTMLElement;
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
  private bar: InkBar | null = null;
  private liveQueued = false;
  private saveTimer = 0;
  private dirty = false;
  private lastSaved: string | null = null;
  private ink: Ink;

  constructor(private plugin: PencilCanvasPlugin, private containerEl: HTMLElement, private file: TFile) {
    super();
    this.ink = new Ink(plugin, {
      toWorld: (e) => this.toWorld(e),
      zoom: () => this.zoom(),
      baseScale: () => this.frame.k,
      changed: () => this.changed(),
      live: () => this.requestLive(),
      redraw: () => this.queue(),
    });
  }

  get strokes(): Stroke[] {
    return this.ink.strokes;
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
          if (this.editing && !this.ink.busy) this.endSession(false);
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
    this.ink.finish(true);
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
    this.ink.load(doc?.strokes ?? []);
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
    const strokes = this.ink.strokes;
    const b = drawingBounds(strokes, this.images, lib);
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
    for (const st of strokes) lib.draw(ctx, st, scale);
    this.drawLive();
    this.bar?.sync();
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
    this.registerDomEvent(
      box,
      "pointermove",
      (e) => {
        if (this.ink.move(e)) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      opts
    );
    this.registerDomEvent(box, "pointerup", (e) => this.ink.up(e, false) && e.stopPropagation(), opts);
    this.registerDomEvent(box, "pointercancel", (e) => this.ink.up(e, true) && e.stopPropagation(), opts);
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
        if (this.editing && !this.ink.busy && !this.nodeEl!.contains(e.target as Node)) this.endSession();
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
    this.bar = buildInkBar(this.nodeEl!, this.ink, [
      {
        icon: "maximize-2",
        label: "Open in a tab (all tools)",
        key: "open",
        run: () => {
          this.endSession();
          this.plugin.openDrawing(this.file);
        },
      },
      { icon: "check", label: "Done", key: "done", run: () => this.endSession() },
    ]);
    this.placeBar();
  }

  endSession(refit = true) {
    if (!this.editing) return;
    this.ink.finish(false);
    this.editing = false;
    this.nodeEl?.removeClass("pc-card-drawing");
    this.bar?.el.remove();
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

  private onDown(e: PointerEvent) {
    if (this.ink.busy || !this.draws(e)) return;
    if (!this.editing) {
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
    this.ink.down(e);
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
    const st = this.ink.liveStroke;
    if (!st) return;
    this.applyFrame(ctx);
    this.plugin.lib.draw(ctx, st, this.frame.k * this.res, true);
  }

  private changed() {
    this.dirty = true;
    this.bar?.sync();
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), 500);
  }

  /** Write the drawing back to its file (which also refreshes any other place it is shown). */
  private flush() {
    window.clearTimeout(this.saveTimer);
    if (!this.dirty || !this.readable) return;
    this.dirty = false;
    const data = serializeDrawing(this.ink.strokes, this.images, this.view, this.plugin.lib);
    this.lastSaved = data;
    this.plugin.app.vault.modify(this.file, data).catch((e) => console.error("Pencil Canvas: could not save the drawing", e));
  }

  /** Canvas shrinks its cards when zoomed out; keep the toolbar finger-sized regardless. */
  private placeBar() {
    if (!this.bar) return;
    const r = this.root.getBoundingClientRect();
    const k = r.width ? this.root.clientWidth / r.width : 1;
    this.bar.el.style.transform = `translateX(-50%) scale(${+k.toFixed(4)})`;
  }
}
