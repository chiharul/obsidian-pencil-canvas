import { Component, TFile, normalizePath, setIcon } from "obsidian";
import type PencilCanvasPlugin from "./main";
import { DrawingFile, Img } from "./types";
import { parseDrawing, serializeDrawing } from "./doc";
import { Ink, InkBar, buildInkBar } from "./ink";

/** Annotations for "Board.canvas" are kept next to it in "Board.ink.pencil". */
export function inkPathFor(canvasPath: string): string {
  return normalizePath(canvasPath.replace(/\.canvas$/i, "") + ".ink.pencil");
}

/**
 * A layer of ink over a whole Obsidian Canvas: strokes live in the canvas's own coordinates,
 * so they stay put next to the cards while you pan and zoom. The pencil draws on any empty
 * part of the canvas; with "Annotate" switched on it (and the mouse) draws over cards too.
 */
export class CanvasInk extends Component {
  private wrapper!: HTMLElement;
  private layer!: HTMLCanvasElement;
  private live!: HTMLCanvasElement;
  private toggleEl: HTMLElement | null = null;
  private bar: InkBar | null = null;
  private ink: Ink;
  private images: Img[] = [];
  private docView: DrawingFile["view"] | null = null;
  private readable = true;
  private mode = false;
  private canvasPath = "";
  private raf = 0;
  private sig = "";
  private dirty = false;
  private saveTimer = 0;
  private lastSaved: string | null = null;
  private saving: Promise<unknown> = Promise.resolve();
  private libListener = () => (this.sig = "");

  constructor(private plugin: PencilCanvasPlugin, private view: any) {
    super();
    this.ink = this.freshInk();
  }

  private get cv(): any {
    return this.view.canvas;
  }

  onload() {
    const cv = this.cv;
    this.wrapper = cv.wrapperEl as HTMLElement;
    this.layer = this.wrapper.createEl("canvas", { cls: "pc-ink-layer" });
    this.live = this.wrapper.createEl("canvas", { cls: "pc-ink-layer" });

    const controls: HTMLElement | null = cv.canvasControlsEl ?? this.wrapper.querySelector(".canvas-controls");
    if (controls) {
      const group = controls.createDiv("canvas-control-group pc-ink-group");
      this.toggleEl = group.createDiv({ cls: "canvas-control-item", attr: { "aria-label": "Annotate: draw on the canvas", "data-tooltip-position": "left" } });
      setIcon(this.toggleEl, "pencil-line");
      this.toggleEl.addEventListener("click", () => this.setMode(!this.mode));
      this.register(() => group.remove());
    }

    // Capture phase, so the stroke starts before Canvas turns the press into a pan, selection or card drag.
    const opts = { capture: true };
    this.registerDomEvent(this.wrapper, "pointerdown", (e) => this.onDown(e), opts);
    this.registerDomEvent(
      this.wrapper,
      "pointermove",
      (e) => {
        if (this.ink.move(e)) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      opts
    );
    this.registerDomEvent(this.wrapper, "pointerup", (e) => this.ink.up(e, false) && e.stopPropagation(), opts);
    this.registerDomEvent(this.wrapper, "pointercancel", (e) => this.ink.up(e, true) && e.stopPropagation(), opts);
    // keep the pencil's own touch events away from Canvas's pan / zoom handling while it is drawing
    const stylus = (e: TouchEvent) => {
      const t = e.changedTouches[0] as (Touch & { touchType?: string }) | undefined;
      if (t?.touchType === "stylus" && (this.ink.busy || this.wouldDraw("pen", 0, e.target))) e.stopPropagation();
    };
    for (const type of ["touchstart", "touchmove", "touchend"] as const) this.registerDomEvent(this.wrapper, type, stylus, opts);
    this.registerDomEvent(document, "keydown", (e) => {
      if (this.mode && e.key === "Escape" && this.wrapper.isConnected && this.wrapper.offsetParent) this.setMode(false);
    });

    this.registerEvent(
      this.plugin.app.vault.on("modify", (f) => {
        if (f.path === inkPathFor(this.canvasPath)) this.read();
      })
    );
    this.registerEvent(
      this.plugin.app.vault.on("rename", (f) => {
        if (f.path === inkPathFor(this.canvasPath)) this.read();
      })
    );
    this.registerEvent(
      this.plugin.app.vault.on("delete", (f) => {
        if (f.path === inkPathFor(this.canvasPath) && !this.dirty) {
          this.lastSaved = null;
          this.ink.load([]);
          this.sig = "";
        }
      })
    );
    this.plugin.lib.listeners.add(this.libListener);
    this.register(() => this.plugin.lib.listeners.delete(this.libListener));

    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      this.frame();
    };
    this.raf = requestAnimationFrame(tick);
  }

  onunload() {
    cancelAnimationFrame(this.raf);
    this.ink.finish(true);
    this.setMode(false);
    this.flush();
    this.layer?.remove();
    this.live?.remove();
  }

  // ------------------------------------------------------------- file

  /** Called every frame: follow the leaf to another canvas file, and the viewport as it pans and zooms. */
  private frame() {
    if (!this.wrapper.isConnected || !this.wrapper.offsetParent) return;
    const path: string = this.view.file?.path ?? "";
    if (path !== this.canvasPath) {
      this.ink.finish(true);
      this.flush();
      this.canvasPath = path;
      this.lastSaved = null;
      this.ink = this.freshInk();
      this.images = [];
      this.docView = null;
      this.readable = true;
      this.bar?.el.remove();
      this.bar = null;
      if (this.mode) this.showBar();
      this.sig = "";
      this.read();
    }
    const cv = this.cv;
    const w = this.wrapper.clientWidth, h = this.wrapper.clientHeight;
    const sig = `${cv.x}|${cv.y}|${cv.scale}|${w}|${h}|${window.devicePixelRatio}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.render(w, h);
    }
  }

  private freshInk() {
    return new Ink(this.plugin, {
      toWorld: (e) => this.toWorld(e),
      zoom: () => this.cv.scale || 1,
      baseScale: () => this.cv.scale || 1,
      changed: () => this.changed(),
      live: () => this.drawLive(),
      redraw: () => (this.sig = ""),
    });
  }

  private async read() {
    const forPath = this.canvasPath;
    const file = this.plugin.app.vault.getAbstractFileByPath(inkPathFor(forPath));
    let data = "";
    if (file instanceof TFile) {
      try {
        data = await this.plugin.app.vault.cachedRead(file);
      } catch {
        /* deleted meanwhile */
      }
    }
    if (forPath !== this.canvasPath) return; // the leaf moved on while reading
    if (this.lastSaved !== null && data === this.lastSaved) return; // our own save coming back
    if (this.dirty || this.ink.busy) return; // newer strokes here are about to be written
    const doc = parseDrawing(data);
    this.readable = !!doc;
    this.ink.load(doc?.strokes ?? []);
    this.images = doc?.images ?? [];
    this.docView = doc?.view ?? null;
    if (doc) for (const id of Object.keys(doc.brushes)) this.plugin.lib.addDoc({ ...doc.brushes[id], id });
    this.sig = "";
  }

  private changed() {
    this.dirty = true;
    this.bar?.sync();
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), 500);
  }

  private flush() {
    window.clearTimeout(this.saveTimer);
    if (!this.dirty || !this.readable || !this.canvasPath) return;
    this.dirty = false;
    const path = inkPathFor(this.canvasPath);
    const data = serializeDrawing(this.ink.strokes, this.images, this.docView, this.plugin.lib);
    this.lastSaved = data;
    const vault = this.plugin.app.vault;
    // one write at a time, so creating the file and the next save cannot overlap
    this.saving = this.saving
      .then(async () => {
        const file = vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await vault.modify(file, data);
        else await vault.create(path, data);
      })
      .catch((e) => console.error("Pencil Canvas: could not save the canvas annotations", e));
  }

  // ------------------------------------------------------------- drawing

  private toWorld(e: { clientX: number; clientY: number }) {
    const cv = this.cv;
    const r = this.wrapper.getBoundingClientRect();
    const s = cv.scale || 1;
    return { x: (e.clientX - r.left - r.width / 2) / s + cv.x, y: (e.clientY - r.top - r.height / 2) / s + cv.y };
  }

  private applyCam(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number) {
    const cv = this.cv;
    const s = cv.scale || 1;
    ctx.setTransform(s * dpr, 0, 0, s * dpr, (w / 2 - cv.x * s) * dpr, (h / 2 - cv.y * s) * dpr);
  }

  private render(w: number, h: number) {
    if (!w || !h) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    for (const c of [this.layer, this.live]) {
      if (c.width !== W) c.width = W;
      if (c.height !== H) c.height = H;
    }
    const ctx = this.layer.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cv = this.cv;
    const s = cv.scale || 1;
    const x0 = cv.x - w / 2 / s, x1 = cv.x + w / 2 / s, y0 = cv.y - h / 2 / s, y1 = cv.y + h / 2 / s;
    this.applyCam(ctx, w, h, dpr);
    const lib = this.plugin.lib;
    for (const st of this.ink.strokes) {
      const b = lib.geoOf(st).bbox;
      if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
      lib.draw(ctx, st, s * dpr);
    }
    this.drawLive();
    this.bar?.sync();
  }

  private drawLive() {
    const ctx = this.live.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    const st = this.ink.liveStroke;
    if (!st) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.applyCam(ctx, this.wrapper.clientWidth, this.wrapper.clientHeight, dpr);
    this.plugin.lib.draw(ctx, st, (this.cv.scale || 1) * dpr, true);
  }

  /** Is this spot bare canvas (no card, connection or control under it)? */
  private isEmpty(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (target === this.wrapper || target === this.cv.canvasEl) return true;
    const bg = this.wrapper.firstElementChild;
    return !!bg && bg.tagName.toLowerCase() === "svg" && bg.contains(target);
  }

  private wouldDraw(pointerType: string, button: number, target: EventTarget | null): boolean {
    if (!this.readable || this.cv.readonly) return false;
    if (target instanceof Element && target.closest(".canvas-controls, .canvas-card-menu, .pc-card-bar, .menu")) return false;
    if (this.mode) {
      if (pointerType === "pen") return true;
      if (pointerType === "touch") return this.plugin.settings.fingerDraw;
      return button === 0 && !this.cv.isHoldingSpace;
    }
    // without the mode: only the pencil, and only where there is nothing
    return pointerType === "pen" && this.plugin.settings.cardDraw !== false && this.isEmpty(target);
  }

  private onDown(e: PointerEvent) {
    if (this.ink.busy || !this.wouldDraw(e.pointerType, e.button, e.target)) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      this.wrapper.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already released */
    }
    if (!this.mode) this.showBar();
    this.ink.down(e);
  }

  // ------------------------------------------------------------- annotate mode

  /** On: pencil and mouse draw anywhere, over cards too. Off: the canvas behaves as usual (the pencil still draws on empty space). */
  setMode(on: boolean) {
    if (on && (this.cv.readonly || !this.readable)) return;
    if (this.mode === on) {
      if (!on) this.hideBar();
      return;
    }
    this.ink.finish(false);
    this.mode = on;
    this.wrapper.toggleClass("pc-annotating", on);
    this.toggleEl?.toggleClass("is-active", on);
    if (on) this.showBar();
    else {
      this.hideBar();
      this.flush();
    }
  }

  toggleMode() {
    this.setMode(!this.mode);
  }

  private showBar() {
    if (this.bar) return;
    this.bar = buildInkBar(this.wrapper, this.ink, [{ icon: "check", label: "Done", key: "done", run: () => this.setMode(false) }]);
    this.bar.el.addClass("pc-ink-bar");
  }

  private hideBar() {
    this.bar?.el.remove();
    this.bar = null;
  }
}
