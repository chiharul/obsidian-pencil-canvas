import { unzipSync, unzlibSync } from "fflate";
import { Brush } from "../types";
import { BRUSH_DEFAULTS, brushHash } from "../brushes";
import { parseBplist, unarchiveRoot } from "./bplist";
import { TipMode, canvasFromRGBA, decodeImage, makeTip, parseGbr, parseGih } from "./tip";

export interface ImportResult {
  brushes: Brush[];
  warnings: string[];
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const num = (v: any, def: number) => (typeof v === "number" && isFinite(v) ? v : typeof v === "boolean" ? (v ? 1 : 0) : def);
const stem = (name: string) => name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
const ext = (name: string) => (/\.([^.\\/]+)$/.exec(name)?.[1] ?? "").toLowerCase();

function finish(b: Omit<Brush, "id">): Brush {
  return { ...b, id: `${b.source}-${brushHash(b)}` };
}

// ------------------------------------------------------------------ Procreate

async function procreateBrush(archive: Uint8Array, shape: Uint8Array | undefined, fallbackName: string, warnings: string[]): Promise<Brush> {
  const o = unarchiveRoot(parseBplist(archive));
  const name = (typeof o.name === "string" && o.name.trim()) || fallbackName;
  let tip: string | undefined;
  if (shape) {
    const cv = await decodeImage(shape, "image/png");
    if (cv) tip = makeTip(cv, "white", !!o.shapeInverted);
  } else if (typeof o.bundledShapePath === "string" && o.bundledShapePath) {
    warnings.push(`"${name}" uses a shape that ships inside Procreate itself, so a round tip is used instead.`);
  }
  const taperStart = num(o.pencilTaperStartLength, num(o.taperStartLength, 0));
  const taperEnd = num(o.pencilTaperEndLength, num(o.taperEndLength, 0));
  return finish({
    ...BRUSH_DEFAULTS,
    name,
    source: "procreate",
    tip,
    spacing: clamp(num(o.plotSpacing, 0.1), 0.03, 3),
    jitter: clamp(num(o.plotJitter, 0), 0, 3),
    sizePressure: clamp(Math.abs(num(o.dynamicsPressureSize, 0)), 0, 1),
    opacityPressure: clamp(Math.abs(num(o.dynamicsPressureOpacity, 0)), 0, 1),
    minSize: 0.08,
    opacity: clamp(num(o.maxOpacity, 1), 0.02, 1),
    sizeJitter: clamp(num(o.dynamicsJitterSize, 0), 0, 1),
    opacityJitter: clamp(num(o.dynamicsJitterOpacity, 0), 0, 1),
    rotJitter: clamp(num(o.shapeScatter, 0), 0, 1),
    followStroke: Math.abs(num(o.shapeRotation, 0)) > 0.5,
    angle: 0,
    taperStart: clamp(taperStart, 0, 1),
    taperEnd: clamp(taperEnd, 0, 1),
    streamline: clamp(num(o.plotSmoothing, 0.2), 0, 1),
  });
}

async function importProcreateZip(data: Uint8Array, fileName: string, res: ImportResult) {
  const files = unzipSync(data, { filter: (f) => /(^|\/)(Brush\.archive|Shape\.png)$/i.test(f.name) });
  const archives = Object.keys(files).filter((n) => /(^|\/)Brush\.archive$/i.test(n)).sort();
  if (!archives.length) throw new Error("no Brush.archive inside");
  for (const a of archives) {
    const dir = a.slice(0, a.length - "Brush.archive".length);
    const shapeKey = Object.keys(files).find((n) => n.toLowerCase() === (dir + "Shape.png").toLowerCase());
    try {
      res.brushes.push(await procreateBrush(files[a], shapeKey ? files[shapeKey] : undefined, stem(fileName), res.warnings));
    } catch (e) {
      res.warnings.push(`${fileName}: could not read ${a} (${(e as Error).message})`);
    }
  }
}

// ------------------------------------------------------------------ Krita

function pngText(buf: Uint8Array, key: string): string | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((v, i) => buf[i] === v)) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const latin = (a: Uint8Array) => {
    let s = "";
    for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode(...a.subarray(i, i + 8192));
    return s;
  };
  const text = (a: Uint8Array) => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(a);
    } catch {
      return latin(a);
    }
  };
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = dv.getUint32(pos);
    const type = latin(buf.subarray(pos + 4, pos + 8));
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type !== "tEXt" && type !== "zTXt" && type !== "iTXt") continue;
    const z = body.indexOf(0);
    if (z < 0 || latin(body.subarray(0, z)) !== key) continue;
    if (type === "tEXt") return text(body.subarray(z + 1));
    if (type === "zTXt") return text(unzlibSync(body.subarray(z + 2)));
    const compressed = body[z + 1] === 1;
    let p = z + 3;
    while (p < body.length && body[p] !== 0) p++; // language tag
    p++;
    while (p < body.length && body[p] !== 0) p++; // translated keyword
    p++;
    const rest = body.subarray(p);
    return text(compressed ? unzlibSync(rest) : rest);
  }
  return null;
}

async function tipFromFile(bytes: Uint8Array, name: string): Promise<{ tip?: string; spacing?: number; ok: boolean }> {
  const e = ext(name);
  if (e === "gbr" || e === "gih") {
    const g = e === "gbr" ? parseGbr(bytes) : parseGih(bytes);
    if (!g) return { ok: false };
    return { tip: makeTip(g.canvas, g.mode), spacing: g.spacing, ok: true };
  }
  if (e === "png" || e === "svg" || e === "jpg" || e === "jpeg") {
    const cv = await decodeImage(bytes, e === "svg" ? "image/svg+xml" : e === "png" ? "image/png" : "image/jpeg");
    if (!cv) return { ok: false };
    return { tip: makeTip(cv, "black"), ok: true };
  }
  return { ok: false };
}

function autoBrushTip(mask: Element | null): string | undefined {
  if (!mask) return undefined;
  const type = mask.getAttribute("type") ?? "circle";
  const ratio = clamp(parseFloat(mask.getAttribute("ratio") ?? "1") || 1, 0.02, 1);
  const hf = clamp(parseFloat(mask.getAttribute("hfade") ?? "1"), 0, 1);
  const vf = clamp(parseFloat(mask.getAttribute("vfade") ?? "1"), 0, 1);
  const fade = isNaN(hf) || isNaN(vf) ? 1 : (hf + vf) / 2;
  const id = mask.getAttribute("id") ?? "default";
  const soft = id !== "default";
  if (type === "circle" && ratio > 0.95 && fade > 0.9 && !soft) return undefined; // hard round → vector
  const n = 96;
  const rgba = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5 - n / 2) / (n / 2);
      const dy = (y + 0.5 - n / 2) / (n / 2) / ratio;
      const d = type === "rect" ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy);
      let a = 0;
      if (d < 1) {
        if (soft) a = Math.exp(-d * d * 4) * (1 - d * d);
        else a = d <= fade ? 1 : (1 - d) / Math.max(1e-3, 1 - fade);
      }
      const i = (y * n + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 255;
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return makeTip(canvasFromRGBA(n, n, rgba), "alpha");
}

function b64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function kritaPreset(
  kpp: Uint8Array,
  fileName: string,
  lookup: (file: string) => Uint8Array | undefined,
  warnings: string[]
): Promise<Brush> {
  const xml = pngText(kpp, "preset");
  if (!xml) throw new Error("no preset data inside the .kpp");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement;
  if (!root || root.nodeName === "parsererror" || doc.getElementsByTagName("parsererror").length) throw new Error("preset XML is invalid");
  const params: Record<string, string> = {};
  Array.from(root.getElementsByTagName("param")).forEach((p) => {
    const n = p.getAttribute("name");
    if (n) params[n] = p.textContent ?? "";
  });
  const embedded = new Map<string, Uint8Array>();
  Array.from(root.getElementsByTagName("resource")).forEach((r) => {
    const f = r.getAttribute("filename") || r.getAttribute("name");
    try {
      if (f && r.textContent) embedded.set(stem(f).toLowerCase() + "." + ext(f), b64(r.textContent));
    } catch {
      /* ignore broken resource */
    }
  });
  const name = (root.getAttribute("name") || stem(fileName)).replace(/_/g, " ").trim();
  const paintop = root.getAttribute("paintopid") ?? "paintbrush";
  if (paintop !== "paintbrush") warnings.push(`"${name}" uses Krita's "${paintop}" engine; it is imported as a regular stamp brush.`);

  const bool = (k: string, def: boolean) => (k in params ? params[k] === "true" : def);
  const f = (k: string, def: number) => {
    const v = parseFloat(params[k]);
    return isFinite(v) ? v : def;
  };

  let tip: string | undefined;
  let spacing = 0.1;
  let angle = 0;
  const def = params["brush_definition"];
  if (def) {
    const bd = new DOMParser().parseFromString(def, "text/xml").documentElement;
    if (bd && bd.nodeName !== "parsererror") {
      const type = bd.getAttribute("type") ?? "auto_brush";
      const sp = parseFloat(bd.getAttribute("spacing") ?? "");
      if (isFinite(sp)) spacing = sp;
      if (bd.getAttribute("useAutoSpacing") === "1") spacing = 0.1;
      const ang = parseFloat(bd.getAttribute("angle") ?? "");
      if (isFinite(ang)) angle = ang;
      if (type === "auto_brush") tip = autoBrushTip(bd.getElementsByTagName("MaskGenerator")[0] ?? null);
      else {
        const file = bd.getAttribute("filename") ?? "";
        const key = stem(file).toLowerCase() + "." + ext(file);
        const bytes = embedded.get(key) ?? lookup(file);
        if (bytes) {
          const t = await tipFromFile(bytes, file);
          if (t.ok) tip = t.tip;
          else warnings.push(`"${name}": the tip "${file}" could not be decoded; a round tip is used.`);
        } else if (file) {
          warnings.push(`"${name}": its tip "${file}" is not inside this file (it lives in Krita's resource folder). Import the .bundle, or a round tip is used.`);
        }
      }
    }
  }
  const rot = params["RotationSensor"] ?? "";
  const sizeSensor = params["SizeSensor"] ?? "pressure";
  return finish({
    ...BRUSH_DEFAULTS,
    name,
    source: "krita",
    tip,
    spacing: clamp(spacing, 0.03, 3),
    sizePressure: bool("PressureSize", true) && /pressure/.test(sizeSensor) ? 1 : 0,
    opacityPressure: (bool("PressureOpacity", false) || bool("PressureFlow", false)) ? 0.8 : 0,
    minSize: 0.05,
    opacity: clamp(f("OpacityValue", 1) * f("FlowValue", 1), 0.02, 1),
    jitter: bool("PressureScatter", false) ? clamp(f("ScatterValue", 1) * 0.5, 0, 2) : 0,
    rotJitter: bool("PressureRotation", false) && /fuzzy/.test(rot) ? 1 : 0,
    followStroke: bool("PressureRotation", false) && /drawingangle/.test(rot),
    angle,
    streamline: 0.2,
  });
}

async function importKritaBundle(data: Uint8Array, fileName: string, res: ImportResult) {
  const files = unzipSync(data, { filter: (f) => /\.(kpp|gbr|gih|png|svg)$/i.test(f.name) && f.originalSize < 40e6 });
  const tips = new Map<string, Uint8Array>();
  for (const n of Object.keys(files)) if (!/\.kpp$/i.test(n)) tips.set(n.replace(/^.*\//, "").toLowerCase(), files[n]);
  const presets = Object.keys(files).filter((n) => /\.kpp$/i.test(n)).sort();
  if (!presets.length) throw new Error("no brush presets (.kpp) inside");
  for (const p of presets) {
    try {
      res.brushes.push(await kritaPreset(files[p], p, (f) => tips.get(f.replace(/^.*[\\/]/, "").toLowerCase()), res.warnings));
    } catch (e) {
      res.warnings.push(`${stem(p)}: ${(e as Error).message}`);
    }
  }
}

// ------------------------------------------------------------------ entry point

export async function importBrushFile(name: string, data: Uint8Array): Promise<ImportResult> {
  const res: ImportResult = { brushes: [], warnings: [] };
  const e = ext(name);
  const isZip = data[0] === 0x50 && data[1] === 0x4b;
  try {
    if (e === "brush" || e === "brushset") await importProcreateZip(data, name, res);
    else if (e === "bundle") await importKritaBundle(data, name, res);
    else if (e === "kpp") res.brushes.push(await kritaPreset(data, name, () => undefined, res.warnings));
    else if (e === "gbr" || e === "gih" || e === "png" || e === "svg") {
      const t = await tipFromFile(data, name);
      if (!t.ok) throw new Error("could not read the brush tip");
      res.brushes.push(
        finish({ ...BRUSH_DEFAULTS, name: stem(name), source: "tip", tip: t.tip, spacing: clamp(t.spacing ?? 0.15, 0.03, 3), sizePressure: 0.6 })
      );
    } else if (isZip) {
      const listing: string[] = [];
      unzipSync(data, { filter: (f) => (listing.push(f.name), false) });
      if (listing.some((n) => /Brush\.archive$/i.test(n))) await importProcreateZip(data, name, res);
      else if (listing.some((n) => /\.kpp$/i.test(n))) await importKritaBundle(data, name, res);
      else throw new Error("no Procreate or Krita brushes found in this archive");
    } else if (e === "abr") throw new Error("Photoshop .abr brushes are not supported");
    else throw new Error("unsupported file type");
  } catch (err) {
    res.warnings.push(`${name}: ${(err as Error).message}`);
  }
  return res;
}
