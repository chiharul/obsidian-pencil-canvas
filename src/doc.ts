import { Brush, DrawingFile, Img, Stroke } from "./types";
import type { BrushLibrary } from "./brushes";

export interface Drawing {
  strokes: Stroke[];
  images: Img[];
  view: DrawingFile["view"] | null;
  brushes: Record<string, Brush>;
}

/** Read a .pencil file. Returns null when the text is not a drawing at all (it must then be left untouched). */
export function parseDrawing(data: string): Drawing | null {
  let doc: Partial<DrawingFile> | null = null;
  if (data.trim()) {
    try {
      doc = JSON.parse(data);
    } catch {
      return null;
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
  const images: Img[] = [];
  if (doc && Array.isArray(doc.images)) {
    for (const im of doc.images) {
      if (im && typeof im.src === "string" && im.w > 0 && im.h > 0) {
        images.push({ id: String(im.id ?? Math.random()), src: im.src, x: +im.x || 0, y: +im.y || 0, w: im.w, h: im.h, r: +im.r || 0 });
      }
    }
  }
  const view = doc?.view && isFinite(doc.view.zoom) && doc.view.zoom > 0 ? { x: doc.view.x || 0, y: doc.view.y || 0, zoom: doc.view.zoom } : null;
  return { strokes, images, view, brushes: doc?.brushes && typeof doc.brushes === "object" ? doc.brushes : {} };
}

/** The text of a .pencil file. Brushes that are not built in travel with the drawing. */
export function serializeDrawing(strokes: Stroke[], images: Img[], view: DrawingFile["view"] | null, lib: BrushLibrary): string {
  const brushes: Record<string, Brush> = {};
  for (const st of strokes) {
    if (st.t === "p" && !lib.isBuiltin(st.b) && !brushes[st.b]) {
      const b = lib.get(st.b);
      if (b.id === st.b) brushes[st.b] = b;
    }
  }
  const doc: Partial<DrawingFile> = { app: "pencil-canvas", version: 1 };
  if (view) doc.view = view;
  doc.strokes = strokes;
  doc.images = images;
  doc.brushes = brushes;
  return JSON.stringify(doc);
}

/** Bounding box of everything in a drawing, in world units. */
export function drawingBounds(strokes: Stroke[], images: Img[], lib: BrushLibrary): [number, number, number, number] | null {
  if (!strokes.length && !images.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const im of images) {
    const c = Math.abs(Math.cos(im.r)), s = Math.abs(Math.sin(im.r));
    const hw = (im.w * c + im.h * s) / 2, hh = (im.w * s + im.h * c) / 2;
    x0 = Math.min(x0, im.x - hw);
    y0 = Math.min(y0, im.y - hh);
    x1 = Math.max(x1, im.x + hw);
    y1 = Math.max(y1, im.y + hh);
  }
  for (const st of strokes) {
    const b = lib.geoOf(st).bbox;
    x0 = Math.min(x0, b[0]);
    y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[2]);
    y1 = Math.max(y1, b[3]);
  }
  return [x0, y0, x1, y1];
}
