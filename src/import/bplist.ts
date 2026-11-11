/** Minimal binary property list reader + NSKeyedArchiver flattening (enough for Procreate's Brush.archive). */

export class UID {
  constructor(public value: number) {}
}

export function parseBplist(buf: Uint8Array): any {
  if (buf.length < 40 || String.fromCharCode(...buf.subarray(0, 6)) !== "bplist") throw new Error("Not a binary plist");
  const int = (pos: number, size: number) => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i];
    return v;
  };
  const t = buf.length - 32;
  const offSize = buf[t + 6];
  const refSize = buf[t + 7];
  const count = int(t + 8, 8);
  const top = int(t + 16, 8);
  const table = int(t + 24, 8);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const memo = new Map<number, any>();

  const read = (idx: number, depth: number): any => {
    if (memo.has(idx)) return memo.get(idx);
    if (idx >= count || depth > 64) return null;
    let pos = int(table + idx * offSize, offSize);
    const marker = buf[pos++];
    const type = marker >> 4;
    let info = marker & 15;
    const len = () => {
      if (info !== 15) return info;
      const sz = 1 << (buf[pos++] & 15);
      const v = int(pos, sz);
      pos += sz;
      return v;
    };
    let val: any;
    switch (type) {
      case 0:
        val = info === 8 ? false : info === 9 ? true : null;
        break;
      case 1: {
        const sz = 1 << info;
        if (sz === 8) {
          const hi = int(pos, 4);
          const lo = int(pos + 4, 4);
          val = hi >= 0x80000000 ? -((0xffffffff - hi) * 4294967296 + (0xffffffff - lo) + 1) : hi * 4294967296 + lo;
        } else val = int(pos, sz);
        break;
      }
      case 2:
        val = info === 2 ? dv.getFloat32(pos) : dv.getFloat64(pos);
        break;
      case 3:
        val = dv.getFloat64(pos);
        break;
      case 4: {
        const n = len();
        val = buf.subarray(pos, pos + n);
        break;
      }
      case 5: {
        const n = len();
        let s = "";
        for (let i = 0; i < n; i++) s += String.fromCharCode(buf[pos + i]);
        val = s;
        break;
      }
      case 6: {
        const n = len();
        let s = "";
        for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(pos + i * 2));
        val = s;
        break;
      }
      case 8:
        val = new UID(int(pos, info + 1));
        break;
      case 10:
      case 12: {
        const n = len();
        const arr: any[] = [];
        memo.set(idx, arr);
        for (let i = 0; i < n; i++) arr.push(read(int(pos + i * refSize, refSize), depth + 1));
        return arr;
      }
      case 13: {
        const n = len();
        const obj: Record<string, any> = {};
        memo.set(idx, obj);
        for (let i = 0; i < n; i++) {
          const k = read(int(pos + i * refSize, refSize), depth + 1);
          obj[String(k)] = read(int(pos + (n + i) * refSize, refSize), depth + 1);
        }
        return obj;
      }
      default:
        val = null;
    }
    memo.set(idx, val);
    return val;
  };
  return read(top, 0);
}

/** Return the root object of an NSKeyedArchiver plist with first-level UID references resolved. */
export function unarchiveRoot(plist: any): Record<string, any> {
  const objects: any[] = plist?.$objects;
  const top = plist?.$top;
  if (!Array.isArray(objects) || !top) throw new Error("Not a keyed archive");
  const rootRef = top.root ?? Object.values(top)[0];
  const deref = (v: any): any => {
    if (v instanceof UID) {
      const o = objects[v.value];
      if (o === "$null") return null;
      if (o && typeof o === "object" && "NS.string" in o) return o["NS.string"];
      return o;
    }
    return v;
  };
  const root = deref(rootRef);
  const out: Record<string, any> = {};
  if (root && typeof root === "object") for (const k of Object.keys(root)) out[k] = deref(root[k]);
  return out;
}
