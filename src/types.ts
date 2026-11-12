export type Tool = "pen" | "highlighter" | "eraser";

/** How a pen stroke's vector path is rendered. */
export interface Brush {
  id: string;
  name: string;
  source: "builtin" | "procreate" | "krita" | "tip";
  /** PNG data URL (white + alpha mask) or "builtin:<name>". Absent = pure vector outline. */
  tip?: string;
  /** Stamp spacing as a fraction of the stamp diameter. */
  spacing: number;
  /** 0..1: how much pen pressure changes width. */
  sizePressure: number;
  /** 0..1: how much pen pressure changes opacity. */
  opacityPressure: number;
  /** Width at zero pressure, as a fraction of the nominal width. */
  minSize: number;
  /** Per-stamp opacity (flow). */
  opacity: number;
  /** Position scatter as a fraction of the diameter. */
  jitter: number;
  sizeJitter: number;
  opacityJitter: number;
  /** 0..1: random rotation per stamp. */
  rotJitter: number;
  /** Rotate the tip to follow the stroke direction. */
  followStroke: boolean;
  /** Base tip rotation in radians. */
  angle: number;
  /** Taper lengths (0..1). */
  taperStart: number;
  taperEnd: number;
  /** 0..1 input smoothing. */
  streamline: number;
}

/**
 * A stroke is stored as vector data: a centre line of (x, y, pressure) triples
 * in world units plus the brush / colour / width used to render it.
 */
export interface Stroke {
  /** "p" = pen, "h" = highlighter */
  t: "p" | "h";
  /** brush id (pen only) */
  b: string;
  /** colour */
  c: string;
  /** nominal width in world units */
  s: number;
  /** opacity */
  o: number;
  /** flat x, y, pressure triples */
  p: number[];
  /** bit 1: no taper at start, bit 2: no taper at end (set when the eraser cuts a stroke) */
  k?: number;
  /** random seed for jitter */
  r?: number;
}

/** A placed image. The picture itself is a normal attachment file in the vault. */
export interface Img {
  id: string;
  /** vault path of the image file */
  src: string;
  /** centre, in world units */
  x: number;
  y: number;
  w: number;
  h: number;
  /** rotation in radians */
  r: number;
}

export interface DrawingFile {
  images?: Img[];
  app: "pencil-canvas";
  version: 1;
  view: { x: number; y: number; zoom: number };
  strokes: Stroke[];
  /** imported brushes used by this drawing, so it renders the same on every device */
  brushes?: Record<string, Brush>;
}

export interface Settings {
  pen: { size: number; color: string; opacity: number; brush: string; smoothing: number };
  highlighter: { size: number; color: string };
  eraser: { size: number; mode: "stroke" | "partial" };
  fingerDraw: boolean;
  /** true: pen / highlighter width is fixed on the canvas; false: fixed on screen (thinner lines when zoomed in) */
  fixedSize: boolean;
  dots: boolean;
  brushes: Brush[];
}
