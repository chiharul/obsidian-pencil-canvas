/** Turn brush-tip images into a small white-on-alpha mask stored as a PNG data URL. */

export type TipMode = "white" | "black" | "alpha";

const MAX = 128;

export async function decodeImage(bytes: Uint8Array, mime: string): Promise<HTMLCanvasElement | null> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("decode failed"));
      img.src = url;
    });
    const w = img.naturalWidth || 256;
    const h = img.naturalHeight || 256;
    const k = Math.min(1, 1024 / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function canvasFromRGBA(w: number, h: number, rgba: Uint8ClampedArray): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * mode "white": white pixels paint (Procreate). "black": dark pixels paint (Krita / GIMP images).
 * "alpha": the alpha channel is the mask.
 * Returns undefined when the tip is empty or is just a hard round dot — those render
 * as a pure vector outline instead.
 */
export function makeTip(src: HTMLCanvasElement, mode: TipMode, invert = false): string | undefined {
  const k = Math.min(1, MAX / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const m = new Float32Array(n);
  let minA = 255;
  for (let i = 0; i < n; i++) if (d[i * 4 + 3] < minA) minA = d[i * 4 + 3];
  const hasAlpha = minA < 250;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const lum = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
    const a = d[i * 4 + 3];
    let v: number;
    if (mode === "white") v = (lum * a) / 255;
    else if (mode === "black") v = ((255 - lum) * a) / 255;
    else v = hasAlpha ? a : 255 - lum;
    m[i] = v;
    if (v > max) max = v;
  }
  if (max < 16 && hasAlpha) {
    // e.g. a black shape on transparency in "white" mode: fall back to alpha
    max = 0;
    for (let i = 0; i < n; i++) {
      m[i] = d[i * 4 + 3];
      if (m[i] > max) max = m[i];
    }
  }
  const corners = [0, w - 1, (h - 1) * w, n - 1];
  const cornersSolid = corners.every((i) => m[i] > 128);
  // A usable tip never has opaque corners, so the corners decide the polarity
  // (more reliable than the "inverted" flags, which describe the source image).
  void invert;
  if (cornersSolid) {
    max = 0;
    for (let i = 0; i < n; i++) {
      m[i] = 255 - m[i];
      if (m[i] > max) max = m[i];
    }
  }
  if (max < 16) return undefined;
  const gain = 255 / max;

  // hard round dot → no texture needed
  if (Math.abs(w - h) <= Math.max(1, w * 0.1)) {
    let inside = 0, insideOk = 0, outside = 0, outsideOk = 0;
    const rad = Math.min(w, h) / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dist = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) / rad;
        const v = m[y * w + x] * gain;
        if (dist < 0.8) {
          inside++;
          if (v > 225) insideOk++;
        } else if (dist > 1.05) {
          outside++;
          if (v < 30) outsideOk++;
        }
      }
    }
    if (inside && insideOk / inside > 0.985 && (!outside || outsideOk / outside > 0.97)) return undefined;
  }

  for (let i = 0; i < n; i++) {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255;
    d[i * 4 + 3] = Math.round(m[i] * gain);
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

/** GIMP .gbr (also used by Krita). Returns canvas + spacing (fraction). */
export function parseGbr(buf: Uint8Array, offset = 0): { canvas: HTMLCanvasElement; mode: TipMode; spacing: number; name: string; end: number } | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < offset + 20) return null;
  const headerSize = dv.getUint32(offset);
  const version = dv.getUint32(offset + 4);
  const w = dv.getUint32(offset + 8);
  const h = dv.getUint32(offset + 12);
  const bytes = dv.getUint32(offset + 16);
  if (!w || !h || w > 16384 || h > 16384 || (bytes !== 1 && bytes !== 4) || version < 1 || version > 3) return null;
  let spacing = 0.1;
  let nameStart = offset + 20;
  if (version >= 2) {
    if (String.fromCharCode(...buf.subarray(offset + 20, offset + 24)) !== "GIMP") return null;
    spacing = dv.getUint32(offset + 24) / 100;
    nameStart = offset + 28;
  }
  const name = new TextDecoder().decode(buf.subarray(nameStart, offset + headerSize)).replace(/\0+$/, "");
  const start = offset + headerSize;
  const size = w * h * bytes;
  if (start + size > buf.length) return null;
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (bytes === 1) {
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 255;
      rgba[i * 4 + 3] = buf[start + i];
    }
  } else rgba.set(buf.subarray(start, start + size));
  return { canvas: canvasFromRGBA(w, h, rgba), mode: bytes === 1 ? "white" : "alpha", spacing, name, end: start + size };
}

/** GIMP image hose (.gih): use the first cell. */
export function parseGih(buf: Uint8Array) {
  let nl = 0;
  let i = 0;
  for (; i < buf.length && nl < 2; i++) if (buf[i] === 10) nl++;
  if (nl < 2) return null;
  return parseGbr(buf, i);
}
