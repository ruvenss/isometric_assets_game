// Voxel-style renderer for isometric (2:1 dimetric) game sprites. Zero dependencies.
//
// Models are built from rounded solids (signed distance fields) on a 1 unit = 1 tile grid
// and ray-marched with an orthographic 2:1 dimetric camera: soft projected shadows,
// ambient occlusion, 2x2 supersampling, no outlines. Used by scripts/office-voxel.mjs.
//
// Axes: x runs down-right on screen, y down-left, z up. A model's front is +y.
// Screen: sx = (x - y) * 128, sy = (x + y) * 64 - z * 128 (origin = back vertex of the footprint).

import { deflateSync, inflateSync } from 'node:zlib';

export const TW = 256, TH = 128, HW = TW / 2, HH = TH / 2, ZS = 128; // px per tile / per unit of height
export const CELL_W = 256, CELL_H = 512;                              // fixed canvas of walls and wall pieces

// ---------------------------------------------------------------- image + png
export const img = (w, h) => ({ w, h, d: new Uint8Array(w * h * 4) });
const CRC = new Int32Array(256).map((_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(im) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(im.w, 0); ihdr.writeUInt32BE(im.h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const row = im.w * 4 + 1, raw = Buffer.alloc(row * im.h);
  for (let y = 0; y < im.h; y++) Buffer.from(im.d.buffer, im.d.byteOffset + y * im.w * 4, im.w * 4).copy(raw, y * row + 1);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// Decoder for 8-bit RGBA, non-interlaced PNGs (what encodePng writes).
export function decodePng(buf) {
  let p = 8, w = 0, h = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('decodePng: only 8-bit RGBA, non-interlaced');
    } else if (type === 'IDAT') idat.push(data);
    p += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat)), im = img(w, h), bpl = w * 4;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (bpl + 1)], src = y * (bpl + 1) + 1, dst = y * bpl;
    for (let i = 0; i < bpl; i++) {
      const a = i >= 4 ? im.d[dst + i - 4] : 0, b = y ? im.d[dst + i - bpl] : 0, c = i >= 4 && y ? im.d[dst + i - bpl - 4] : 0;
      let v = raw[src + i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      im.d[dst + i] = v;
    }
  }
  return im;
}
// Alpha-blend src over dst at (ox, oy).
export function over(dst, src, ox, oy) {
  for (let y = 0; y < src.h; y++) {
    const ty = oy + y; if (ty < 0 || ty >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const tx = ox + x; if (tx < 0 || tx >= dst.w) continue;
      const s = (y * src.w + x) * 4, sa = src.d[s + 3]; if (!sa) continue;
      const t = (ty * dst.w + tx) * 4, da = dst.d[t + 3];
      if (sa === 255 || !da) { dst.d[t] = src.d[s]; dst.d[t + 1] = src.d[s + 1]; dst.d[t + 2] = src.d[s + 2]; dst.d[t + 3] = sa; continue; }
      const a = sa / 255, b = (da / 255) * (1 - a), o = a + b;
      for (let k = 0; k < 3; k++) dst.d[t + k] = Math.round((src.d[s + k] * a + dst.d[t + k] * b) / o);
      dst.d[t + 3] = Math.round(o * 255);
    }
  }
}
export function crop(im, x0, y0, w, h) {
  const out = img(w, h);
  for (let y = 0; y < h; y++) {
    const sy = y0 + y; if (sy < 0 || sy >= im.h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x0 + x; if (sx < 0 || sx >= im.w) continue;
      out.d.set(im.d.subarray((sy * im.w + sx) * 4, (sy * im.w + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return out;
}
// Bounding box of the non-transparent pixels, or null.
export function contentBox(im) {
  let x0 = im.w, y0 = im.h, x1 = -1, y1 = -1;
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) if (im.d[(y * im.w + x) * 4 + 3]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------------------------------------------------------------- colour + noise
export const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export const rgb = (c) => (typeof c === 'string' ? hex(c) : c);
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const mul = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const mod = (a, n) => ((a % n) + n) % n;
export function hash(x, y, s = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Smooth value noise, periodic with `n` cells per unit (seamless across tiles when n is an integer).
export function pnoise(u, v, n, s = 0) {
  const gu = u * n, gv = v * n, iu = Math.floor(gu), iv = Math.floor(gv);
  const fu = gu - iu, fv = gv - iv, a = fu * fu * (3 - 2 * fu), b = fv * fv * (3 - 2 * fv);
  const g = (i, j) => hash(mod(i, n), mod(j, n), s);
  const p = g(iu, iv) + (g(iu + 1, iv) - g(iu, iv)) * a, q = g(iu, iv + 1) + (g(iu + 1, iv + 1) - g(iu, iv + 1)) * a;
  return p + (q - p) * b;
}
// Non-periodic 3D value noise for props.
export function noise3(x, y, z, s = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz, a = fx * fx * (3 - 2 * fx), b = fy * fy * (3 - 2 * fy), c = fz * fz * (3 - 2 * fz);
  const g = (i, j, k) => hash(i + k * 57, j - k * 131, s);
  const l = (k) => {
    const p = g(ix, iy, k) + (g(ix + 1, iy, k) - g(ix, iy, k)) * a, q = g(ix, iy + 1, k) + (g(ix + 1, iy + 1, k) - g(ix, iy + 1, k)) * a;
    return p + (q - p) * b;
  };
  const p = l(iz), q = l(iz + 1);
  return p + (q - p) * c;
}

// ---------------------------------------------------------------- solids (signed distance fields)
// A shape is { d(x, y, z) -> distance, bb: [x0, y0, z0, x1, y1, z1] }.
const mk = (d, bb) => ({ d, bb });
export function box(x0, x1, y0, y1, z0, z1, r = 0.012) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2, hx = (x1 - x0) / 2, hy = (y1 - y0) / 2, hz = (z1 - z0) / 2;
  r = Math.min(r, hx, hy, hz);
  const ax = hx - r, ay = hy - r, az = hz - r;
  return mk((x, y, z) => {
    const qx = Math.abs(x - cx) - ax, qy = Math.abs(y - cy) - ay, qz = Math.abs(z - cz) - az;
    const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0, oz = qz > 0 ? qz : 0;
    const m = qx > qy ? (qx > qz ? qx : qz) : (qy > qz ? qy : qz);
    return Math.sqrt(ox * ox + oy * oy + oz * oz) + (m < 0 ? m : 0) - r;
  }, [x0, y0, z0, x1, y1, z1]);
}
// Cylinder along `axis` ('z' default): centre line through (c1, c2) in the other two axes, from a0 to a1.
export function cyl(c1, c2, a0, a1, R, r = 0.008, axis = 'z') {
  const ca = (a0 + a1) / 2, ha = (a1 - a0) / 2; r = Math.min(r, R, ha);
  const RR = R - r, hh = ha - r;
  const f = (p, q, a) => {
    const dr = Math.sqrt((p - c1) * (p - c1) + (q - c2) * (q - c2)) - RR, da = Math.abs(a - ca) - hh;
    const o1 = dr > 0 ? dr : 0, o2 = da > 0 ? da : 0, m = dr > da ? dr : da;
    return Math.sqrt(o1 * o1 + o2 * o2) + (m < 0 ? m : 0) - r;
  };
  if (axis === 'z') return mk((x, y, z) => f(x, y, z), [c1 - R, c2 - R, a0, c1 + R, c2 + R, a1]);
  if (axis === 'y') return mk((x, y, z) => f(x, z, y), [c1 - R, a0, c2 - R, c1 + R, a1, c2 + R]); // (c1, c2) = (x, z)
  return mk((x, y, z) => f(y, z, x), [a0, c1 - R, c2 - R, a1, c1 + R, c2 + R]);                   // (c1, c2) = (y, z)
}
export const sph = (cx, cy, cz, R) => mk((x, y, z) => Math.sqrt((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) - R, [cx - R, cy - R, cz - R, cx + R, cy + R, cz + R]);
export function ell(cx, cy, cz, rx, ry, rz) {
  const m = Math.min(rx, ry, rz);
  return mk((x, y, z) => {
    const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
    const k0 = Math.sqrt(px * px + py * py + pz * pz);
    if (k0 < 1e-6) return -m;
    const k1 = Math.sqrt((px / rx) ** 2 + (py / ry) ** 2 + (pz / rz) ** 2);
    return (k0 * (k0 - 1)) / k1;
  }, [cx - rx, cy - ry, cz - rz, cx + rx, cy + ry, cz + rz]);
}
export function cap(ax, ay, az, bx, by, bz, r) {
  const ex = bx - ax, ey = by - ay, ez = bz - az, ee = ex * ex + ey * ey + ez * ez || 1e-9;
  return mk((x, y, z) => {
    const px = x - ax, py = y - ay, pz = z - az;
    let h = (px * ex + py * ey + pz * ez) / ee; h = h < 0 ? 0 : h > 1 ? 1 : h;
    const dx = px - ex * h, dy = py - ey * h, dz = pz - ez * h;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
  }, [Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.min(az, bz) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r, Math.max(az, bz) + r]);
}
// Ring around `axis` through centre (cx, cy, cz).
export function tor(cx, cy, cz, R, r, axis = 'z') {
  const f = (p, q, a) => { const k = Math.sqrt(p * p + q * q) - R; return Math.sqrt(k * k + a * a) - r; };
  const o = R + r;
  if (axis === 'z') return mk((x, y, z) => f(x - cx, y - cy, z - cz), [cx - o, cy - o, cz - r, cx + o, cy + o, cz + r]);
  if (axis === 'y') return mk((x, y, z) => f(x - cx, z - cz, y - cy), [cx - o, cy - r, cz - o, cx + o, cy + r, cz + o]);
  return mk((x, y, z) => f(y - cy, z - cz, x - cx), [cx - r, cy - o, cz - o, cx + r, cy + o, cz + o]);
}
// Truncated cone along z: radius r0 at z0, r1 at z1.
export function cone(cx, cy, z0, z1, r0, r1) {
  const h = (z1 - z0) / 2, cz = (z0 + z1) / 2, k2x = r1 - r0, k2y = 2 * h, kk = k2x * k2x + k2y * k2y, R = Math.max(r0, r1);
  return mk((x, y, z) => {
    const qx = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2), qy = z - cz;
    const cax = qx - Math.min(qx, qy < 0 ? r0 : r1), cay = Math.abs(qy) - h;
    let t = ((r1 - qx) * k2x + (h - qy) * k2y) / kk; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cbx = qx - r1 + k2x * t, cby = qy - h + k2y * t;
    const s = cbx < 0 && cay < 0 ? -1 : 1;
    return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
  }, [cx - R, cy - R, z0, cx + R, cy + R, z1]);
}
const bbUnion = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])];
const bbGrow = (a, g) => [a[0] - g, a[1] - g, a[2] - g, a[3] + g, a[4] + g, a[5] + g];
export const uni = (...s) => mk((x, y, z) => { let m = 1e9; for (const a of s) { const d = a.d(x, y, z); if (d < m) m = d; } return m; }, s.map((a) => a.bb).reduce(bbUnion));
export const cut = (a, ...bs) => mk((x, y, z) => { let d = a.d(x, y, z); for (const b of bs) { const e = -b.d(x, y, z); if (e > d) d = e; } return d; }, a.bb);
export const isect = (a, b) => mk((x, y, z) => Math.max(a.d(x, y, z), b.d(x, y, z)), [Math.max(a.bb[0], b.bb[0]), Math.max(a.bb[1], b.bb[1]), Math.max(a.bb[2], b.bb[2]), Math.min(a.bb[3], b.bb[3]), Math.min(a.bb[4], b.bb[4]), Math.min(a.bb[5], b.bb[5])]);
export const shell = (a, th) => mk((x, y, z) => Math.abs(a.d(x, y, z)) - th, bbGrow(a.bb, th));
export const grow = (a, g) => mk((x, y, z) => a.d(x, y, z) - g, bbGrow(a.bb, g));
// Smooth union: shapes melt into each other over distance k.
export const blob = (k, ...s) => mk((x, y, z) => {
  let m = s[0].d(x, y, z);
  for (let i = 1; i < s.length; i++) { const d = s[i].d(x, y, z), h = Math.max(k - Math.abs(m - d), 0) / k; m = Math.min(m, d) - h * h * k * 0.25; }
  return m;
}, bbGrow(s.map((a) => a.bb).reduce(bbUnion), k * 0.25));
// Keep only x in [xa, xb] / y / z, with flat (unrounded) ends.
export const clip = (a, axis, lo, hi) => {
  const i = 'xyz'.indexOf(axis), bb = a.bb.slice(); bb[i] = Math.max(bb[i], lo); bb[i + 3] = Math.min(bb[i + 3], hi);
  return mk(i === 0 ? (x, y, z) => Math.max(a.d(x, y, z), lo - x, x - hi) : i === 1 ? (x, y, z) => Math.max(a.d(x, y, z), lo - y, y - hi) : (x, y, z) => Math.max(a.d(x, y, z), lo - z, z - hi), bb);
};
// Rotate a shape by `deg` around `axis` through the pivot (px, py, pz).
export function rot(s, axis, deg, px = 0, py = 0, pz = 0) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), n = Math.sin(a);
  const fwd = axis === 'z' ? (x, y, z) => [c * x - n * y, n * x + c * y, z] : axis === 'x' ? (x, y, z) => [x, c * y - n * z, n * y + c * z] : (x, y, z) => [c * x + n * z, y, -n * x + c * z];
  const d = axis === 'z' ? (x, y, z) => { x -= px; y -= py; return s.d(c * x + n * y + px, -n * x + c * y + py, z); }
    : axis === 'x' ? (x, y, z) => { y -= py; z -= pz; return s.d(x, c * y + n * z + py, -n * y + c * z + pz); }
      : (x, y, z) => { x -= px; z -= pz; return s.d(c * x - n * z + px, y, n * x + c * z + pz); };
  let bb = null;
  for (let i = 0; i < 8; i++) {
    const p = fwd(s.bb[i & 1 ? 3 : 0] - px, s.bb[i & 2 ? 4 : 1] - py, s.bb[i & 4 ? 5 : 2] - pz), q = [p[0] + px, p[1] + py, p[2] + pz];
    bb = bb ? bbUnion(bb, [...q, ...q]) : [...q, ...q];
  }
  return mk(d, bb);
}
// Arbitrary point transform (inv maps a model point back into the shape's own space).
export const warp = (s, inv, bb) => mk((x, y, z) => { const p = inv(x, y, z); return s.d(p[0], p[1], p[2]); }, bb);

// ---------------------------------------------------------------- materials
// A material is a colour ('#rrggbb'), or { c, glow, gloss, a, mask }.
//   c     colour or fn(x, y, z, nx, ny, nz) -> [r, g, b] | { c, glow, a, gloss }
//   glow  0..1 emissive share (ignores shading)       gloss  specular strength
//   a     opacity < 1 = glass (what is behind shows)   mask   occludes but leaves the pixel transparent
const MCACHE = new Map();
export function material(m) {
  if (typeof m === 'string') { let r = MCACHE.get(m); if (!r) MCACHE.set(m, r = { c: hex(m) }); return r; }
  if (typeof m === 'function') return { c: m };
  if (typeof m.c === 'string') return { ...m, c: hex(m.c) };
  return m;
}

// ---------------------------------------------------------------- model builder
export class Model {
  constructor(X, Y) { this.X = X; this.Y = Y; this.parts = []; this.gz = 0; this.ground = 'shadow'; this.catch = null; }
  add(shape, m) { this.parts.push({ d: shape.d, bb: shape.bb, mat: material(m) }); return this; }
  b(x0, x1, y0, y1, z0, z1, m, r) { return this.add(box(x0, x1, y0, y1, z0, z1, r), m); }
  c(cx, cy, z0, z1, R, m, r) { return this.add(cyl(cx, cy, z0, z1, R, r), m); }
  s(cx, cy, cz, R, m) { return this.add(sph(cx, cy, cz, R), m); }
  e(cx, cy, cz, rx, ry, rz, m) { return this.add(ell(cx, cy, cz, rx, ry, rz), m); }
  k(ax, ay, az, bx, by, bz, r, m) { return this.add(cap(ax, ay, az, bx, by, bz, r), m); }
  t(cx, cy, cz, R, r, m, axis) { return this.add(tor(cx, cy, cz, R, r, axis), m); }
  n(cx, cy, z0, z1, r0, r1, m) { return this.add(cone(cx, cy, z0, z1, r0, r1), m); }
  get bb() { return this.parts.map((p) => p.bb).reduce(bbUnion); }
}

// ---------------------------------------------------------------- stroke font (signs, labels)
// Glyphs on a 4 x 6 grid, strokes separated by '|', points as "xy".
const FONT = {
  A: '00 26 40|12 32', B: '00 06 36 45 44 33 03|33 42 41 30 00', C: '45 36 16 05 01 10 30 41', D: '00 06 26 44 42 20 00',
  E: '40 00 06 46|03 33', F: '00 06 46|03 33', G: '45 36 16 05 01 10 30 41 43 23', H: '00 06|40 46|03 43', I: '20 26|10 30|16 36',
  J: '36 31 20 10 01', K: '00 06|46 03 40', L: '06 00 40', M: '00 06 23 46 40', N: '00 06 40 46', O: '10 30 41 45 36 16 05 01 10',
  P: '00 06 36 45 44 33 03', Q: '10 30 41 45 36 16 05 01 10|22 40', R: '00 06 36 45 44 33 03|23 40', S: '45 36 16 05 04 13 33 42 41 30 10 01', T: '06 46|26 20',
  U: '06 01 10 30 41 46', V: '06 20 46', W: '06 10 23 30 46', X: '00 46|06 40', Y: '06 23 46|23 20', Z: '06 46 00 40',
  0: '10 30 41 45 36 16 05 01 10', 1: '15 26 20|10 30', 2: '05 16 36 45 44 00 40', 3: '06 46 23 33 42 41 30 10 01', 4: '30 36 02 42',
  5: '46 06 03 33 42 41 30 00', 6: '36 16 05 01 10 30 41 42 33 03', 7: '06 46 10', 8: '13 04 05 16 36 45 44 33 13 02 01 10 30 41 42 33', 9: '10 30 41 45 36 16 05 04 13 43',
  '%': '00 46|06 16 15 05 06|30 40 41 31 30', '!': '26 22|20 20', ' ': '',
};
// Lines of text -> list of segments [x0, y0, x1, y1], centred on (cx, cy); `size` = glyph height.
export function textSegs(lines, cx, cy, size, gap = 0.45) {
  const u = size / 6, adv = 4 * u + u * 1.6, lh = size * (1 + gap), segs = [];
  lines.forEach((line, li) => {
    const w = line.length * adv - u * 1.6, x0 = cx - w / 2, y0 = cy + ((lines.length - 1) / 2 - li) * lh - size / 2;
    [...line].forEach((ch, ci) => {
      for (const stroke of (FONT[ch] || '').split('|').filter(Boolean)) {
        const pts = stroke.split(' ').map((p) => [x0 + ci * adv + +p[0] * u, y0 + +p[1] * u]);
        for (let i = 0; i < pts.length - 1; i++) segs.push([...pts[i], ...pts[i + 1]]);
      }
    });
  });
  return segs;
}
export function segDist(segs, x, y) {
  let m = 1e9;
  for (const s of segs) {
    const ex = s[2] - s[0], ey = s[3] - s[1], px = x - s[0], py = y - s[1], ee = ex * ex + ey * ey;
    let h = ee ? (px * ex + py * ey) / ee : 0; h = h < 0 ? 0 : h > 1 ? 1 : h;
    const dx = px - ex * h, dy = py - ey * h, d = dx * dx + dy * dy;
    if (d < m) m = d;
  }
  return Math.sqrt(m);
}

// ---------------------------------------------------------------- floor tiles (2D)
// Is the pixel (px, py) of a canvas whose tile bottom vertex is at (ax, ay) inside the tile
// diamond? Half-open in tile space, so neighbouring tiles share no pixel and leave no gap.
export function inTile(px, py, ax, ay) {
  const dx = (px + 0.5 - ax) / HW, dy = (py + 0.5 - (ay - TH)) / HH;
  const u = (dx + dy) / 2, v = (dy - dx) / 2;
  return u >= 0 && u < 1 && v >= 0 && v < 1;
}
// tex(u, v) -> [r, g, b], u / v in tile units (period 1). 256 x 128 image, anchor (128, 128).
export function floorTile(tex) {
  const im = img(TW, TH), S = 3;
  for (let py = 0; py < TH; py++) for (let px = 0; px < TW; px++) {
    if (!inTile(px, py, HW, TH)) continue;
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const dx = (px + (i + 0.5) / S - HW) / HW, dy = (py + (j + 0.5) / S) / HH;
      const c = tex(mod((dx + dy) / 2, 1), mod((dy - dx) / 2, 1));
      r += c[0]; g += c[1]; b += c[2];
    }
    const o = (py * TW + px) * 4, n = S * S;
    im.d[o] = clamp(Math.round(r / n), 0, 255); im.d[o + 1] = clamp(Math.round(g / n), 0, 255); im.d[o + 2] = clamp(Math.round(b / n), 0, 255); im.d[o + 3] = 255;
  }
  return im;
}

// ---------------------------------------------------------------- renderer
const norm = (v) => { const l = Math.hypot(...v); return v.map((a) => a / l); };
const L_SHADE = norm([-0.30, 0.52, 0.80]);  // key light: from the upper left, slightly towards the viewer
const L_SHADOW = norm([-0.28, 0.40, 0.87]); // shadow rays use a steeper light so cast shadows stay short
const L_FILL = norm([0.8, 0.15, 0.25]);
const VIEW = norm([1, 1, 1]);               // towards the camera
const SHADOW_RGB = [10, 13, 22];
export const DIRS = { sw: 0, se: 1, ne: 2, nw: 3 };

// Quarter turns: q = 0 front faces sw (+y), 1 se (+x), 2 ne (-y), 3 nw (-x).
const toLocal = (q, X, Y) => [(x, y) => [x, y], (x, y) => [X - y, x], (x, y) => [X - x, Y - y], (x, y) => [y, Y - x]][q];
const toWorld = (q, X, Y) => [(x, y) => [x, y], (x, y) => [y, X - x], (x, y) => [X - x, Y - y], (x, y) => [Y - y, x]][q];
const vecLocal = (q, v) => [[v[0], v[1], v[2]], [-v[1], v[0], v[2]], [-v[0], -v[1], v[2]], [v[1], -v[0], v[2]]][q];
export const footprint = (m, q) => (q & 1 ? { x: m.Y, y: m.X } : { x: m.X, y: m.Y });

// Render `model` rotated by q quarter turns.
//   canvas    { x, y, w, h } in screen px relative to the footprint's back vertex; default = fitted
//   tileMask  ground (shadow / glow) only inside the pixel-exact diamond of tile (0, 0)
//   owner     also return a Float32Array with the local x of the surface in each pixel
// Returns { im, ox, oy, owner } where (ox, oy) is the screen position of the image's top-left.
export function render(model, { q = 0, canvas = null, ss = 2, tileMask = false, owner = false } = {}) {
  const parts = model.parts, n = parts.length, { X, Y, gz } = model;
  const ds = parts.map((p) => p.d), mats = parts.map((p) => p.mat), glass = parts.map((p) => typeof p.mat.a === 'number' && p.mat.a < 1 || !!p.mat.decal);
  const bx = new Float64Array(n), by = new Float64Array(n), bz = new Float64Array(n), br = new Float64Array(n);
  parts.forEach((p, i) => {
    const b = p.bb; bx[i] = (b[0] + b[3]) / 2; by[i] = (b[1] + b[4]) / 2; bz[i] = (b[2] + b[5]) / 2;
    br[i] = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
  });
  const BB = bbGrow(model.bb, 0.01);
  const tl = toLocal(q, X, Y), tw = toWorld(q, X, Y), fp = footprint(model, q);
  const V = vecLocal(q, VIEW), LS = vecLocal(q, L_SHADE), LH = vecLocal(q, L_SHADOW), LF = vecLocal(q, L_FILL);
  const HV = norm([LS[0] + V[0], LS[1] + V[1], LS[2] + V[2]]);
  const groundFn = typeof model.ground === 'function' ? model.ground : null, shadowGround = model.ground === 'shadow';
  const cat = model.catch;

  let hit = -1;
  function map(x, y, z, noGlass) {
    let m = 1e9, mi = -1;
    for (let i = 0; i < n; i++) {
      if (noGlass && glass[i]) continue;
      if (m < 1e8) { const ex = x - bx[i], ey = y - by[i], ez = z - bz[i], lim = br[i] + m; if (lim > 0 && ex * ex + ey * ey + ez * ez > lim * lim) continue; }
      const d = ds[i](x, y, z);
      if (d < m) { m = d; mi = i; }
    }
    hit = mi;
    return m;
  }
  // March from t = hi down to lo along the view ray through ground point g. Returns t or -1.
  function trace(gx, gy, gzz, hi, lo, noGlass) {
    let t = hi;
    for (let i = 0; i < 200; i++) {
      const d = map(gx + V[0] * t, gy + V[1] * t, gzz + V[2] * t, noGlass);
      if (d < 0.0012) return t;
      t -= d * 0.95;
      if (t < lo) return -1;
    }
    return -1;
  }
  function shadow(x, y, z) {
    let res = 1, t = 0.012;
    const maxT = (BB[5] - z) / LH[2] + 0.05;
    for (let i = 0; i < 56 && t < maxT; i++) {
      const h = map(x + LH[0] * t, y + LH[1] * t, z + LH[2] * t, true);
      if (h < 0.0008) return 0;
      const r = (7 * h) / t; if (r < res) res = r;
      t += h < 0.008 ? 0.008 : h > 0.14 ? 0.14 : h;
    }
    return res * res * (3 - 2 * res);
  }
  function ambOcc(x, y, z, nx, ny, nz) {
    let occ = 0, sca = 1;
    for (let i = 0; i < 4; i++) {
      const h = 0.012 + 0.036 * i, d = map(x + nx * h, y + ny * h, z + nz * h, true);
      occ += (h - d) * sca; sca *= 0.8;
    }
    return clamp(1 - 2.6 * occ);
  }
  const out = [0, 0, 0, 0]; // r, g, b (0..255), a (0..1) of the last sample
  let outX = NaN;
  function ground(gx, gy) {
    out[3] = 0;
    if (cat && (gx < cat[0] || gy < cat[1] || gx > cat[2] || gy > cat[3])) return;
    if (groundFn) { const c = groundFn(gx, gy, q); if (c) { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = c[3]; } return; }
    if (!shadowGround) return;
    if (gx < SB[0] || gy < SB[1] || gx > SB[2] || gy > SB[3]) return;
    const sh = shadow(gx, gy, gz + 0.002), ao = ambOcc(gx, gy, gz, 0, 0, 1);
    const a = 1 - (1 - 0.40 * (1 - sh)) * (1 - 0.30 * (1 - ao));
    if (a < 0.004) return;
    out[0] = SHADOW_RGB[0]; out[1] = SHADOW_RGB[1]; out[2] = SHADOW_RGB[2]; out[3] = a;
  }
  function surface(gx, gy, t, noGlass, lo) {
    const x = gx + V[0] * t, y = gy + V[1] * t, z = gz + V[2] * t, mi = hit, mt = mats[mi], e = 0.0015;
    const d1 = map(x + e, y - e, z - e, noGlass), d2 = map(x - e, y - e, z + e, noGlass), d3 = map(x - e, y + e, z - e, noGlass), d4 = map(x + e, y + e, z + e, noGlass);
    let nx = d1 - d2 - d3 + d4, ny = -d1 - d2 + d3 + d4, nz = -d1 + d2 - d3 + d4;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    if (mt.mask) { out[3] = 0; return; }
    let c = mt.c, glow = mt.glow || 0, gloss = mt.gloss || 0, alpha = mt.a ?? 1;
    if (typeof c === 'function') {
      const r = c(x, y, z, nx, ny, nz);
      if (Array.isArray(r)) c = r; else { c = r.c; if (r.glow !== undefined) glow = r.glow === true ? 1 : r.glow; if (r.a !== undefined) alpha = r.a; if (r.gloss !== undefined) gloss = r.gloss; }
    }
    if (glow === true) glow = 1;
    let lum = 1, spec = 0;
    if (glow < 1) {
      const ndl = nx * LS[0] + ny * LS[1] + nz * LS[2];
      const sh = ndl > 0 || gloss ? shadow(x + nx * 0.006, y + ny * 0.006, z + nz * 0.006) : 0;
      const ao = ambOcc(x, y, z, nx, ny, nz), fill = Math.max(0, nx * LF[0] + ny * LF[1] + nz * LF[2]);
      lum = (0.5 + 0.1 * nz + 0.17 * fill) * (0.3 + 0.7 * ao) + 0.6 * Math.max(0, ndl) * sh * (0.55 + 0.45 * ao);
      if (gloss) spec = gloss * Math.pow(Math.max(0, nx * HV[0] + ny * HV[1] + nz * HV[2]), 36) * sh;
      lum = lum * (1 - glow) + glow;
    }
    let r = c[0] * lum + 255 * spec, g = c[1] * lum + 255 * spec, b = c[2] * lum + 255 * spec;
    if (alpha < 1) {
      // glass / decal: keep going and blend with what is behind
      const t2 = noGlass ? -1 : trace(gx, gy, gz, t - 0.004, lo, true);
      if (t2 >= 0) surface(gx, gy, t2, true, lo); else ground(gx, gy);
      const ba = out[3] * (1 - alpha), o = alpha + ba;
      if (o <= 0) { out[3] = 0; return; }
      r = (r * alpha + out[0] * ba) / o; g = (g * alpha + out[1] * ba) / o; b = (b * alpha + out[2] * ba) / o; alpha = o;
    }
    out[0] = r; out[1] = g; out[2] = b; out[3] = alpha; outX = x;
  }
  // Ground region that can receive this model's shadow (local x / y).
  const sdx = -LH[0] / LH[2], sdy = -LH[1] / LH[2], hgt = Math.max(0, BB[5] - gz);
  const SB = [Math.min(BB[0], BB[0] + sdx * hgt) - 0.12, Math.min(BB[1], BB[1] + sdy * hgt) - 0.12, Math.max(BB[3], BB[3] + sdx * hgt) + 0.12, Math.max(BB[4], BB[4] + sdy * hgt) + 0.12];
  const scr = (lx, ly, z) => { const w = tw(lx, ly); return [(w[0] - w[1]) * HW, (w[0] + w[1]) * HH - z * ZS]; };
  if (!canvas) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const add = (p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); };
    for (let i = 0; i < 8; i++) add(scr(BB[i & 1 ? 3 : 0], BB[i & 2 ? 4 : 1], BB[i & 4 ? 5 : 2]));
    if (shadowGround) for (let i = 0; i < 4; i++) add(scr(SB[i & 1 ? 2 : 0], SB[i & 2 ? 3 : 1], gz));
    if (groundFn) { add([-fp.y * HW, 0]); add([fp.x * HW, (fp.x + fp.y) * HH]); }
    x0 = Math.floor(x0) - 2; y0 = Math.floor(y0) - 2;
    canvas = { x: x0, y: y0, w: Math.ceil(x1) + 2 - x0, h: Math.ceil(y1) + 2 - y0 };
  }
  const im = img(canvas.w, canvas.h), own = owner ? new Float32Array(canvas.w * canvas.h).fill(NaN) : null;
  const ax = fp.x * HW - fp.y * HW - canvas.x, ay = (fp.x + fp.y) * HH - canvas.y; // anchor of the footprint (bottom vertex)
  for (let py = 0; py < canvas.h; py++) for (let px = 0; px < canvas.w; px++) {
    let R = 0, G = 0, B = 0, A = 0, ox = NaN;
    const maskOk = !tileMask || inTile(px, py, -canvas.x, TH - canvas.y);
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const sx = canvas.x + px + (i + 0.5) / ss, sy = canvas.y + py + (j + 0.5) / ss;
      const a = sx / HW, b = (sy + gz * ZS) / HH, g = tl((a + b) / 2, (b - a) / 2), gx = g[0], gy = g[1];
      // slab test against the model's bounding box
      let lo = 0, hi = 1e9;
      const t1 = (BB[0] - gx) / V[0], t2 = (BB[3] - gx) / V[0]; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
      const t3 = (BB[1] - gy) / V[1], t4 = (BB[4] - gy) / V[1]; lo = Math.max(lo, Math.min(t3, t4)); hi = Math.min(hi, Math.max(t3, t4));
      const t5 = (BB[2] - gz) / V[2], t6 = (BB[5] - gz) / V[2]; lo = Math.max(lo, Math.min(t5, t6)); hi = Math.min(hi, Math.max(t5, t6));
      out[3] = 0; outX = NaN;
      const t = hi > lo ? trace(gx, gy, gz, hi, lo, false) : -1;
      if (t >= 0) surface(gx, gy, t, false, lo); else if (maskOk) ground(gx, gy);
      if (out[3] > 0) { R += out[0] * out[3]; G += out[1] * out[3]; B += out[2] * out[3]; A += out[3]; if (ox !== ox && outX === outX) ox = outX; }
    }
    if (A <= 0) continue;
    const o = (py * canvas.w + px) * 4, al = Math.round((A / (ss * ss)) * 255);
    if (!al) continue;
    im.d[o] = clamp(Math.round(R / A), 0, 255); im.d[o + 1] = clamp(Math.round(G / A), 0, 255); im.d[o + 2] = clamp(Math.round(B / A), 0, 255); im.d[o + 3] = al;
    if (own) own[py * canvas.w + px] = ox;
  }
  return { im, ox: canvas.x, oy: canvas.y, ax, ay, owner: own };
}
