import { Menu, Notice, Scope, TextFileView, WorkspaceLeaf, arrayBufferToBase64, setIcon } from "obsidian";
import type PencilCanvasPlugin from "./main";
import { Brush, DrawingFile, Img, Stroke, Tool } from "./types";
import { cutStroke, strokeHit, svgPath } from "./geometry";

export const VIEW_TYPE = "pencil-canvas";
export const FILE_EXT = "pencil";

const PEN_COLORS = ["#1e1e1e", "#ffffff", "#868e96", "#e03131", "#f76707", "#f2b705", "#2f9e44", "#1098ad", "#1971c2", "#7048e8", "#c2255c", "#7b4b2a"];
const HL_COLORS = ["#ffe066", "#b2f2bb", "#99e9f2", "#a5d8ff", "#eebefa", "#ffc9c9", "#ffd8a8"];
const SIZE_RANGE: Record<Tool, [number, number]> = { pen: [1, 64], highlighter: [4, 96], eraser: [4, 240] };
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 128;
const SLOW_MS = 12;

type Handle = "move" | "rot" | "nw" | "ne" | "se" | "sw";
const HOLD_MS = 450;

interface Snap {
  s: Stroke[];
  i: Img[];
}

interface Act {
  kind: "stroke" | "erase" | "pan" | "img";
  // image move / resize / rotate
  mode?: Handle;
  img0?: Img;
  beforeI?: Img[];
  id: number;
  ptype: string;
  // stroke
  st?: Stroke;
  smooth?: number;
  dec?: number;
  sx?: number;
  sy?: number;
  sp?: number;
  rawX?: number;
  rawY?: number;
  // erase
  before?: Stroke[];
  changed?: boolean;
  // erase + pan: last position (world for erase, screen for pan)
  lx: number;
  ly: number;
}

interface TouchPt {
  x: number;
  y: number;
  sx: number;
  sy: number;
  palm: boolean;
}

export class DrawView extends TextFileView {
  plugin: PencilCanvasPlugin;
  strokes: Stroke[] = [];
  images: Img[] = [];
  private sel: string | null = null;
  private selEl!: HTMLElement;
  private imgCache = new Map<string, HTMLImageElement>();
  private holdTimer = 0;
  private clickImg: { id: string; x: number; y: number } | null = null;
  private imgInput!: HTMLInputElement;
  private diagEl: HTMLElement | null = null;
  private diagOff: (() => void) | null = null;
  private undoStack: Snap[] = [];
  private redoStack: Snap[] = [];
  private cam = { x: 0, y: 0, zoom: 1 };
  private camSet = false;
  tool: Tool = "pen";
  private prevTool: Tool = "pen";
  private unreadable: string | null = null;

  private stage!: HTMLElement;
  private main!: HTMLCanvasElement;
  private live!: HTMLCanvasElement;
  private mctx!: CanvasRenderingContext2D;
  private lctx!: CanvasRenderingContext2D;
  private cache: HTMLCanvasElement | null = null;
  private cursorEl!: HTMLElement;
  private toolbar!: HTMLElement;
  private popover: HTMLElement | null = null;
  private popoverKind = "";
  private ui: Record<string, HTMLElement> = {};
  private sizeInput!: HTMLInputElement;
  private fileInput!: HTMLInputElement;

  private dpr = 1;
  private w = 0;
  private h = 0;
  private renderQueued = false;
  private liveQueued = false;
  private lastMs = 0;
  private rv = { x: 0, y: 0, zoom: 1 };
  private preview = false;
  private previewTimer = 0;

  private act: Act | null = null;
  private touches = new Map<number, TouchPt>();
  private gest: { max: number; moved: boolean; t0: number; palm: boolean } | null = null;
  private pinch: { n: number; cx: number; cy: number; d: number } | null = null;
  private lastTap = { t: 0, x: 0, y: 0 };
  private space = false;
  private ro: ResizeObserver | null = null;
  private libListener = () => {
    this.requestRender();
    if (this.popoverKind === "brush") this.openPopover("brush", true);
  };

  constructor(leaf: WorkspaceLeaf, plugin: PencilCanvasPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "z", () => (this.undo(), false));
    this.scope.register(["Mod", "Shift"], "z", () => (this.redo(), false));
    this.scope.register(["Mod"], "y", () => (this.redo(), false));
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getIcon() {
    return "pencil";
  }

  getDisplayText() {
    return this.file?.basename ?? "Drawing";
  }

  // ------------------------------------------------------------- file data

  getViewData(): string {
    if (this.unreadable !== null) return this.unreadable;
    const lib = this.plugin.lib;
    const brushes: Record<string, Brush> = {};
    for (const st of this.strokes) {
      if (st.t === "p" && !lib.isBuiltin(st.b) && !brushes[st.b]) {
        const b = lib.get(st.b);
        if (b.id === st.b) brushes[st.b] = b;
      }
    }
    const r = (v: number) => Math.round(v * 1000) / 1000;
    const doc: DrawingFile = {
      app: "pencil-canvas",
      version: 1,
      view: { x: r(this.cam.x), y: r(this.cam.y), zoom: +this.cam.zoom.toPrecision(6) },
      strokes: this.strokes,
      images: this.images,
      brushes,
    };
    return JSON.stringify(doc);
  }

  setViewData(data: string, clear: boolean) {
    if (clear) this.clear();
    this.unreadable = null;
    let doc: Partial<DrawingFile> | null = null;
    if (data.trim()) {
      try {
        doc = JSON.parse(data);
      } catch {
        this.unreadable = data;
        new Notice("Pencil Canvas: this file could not be read. It is left untouched.");
      }
    }
    const strokes: Stroke[] = [];
    if (doc && Array.isArray(doc.strokes)) {
      for (const s of doc.strokes) {
        if (s && Array.isArray(s.p) && s.p.length >= 3 && typeof s.s === "number") {
          strokes.push({ ...s, t: s.t === "h" ? "h" : "p", b: s.b ?? "ink", c: s.c ?? "#000", o: s.o ?? 1 });
        }
      }
    }
    if (doc?.brushes) for (const id of Object.keys(doc.brushes)) this.plugin.lib.addDoc({ ...doc.brushes[id], id });
    this.strokes = strokes;
    this.images = [];
    if (doc && Array.isArray(doc.images)) {
      for (const im of doc.images) {
        if (im && typeof im.src === "string" && im.w > 0 && im.h > 0) {
          this.images.push({ id: String(im.id ?? Math.random()), src: im.src, x: +im.x || 0, y: +im.y || 0, w: im.w, h: im.h, r: +im.r || 0 });
        }
      }
    }
    this.sel = null;
    this.undoStack = [];
    this.redoStack = [];
    if (doc?.view && isFinite(doc.view.zoom) && doc.view.zoom > 0) {
      this.cam = { x: doc.view.x || 0, y: doc.view.y || 0, zoom: doc.view.zoom };
      this.camSet = true;
    } else this.camSet = false;
    this.centerIfNeeded();
    this.syncToolbar();
    this.requestRender();
  }

  clear() {
    this.strokes = [];
    this.images = [];
    this.sel = null;
    this.undoStack = [];
    this.redoStack = [];
    this.act = null;
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.camSet = false;
  }

  private centerIfNeeded() {
    if (this.camSet || !this.w) return;
    this.cam = { x: this.w / 2, y: this.h / 2, zoom: 1 };
    this.camSet = true;
  }

  private changed() {
    if (this.unreadable !== null) return;
    this.requestSave();
  }

  // ------------------------------------------------------------- lifecycle

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("pc-root");
    this.stage = root.createDiv("pc-stage");
    this.stage.tabIndex = -1;
    this.main = this.stage.createEl("canvas", { cls: "pc-canvas" });
    this.live = this.stage.createEl("canvas", { cls: "pc-canvas" });
    this.mctx = this.main.getContext("2d")!;
    this.lctx = this.live.getContext("2d")!;
    this.cursorEl = this.stage.createDiv("pc-cursor");
    this.buildSelection();
    this.buildToolbar(root);

    const st = this.stage;
    this.registerDomEvent(st, "pointerdown", (e) => this.onDown(e));
    this.registerDomEvent(st, "pointermove", (e) => this.onMove(e));
    this.registerDomEvent(st, "pointerup", (e) => this.onUp(e, false));
    this.registerDomEvent(st, "pointercancel", (e) => this.onUp(e, true));
    this.registerDomEvent(st, "pointerleave", () => this.cursorEl.removeClass("is-visible"));
    this.registerDomEvent(st, "wheel", (e) => this.onWheel(e), { passive: false });
    this.registerDomEvent(st, "contextmenu", (e) => e.preventDefault());
    // keep iOS / Obsidian gestures (sidebar swipes, text loupe, scrolling) away from the canvas
    const block = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    for (const t of ["touchstart", "touchmove", "touchend", "gesturestart", "gesturechange", "dblclick"] as const) {
      st.addEventListener(t, block, { passive: false });
    }
    this.registerDomEvent(st, "keydown", (e) => this.onKey(e, true));
    this.registerDomEvent(st, "keyup", (e) => this.onKey(e, false));
    this.registerDomEvent(document, "paste", (e) => this.onPaste(e));
    this.registerDomEvent(st, "dragover", (e) => e.preventDefault());
    this.registerDomEvent(st, "drop", (e) => {
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      this.insertImages(files, true);
    });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.stage);
    this.plugin.lib.listeners.add(this.libListener);
    this.resize();
    this.syncToolbar();
  }

  async onClose() {
    this.ro?.disconnect();
    this.plugin.lib.listeners.delete(this.libListener);
    window.clearTimeout(this.previewTimer);
    window.clearTimeout(this.holdTimer);
    this.diagOff?.();
  }

  private resize() {
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.w = r.width;
    this.h = r.height;
    for (const c of [this.main, this.live]) {
      c.width = Math.round(this.w * this.dpr);
      c.height = Math.round(this.h * this.dpr);
    }
    this.centerIfNeeded();
    this.preview = false;
    this.render();
  }

  // ------------------------------------------------------------- rendering

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private applyCam(ctx: CanvasRenderingContext2D) {
    const k = this.dpr * this.cam.zoom;
    ctx.setTransform(k, 0, 0, k, this.dpr * this.cam.x, this.dpr * this.cam.y);
  }

  private render() {
    if (!this.mctx || !this.w) return;
    window.clearTimeout(this.previewTimer);
    this.preview = false;
    const t0 = performance.now();
    const ctx = this.mctx;
    const lib = this.plugin.lib;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.main.width, this.main.height);
    this.applyCam(ctx);
    const z = this.cam.zoom;
    const x0 = -this.cam.x / z, y0 = -this.cam.y / z;
    const x1 = x0 + this.w / z, y1 = y0 + this.h / z;
    const scale = this.dpr * z;
    for (const im of this.images) {
      const rad = Math.hypot(im.w, im.h) / 2;
      if (im.x + rad < x0 || im.x - rad > x1 || im.y + rad < y0 || im.y - rad > y1) continue;
      this.drawImage(ctx, im);
    }
    for (const st of this.strokes) {
      const b = lib.geoOf(st).bbox;
      if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
      lib.draw(ctx, st, scale);
    }
    this.lastMs = performance.now() - t0;
    this.rv = { ...this.cam };
    this.updateBackground();
    this.updateSel();
  }

  private imgEl(src: string): HTMLImageElement | null {
    let el = this.imgCache.get(src);
    if (!el) {
      el = new Image();
      this.imgCache.set(src, el);
      el.onload = () => this.requestRender();
      el.src = this.app.vault.adapter.getResourcePath(src);
    }
    return el.complete && el.naturalWidth > 0 ? el : null;
  }

  private drawImage(ctx: CanvasRenderingContext2D, im: Img) {
    const el = this.imgEl(im.src);
    ctx.save();
    ctx.translate(im.x, im.y);
    if (im.r) ctx.rotate(im.r);
    if (el) ctx.drawImage(el, -im.w / 2, -im.h / 2, im.w, im.h);
    else {
      // still loading, or the file is missing
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = "#888";
      ctx.fillRect(-im.w / 2, -im.h / 2, im.w, im.h);
    }
    ctx.restore();
  }

  /** Pan / zoom happened. Heavy scenes are previewed from a bitmap and redrawn crisply when the gesture pauses. */
  private viewChanged() {
    this.updateBackground();
    this.updateSel();
    this.updateZoomLabel();
    if (this.lastMs <= SLOW_MS) {
      this.requestRender();
      return;
    }
    if (!this.preview) {
      if (!this.cache) this.cache = document.createElement("canvas");
      this.cache.width = this.main.width;
      this.cache.height = this.main.height;
      this.cache.getContext("2d")!.drawImage(this.main, 0, 0);
      this.preview = true;
    }
    const k = this.cam.zoom / this.rv.zoom;
    const ctx = this.mctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.main.width, this.main.height);
    ctx.setTransform(k, 0, 0, k, this.dpr * (this.cam.x - this.rv.x * k), this.dpr * (this.cam.y - this.rv.y * k));
    ctx.drawImage(this.cache!, 0, 0);
    window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => this.render(), 140);
  }

  updateBackground() {
    const s = this.stage.style;
    if (!this.plugin.settings.dots) {
      s.backgroundImage = "";
      return;
    }
    let gap = 24 * this.cam.zoom;
    while (gap < 14) gap *= 4;
    while (gap > 56) gap /= 4;
    s.backgroundImage = "radial-gradient(circle, var(--pc-dot) 1px, transparent 1.4px)";
    s.backgroundSize = `${gap}px ${gap}px`;
    s.backgroundPosition = `${this.cam.x - gap / 2}px ${this.cam.y - gap / 2}px`;
  }

  private requestLive() {
    if (this.liveQueued) return;
    this.liveQueued = true;
    requestAnimationFrame(() => {
      this.liveQueued = false;
      const ctx = this.lctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.live.width, this.live.height);
      const st = this.act?.kind === "stroke" ? this.act.st : null;
      if (st && st.p.length) {
        this.applyCam(ctx);
        this.plugin.lib.draw(ctx, st, this.dpr * this.cam.zoom, true);
      }
    });
  }

  // ------------------------------------------------------------- history

  private commit(next: Stroke[], images: Img[] = this.images) {
    this.undoStack.push({ s: this.strokes, i: this.images });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.strokes = next;
    this.images = images;
    this.changed();
    this.syncToolbar();
  }

  undo() {
    if (this.act) this.cancelAct();
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push({ s: this.strokes, i: this.images });
    this.strokes = prev.s;
    this.images = prev.i;
    if (!this.images.some((im) => im.id === this.sel)) this.sel = null;
    this.changed();
    this.syncToolbar();
    this.requestRender();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push({ s: this.strokes, i: this.images });
    this.strokes = next.s;
    this.images = next.i;
    if (!this.images.some((im) => im.id === this.sel)) this.sel = null;
    this.changed();
    this.syncToolbar();
    this.requestRender();
  }

  // ------------------------------------------------------------- input

  private local(e: { clientX: number; clientY: number }) {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private toWorld(x: number, y: number) {
    return { x: (x - this.cam.x) / this.cam.zoom, y: (y - this.cam.y) / this.cam.zoom };
  }

  private onDown(e: PointerEvent) {
    this.closePopover();
    this.stage.focus({ preventScroll: true });
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    const pos = this.local(e);
    if (e.pointerType === "touch") {
      const penBusy = !!this.act && this.act.ptype !== "touch";
      this.touches.set(e.pointerId, { x: pos.x, y: pos.y, sx: pos.x, sy: pos.y, palm: penBusy });
      if (!this.gest) this.gest = { max: 0, moved: false, t0: performance.now(), palm: false };
      if (penBusy) {
        this.gest.palm = true; // palm resting while the pencil draws
        return;
      }
      this.gest.max = Math.max(this.gest.max, this.touches.size);
      this.pinch = null;
      window.clearTimeout(this.holdTimer);
      if (this.touches.size === 1 && !this.act) {
        // corner dots / rotate knob of the selected image respond straight away
        const h = this.handleAt(pos.x, pos.y, 26);
        if (h) {
          this.gest.moved = true;
          this.startImgAct(e.pointerId, "touch", h, pos);
          return;
        }
        // moving an image needs a long hold; a quick drag still pans the canvas
        const w = this.toWorld(pos.x, pos.y);
        const im = this.imgAt(w.x, w.y);
        if (im) this.holdTimer = window.setTimeout(() => this.onHold(e.pointerId, im.id), HOLD_MS);
      }
      if (this.plugin.settings.fingerDraw && this.touches.size === 1 && !this.act) {
        this.begin(e, pos);
        return;
      }
      if (this.act && this.act.ptype === "touch") this.cancelAct(); // second finger → pan / zoom instead
      return;
    }
    if (this.act) return;
    if (e.pointerType === "mouse") {
      if (e.button === 1 || e.button === 2 || (e.button === 0 && this.space)) {
        this.act = { kind: "pan", id: e.pointerId, ptype: "mouse", lx: pos.x, ly: pos.y };
        this.stage.addClass("is-panning");
        return;
      }
      if (e.button !== 0) return;
      // mouse: click an image to select it, then drag it or its handles
      const w = this.toWorld(pos.x, pos.y);
      const hit = this.imgAt(w.x, w.y);
      this.clickImg = null;
      if (this.sel) {
        const h = this.handleAt(pos.x, pos.y, 12) ?? (hit && hit.id === this.sel ? "move" : null);
        if (h) {
          this.startImgAct(e.pointerId, "mouse", h, pos);
          return;
        }
        this.select(null);
        if (!hit) return; // clicking empty canvas only deselects
      }
      if (hit) this.clickImg = { id: hit.id, x: pos.x, y: pos.y };
    } else this.select(null); // the pencil never moves or resizes images, it just draws
    this.begin(e, pos);
  }

  private begin(e: PointerEvent, pos: { x: number; y: number }) {
    const s = this.plugin.settings;
    const isPen = e.pointerType === "pen";
    if (isPen) {
      // anything already touching the screen is a resting hand
      this.touches.forEach((t) => (t.palm = true));
      if (this.gest) this.gest.palm = true;
    }
    // pens with an eraser end or a barrel button erase while it is held
    const erasing = this.tool === "eraser" || (isPen && (e.button === 5 || (e.buttons & 32) !== 0 || (e.buttons & 2) !== 0));
    const w = this.toWorld(pos.x, pos.y);
    if (erasing) {
      this.act = { kind: "erase", id: e.pointerId, ptype: e.pointerType, before: this.strokes, changed: false, lx: w.x, ly: w.y };
      this.erase(w.x, w.y);
      this.showCursor(pos, "eraser");
      return;
    }
    const z = this.cam.zoom;
    const k = s.fixedSize ? 1 : 1 / z; // slider size → canvas units
    const hl = this.tool === "highlighter";
    const brush = hl ? null : this.plugin.lib.get(s.pen.brush);
    const st: Stroke = hl
      ? { t: "h", b: "", c: s.highlighter.color, s: s.highlighter.size * k, o: 0.4, p: [], r: (Math.random() * 1e9) | 0 }
      : { t: "p", b: brush!.id, c: s.pen.color, s: s.pen.size * k, o: s.pen.opacity, p: [], r: (Math.random() * 1e9) | 0 };
    this.act = {
      kind: "stroke",
      id: e.pointerId,
      ptype: e.pointerType,
      st,
      smooth: Math.min(0.97, (hl ? 0.35 : brush!.streamline) + (s.pen.smoothing || 0)),
      dec: Math.max(1, Math.min(7, Math.ceil(Math.log10(z)) + 2)),
      lx: 0,
      ly: 0,
    };
    this.addPoint(this.act, w.x, w.y, this.pressure(e));
    this.requestLive();
  }

  private pressure(e: PointerEvent) {
    if (e.pointerType !== "pen") return 0.5;
    return e.pressure > 0 ? Math.min(1, e.pressure) : 0.5;
  }

  private addPoint(a: Act, wx: number, wy: number, p: number, force = false) {
    const st = a.st!;
    const n = st.p.length;
    if (n && !force) {
      const k = 1 - a.smooth! * 0.8;
      a.sx! += (wx - a.sx!) * k;
      a.sy! += (wy - a.sy!) * k;
      a.sp! += (p - a.sp!) * 0.6;
    } else {
      a.sx = wx;
      a.sy = wy;
      a.sp = n ? a.sp : p;
    }
    a.rawX = wx;
    a.rawY = wy;
    if (n && Math.hypot(a.sx! - st.p[n - 3], a.sy! - st.p[n - 2]) * this.cam.zoom < 0.4) return;
    const q = Math.pow(10, a.dec!);
    st.p.push(Math.round(a.sx! * q) / q, Math.round(a.sy! * q) / q, Math.round(a.sp! * 1000) / 1000);
  }

  private onMove(e: PointerEvent) {
    const pos = this.local(e);
    const a = this.act;
    if (a && a.id === e.pointerId) {
      if (a.kind === "pan") {
        this.cam.x += pos.x - a.lx;
        this.cam.y += pos.y - a.ly;
        a.lx = pos.x;
        a.ly = pos.y;
        this.viewChanged();
        return;
      }
      if (a.kind === "img") {
        this.imgMove(a, pos);
        return;
      }
      let evs: PointerEvent[] = [];
      try {
        evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      } catch {
        /* not supported */
      }
      if (!evs.length) evs = [e];
      for (const ce of evs) {
        const lp = this.local(ce);
        const w = this.toWorld(lp.x, lp.y);
        if (a.kind === "erase") this.erase(w.x, w.y);
        else this.addPoint(a, w.x, w.y, this.pressure(ce));
      }
      if (a.kind === "stroke") this.requestLive();
      if (e.pointerType === "touch") {
        const t = this.touches.get(e.pointerId);
        if (t) {
          t.x = pos.x;
          t.y = pos.y;
          if (this.gest && Math.hypot(pos.x - t.sx, pos.y - t.sy) > 8) {
            this.gest.moved = true;
            window.clearTimeout(this.holdTimer);
          }
        }
      } else this.showCursor(pos, a.kind === "erase" ? "eraser" : this.tool);
      return;
    }
    if (e.pointerType === "touch") {
      const t = this.touches.get(e.pointerId);
      if (!t) return;
      t.x = pos.x;
      t.y = pos.y;
      if (t.palm || !this.gest) return;
      if (!this.gest.moved && Math.hypot(pos.x - t.sx, pos.y - t.sy) > 8) {
        this.gest.moved = true;
        window.clearTimeout(this.holdTimer);
      }
      if (this.gest.moved) this.pinchUpdate();
      return;
    }
    if (!a) this.showCursor(pos, this.tool); // mouse / pencil hover
  }

  private pinchUpdate() {
    let n = 0, cx = 0, cy = 0;
    this.touches.forEach((t) => {
      if (t.palm) return;
      n++;
      cx += t.x;
      cy += t.y;
    });
    if (!n) return;
    cx /= n;
    cy /= n;
    let d = 0;
    if (n > 1) {
      this.touches.forEach((t) => {
        if (!t.palm) d += Math.hypot(t.x - cx, t.y - cy);
      });
      d /= n;
    }
    const p = this.pinch;
    if (!p || p.n !== n) {
      this.pinch = { n, cx, cy, d };
      return;
    }
    this.cam.x += cx - p.cx;
    this.cam.y += cy - p.cy;
    if (n > 1 && p.d > 1 && d > 1) this.zoomAt(cx, cy, d / p.d);
    this.pinch = { n, cx, cy, d };
    this.viewChanged();
  }

  private zoomAt(px: number, py: number, k: number) {
    const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.cam.zoom * k));
    k = nz / this.cam.zoom;
    this.cam.x = px - (px - this.cam.x) * k;
    this.cam.y = py - (py - this.cam.y) * k;
    this.cam.zoom = nz;
  }

  private onUp(e: PointerEvent, cancelled: boolean) {
    const pos = this.local(e);
    const a = this.act;
    window.clearTimeout(this.holdTimer);
    if (a && a.id === e.pointerId) {
      const c = this.clickImg;
      if (c && e.pointerType === "mouse" && !cancelled && Math.hypot(pos.x - c.x, pos.y - c.y) < 4) {
        // a plain click on an image selects it instead of leaving a dot
        this.cancelAct();
        this.select(c.id);
      } else this.finishAct(cancelled);
      this.clickImg = null;
    }
    if (e.pointerType !== "touch") return;
    if (!this.touches.delete(e.pointerId)) return;
    this.pinch = null;
    if (this.touches.size === 0 && this.gest) {
      const g = this.gest;
      this.gest = null;
      if (!cancelled && !g.moved && !g.palm && performance.now() - g.t0 < 350) this.onTap(g.max, pos);
    }
  }

  private onTap(fingers: number, pos: { x: number; y: number }) {
    if (fingers === 2) {
      this.undo();
      this.toast("Undo");
    } else if (fingers === 3) {
      this.redo();
      this.toast("Redo");
    } else if (fingers === 1 && this.sel) {
      this.select(null);
    } else if (fingers === 1 && !this.plugin.settings.fingerDraw) {
      const now = performance.now();
      const l = this.lastTap;
      if (now - l.t < 400 && Math.hypot(pos.x - l.x, pos.y - l.y) < 60) {
        this.lastTap.t = 0;
        this.toggleEraser();
      } else this.lastTap = { t: now, x: pos.x, y: pos.y };
    }
  }

  private finishAct(cancelled: boolean) {
    const a = this.act;
    if (!a) return;
    this.act = null;
    this.stage.removeClass("is-panning");
    if (a.kind === "stroke") {
      const st = a.st!;
      if (!cancelled && st.p.length >= 3) {
        // let the smoothed line catch up with where the pen actually ended
        if (a.smooth! > 0 && a.rawX !== undefined) this.addPoint(a, a.rawX, a.rawY!, a.sp!, true);
        this.commit(this.strokes.concat(st));
        if (this.preview) this.render();
        else {
          this.applyCam(this.mctx);
          this.plugin.lib.draw(this.mctx, st, this.dpr * this.cam.zoom);
        }
      }
      this.requestLive();
    } else if (a.kind === "erase") {
      if (a.changed) {
        const after = this.strokes;
        this.strokes = a.before!;
        this.commit(after);
      }
    } else if (a.kind === "img") {
      this.stage.removeClass("is-moving");
      if (a.changed) {
        const after = this.images;
        this.images = a.beforeI!;
        if (cancelled) this.requestRender();
        else this.commit(this.strokes, after);
        this.updateSel();
      }
    }
  }

  private cancelAct() {
    const a = this.act;
    if (!a) return;
    if (a.kind === "erase" && a.changed) {
      this.strokes = a.before!;
      this.requestRender();
    }
    if (a.kind === "img") {
      this.stage.removeClass("is-moving");
      if (a.changed) {
        this.images = a.beforeI!;
        this.requestRender();
      }
    }
    this.act = null;
    this.stage.removeClass("is-panning");
    this.requestLive();
  }

  private erase(wx: number, wy: number) {
    const a = this.act!;
    const s = this.plugin.settings.eraser;
    const R = s.size / 2 / this.cam.zoom;
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
      this.requestRender();
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const pos = this.local(e);
    const unit = e.deltaMode === 1 ? 32 : 1;
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(pos.x, pos.y, Math.exp(-e.deltaY * unit * 0.0045));
    } else if (e.shiftKey && !e.deltaX) {
      this.cam.x -= e.deltaY * unit;
    } else {
      this.cam.x -= e.deltaX * unit;
      this.cam.y -= e.deltaY * unit;
    }
    this.viewChanged();
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (e.key === " ") {
      this.space = down;
      this.stage.toggleClass("can-pan", down);
      e.preventDefault();
      return;
    }
    if (!down || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.sel && (e.key === "Delete" || e.key === "Backspace")) return this.deleteSel();
    if (e.key === "Escape") return this.select(null);
    const k = e.key.toLowerCase();
    if (k === "p" || k === "b") this.setTool("pen");
    else if (k === "h") this.setTool("highlighter");
    else if (k === "e") this.setTool("eraser");
    else if (k === "[" || k === "]") this.setSize(this.toolSize() * (k === "]" ? 1.25 : 0.8));
  }

  private showCursor(pos: { x: number; y: number }, tool: Tool) {
    const s = this.plugin.settings;
    const k = s.fixedSize ? this.cam.zoom : 1; // the ring shows the real width at this zoom
    const d = Math.max(4, tool === "eraser" ? s.eraser.size : (tool === "highlighter" ? s.highlighter.size : s.pen.size) * k);
    const c = this.cursorEl;
    c.style.width = c.style.height = d + "px";
    c.style.transform = `translate(${pos.x - d / 2}px, ${pos.y - d / 2}px)`;
    c.toggleClass("is-eraser", tool === "eraser");
    c.addClass("is-visible");
  }

  // ------------------------------------------------------------- images

  private buildSelection() {
    const el = (this.selEl = this.stage.createDiv("pc-sel"));
    for (const c of ["nw", "ne", "se", "sw"]) el.createDiv("pc-dot pc-dot-" + c);
    el.createDiv("pc-rot-stem");
    const rot = el.createDiv("pc-rot");
    setIcon(rot, "rotate-cw");
    const del = el.createDiv({ cls: "pc-sel-del", attr: { "aria-label": "Remove image" } });
    setIcon(del, "trash-2");
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      this.deleteSel();
    });
  }

  private selected(): Img | null {
    return this.sel ? this.images.find((im) => im.id === this.sel) ?? null : null;
  }

  select(id: string | null) {
    if (this.sel === id) return;
    this.sel = id;
    this.updateSel();
  }

  /** Position the selection frame (corner dots, rotate knob, delete) over the selected image. */
  private updateSel() {
    const el = this.selEl;
    if (!el) return;
    const im = this.selected();
    el.toggleClass("is-visible", !!im);
    if (!im) return;
    const z = this.cam.zoom;
    const w = im.w * z, h = im.h * z;
    el.style.width = w + "px";
    el.style.height = h + "px";
    el.style.setProperty("--pc-r", -im.r + "rad"); // keeps the knob icons upright
    el.style.transform = `translate(${im.x * z + this.cam.x - w / 2}px, ${im.y * z + this.cam.y - h / 2}px) rotate(${im.r}rad)`;
  }

  /** Topmost image under a world point. */
  private imgAt(wx: number, wy: number): Img | null {
    for (let i = this.images.length - 1; i >= 0; i--) {
      const im = this.images[i];
      const dx = wx - im.x, dy = wy - im.y;
      const c = Math.cos(-im.r), s = Math.sin(-im.r);
      if (Math.abs(dx * c - dy * s) <= im.w / 2 && Math.abs(dx * s + dy * c) <= im.h / 2) return im;
    }
    return null;
  }

  /** Corner dot or rotate knob of the selected image under a screen point. */
  private handleAt(sx: number, sy: number, tol: number): Handle | null {
    const im = this.selected();
    if (!im) return null;
    const z = this.cam.zoom;
    const cx = im.x * z + this.cam.x, cy = im.y * z + this.cam.y;
    const c = Math.cos(im.r), s = Math.sin(im.r);
    const at = (lx: number, ly: number) => Math.hypot(cx + lx * c - ly * s - sx, cy + lx * s + ly * c - sy) <= tol;
    const hw = (im.w * z) / 2, hh = (im.h * z) / 2;
    if (at(0, -hh - 34)) return "rot";
    if (at(-hw, -hh)) return "nw";
    if (at(hw, -hh)) return "ne";
    if (at(hw, hh)) return "se";
    if (at(-hw, hh)) return "sw";
    return null;
  }

  private startImgAct(id: number, ptype: string, mode: Handle, pos: { x: number; y: number }) {
    const im = this.selected();
    if (!im) return;
    const w = this.toWorld(pos.x, pos.y);
    this.act = { kind: "img", id, ptype, mode, img0: im, beforeI: this.images, changed: false, lx: w.x, ly: w.y };
    this.stage.addClass("is-moving");
    this.cursorEl.removeClass("is-visible");
  }

  /** A finger has rested on an image long enough: select it and let the same finger drag it. */
  private onHold(pointerId: number, imgId: string) {
    const t = this.touches.get(pointerId);
    if (!t || t.palm || this.touches.size !== 1 || (this.gest && this.gest.moved)) return;
    if (this.act) {
      if (this.act.ptype !== "touch") return;
      this.cancelAct(); // finger-drawing mode had started a dot
    }
    if (!this.images.some((im) => im.id === imgId)) return;
    if (this.gest) this.gest.moved = true; // not a tap any more
    this.select(imgId);
    this.startImgAct(pointerId, "touch", "move", t);
  }

  private imgMove(a: Act, pos: { x: number; y: number }) {
    const o = a.img0!;
    const w = this.toWorld(pos.x, pos.y);
    let next: Img;
    if (a.mode === "move") {
      next = { ...o, x: o.x + w.x - a.lx, y: o.y + w.y - a.ly };
    } else if (a.mode === "rot") {
      let r = Math.atan2(w.y - o.y, w.x - o.x) + Math.PI / 2;
      const q = Math.round(r / (Math.PI / 2)) * (Math.PI / 2);
      if (Math.abs(r - q) < 0.045) r = q; // snap to right angles
      next = { ...o, r };
    } else {
      // uniform scale, anchored at the opposite corner
      const sx = a.mode === "ne" || a.mode === "se" ? 1 : -1;
      const sy = a.mode === "se" || a.mode === "sw" ? 1 : -1;
      const c = Math.cos(o.r), s = Math.sin(o.r);
      const dxl = sx * o.w, dyl = sy * o.h; // diagonal in the image's own frame
      const d0 = Math.hypot(dxl, dyl);
      const ux = (dxl * c - dyl * s) / d0, uy = (dxl * s + dyl * c) / d0;
      const ox = o.x - (ux * d0) / 2, oy = o.y - (uy * d0) / 2;
      const d = (w.x - ox) * ux + (w.y - oy) * uy;
      const k = Math.max(d, 24 / this.cam.zoom) / d0;
      next = { ...o, w: o.w * k, h: o.h * k, x: ox + (ux * d0 * k) / 2, y: oy + (uy * d0 * k) / 2 };
    }
    this.images = this.images.map((im) => (im.id === o.id ? next : im));
    a.changed = true;
    this.updateSel();
    this.requestRender();
  }

  deleteSel() {
    const im = this.selected();
    if (!im) return;
    if (this.act) this.cancelAct();
    this.sel = null;
    this.commit(this.strokes, this.images.filter((x) => x.id !== im.id));
    this.updateSel();
    this.requestRender();
  }

  private onPaste(e: ClipboardEvent) {
    if (this.app.workspace.getActiveViewOfType(DrawView) !== this) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    this.insertImages(files, false);
  }

  /** "Paste image" button: asks the system clipboard directly (iPadOS shows its own Paste prompt). */
  async pasteFromClipboard() {
    try {
      const items = await navigator.clipboard.read();
      const blobs: Blob[] = [];
      for (const it of items) {
        const type = it.types.find((x) => x.startsWith("image/"));
        if (type) blobs.push(await it.getType(type));
      }
      if (!blobs.length) new Notice("There is no image on the clipboard.");
      else await this.insertImages(blobs, false);
    } catch {
      new Notice("Could not read the clipboard. Copy an image first, then allow the paste when asked.");
    }
  }

  async insertImages(blobs: Blob[], keepNames: boolean) {
    let i = 0;
    for (const b of blobs) await this.insertImage(b, keepNames && b instanceof File ? b.name : undefined, i++);
  }

  /** Save the picture as an attachment in the vault and place it in the middle of the screen. */
  private async insertImage(blob: Blob, name: string | undefined, offset: number) {
    if (!this.file || this.unreadable !== null) return;
    try {
      const sub = (blob.type.split("/")[1] || "png").toLowerCase();
      const ext = sub === "jpeg" ? "jpg" : sub === "svg+xml" ? "svg" : sub.replace(/[^a-z0-9]/g, "") || "png";
      const d = new Date();
      const two = (v: number) => String(v).padStart(2, "0");
      const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
      const fileName = (name && /\.[a-z0-9]+$/i.test(name) ? name : `Pasted image ${stamp}.${ext}`).replace(/[\\/:*?"<>|#^[\]]/g, "_");
      const size = await new Promise<{ w: number; h: number }>((res, rej) => {
        const url = URL.createObjectURL(blob);
        const el = new Image();
        el.onload = () => {
          URL.revokeObjectURL(url);
          res({ w: el.naturalWidth || 300, h: el.naturalHeight || 300 });
        };
        el.onerror = () => {
          URL.revokeObjectURL(url);
          rej(new Error("not an image this device can display"));
        };
        el.src = url;
      });
      const path = await this.app.fileManager.getAvailablePathForAttachment(fileName, this.file.path);
      await this.app.vault.createBinary(path, await blob.arrayBuffer());
      const z = this.cam.zoom;
      const fit = Math.min(1, (this.w * 0.6) / size.w, (this.h * 0.6) / size.h);
      const shift = (offset * 24) / z;
      const im: Img = {
        id: Math.random().toString(36).slice(2, 10),
        src: path,
        x: (this.w / 2 - this.cam.x) / z + shift,
        y: (this.h / 2 - this.cam.y) / z + shift,
        w: (size.w * fit) / z,
        h: (size.h * fit) / z,
        r: 0,
      };
      this.commit(this.strokes, this.images.concat(im));
      this.select(im.id);
      this.requestRender();
    } catch (err) {
      new Notice("Could not insert the image: " + (err as Error).message);
    }
  }

  // ------------------------------------------------------------- input test

  /** Lists every input event the app receives, to find out what (if anything) a pencil gesture sends. */
  toggleDiag() {
    if (this.diagEl) {
      this.diagOff?.();
      this.diagOff = null;
      this.diagEl.remove();
      this.diagEl = null;
      return;
    }
    const el = (this.diagEl = this.contentEl.createDiv("pc-diag"));
    el.createDiv({ cls: "pc-diag-title", text: "Input test" });
    el.createDiv({
      cls: "pc-diag-help",
      text: "Double-tap the flat side of the Apple Pencil while it is NOT touching the screen. Every event Obsidian receives is listed below. Touching the screen should add lines (that proves the test works).",
    });
    const log = el.createDiv("pc-diag-log");
    log.setText("Nothing received yet.");
    const skip = /move|rawupdate|motion|orientation|scroll|wheel|animation|transition|progress|timeupdate|message|resize|over$|out$|enter$|leave$|^load|^error$|storage|selectionchange/;
    const types = new Set<string>(["gesturestart", "gesturechange", "gestureend", "touchstart", "touchend", "touchcancel", "webkitmouseforcedown", "webkitmouseforcewillbegin"]);
    for (const src of [window, document] as object[]) for (const k in src) if (k.startsWith("on") && k.length > 2) types.add(k.slice(2));
    let count = 0;
    const t0 = performance.now();
    const handler = (e: Event) => {
      let info = "";
      if (typeof PointerEvent !== "undefined" && e instanceof PointerEvent) info = ` ${e.pointerType} button=${e.button} buttons=${e.buttons} pressure=${e.pressure.toFixed(2)}`;
      else if (e instanceof KeyboardEvent) info = ` key="${e.key}" code=${e.code}`;
      else if (typeof TouchEvent !== "undefined" && e instanceof TouchEvent) info = ` touches=${e.touches.length}`;
      if (!count++) log.empty();
      const line = createDiv({ text: `${((performance.now() - t0) / 1000).toFixed(2)}s  ${e.type}${info}` });
      log.prepend(line);
      while (log.childElementCount > 14) log.lastElementChild!.remove();
    };
    const list = Array.from(types).filter((t) => !skip.test(t));
    list.forEach((t) => window.addEventListener(t, handler, true));
    this.diagOff = () => list.forEach((t) => window.removeEventListener(t, handler, true));
  }

  // ------------------------------------------------------------- tools

  setTool(t: Tool) {
    if (t !== this.tool) {
      if (this.tool !== "eraser") this.prevTool = this.tool;
      this.tool = t;
    }
    this.closePopover();
    this.syncToolbar();
  }

  /** Double-tap: swap between the eraser and the tool used before it. */
  toggleEraser() {
    if (this.tool === "eraser") this.setTool(this.prevTool);
    else this.setTool("eraser");
    this.toast(this.tool === "eraser" ? "Eraser" : this.tool === "pen" ? "Pen" : "Highlighter");
  }

  private toolSize() {
    return this.plugin.settings[this.tool].size;
  }

  private setSize(v: number) {
    const [lo, hi] = SIZE_RANGE[this.tool];
    this.plugin.settings[this.tool].size = Math.round(Math.max(lo, Math.min(hi, v)) * 2) / 2;
    this.plugin.saveSettings();
    this.syncToolbar();
  }

  private toast(text: string) {
    const el = this.stage.createDiv({ cls: "pc-toast", text });
    window.setTimeout(() => el.remove(), 900);
  }

  // ------------------------------------------------------------- toolbar

  private buildToolbar(root: HTMLElement) {
    const tb = (this.toolbar = root.createDiv("pc-toolbar"));
    const btn = (key: string, icon: string, label: string, cb: (e: MouseEvent) => void) => {
      const b = tb.createEl("button", { cls: "pc-btn", attr: { "aria-label": label, type: "button" } });
      setIcon(b, icon);
      b.addEventListener("click", cb);
      this.ui[key] = b;
      return b;
    };
    const toolBtn = (t: Tool, icon: string, label: string) =>
      btn(t, icon, label, () => this.setTool(t));
    toolBtn("pen", "pencil", "Pen (P)");
    toolBtn("highlighter", "highlighter", "Highlighter (H)");
    toolBtn("eraser", "eraser", "Eraser (E) — double-tap with a finger to swap");
    tb.createDiv("pc-sep");

    const sizeWrap = tb.createDiv("pc-size");
    sizeWrap.setAttr("aria-label", "Size");
    this.ui.sizeDot = sizeWrap.createDiv("pc-size-dot");
    this.sizeInput = sizeWrap.createEl("input", { type: "range", cls: "pc-slider" });
    this.sizeInput.step = "0.5";
    this.sizeInput.addEventListener("input", () => this.setSize(parseFloat(this.sizeInput.value)));
    this.ui.sizeLabel = sizeWrap.createSpan("pc-size-label");

    const color = btn("color", "circle", "Colour", () => this.openPopover("color"));
    color.empty();
    this.ui.swatch = color.createDiv("pc-swatch");
    btn("brush", "brush", "Brushes", () => this.openPopover("brush"));
    btn("image", "image-plus", "Insert image", (e) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("From files / photos…").setIcon("image").onClick(() => this.imgInput.click()));
      menu.addItem((i) => i.setTitle("Paste from clipboard").setIcon("clipboard-paste").onClick(() => this.pasteFromClipboard()));
      menu.showAtMouseEvent(e);
    });
    const whole = tb.createEl("button", { cls: "pc-pill", text: "Whole strokes", attr: { type: "button", "aria-label": "Erase entire strokes instead of only the part you rub" } });
    whole.addEventListener("click", () => {
      const e = this.plugin.settings.eraser;
      e.mode = e.mode === "stroke" ? "partial" : "stroke";
      this.plugin.saveSettings();
      this.syncToolbar();
    });
    this.ui.whole = whole;

    tb.createDiv("pc-sep");
    btn("undo", "undo-2", "Undo (two-finger tap)", () => this.undo());
    btn("redo", "redo-2", "Redo (three-finger tap)", () => this.redo());
    const zoom = tb.createEl("button", { cls: "pc-pill pc-zoom", attr: { type: "button", "aria-label": "Reset zoom" } });
    zoom.addEventListener("click", () => {
      this.zoomAt(this.w / 2, this.h / 2, 1 / this.cam.zoom);
      this.viewChanged();
    });
    this.ui.zoom = zoom;
    btn("more", "more-horizontal", "More", (e) => this.openMenu(e));

    this.imgInput = root.createEl("input", { type: "file", cls: "pc-file" });
    this.imgInput.accept = "image/*";
    this.imgInput.multiple = true;
    this.imgInput.addEventListener("change", async () => {
      const files = Array.from(this.imgInput.files ?? []);
      this.imgInput.value = "";
      if (files.length) await this.insertImages(files, true);
    });
    this.fileInput = root.createEl("input", { type: "file", cls: "pc-file" });
    this.fileInput.multiple = true;
    this.fileInput.addEventListener("change", async () => {
      const files = Array.from(this.fileInput.files ?? []);
      this.fileInput.value = "";
      if (!files.length) return;
      const first = await this.plugin.importBrushes(files);
      if (first) {
        this.plugin.settings.pen.brush = first;
        this.plugin.saveSettings();
        this.setTool("pen");
      }
      this.openPopover("brush", true);
    });
  }

  syncToolbar() {
    if (!this.toolbar) return;
    const s = this.plugin.settings;
    for (const t of ["pen", "highlighter", "eraser"] as Tool[]) this.ui[t].toggleClass("is-active", this.tool === t);
    const [lo, hi] = SIZE_RANGE[this.tool];
    this.sizeInput.min = String(lo);
    this.sizeInput.max = String(hi);
    const size = s[this.tool].size;
    this.sizeInput.value = String(size);
    this.ui.sizeLabel.setText(String(size));
    const dot = Math.max(2, Math.min(18, size / 2.5));
    this.ui.sizeDot.style.setProperty("--d", dot + "px");
    const isEraser = this.tool === "eraser";
    this.ui.color.toggleClass("pc-hidden", isEraser);
    this.ui.brush.toggleClass("pc-hidden", this.tool !== "pen");
    this.ui.whole.toggleClass("pc-hidden", !isEraser);
    this.ui.whole.toggleClass("is-active", s.eraser.mode === "stroke");
    this.ui.swatch.style.background = this.tool === "highlighter" ? s.highlighter.color : s.pen.color;
    this.ui.undo.toggleClass("is-disabled", !this.undoStack.length);
    this.ui.redo.toggleClass("is-disabled", !this.redoStack.length);
    this.updateZoomLabel();
  }

  private updateZoomLabel() {
    this.ui.zoom?.setText(Math.round(this.cam.zoom * 100) + "%");
  }

  private closePopover() {
    this.popover?.remove();
    this.popover = null;
    this.popoverKind = "";
  }

  private openPopover(kind: "color" | "brush", keepOpen = false) {
    const wasOpen = this.popoverKind === kind;
    this.closePopover();
    if (wasOpen && !keepOpen) return;
    const pop = (this.popover = this.contentEl.createDiv("pc-popover"));
    this.popoverKind = kind;
    const top = this.toolbar.offsetTop + this.toolbar.offsetHeight + 6;
    pop.style.top = top + "px";
    pop.style.maxHeight = `calc(100% - ${top + 12}px)`;
    const s = this.plugin.settings;
    if (kind === "color") {
      const hl = this.tool === "highlighter";
      const target = hl ? s.highlighter : s.pen;
      const grid = pop.createDiv("pc-colors");
      const pick = (c: string) => {
        target.color = c;
        this.plugin.saveSettings();
        this.syncToolbar();
      };
      for (const c of hl ? HL_COLORS : PEN_COLORS) {
        const sw = grid.createEl("button", { cls: "pc-color", attr: { type: "button", "aria-label": c } });
        sw.style.background = c;
        sw.toggleClass("is-active", c.toLowerCase() === target.color.toLowerCase());
        sw.addEventListener("click", () => {
          pick(c);
          this.closePopover();
        });
      }
      const custom = pop.createEl("label", { cls: "pc-custom", text: "Custom colour " });
      const inp = custom.createEl("input", { type: "color" });
      inp.value = /^#[0-9a-f]{6}$/i.test(target.color) ? target.color : "#000000";
      inp.addEventListener("input", () => pick(inp.value));
      return;
    }
    // brushes
    const head = pop.createDiv("pc-brush-head");
    const imp = head.createEl("button", { cls: "mod-cta", text: "Import brushes…", attr: { type: "button" } });
    imp.addEventListener("click", () => this.fileInput.click());
    head.createDiv({ cls: "pc-hint", text: "Procreate .brush / .brushset · Krita .kpp / .bundle / .gbr" });
    const op = pop.createDiv("pc-row");
    op.createSpan({ text: "Opacity" });
    const opIn = op.createEl("input", { type: "range", cls: "pc-slider" });
    opIn.min = "5";
    opIn.max = "100";
    opIn.value = String(Math.round(s.pen.opacity * 100));
    const opLabel = op.createSpan({ cls: "pc-size-label", text: opIn.value + "%" });
    opIn.addEventListener("input", () => {
      s.pen.opacity = parseInt(opIn.value) / 100;
      opLabel.setText(opIn.value + "%");
      this.plugin.saveSettings();
    });
    const sm = pop.createDiv("pc-row");
    sm.createSpan({ text: "Smoothing" });
    const smIn = sm.createEl("input", { type: "range", cls: "pc-slider" });
    smIn.min = "0";
    smIn.max = "80";
    smIn.value = String(Math.round((s.pen.smoothing || 0) * 100));
    const smLabel = sm.createSpan({ cls: "pc-size-label", text: smIn.value + "%" });
    smIn.addEventListener("input", () => {
      s.pen.smoothing = parseInt(smIn.value) / 100;
      smLabel.setText(smIn.value + "%");
      this.plugin.saveSettings();
    });
    const list = pop.createDiv("pc-brushes");
    const lib = this.plugin.lib;
    const ink = getComputedStyle(this.contentEl).getPropertyValue("--text-normal").trim() || "#888";
    for (const b of lib.all()) {
      const row = list.createDiv("pc-brush");
      row.toggleClass("is-active", b.id === s.pen.brush);
      const cv = row.createEl("canvas", { cls: "pc-brush-preview" });
      this.drawPreview(cv, b, ink);
      const meta = row.createDiv("pc-brush-meta");
      meta.createDiv({ cls: "pc-brush-name", text: b.name });
      meta.createDiv({ cls: "pc-brush-src", text: (b.source === "builtin" ? "Built-in" : b.source === "tip" ? "Brush tip" : b.source[0].toUpperCase() + b.source.slice(1)) + (b.tip ? " · textured" : " · pure vector") });
      row.addEventListener("click", () => {
        s.pen.brush = b.id;
        this.plugin.saveSettings();
        this.closePopover();
      });
      if (b.source !== "builtin") {
        const del = row.createEl("button", { cls: "pc-btn pc-del", attr: { type: "button", "aria-label": "Remove brush" } });
        setIcon(del, "trash-2");
        del.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (s.pen.brush === b.id) s.pen.brush = "ink";
          lib.remove(b.id);
          this.plugin.persistBrushes();
        });
      }
    }
  }

  private drawPreview(cv: HTMLCanvasElement, b: Brush, color: string) {
    const W = 132, H = 34;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr;
    cv.height = H * dpr;
    const p: number[] = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      p.push(10 + t * (W - 20), H / 2 + Math.sin(t * Math.PI * 2) * 8, 0.12 + 0.75 * Math.sin(t * Math.PI));
    }
    const st: Stroke = { t: "p", b: b.id, c: color, s: 9, o: 1, p, r: 7 };
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.plugin.lib.draw(ctx, st, dpr, true);
  }

  private openMenu(e: MouseEvent) {
    const s = this.plugin.settings;
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("Draw with finger").setIcon("hand").setChecked(s.fingerDraw).onClick(() => {
        s.fingerDraw = !s.fingerDraw;
        this.plugin.saveSettings();
      })
    );
    menu.addItem((i) =>
      i.setTitle("Pen size fixed on canvas").setIcon("ruler").setChecked(s.fixedSize).onClick(() => {
        s.fixedSize = !s.fixedSize;
        this.plugin.saveSettings();
      })
    );
    menu.addItem((i) =>
      i.setTitle("Dotted background").setIcon("grip").setChecked(s.dots).onClick(() => {
        s.dots = !s.dots;
        this.plugin.saveSettings();
        this.plugin.eachView((v) => v.updateBackground());
      })
    );
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Zoom to fit").setIcon("maximize").onClick(() => this.zoomToFit()));
    menu.addItem((i) => i.setTitle("Input test (Apple Pencil double-tap)").setIcon("activity").setChecked(!!this.diagEl).onClick(() => this.toggleDiag()));
    menu.addItem((i) => i.setTitle("Export SVG").setIcon("image-down").onClick(() => this.exportSvg()));
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Clear canvas").setIcon("trash-2").onClick(() => {
        if (!this.strokes.length && !this.images.length) return;
        this.sel = null;
        this.commit([], []);
        this.requestRender();
      })
    );
    menu.showAtMouseEvent(e);
  }

  private bounds(): [number, number, number, number] | null {
    if (!this.strokes.length && !this.images.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const im of this.images) {
      const c = Math.abs(Math.cos(im.r)), s = Math.abs(Math.sin(im.r));
      const hw = (im.w * c + im.h * s) / 2, hh = (im.w * s + im.h * c) / 2;
      x0 = Math.min(x0, im.x - hw);
      y0 = Math.min(y0, im.y - hh);
      x1 = Math.max(x1, im.x + hw);
      y1 = Math.max(y1, im.y + hh);
    }
    for (const st of this.strokes) {
      const b = this.plugin.lib.geoOf(st).bbox;
      x0 = Math.min(x0, b[0]);
      y0 = Math.min(y0, b[1]);
      x1 = Math.max(x1, b[2]);
      y1 = Math.max(y1, b[3]);
    }
    return [x0, y0, x1, y1];
  }

  zoomToFit() {
    const b = this.bounds();
    if (!b || !this.w) return;
    const pad = 60;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min((this.w - pad * 2) / (b[2] - b[0]), (this.h - pad * 2) / (b[3] - b[1]))));
    this.cam.zoom = z;
    this.cam.x = this.w / 2 - ((b[0] + b[2]) / 2) * z;
    this.cam.y = this.h / 2 - ((b[1] + b[3]) / 2) * z;
    this.viewChanged();
  }

  async toSvg(): Promise<string | null> {
    const b = this.bounds();
    if (!b) return null;
    const span = Math.max(b[2] - b[0], b[3] - b[1]);
    const dec = Math.max(0, Math.min(8, 4 - Math.floor(Math.log10(span || 1))));
    const f = (v: number) => String(+v.toFixed(dec));
    const lib = this.plugin.lib;
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(b[0])} ${f(b[1])} ${f(b[2] - b[0])} ${f(b[3] - b[1])}">`,
    ];
    const mimes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif" };
    for (const im of this.images) {
      try {
        const ext = (/\.([^.]+)$/.exec(im.src)?.[1] ?? "png").toLowerCase();
        const data = arrayBufferToBase64(await this.app.vault.adapter.readBinary(im.src));
        const deg = +((im.r * 180) / Math.PI).toFixed(3);
        parts.push(
          `<image href="data:${mimes[ext] ?? "image/png"};base64,${data}" x="${f(im.x - im.w / 2)}" y="${f(im.y - im.h / 2)}" width="${f(im.w)}" height="${f(im.h)}" preserveAspectRatio="none"${deg ? ` transform="rotate(${deg} ${f(im.x)} ${f(im.y)})"` : ""}/>`
        );
      } catch {
        /* image file missing: leave it out */
      }
    }
    for (const st of this.strokes) {
      const g = lib.geoOf(st);
      const br = lib.brushOf(st);
      const o = br.tip ? Math.min(1, st.o * Math.min(1, br.opacity * 2.5)) : st.o;
      parts.push(`<path fill="${st.c}"${o < 1 ? ` fill-opacity="${+o.toFixed(3)}"` : ""} d="${svgPath(g.samples, f)}"/>`);
    }
    parts.push("</svg>");
    return parts.join("\n");
  }

  async exportSvg() {
    const svg = await this.toSvg();
    if (!svg || !this.file) {
      new Notice("Nothing to export yet.");
      return;
    }
    const dir = this.file.parent && this.file.parent.path !== "/" ? this.file.parent.path + "/" : "";
    const path = `${dir}${this.file.basename}.svg`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) await this.app.vault.adapter.write(path, svg);
    else await this.app.vault.create(path, svg);
    new Notice(`Exported ${path}`);
  }
}
