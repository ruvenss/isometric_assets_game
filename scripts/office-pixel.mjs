#!/usr/bin/env node
// Pixel-art office tiles — 2:1 dimetric (commonly called isometric in games).
// Zero dependencies: draws every tile procedurally at native resolution, scales
// it up with nearest-neighbour, and writes PNG-32 files plus 1024x1024 tilesets.
//
//   node scripts/office-pixel.mjs
//
// Rule from office.md: never overwrite an existing file. Existing PNGs (tiles, sheets,
// previews) are kept as they are; new designs go to new sheets and are appended to
// office_tileset.json. To regenerate a tile on purpose, delete its PNG and its config
// entry first.
//
// Spec: STYLES/PIXEL/INDOORS/OFFICE/TILE-SPEC.md

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OFFICE_OUT || join(ROOT, 'STYLES/PIXEL/INDOORS/OFFICE'); // override for dry runs

// ---------------------------------------------------------------- spec numbers
const SCALE = 2;         // export scale (native px -> exported px)
const TW = 64, TH = 32;  // native floor diamond (W = 2H, 2px:1px stepping)
const CW = 64, CH = 128; // native cell canvas; diamond sits on the bottom edge
const DY = CH - TH;      // y of the diamond's top vertex inside the cell
const WALL_H = 80;       // native wall height (5 z-steps of 16px)
const SHADE_NW = 0.84;   // NW-edge walls face away from the upper-left light
const ATLAS = 1024, COLS = ATLAS / (CW * SCALE), ROWS = ATLAS / (CH * SCALE);

// ---------------------------------------------------------------- image + png
const img = (w, h) => ({ w, h, d: new Uint8Array(w * h * 4) });
function put(im, x, y, c) {
  if (x < 0 || y < 0 || x >= im.w || y >= im.h) return;
  const i = (y * im.w + x) * 4;
  im.d[i] = c[0]; im.d[i + 1] = c[1]; im.d[i + 2] = c[2]; im.d[i + 3] = 255;
}
function blit(dst, src, ox, oy) {
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    const i = (y * src.w + x) * 4;
    if (src.d[i + 3]) put(dst, ox + x, oy + y, src.d.subarray(i, i + 3));
  }
}
function upscale(src, k) {
  const out = img(src.w * k, src.h * k);
  for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) {
    const s = ((y / k | 0) * src.w + (x / k | 0)) * 4, t = (y * out.w + x) * 4;
    out.d.set(src.d.subarray(s, s + 4), t);
  }
  return out;
}
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
function png(im) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(im.w, 0); ihdr.writeUInt32BE(im.h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((im.w * 4 + 1) * im.h);
  for (let y = 0; y < im.h; y++) {
    raw[y * (im.w * 4 + 1)] = 0;
    Buffer.from(im.d.buffer, y * im.w * 4, im.w * 4).copy(raw, y * (im.w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const stats = { written: 0, kept: 0 };
function save(rel, im) {
  const p = join(OUT, rel);
  if (existsSync(p)) { stats.kept++; return false; }   // never overwrite (office.md)
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, png(im));
  stats.written++;
  return true;
}

// ---------------------------------------------------------------- colour + noise
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const ramp = (...hs) => hs.map(hex);
const scale = (c, f) => c.map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
const mod = (a, n) => ((a % n) + n) % n;
function hash(x, y, s = 0) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => v / 16 - 0.47);
// Pick a ramp entry for tone t in [0,1] with 4x4 ordered dithering (no blended colours).
function pick(r, t, x, y, amount = 0.5) {
  const i = Math.round(t * (r.length - 1) + BAYER[(y & 3) * 4 + (x & 3)] * amount);
  return r[Math.max(0, Math.min(r.length - 1, i))];
}
// Smooth periodic value noise (period `p` texels, cell size `c`), seamless when c divides p.
function vnoise(u, v, c, p, s) {
  const n = p / c, gu = u / c, gv = v / c, iu = Math.floor(gu), iv = Math.floor(gv);
  const fu = gu - iu, fv = gv - iv, sm = (t) => t * t * (3 - 2 * t);
  const g = (a, b) => hash(mod(a, n), mod(b, n), s);
  const a = g(iu, iv) + (g(iu + 1, iv) - g(iu, iv)) * sm(fu);
  const b = g(iu, iv + 1) + (g(iu + 1, iv + 1) - g(iu, iv + 1)) * sm(fu);
  return a + (b - a) * sm(fv);
}

const INK = hex('#1b1d22');

// ---------------------------------------------------------------- floor textures
// (u, v) are integer texels 0..31 in tile space; every texture repeats at 32 so
// neighbouring tiles join seamlessly. u runs along screen +x/+y (down-right).
const P = {
  wood: ramp('#4a2e1b', '#6b4329', '#865634', '#a06b40', '#b8814f', '#cc9862'),
  carpetGray: ramp('#4f535b', '#5d6169', '#6b6f78', '#7a7e87', '#888c95'),
  carpetBlack: ramp('#121317', '#181a1f', '#1f2127', '#272a31', '#30333b'),
  cement: ramp('#9ea2a5', '#abafb2', '#b8bbbe', '#c4c7c9', '#d0d2d3'),
  tileBlack: ramp('#0d0e11', '#14161a', '#1c1e23', '#25282e', '#33373e', '#474c55'),
  tileBlue: ramp('#245a8c', '#2f6fa8', '#3b82c4', '#4b95d6', '#66abe2'),
  brick: ramp('#5e2219', '#7a2e21', '#93392a', '#a84733', '#bb5940', '#cc6e52'),
  plaster: ramp('#cdd1d5', '#dadde0', '#e4e6e8', '#eceef0', '#f5f6f7'),
  blue: ramp('#7fa9c9', '#8db6d4', '#9ac2de', '#a7cde7', '#b5d8ef'),
};

const FLOORS = {
  wood(u, v) {
    const plank = v >> 2, joint = (plank * 13 + 5) & 31;
    if ((v & 3) === 3) return P.wood[0];                     // gap between planks
    if (u === joint) return P.wood[1];                       // butt joint, staggered
    const seg = hash(plank, u < joint ? 0 : 1, 11);
    const grain = vnoise(u, v * 4, 4, 32, plank) - 0.5;
    let t = 0.28 + seg * 0.42 + grain * 0.35 + ((v & 3) === 0 ? 0.14 : 0);
    if (hash(u, v, 12) > 0.94) t -= 0.25;                    // knots / grain flecks
    return pick(P.wood, t, u, v, 0.6);
  },
  carpetGray: (u, v) => carpet(P.carpetGray, u, v, 21),
  carpetBlack: (u, v) => carpet(P.carpetBlack, u, v, 22),
  cement(u, v) {
    let t = 0.3 + vnoise(u, v, 8, 32, 31) * 0.45 + vnoise(u, v, 4, 32, 32) * 0.2;
    const h = hash(u, v, 33);
    if (h > 0.965) t -= 0.35; else if (h < 0.02) t += 0.3;   // aggregate speckles
    return pick(P.cement, t, u, v, 0.8);
  },
  tileBlack(u, v) {
    const a = u & 15, b = v & 15;
    if (a === 15 || b === 15) return hex('#3b3f47');         // grout
    if (a === 0 || b === 0) return P.tileBlack[3];           // bevel catching light
    if ((a === 2 && b >= 2 && b <= 5) || (b === 2 && a >= 2 && a <= 5)) return P.tileBlack[4]; // gloss corner
    const t = 0.2 + hash(u >> 4, v >> 4, 41) * 0.15 + (hash(u, v, 42) > 0.9 ? 0.15 : 0);
    return pick(P.tileBlack, t, u, v, 0.4);
  },
  tileBlue(u, v) {
    if ((u & 3) === 3 || (v & 3) === 3) return hex('#dce5ec');
    const t = hash(u >> 2, v >> 2, 51);
    const c = P.tileBlue[Math.floor(t * 4)];
    return (u & 3) === 0 && (v & 3) === 0 ? scale(c, 1.12) : c;
  },
};
function carpet(r, u, v, s) {
  const weave = ((u + v) & 3) === 0 ? -0.12 : ((u - v) & 3) === 0 ? 0.06 : 0;
  const t = 0.42 + (vnoise(u, v, 8, 32, s) - 0.5) * 0.3 + (hash(u, v, s) - 0.5) * 0.35 + weave;
  return pick(r, t, u, v, 0.7);
}

// ---------------------------------------------------------------- wall textures
// (u, v): u = 0..31 along the wall (left to right on screen), v = 0..79 from the floor up.
// Return [r,g,b] or { c, glow: true } for emissive pixels that ignore face shading.
function plaster(u, v, s = 61) {
  return pick(P.plaster, 0.55 + (vnoise(u, v, 8, 32, s) - 0.5) * 0.3 + (hash(u, v, s) - 0.5) * 0.3, u, v, 0.6);
}
function woodBoard(u, v) {
  if ((u & 7) === 7) return P.wood[1];
  const t = 0.4 + hash(u >> 3, 0, 71) * 0.25 + (vnoise(u * 4, v, 4, 32, u >> 3) - 0.5) * 0.4;
  return pick(P.wood, t, u, v, 0.5);
}
function blackTile(u, v, size, s) {
  const a = mod(u, size), b = mod(v, size);
  if (a === size - 1 || b === 0) return hex('#454a52');      // grout (bottom = mortar bed)
  if (b === size - 1 || a === 0) return P.tileBlack[3];      // top/left bevel
  if (size > 8 && ((a === 2 && b >= size - 6 && b <= size - 3) || (b === size - 3 && a >= 2 && a <= 5)))
    return P.tileBlack[4];                                   // glossy corner highlight
  return pick(P.tileBlack, 0.18 + hash(Math.floor(u / size), Math.floor(v / size), s) * 0.18, u, v, 0.4);
}

const WALLS = {
  brick(u, v) {
    const row = v >> 2, off = (row & 1) * 4, bu = u + off;
    if ((v & 3) === 0 || (bu & 7) === 7) return hash(u, v, 81) > 0.8 ? hex('#a99a8c') : hex('#bdae9f');
    const tone = hash(mod(bu >> 3, 4), row % 20, 82);
    let t = 0.2 + tone * 0.55 + ((v & 3) === 3 ? 0.12 : 0) + (hash(u, v, 83) - 0.5) * 0.25;
    return pick(P.brick, t, u, v, 0.6);
  },
  white(u, v) {
    if (v < 4) return v === 3 ? hex('#c9ced3') : hex('#a3a9b0');
    if (v === 4) return hex('#b4b9be');                      // contact shadow above skirting
    return plaster(u, v);
  },
  woodWhite(u, v) {
    if (v < 3) return v === 2 ? P.wood[2] : P.wood[0];       // skirting
    if (v < 33) return woodBoard(u, v);
    if (v < 36) return v === 35 ? P.wood[5] : v === 34 ? P.wood[3] : P.wood[1]; // dado rail
    if (v === 36) return hex('#bfc3c7');
    return plaster(u, v, 62);
  },
  blueSkirting(u, v) {
    if (v < 6) return v === 5 ? hex('#ffffff') : v === 0 ? hex('#aebbc5') : v === 1 ? hex('#cfd8df') : hex('#e6ecf0');
    if (v === 6) return hex('#6f97b5');
    return pick(P.blue, 0.55 + (vnoise(u, v, 8, 32, 91) - 0.5) * 0.3 + (hash(u, v, 92) - 0.5) * 0.3, u, v, 0.6);
  },
  whiteLed(u, v) {
    if (v < 3) return hex(v === 2 ? '#3a3e46' : '#25282e');  // dark aluminium skirting
    if (v === 3) return { c: hex('#ffffff'), glow: true };   // LED strip
    if (v === 4) return { c: hex('#bff4ff'), glow: true };
    // Glow wash fading upward, ordered-dithered into the plaster (no random speckle).
    const g = 1 - (v - 5) / 10;
    if (g > 0.5 + BAYER[(v & 3) * 4 + (u & 3)]) return { c: hex(g > 0.6 ? '#d3f7ff' : '#e3f8fc'), glow: true };
    return plaster(u, v, 63);
  },
  blackTiles: (u, v) => blackTile(u, v, 16, 101),
  blackWhite(u, v) {
    if (v < 28) return blackTile(u, v, 4, 111);
    if (v < 30) return v === 29 ? hex('#d8dde2') : hex('#7d838b'); // chrome trim
    if (v === 30) return hex('#b9bec3');
    return plaster(u, v, 64);
  },
};

// ---------------------------------------------------------------- tile builders
// Pixel-neat diamond: row y of the top half spans x = 30-2y .. 33+2y. Tiles placed at
// (+32,+16) offsets tessellate with no gaps and no overlaps.
function inDiamond(x, y) {
  const r = y < TH / 2 ? y : TH - 1 - y;
  return y >= 0 && y < TH && x >= TW / 2 - 2 - 2 * r && x <= TW / 2 + 1 + 2 * r;
}
// Map a diamond pixel to tile-space texels. Continuous across tiles, period 32.
function texel(x, y) {
  const dx = x + 0.5 - TW / 2, dy = y + 0.5;
  return [mod(Math.floor(dy + dx / 2), 32), mod(Math.floor(dy - dx / 2), 32)];
}
function floorTile(fn) {
  const im = img(CW, CH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++)
    if (inDiamond(x, y)) put(im, x, DY + y, fn(...texel(x, y)));
  return im;
}
// Draw a wall-face texture fn(u, v) onto one back edge of the tile.
// side 'ne': back-right edge (faces down-left, lit). side 'nw': back-left edge (shadow side).
// u0 offsets u for multi-tile pieces; cap adds the wall's top cap + ink line.
// fn returns [r,g,b], { c, glow: true } (emissive, unshaded) or null (transparent).
function faceTile(fn, side, u0 = 0, cap = true) {
  const im = img(CW, CH), f = side === 'ne' ? 1 : SHADE_NW;
  for (let i = 0; i < TW / 2; i++) {
    const x = side === 'ne' ? TW / 2 + i : i;
    const base = DY + (side === 'ne' ? i >> 1 : (TW / 2 - 1 - i) >> 1); // floor-edge row
    for (let v = 0; v < WALL_H; v++) {
      const s = fn(u0 + i, v);
      if (s) put(im, x, base - v, s.glow ? s.c : scale(s, f));
    }
    if (!cap) continue;
    const top = fn(i, WALL_H - 1), tc = top.glow ? top.c : top;
    put(im, x, base - WALL_H, scale(tc, 1.12 * (side === 'ne' ? 1 : 0.97)));
    put(im, x, base - WALL_H - 1, scale(tc, 1.2));
    put(im, x, base - WALL_H - 2, INK);
  }
  return im;
}
const wallTile = (fn, side) => faceTile(fn, side);

// ---------------------------------------------------------------- decorations
// Transparent overlays in the same wall-face space (u along the wall, v up from the
// floor). Place one on the same tile, after the wall it hangs on. Pieces wider than one
// tile are cut into one-tile parts; part1 is always the left-hand piece on screen.

// 3x5 pixel font (M, N, W are wider). Only the glyphs the signs need.
const GLYPHS = Object.fromEntries(Object.entries({
  A: '.#.|#.#|###|#.#|#.#', B: '##.|#.#|##.|#.#|##.', C: '.##|#..|#..|#..|.##',
  D: '##.|#.#|#.#|#.#|##.', E: '###|#..|##.|#..|###', F: '###|#..|##.|#..|#..',
  G: '.##|#..|#.#|#.#|.##', H: '#.#|#.#|###|#.#|#.#', I: '###|.#.|.#.|.#.|###',
  K: '#.#|#.#|##.|#.#|#.#', L: '#..|#..|#..|#..|###', M: '#...#|##.##|#.#.#|#...#|#...#',
  N: '#..#|##.#|#.##|#..#|#..#', O: '.#.|#.#|#.#|#.#|.#.', P: '##.|#.#|##.|#..|#..',
  R: '##.|#.#|##.|#.#|#.#', S: '.##|#..|.#.|..#|##.', T: '###|.#.|.#.|.#.|.#.',
  U: '#.#|#.#|#.#|#.#|###', V: '#.#|#.#|#.#|#.#|.#.', W: '#...#|#...#|#.#.#|##.##|#...#',
  Y: '#.#|#.#|.#.|.#.|.#.', Z: '###|..#|.#.|#..|###', 0: '###|#.#|#.#|#.#|###',
  1: '.#.|##.|.#.|.#.|###', '%': '#.#|..#|.#.|#..|#.#', ' ': '..|..|..|..|..',
}).map(([k, g]) => [k, g.split('|')]));

// Neon sign: 1px tubes in the core colour, each with a dimmer shadow pixel right under it
// (a full halo would close the 1px gaps between letters). Centred on the wall at v≈48.
function neon(lines, width, core, halo) {
  const m = new Set(), C = hex(core), H = hex(halo);
  const top = 48 + Math.floor((lines.length * 7 - 2) / 2);
  lines.forEach((line, li) => {
    const gl = [...line].map((ch) => GLYPHS[ch]);
    let u = Math.floor((width - gl.reduce((a, g) => a + g[0].length + 1, -1)) / 2);
    for (const g of gl) {
      g.forEach((row, r) => [...row].forEach((px, c) => px === '#' && m.add(`${u + c},${top - li * 7 - r}`)));
      u += g[0].length + 1;
    }
  });
  return (u, v) => {
    if (m.has(`${u},${v}`)) return { c: C, glow: true };
    return m.has(`${u},${v + 1}`) ? { c: H, glow: true } : null;
  };
}
const NEONS = [
  ['decor-neon-amazing', ['EVERYTHING IS', 'GOING TO BE', 'FUCKING', 'AMAZING'], 2, '#ff5ad9', '#b02d92'],
  ['decor-neon-fuck-trump', ['FUCK', 'TRUMP'], 1, '#ff4545', '#a82222'],
  ['decor-neon-trust-your-code', ['TRUST', 'YOUR', 'CODE'], 1, '#42f0ff', '#1f8fa0'],
  ['decor-neon-coffee', ['100%', 'COFFEE', 'MADE'], 1, '#ffb43c', '#a8661a'],
  ['decor-neon-deploy-fridays', ['DEPLOY', 'ON', 'FRIDAYS'], 1, '#5cff7c', '#23963b'],
  ['decor-neon-force', ['MAY THE', 'FORCE', 'BE WITH', 'YOU'], 1, '#62a8ff', '#2a5ea8'],
  ['decor-neon-power-up', ['POWER', 'UP'], 1, '#fff24d', '#a89a1c'],
];

// Big TV, 2 tiles wide, showing a code editor.
const CODE = ['#7fd1ff', '#ff8ad8', '#ffd36b', '#8cf59b', '#c7d2e0'].map(hex);
function tv(u, v) {
  const x0 = 4, x1 = 59, y0 = 30, y1 = 66;
  if (u < x0 || u > x1 || v < y0 || v > y1) return null;
  if (u === x0 || u === x1 || v === y0 || v === y1) return hex('#0b0c0f');
  if (u < x0 + 2 || u > x1 - 2 || v < y0 + 2 || v > y1 - 2) return v === y1 - 1 ? hex('#3a3e46') : hex('#1b1d22');
  const sx = u - x0 - 2, sy = y1 - 2 - v, line = Math.floor(sy / 3);
  let c = sx < 4 ? hex('#0b1422') : hex('#0f1b2d');
  if (sy % 3 === 1) {
    if (sx > 0 && sx < 3) c = hex('#3b4d66');                // line numbers
    else if (sx >= 4) {
      let x = 6 + Math.floor(hash(line, 0, 121) * 3) * 2;    // indentation
      const end = 14 + Math.floor(hash(line, 1, 121) * 32);
      for (let t = 0; x < end; t++) {
        const len = 2 + Math.floor(hash(line, t, 122) * 5);
        if (sx >= x && sx < Math.min(x + len, end)) { c = CODE[Math.floor(hash(line, t, 123) * CODE.length)]; break; }
        x += len + 1;
      }
    }
  }
  if (line === 7 && sy % 3 !== 2 && sx === 31) c = hex('#ffffff'); // cursor
  const d = sx - sy;
  if ((d >= 14 && d <= 15) || d === 18) c = c.map((x) => Math.round(x + (255 - x) * 0.14)); // glass glare
  return { c, glow: true };
}

// Wall-mounted wood bookshelf with three shelves of books.
const BOOK = ['#a83232', '#2f5d8c', '#3d7a3d', '#c9a227', '#6b3f8c', '#d0d0c8', '#c2612b', '#22313f'].map(hex);
const SHELVES = [[24, 37], [40, 53], [56, 69]];
const BOOKS = SHELVES.map((_, s) => {
  const out = [];
  for (let u = 4, k = 0; u < 28; k++) {
    const w = 1 + Math.floor(hash(s, k, 131) * 3), gap = hash(s, k, 134) > 0.85;
    if (!gap) out.push({ u0: u, u1: Math.min(27, u + w - 1), h: 7 + Math.floor(hash(s, k, 132) * 6), c: BOOK[Math.floor(hash(s, k, 133) * BOOK.length)] });
    u += w + (gap ? 2 : 0);
  }
  return out;
});
function bookshelf(u, v) {
  const W = P.wood;
  if (u < 2 || u > 29 || v < 22 || v > 71) return null;
  if (u < 4 || u > 27) return u === 2 || u === 29 ? W[1] : W[3];   // side panels
  if (v >= 70) return v === 71 ? W[5] : W[3];                       // top board
  for (const [s, [a, b]] of SHELVES.entries()) {
    if (v === a - 1) return W[4];                                   // shelf board
    if (v === a - 2) return W[2];
    if (v < a || v > b) continue;
    const bk = BOOKS[s].find((k) => u >= k.u0 && u <= k.u1);
    if (bk && v < a + bk.h) {
      if (v === a + bk.h - 1) return scale(bk.c, 1.25);
      if (v === a + 2 && bk.u1 > bk.u0) return hex('#d9b54a');       // gilt title band
      return u === bk.u0 ? scale(bk.c, 1.12) : bk.c;
    }
    return v === b ? hex('#24170d') : hex('#3a2616');               // back panel
  }
  return W[2];
}

// Light switch plate; x = left edge in wall u.
const lightSwitch = (x) => (u, v) => {
  if (u < x || u > x + 3 || v < 38 || v > 43) return null;
  if (u === x || u === x + 3 || v === 38 || v === 43) return hex('#9aa1a8');
  return v >= 41 ? hex('#ffffff') : hex('#d5d9dd');                 // rocker, lit from above
};

// Elevator: steel frame, closed sliding doors, floor indicator and call button.
const ARROW = ['..##..', '.####.', '######', '..##..', '..##..'];
function elevator(u, v) {
  if (u >= 29 && u <= 30 && v >= 30 && v <= 35) {                  // call button panel
    return v >= 32 && v <= 33 ? { c: hex('#ffcf6a'), glow: true } : hex('#8d949c');
  }
  if (v >= 62 && v <= 68) {                                         // floor indicator
    if (u < 11 || u > 20) return null;
    if (u === 11 || u === 20 || v === 62 || v === 68) return hex('#5b6068');
    return ARROW[67 - v]?.[u - 13] === '#' ? { c: hex('#ffb22e'), glow: true } : { c: hex('#140d06'), glow: true };
  }
  if (u < 3 || u > 28 || v > 59) return null;
  if (v === 0) return hex('#4b5058');                               // threshold
  if (u < 6 || u > 25 || v > 56) {                                  // frame
    if (u === 3 || v === 59) return hex('#c3c8cd');
    if (u === 28 || u === 5 || u === 26 || v === 57) return hex('#6a7078');
    return hex('#8d949c');
  }
  if (u === 15) return hex('#5d636b');                              // door seam
  const d = (u > 15 ? u - 16 : u - 6) - (v >> 2);
  if (d === 2 || d === 3) return hex('#cdd3d9');                    // brushed-steel glare
  return u % 3 === 0 ? hex('#a5acb4') : hex('#b2b9c0');
}

// Framed pictures: inner(px, py) with origin at the top-left of the canvas.
function framed(inner, frame) {
  const x0 = 5, x1 = 26, y0 = 38, y1 = 62, F = frame.map(hex);
  return (u, v) => {
    if (u < x0 || u > x1 || v < y0 || v > y1) return null;
    if (u === x0 || u === x1 || v === y0 || v === y1) return F[0];
    if (u === x0 + 1 || u === x1 - 1 || v === y0 + 1 || v === y1 - 1) return v === y1 - 1 || u === x0 + 1 ? F[2] : F[1];
    return inner(u - x0 - 2, y1 - 2 - v);                           // 18 x 21 canvas
  };
}
const SKY = ramp('#6fb6de', '#8fcbe8', '#bfe3f2', '#f6d9a8');
function sea(px, py) {
  if (py < 11) {
    if ((px - 12) ** 2 + (py - 6) ** 2 <= 5) return hex('#fff3c4'); // sun
    return pick(SKY, py / 10, px, py, 0.8);
  }
  if (py < 18) {
    if ((px + py * 3) % 7 === 0) return hex('#cfeaf5');              // wave crests
    return pick(ramp('#3a8fc0', '#2a77a8', '#1e5f8c'), (py - 11) / 6, px, py, 0.8);
  }
  return py === 18 ? hex('#c7a96a') : hex('#e3c98f');                // wet + dry sand
}
const PINES = [[2, 10], [6, 12], [10, 9], [14, 11], [17, 8]];
function forest(px, py) {
  for (const [cx, h] of PINES) {
    const top = 18 - h, dy = py - top;
    if (dy >= 0 && py <= 18 && Math.abs(px - cx) <= dy / 2.2)
      return px < cx ? hex('#3f8a4b') : (dy & 1 ? hex('#24552e') : hex('#2e6b3a'));
    if (py > 18 && py < 20 && px === cx) return hex('#5b3a22');      // trunk
  }
  if (py >= 19) return py === 19 ? hex('#3f6b2b') : hex('#4f7a35'); // ground
  if (py >= 5 + Math.abs(px - 11) * 0.7) return hex('#8aa0b4');     // mountain
  if (py >= 4 + Math.abs(px - 11) * 0.7) return hex('#e9f0f5');     // snow line
  return pick(SKY, py / 14, px, py, 0.8);
}

// ---------------------------------------------------------------- catalogue
const FLOOR_LIST = [
  ['floor-wood', 'wood', 'Wood planks'],
  ['floor-carpet-gray', 'carpetGray', 'Gray carpet'],
  ['floor-carpet-black', 'carpetBlack', 'Black carpet'],
  ['floor-cement-light', 'cement', 'Light gray cement'],
  ['floor-tiles-black', 'tileBlack', 'Black tiles'],
  ['floor-tiles-blue-small', 'tileBlue', 'Small blue tiles'],
];
const WALL_LIST = [
  ['wall-brick', 'brick', 'Brick'],
  ['wall-white', 'white', 'White'],
  ['wall-wood-white', 'woodWhite', 'Wood wainscot bottom, white top'],
  ['wall-blue-skirting', 'blueSkirting', 'Light blue with skirting'],
  ['wall-white-led', 'whiteLed', 'White with bright LED skirting'],
  ['wall-tiles-black-big', 'blackTiles', 'Big black tiles'],
  ['wall-tiles-black-small-white', 'blackWhite', 'Small black tiles bottom, white top'],
];

const tiles = []; // { name, file, label, native, row, col }
FLOOR_LIST.forEach(([name, key, label], col) =>
  tiles.push({ name: `${name}_flat`, file: `FLOORS/${name}_flat.png`, label, native: floorTile(FLOORS[key]), row: 0, col }));
['ne', 'nw'].forEach((side, r) => WALL_LIST.forEach(([name, key, label], col) =>
  tiles.push({ name: `${name}_${side}`, file: `WALLS/${name}_${side}.png`, label, native: wallTile(WALLS[key], side), row: 1 + r, col })));

const DECOR_LIST = [
  ['decor-tv', tv, 2, 'Big TV screen'],
  ...NEONS.map(([n, lines, w, c, h]) => [n, neon(lines, w * 32, c, h), w, `Neon sign: ${lines.join(' ')}`]),
  ['decor-bookshelf', bookshelf, 1, 'Mounted wood bookshelf'],
  ['decor-switch-left', lightSwitch(3), 1, 'Light switch, left side of the tile'],
  ['decor-switch-right', lightSwitch(25), 1, 'Light switch, right side of the tile'],
  ['decor-elevator', elevator, 1, 'Elevator'],
  ['decor-picture-sea', framed(sea, ['#3b2414', '#8a5a33', '#b07a48']), 1, 'Framed sea picture'],
  ['decor-picture-forest', framed(forest, ['#0d0e11', '#25282e', '#3d4149']), 1, 'Framed forest picture'],
];
const decor = []; // 16 pieces per side: rows 0-1 = ne, rows 2-3 = nw
['ne', 'nw'].forEach((side, r) => {
  let idx = 0;
  for (const [name, fn, w, label] of DECOR_LIST) for (let p = 0; p < w; p++, idx++) {
    const part = w > 1 ? `_part${p + 1}` : '';
    decor.push({
      name: `${name}_${side}${part}`, file: `DECOR/${name}_${side}${part}.png`, label,
      parts: w > 1 ? { index: p + 1, of: w } : undefined,
      native: faceTile(fn, side, p * 32, false), row: r * 2 + (idx >> 3), col: idx & 7,
    });
  }
});

// ================================================================ batch 2: TVs, doors, windows
Object.assign(GLYPHS, Object.fromEntries(Object.entries({
  X: '#.#|#.#|.#.|#.#|#.#', Q: '.#.|#.#|#.#|##.|.##', 2: '##.|..#|.#.|#..|###',
  3: '##.|..#|.#.|..#|##.', 4: '#.#|#.#|###|..#|..#', 7: '###|..#|.#.|.#.|.#.',
  8: '###|#.#|###|#.#|###', 9: '###|#.#|###|..#|##.',
}).map(([k, g]) => [k, g.split('|')])));
// Text as a set of "x,y" pixels, y growing downward from y0.
function textPixels(str, x0, y0) {
  const m = new Set();
  let x = x0;
  for (const ch of str) {
    const g = GLYPHS[ch];
    g.forEach((row, r) => [...row].forEach((px, c) => px === '#' && m.add(`${x + c},${y0 + r}`)));
    x += g[0].length + 1;
  }
  return m;
}
const textWidth = (str) => [...str].reduce((a, ch) => a + GLYPHS[ch][0].length + 1, -1);

// Wall-mounted 2-tile screen: bezel in wall space, inner(sx, sy) in screen space
// (origin top-left, 52 x 37 px). Screen pixels are emissive.
function wallScreen(inner) {
  const x0 = 4, x1 = 59, y0 = 28, y1 = 68;
  return (u, v) => {
    if (u < x0 || u > x1 || v < y0 || v > y1) return null;
    if (u === x0 || u === x1 || v === y0 || v === y1) return hex('#0b0c0f');
    if (u < x0 + 2 || u > x1 - 2 || v < y0 + 2 || v > y1 - 2) return v === y1 - 1 ? hex('#3a3e46') : hex('#1b1d22');
    const sx = u - x0 - 2, sy = y1 - 2 - v, d = sx - sy;
    let c = inner(sx, sy);
    if ((d >= 14 && d <= 15) || d === 18) c = c.map((x) => Math.round(x + (255 - x) * 0.12)); // glare
    return { c, glow: true };
  };
}
const THEMES = {
  dark: { bg: '#0e1626', bar: '#1b2a44', card: '#16233a', axis: '#3b4d66', grid: '#16233a', title: '#3b4d66',
    bars: ['#4b95d6', '#66abe2'], barTop: '#9fd0ff', line: '#5cff7c', area: '#12301f',
    kpi: [['42', '#5cff7c'], ['98%', '#42f0ff'], ['7K', '#ff8ad8']] },
  light: { bg: '#e8edf3', bar: '#d3dbe6', card: '#ffffff', axis: '#a3afbf', grid: '#d3dbe6', title: '#8794a6',
    bars: ['#2f6fa8', '#3b82c4'], barTop: '#245a8c', line: '#1f9d55', area: '#c9ecd6',
    kpi: [['42', '#1f9d55'], ['98%', '#2f6fa8'], ['7K', '#c2378f']] },
};
function dashboardScreen(theme) {
  const T = Object.fromEntries(Object.entries(THEMES[theme]).map(([k, v]) =>
    [k, typeof v === 'string' ? hex(v) : k === 'bars' ? v.map(hex) : v]));
  const kpi = T.kpi.map(([t, c], n) => ({ px: textPixels(t, 1 + n * 17 + Math.floor((15 - textWidth(t)) / 2), 5), c: hex(c) }));
  const lineY = (x) => 33 - Math.round(3 + (x - 28) * 0.45 + 3 * Math.sin(x * 0.7));
  return (sx, sy) => {
    if (sy <= 2) {                                                  // title bar + window dots
      if (sy === 1 && sx === 2) return hex('#ff5f57');
      if (sy === 1 && sx === 4) return hex('#febc2e');
      if (sy === 1 && sx === 6) return hex('#28c840');
      if (sy === 1 && sx >= 20 && sx <= 31) return T.title;
      return T.bar;
    }
    if (sy >= 4 && sy <= 10) {                                      // KPI cards
      const n = Math.floor((sx - 1) / 17), a = sx - 1 - n * 17;
      if (n < 0 || n > 2 || a > 14) return T.bg;
      return kpi[n].px.has(`${sx},${sy}`) ? kpi[n].c : T.card;
    }
    if (sy < 13 || sy > 35) return T.bg;
    if (sx >= 1 && sx <= 24) {                                      // bar chart
      if (sx === 1 || sy === 35) return T.axis;
      const b = Math.floor((sx - 3) / 3);
      if (sx >= 3 && (sx - 3) % 3 < 2 && b < 7) {
        const h = 6 + Math.floor(hash(b, 0, 141) * 15);
        if (sy === 35 - h) return T.barTop;
        if (sy > 35 - h) return T.bars[b & 1];
      }
      return (sy === 19 || sy === 27) && !(sx & 1) ? T.grid : T.bg;
    }
    if (sx >= 27 && sx <= 50) {                                     // line chart
      if (sx === 27 || sy === 35) return T.axis;
      const y = lineY(sx), yp = lineY(sx - 1);
      if (sy >= Math.min(y, yp) && sy <= Math.max(y, yp)) return T.line;
      if (sy > y) return (sy + sx) & 1 ? T.area : T.bg;
      return (sy === 19 || sy === 27) && !(sx & 1) ? T.grid : T.bg;
    }
    return T.bg;
  };
}
// Meeting-room screen: a presentation slide with a title, bullets and a pie chart.
const SLIDE_TITLE = textPixels('Q3 PLAN', 4, 3);
function presentationScreen(sx, sy) {
  if (sy >= 35) return sx >= 44 && sx <= 49 ? hex('#a3afbf') : hex('#f4f6f8');   // progress bar
  if (sy <= 9) return SLIDE_TITLE.has(`${sx},${sy}`) ? hex('#ffffff') : hex('#c2532e'); // title band
  if (sx >= 2 && sx <= 25) {                                       // bullets
    const r = sy - 13, line = Math.floor(r / 5);
    if (r >= 0 && r % 5 <= 1 && line < 4) {
      if (sx >= 3 && sx <= 4) return hex('#c2532e');
      const len = [18, 14, 20, 11][line];
      if (sx >= 7 && sx < 7 + len) return r % 5 === 0 ? hex('#5b6470') : hex('#a3afbf');
    }
    return hex('#ffffff');
  }
  const dx = sx - 38.5, dy = sy - 22.5, d2 = dx * dx + dy * dy;    // pie chart
  if (d2 <= 64) {
    const a = (Math.atan2(dy, dx) + Math.PI * 2.5) % (Math.PI * 2);
    return a < 2.6 ? hex('#3b82c4') : a < 4.4 ? hex('#f0a830') : hex('#4caf6a');
  }
  if (d2 <= 82) return hex('#dfe5ec');                            // pie shadow ring
  return hex('#ffffff');
}

// ---------------------------------------------------------------- doors
// Door opening: u 6..25, v 0..58, casing u 4..27 up to v 60. Hinges are on the left of an
// _ne door and the right of an _nw door; an open leaf swings 90° into the room.
const voidPx = (u, v) => (v < 2 ? hex('#2e3239') : v < 6 || (v < 14 && ((u + v) & 1)) ? hex('#1d2026') : hex('#15171c'));
function glassPx(u, v) {
  const d = mod(u - (v >> 1), 24);
  if (d === 3 || d === 4) return hex('#c9e6f2');
  if (d === 7) return hex('#b8dcec');
  return v < 10 ? hex('#8fc0d6') : hex('#a3d0e3');
}
const DOORS = [
  ['door-glass', 'Glass door', { kind: 'glass', frame: '#9aa1a8' }],
  ['door-white', 'White door', { kind: 'panel', base: '#e9ecef', frame: '#c4c9ce', handle: '#8d949c' }],
  ['door-black', 'Black door', { kind: 'panel', base: '#25282e', frame: '#0e0f12', handle: '#c3c8cd' }],
  ['door-gray', 'Gray door', { kind: 'panel', base: '#8a9099', frame: '#5f656d', handle: '#2b2e34' }],
  ['door-red', 'Red door', { kind: 'panel', base: '#b8322b', frame: '#6e1c17', handle: '#d9dde1' }],
  ['door-wood-dark', 'Dark wood door', { kind: 'panel', base: '#5a3822', frame: '#2e1c10', handle: '#d9b54a', grain: true }],
  ['door-wood-light', 'Light wood door', { kind: 'panel', base: '#cfa26a', frame: '#9c7042', handle: '#5b6068', grain: true }],
  ['door-elevator', 'Elevator door', { kind: 'elevator' }],
  ['door-emergency', 'Emergency door with exit sign', { kind: 'emergency', base: '#8b9592', frame: '#5c6461', handle: '#c9ced3' }],
];
// Leaf pixel in leaf space: a = 0..19 from the hinge, v = 0..58. Handle is away from the hinge.
function leafPx(d, a, v) {
  if (d.kind === 'glass') {
    if (a <= 1 || a >= 18 || v <= 2 || v >= 56) return hex(a === 0 || v === 58 ? '#c3c8cd' : d.frame);
    if (v >= 28 && v <= 29 && a >= 3 && a <= 16) return hex('#5b6068');   // push bar
    return glassPx(a, v);
  }
  const B = hex(d.base), R = [0.82, 0.9, 1, 1.08].map((f) => scale(B, f));
  let c = d.grain ? pick(R, 0.25 + vnoise(a * 3, v, 4, 64, 151) * 0.6, a, v, 0.6) : B;
  if (d.kind === 'emergency') {
    if (v >= 27 && v <= 28 && a >= 2 && a <= 17) return a <= 3 ? hex('#d23b2b') : hex(d.handle); // panic bar
    return pick(R, 0.55 + (hash(a, v, 152) - 0.5) * 0.3, a, v, 0.5);
  }
  for (const [y0, y1] of [[6, 26], [32, 53]]) {                     // two recessed panels
    if (a < 3 || a > 16 || v < y0 || v > y1) continue;
    if (v === y1 || a === 3) return scale(c, 0.8);                  // shadowed top/left lip
    if (v === y0 || a === 16) return scale(c, 1.12);                // lit bottom/right lip
  }
  if (a >= 16 && a <= 17 && v >= 29 && v <= 30) return hex(d.handle);
  if (a >= 16 && a <= 17 && v === 28) return scale(B, 0.7);
  return c;
}
const EXIT = textPixels('EXIT', 8, 0);
function doorFace(d, open, hingeLeft) {
  return (u, v) => {
    if (d.kind === 'emergency' && v >= 62 && v <= 69 && u >= 6 && u <= 25) {   // exit sign
      if (u === 6 || u === 25 || v === 62 || v === 69) return hex('#0f5a2a');
      return { c: EXIT.has(`${u},${67 - v}`) ? hex('#ffffff') : hex('#1fa64a'), glow: true };
    }
    if (u < 4 || u > 27 || v > 60) return null;
    const F = hex(d.frame);
    if (u < 6 || u > 25 || v > 58) return u === 4 || v === 60 ? scale(F, 1.15) : F;   // casing
    if (open) return voidPx(u, v);
    return leafPx(d, hingeLeft ? u - 6 : 25 - u, v);
  };
}
function elevatorOpen(u, v) {
  if (u < 6 || u > 25 || v < 1 || v > 56) return elevator(u, v);
  if (u === 6 || u === 25) return hex('#8d949c');                  // door edges in their pockets
  if (v >= 55) return { c: hex('#fffbe8'), glow: true };           // cabin ceiling light
  if (v <= 2) return hex('#3a3e45');                                // cabin floor
  if (v === 24) return hex('#d6dadf');                              // handrail
  if (v === 23) return hex('#7c838b');
  return { c: u & 1 ? hex('#b7aa8f') : hex('#c2b597'), glow: true }; // warm-lit cabin wall
}
// Open leaf: perpendicular to the wall, so it is shaded like the other wall orientation.
function drawLeaf(im, side, d) {
  const f = side === 'ne' ? SHADE_NW : 1;
  for (let a = 0; a < 20; a++) {
    const x = side === 'ne' ? 37 - a : 26 + a, base = DY + 3 + ((a + 1) >> 1);
    for (let v = 0; v <= 58; v++) {
      const c = leafPx(d, a, v);
      put(im, x, base - v, scale(a === 19 ? scale(c, 0.8) : c, f));
    }
  }
}
function doorTile(d, side, open) {
  const face = d.kind === 'elevator' ? (open ? elevatorOpen : elevator) : doorFace(d, open, side === 'ne');
  const im = faceTile(face, side, 0, false);
  if (open && d.kind !== 'elevator') drawLeaf(im, side, d);
  return im;
}
// Big sliding glass door, 2 tiles wide; open = both panels hidden inside the wall.
const slidingDoor = (open) => (u, v) => {
  if (u < 2 || u > 61 || v > 64) return null;
  if (u < 4 || u > 59 || v > 61) return u === 2 || v === 64 ? hex('#b4bac0') : hex('#7d848c');
  if (open) return u === 4 || u === 59 ? hex('#a3d0e3') : voidPx(u, v);
  const a = u < 32 ? u - 4 : u - 32;
  if (a <= 1 || a >= 26 || v <= 2 || v >= 59) return hex('#c3c8cd');
  if (v >= 26 && v <= 31 && (u === 29 || u === 34)) return hex('#5b6068');   // pull handles
  return glassPx(u, v);
};

// ---------------------------------------------------------------- windows
// Glass shows the sky outside: day #87CEEB, night #041A40 (office.md). Sky is emissive.
function sky(u, v, night) {
  const r = mod(u - (v >> 1), 32);
  if (night) {
    if (r === 6 || r === 7 || r === 11) return { c: hex('#0c2a5c'), glow: true };
    const h = hash(u, v, 171);
    return { c: hex(h > 0.975 ? '#ffffff' : h > 0.96 ? '#8fa6d6' : '#041A40'), glow: true };
  }
  if (r === 6 || r === 7 || r === 11) return { c: hex('#b4e2f3'), glow: true };
  const n = vnoise(u, v, 8, 32, 172);
  if (v > 40 && n > 0.7) return { c: hex('#f4fbff'), glow: true };
  if (v > 40 && n > 0.64) return { c: hex('#d9f0fa'), glow: true };
  return { c: hex('#87CEEB'), glow: true };
}
const WF = hex('#2a2d33'), WFL = hex('#454a52'), WHITE = hex('#f2f3f4'), WHITE_D = hex('#c9ced3');
const sill = (u, v, y) => (u >= 3 && u <= 28 && (v === y || v === y + 1) ? (v === y + 1 ? hex('#ffffff') : hex('#b9bec3')) : undefined);
const WINDOWS = {
  'window-full': ['Full window', (u, v, n) => {
    if (v < 1 || v > 78) return null;
    if (u === 0 || u === 31 || v <= 2 || v >= 77) return v >= 77 ? WFL : WF;
    return sky(u, v, n);
  }],
  'window-half': ['Half window', (u, v, n) => {
    const s = sill(u, v, 30); if (s) return s;
    if (u < 4 || u > 27 || v < 32 || v > 64) return null;
    if (u <= 5 || u >= 26 || v <= 33 || v >= 63) return u === 5 || v === 63 ? WFL : WF;
    return sky(u, v, n);
  }],
  'window-grid': ['Window with white grid supports', (u, v, n) => {
    const s = sill(u, v, 20); if (s) return s;
    if (u < 4 || u > 27 || v < 22 || v > 66) return null;
    if (u <= 5 || u >= 26 || v <= 23 || v >= 65) return u === 4 || v === 66 ? WHITE : WHITE_D;
    if (u === 15 || u === 16 || v === 37 || v === 51) return WHITE;
    return sky(u, v, n);
  }],
  'window-arch': ['Window with top arch', (u, v, n) => {
    const s = sill(u, v, 20); if (s) return s;
    const d2 = (u - 15.5) ** 2 + (v - 52) ** 2;
    const inside = v <= 52 ? u >= 6 && u <= 25 && v >= 22 : d2 <= 100;
    if (!inside) return null;
    if (v <= 52 ? u <= 7 || u >= 24 || v <= 23 : d2 > 64) return v > 52 && u < 15.5 ? WHITE : WHITE_D;
    if ((u === 15 || u === 16) || v === 40) return WHITE;
    return sky(u, v, n);
  }],
  'window-circle': ['Circle window', (u, v, n) => {
    const d2 = (u - 15.5) ** 2 + (v - 47.5) ** 2;
    if (d2 > 110) return null;
    if (d2 > 64) return u < 15.5 && v > 47.5 ? WFL : WF;
    return sky(u, v, n);
  }],
};

// ---------------------------------------------------------------- batch 2 catalogue
const SIDES = ['ne', 'nw'];
const twoPart = (base, fn, label, side) => [1, 2].map((p) => ({
  name: `${base.replace('{side}', side)}_part${p}`, label, parts: { index: p, of: 2 },
  native: faceTile(fn, side, (p - 1) * 32, false),
}));
const screens = SIDES.flatMap((side) => [
  ...twoPart('decor-tv-dashboard-dark_{side}', wallScreen(dashboardScreen('dark')), 'TV dashboard with charts, dark mode', side),
  ...twoPart('decor-tv-dashboard-light_{side}', wallScreen(dashboardScreen('light')), 'TV dashboard with charts, light mode', side),
  ...twoPart('decor-tv-presentation_{side}', wallScreen(presentationScreen), 'Meeting-room TV with a presentation', side),
]);
const doorsFor = (side) => [
  ...DOORS.flatMap(([name, label, d]) => ['closed', 'open'].map((st) => ({
    name: `${name}_${side}_${st}`, label: `${label} (${st})`, native: doorTile(d, side, st === 'open'),
  }))),
  ...['closed', 'open'].flatMap((st) => twoPart(`door-glass-sliding_{side}_${st}`, slidingDoor(st === 'open'),
    `Big sliding glass door (${st})`, side)),
];
const windows = SIDES.flatMap((side) => Object.entries(WINDOWS).flatMap(([name, [label, fn]]) =>
  ['day', 'night'].map((t) => ({ name: `${name}_${side}_${t}`, label: `${label} (${t})`, native: faceTile((u, v) => fn(u, v, t === 'night'), side, 0, false) }))));

// ---------------------------------------------------------------- config + sheets (append-only)
const cw = CW * SCALE, ch = CH * SCALE;
const CONFIG = 'office_tileset.json';
const config = existsSync(join(OUT, CONFIG)) ? JSON.parse(readFileSync(join(OUT, CONFIG), 'utf8')) : {
  meta: {
    image: 'office_tileset.png', size: { w: ATLAS, h: ATLAS },
    projection: '2:1 dimetric', ground_angle_deg: 26.565,
    cell: { w: cw, h: ch, cols: COLS, rows: ROWS },
    tile: { w: TW * SCALE, h: TH * SCALE }, unit_elevation_px: 16 * SCALE,
    pixel_scale: SCALE, generator: 'scripts/office-pixel.mjs',
  },
  frames: {},
};
config.meta.sheets ??= [config.meta.image];
for (const f of Object.values(config.frames)) f.image ??= config.meta.image;
// The first decoration batch had its own atlas; fold its entries into the main config.
if (existsSync(join(OUT, 'office_decor_tileset.json'))) {
  const old = JSON.parse(readFileSync(join(OUT, 'office_decor_tileset.json'), 'utf8'));
  for (const [k, f] of Object.entries(old.frames)) config.frames[k] ??= { ...f, image: old.meta.image };
  if (!config.meta.sheets.includes(old.meta.image)) config.meta.sheets.push(old.meta.image);
}
const folder = (name) => (name.startsWith('floor') ? 'FLOORS' : name.startsWith('wall') ? 'WALLS'
  : name.startsWith('door') ? 'DOORS' : name.startsWith('window') ? 'WINDOWS' : 'DECOR');
// Pack the tiles that are not in the config yet onto ONE new sheet. Each group starts on
// a new row. Existing sheets are never reopened.
function appendSheet(groups, file) {
  const fresh = groups.map((g) => g.filter((t) => !config.frames[t.name])).filter((g) => g.length);
  if (!fresh.length) return;
  if (!file) { let n = 3; while (config.meta.sheets.includes(`office_tileset_${n}.png`) || existsSync(join(OUT, `office_tileset_${n}.png`))) n++; file = `office_tileset_${n}.png`; }
  const sheet = img(ATLAS, ATLAS);
  let cell = 0;
  for (const g of fresh) {
    cell = Math.ceil(cell / COLS) * COLS;
    for (const t of g) {
      if (cell >= COLS * ROWS) throw new Error(`sheet ${file} overflow at ${t.name}`);
      const col = cell % COLS, row = Math.floor(cell / COLS), big = upscale(t.native, SCALE);
      const rel = `${folder(t.name)}/${t.name}.png`;
      save(rel, big);
      blit(sheet, big, col * cw, row * ch);
      config.frames[t.name] = {
        frame: { x: col * cw, y: row * ch, w: cw, h: ch },
        anchor: { x: cw / 2, y: ch }, pivot: { x: 0.5, y: 1.0, origin: 'top-left' },
        file: rel, label: t.label, ...(t.parts && { parts: t.parts }), image: file,
      };
      cell++;
    }
  }
  save(file, sheet);
  config.meta.sheets.push(file);
}
appendSheet([tiles.filter((t) => t.row === 0), tiles.filter((t) => t.row === 1), tiles.filter((t) => t.row === 2)], 'office_tileset.png');
appendSheet([decor.filter((t) => t.name.includes('_ne')), decor.filter((t) => t.name.includes('_nw'))], 'office_decor_tileset.png');
appendSheet([doorsFor('ne')]);
appendSheet([doorsFor('nw')]);
appendSheet([[...windows, ...screens]]);
// ================================================================ batch 3: office elements (voxels)
// Props are modelled as voxels: 1 voxel = 1 floor texel, 32 voxels = 1 tile ≈ 1 m, 1 voxel
// tall = 1 px. Each pixel is ray-cast along the view axis (1,1,1), so props share the
// floor's exact 2:1 stepping and the set's light: top x1.12, +y face x1.0 (lit),
// +x face x0.8 (shadow). Models face +y ("sw"); rotations give se / ne / nw.
const mat = (c, o = {}) => ({ c: typeof c === 'string' ? hex(c) : c, ...o });
const RINV = { x: 'y', y: '-x', '-x': '-y', '-y': 'x', top: 'top' };
class Vox {
  constructor(X, Y, Z) { Object.assign(this, { X, Y, Z, rot: 0, d: new Array(X * Y * Z).fill(null) }); }
  set(x, y, z, m) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (x < 0 || y < 0 || z < 0 || x >= this.X || y >= this.Y || z >= this.Z) return;
    this.d[(z * this.Y + y) * this.X + x] = m ? { m, x, y, z } : null;
  }
  get(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= this.X || y >= this.Y || z >= this.Z) return null;
    return this.d[(z * this.Y + y) * this.X + x];
  }
  box(x0, y0, z0, x1, y1, z1, m) {                  // inclusive
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, z, m);
    return this;
  }
  cyl(cx, cy, r, z0, z1, m) {                       // vertical cylinder, centre in voxel units
    for (let z = z0; z <= z1; z++) for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++)
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.set(x, y, z, m);
    return this;
  }
  ell(cx, cy, cz, rx, ry, rz, m, keep = () => true) {
    for (let z = Math.floor(cz - rz); z <= cz + rz; z++) for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++)
      if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 + ((z + 0.5 - cz) / rz) ** 2 <= 1 && keep(x, y, z)) this.set(x, y, z, m);
    return this;
  }
  rotated() {                                        // 90°: front +y -> +x
    const n = new Vox(this.Y, this.X, this.Z);
    n.rot = (this.rot + 1) & 3;
    for (let z = 0; z < this.Z; z++) for (let y = 0; y < this.Y; y++) for (let x = 0; x < this.X; x++) {
      const e = this.get(x, y, z);
      if (e) n.d[(z * n.Y + (this.X - 1 - x)) * n.X + y] = e;   // keeps original coords for textures
    }
    return n;
  }
}
const SHADE = { top: 1.12, y: 1, x: 0.8 };
// Render to a native canvas of ((fx+fy)*32) x ((fx+fy)*16 + HM); the anchor is the
// bottom vertex of the footprint: (fx*32, H).
function renderVox(m, fx, fy) {
  const HM = Math.max(96, Math.ceil((m.Z + 6) / 16) * 16);
  const W = (fx + fy) * 32, H = (fx + fy) * 16 + HM, ox = fy * 32, oy = HM, im = img(W, H);
  const frac = (v) => { const f = v - Math.floor(v); return f < 1e-9 ? 1 : f; };
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const X = px + 0.5 - ox, Y = py + 0.5 - oy, bx = X / 2 + Y, by = Y - X / 2;
    let t = m.Z, face = 'top';
    while (t > 0) {
      const step = Math.min(frac(bx + t), frac(by + t), frac(t));
      const tm = t - step / 2, e = m.get(Math.floor(bx + tm), Math.floor(by + tm), Math.floor(tm));
      if (e && !(e.m.glass && ((px + py) & 1) === 0)) {           // glass: checkerboard see-through
        let face0 = face;
        for (let r = 0; r < m.rot; r++) face0 = RINV[face0];
        let c = typeof e.m.c === 'function' ? e.m.c(e.x, e.y, e.z, face0) : e.m.c;
        let glow = e.m.glow;
        if (c && c.c) { glow = c.glow; c = c.c; }
        put(im, px, py, glow ? c : scale(c, SHADE[face]));
        break;
      }
      face = step === frac(t) ? 'top' : step === frac(by + t) ? 'y' : 'x';
      t -= step;
    }
  }
  const out = img(W, H);                             // 1px ink silhouette outline
  out.d.set(im.d);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (im.d[(y * W + x) * 4 + 3]) continue;
    const on = (a, b) => a >= 0 && b >= 0 && a < W && b < H && im.d[(b * W + a) * 4 + 3];
    if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) put(out, x, y, INK);
  }
  return { im: out, W, H, ax: fx * 32, ay: H };
}

// ---------------------------------------------------------------- materials
const two = (a, b, test) => { const A = hex(a), B = hex(b); return (x, y, z, f) => (test(x, y, z, f) ? B : A); };
const MAT = {
  black: mat('#25272c'), charcoal: mat('#3a3e46'), steel: mat('#8d949c'), chrome: mat('#c3c8cd'),
  white: mat('#e9ecef'), red: mat('#c4302b'), brass: mat('#c9a227'), glassBlue: mat('#9fd3e6', { glass: true }),
  woodL: mat(two('#c48f5a', '#a8763f', (x, y, z, f) => (f === 'top' ? (y + (hash(x >> 3, y, 7) > 0.8 ? 1 : 0)) % 4 === 0 : z % 6 === 0))),
  woodD: mat(two('#6b4329', '#563420', (x, y, z, f) => (f === 'top' ? (y + (hash(x >> 3, y, 8) > 0.8 ? 1 : 0)) % 4 === 0 : z % 6 === 0))),
  mesh: mat(two('#2a2d33', '#3a3e46', (x, y, z) => ((x + y + z) & 1) === 0)),
  felt: mat('#2c3e63'),
  leaf: mat(two('#3f8a4b', '#2e6b3a', (x, y, z) => hash(x, y + z * 7, 9) > 0.55)),
  pot: mat('#c0643c'), soil: mat('#4a3222'), trunk: mat('#6b4329'),
};
const glow = (c) => mat(c, { glow: true });
// Screen face texture: emissive content on the +y face, black bezel elsewhere.
const screenMat = (content, x0, x1, z0, z1) => mat((x, y, z, f) => {
  if (f !== 'y' || x <= x0 || x >= x1 || z <= z0 || z >= z1) return hex('#1b1d22');
  return { c: content(x - x0 - 1, z1 - 1 - z), glow: true };
});
const CODE_C = ['#7fd1ff', '#ff8ad8', '#ffd36b', '#8cf59b'].map(hex);
const codeContent = (s) => (a, b) => {
  if (b % 2 === 1 && a >= 1 + (hash(b, 0, s) * 3 | 0) && a < 4 + (hash(b, 1, s) * 12 | 0)) return CODE_C[hash(a >> 2, b, s) * 4 | 0];
  return hex('#0f1b2d');
};
const sceneContent = (a, b) => {                     // mountains wallpaper
  if (b >= 9 - Math.abs(((a * 3) % 14) - 7) * 0.6) return b > 10 ? hex('#2e6b3a') : hex('#4a5d8c');
  return b < 4 ? hex('#3b2a6b') : hex('#c2537a');
};

// ---------------------------------------------------------------- models (front = +y)
const DESK = 24;                                     // desk-top surface height (voxels)
const MODELS = {};
const model = (name, label, X, Y, Z, dirs, build, extra = {}) => { MODELS[name] = { label, X, Y, Z, dirs, build, ...extra }; };
const ALL4 = ['sw', 'se', 'ne', 'nw'], TWO = ['sw', 'se'], FLAT = ['flat'], WALL = ['ne', 'nw'];

model('desk-wood', 'Wood desk', 64, 32, 26, ALL4, (v) => {
  v.box(3, 4, 21, 60, 28, 23, MAT.woodL);
  for (const [x, y] of [[4, 5], [4, 26], [41, 5]]) v.box(x, y, 0, x + 1, y + 1, 20, MAT.steel);
  v.box(6, 5, 7, 42, 6, 20, MAT.woodL);              // modesty panel
  v.box(44, 6, 0, 58, 27, 20, mat(two('#c48f5a', '#8a5c30', (x, y, z, f) => f === 'y' && (z === 7 || z === 14))));
  for (const z of [4, 11, 17]) v.box(49, 28, z, 53, 28, z, MAT.chrome);
});
const RGB = ['#ff3b6b', '#ff9f1c', '#ffe14d', '#3dff7a', '#2fd5ff', '#7a5cff'].map(hex);
model('desk-gamer', 'Gamer desk', 64, 32, 26, ALL4, (v) => {
  v.box(2, 4, 21, 61, 27, 23, mat((x, y, z, f) => (f === 'y' && y === 27 && z === 22 ? { c: RGB[Math.floor(x / 6) % 6], glow: true }
    : f === 'top' && x >= 8 && x <= 55 && y >= 13 && y <= 25 ? (x === 8 || x === 55 || y === 13 || y === 25 ? RGB[4] : hex('#2b2e35')) : hex('#202227'))));
  for (const x of [4, 57]) {
    v.box(x, 6, 0, x + 3, 25, 2, MAT.black);
    v.box(x + 1, 13, 3, x + 2, 17, 20, MAT.red);
  }
  v.box(7, 6, 11, 57, 7, 13, MAT.black);
});
model('desk-boss', 'Big boss desk', 96, 64, 28, ALL4, (v) => {
  v.box(6, 14, 24, 89, 49, 26, mat((x, y, z, f) => {
    if (f !== 'top') return hex('#563420');
    if (x === 12 || x === 83 || y === 20 || y === 43) return x >= 12 && x <= 83 && y >= 20 && y <= 43 ? hex('#c9a227') : hex('#6b4329');
    return x > 12 && x < 83 && y > 20 && y < 43 ? hex('#2f5d43') : hex('#6b4329');
  }));
  v.box(8, 14, 2, 87, 17, 23, MAT.woodD);           // visitor-side front panel
  for (const x0 of [8, 70]) {
    v.box(x0, 14, 2, x0 + 17, 49, 23, mat(two('#6b4329', '#3f2616', (x, y, z, f) => f === 'y' && (z === 9 || z === 16))));
    for (const z of [5, 12, 19]) v.box(x0 + 7, 50, z, x0 + 10, 50, z, MAT.brass);
  }
  v.box(9, 15, 0, 86, 48, 1, MAT.black);
});
const cabinWall = mat((x, y, z, f) => ((f === 'y' && y === 4) || (f === 'x' && x === 4) || (f === '-x' && x === 27)
  ? ((x + y + z) % 3 === 0 ? hex('#22314f') : hex('#2c3e63')) : hex('#4a4f58')));
model('cabin-soundproof', 'Soundproof phone cabin', 32, 32, 74, ALL4, (v) => {
  v.box(2, 2, 0, 29, 29, 1, MAT.charcoal);
  v.box(2, 2, 2, 29, 4, 70, cabinWall);
  v.box(2, 2, 2, 4, 29, 70, cabinWall);
  v.box(27, 2, 2, 29, 29, 70, cabinWall);
  v.box(2, 2, 71, 29, 29, 73, MAT.charcoal);
  v.box(5, 29, 2, 26, 29, 70, MAT.glassBlue);
  v.box(22, 30, 30, 22, 30, 40, MAT.chrome);         // door handle
  v.box(5, 5, 32, 26, 12, 33, MAT.woodL);            // shelf
  v.cyl(15.5, 19, 4, 2, 15, MAT.charcoal);           // stool
  v.box(12, 12, 69, 19, 19, 70, glow('#fff3c4'));    // ceiling light
});
model('cubicle-panel', 'Cubicle wall panel (on the tile edge)', 32, 32, 42, WALL, (v) => {
  v.box(0, 0, 0, 31, 2, 39, mat(two('#6d7f99', '#61728b', (x, y, z) => ((x + z) & 3) === 0)));
  v.box(0, 0, 40, 31, 2, 41, MAT.chrome);
  v.box(0, 0, 0, 1, 2, 41, MAT.steel);
  v.box(30, 0, 0, 31, 2, 41, MAT.steel);
});
model('monitor-multi-arm', 'Multi monitor with arm holders (sits on a 2x1 desk)', 64, 32, 50, ALL4, (v) => {
  v.box(31, 5, DESK, 32, 6, 46, MAT.steel);          // clamp post
  v.box(10, 7, 44, 53, 8, 45, MAT.steel);            // arm bar
  const scr = (x0, y0, s) => v.box(x0, y0, 33, x0 + 17, y0 + 1, 46, screenMat(codeContent(s), x0, x0 + 17, 33, 46));
  scr(4, 11, 201); scr(23, 9, 202); scr(42, 11, 203);
}, { onDesk: true });
model('monitor-large', 'Big large monitor (sits on a desk)', 32, 32, 50, ALL4, (v) => {
  v.box(10, 6, DESK, 21, 12, DESK, MAT.black);
  v.box(15, 7, DESK + 1, 16, 8, 34, MAT.black);
  v.box(3, 9, 33, 28, 10, 47, screenMat(sceneContent, 3, 28, 33, 47));
}, { onDesk: true });
const keys = (a, b) => mat((x, y, z, f) => (f === 'top' && ((x + y) & 1) ? hex(b) : hex(a)));
model('keyboard-ergonomic', 'Ergonomic split keyboard (sits on a desk)', 32, 32, 30, ALL4, (v) => {
  const K = keys('#2a2d33', '#4a4f58');
  v.box(4, 16, DESK, 14, 22, DESK, K); v.box(9, 16, DESK + 1, 14, 22, DESK + 1, K);
  v.box(17, 16, DESK, 27, 22, DESK, K); v.box(17, 16, DESK + 1, 22, 22, DESK + 1, K);
  v.box(4, 23, DESK, 27, 25, DESK, MAT.charcoal);    // wrist rest
}, { onDesk: true });
model('keyboard', 'Keyboard (sits on a desk)', 32, 32, 30, ALL4, (v) => {
  v.box(7, 17, DESK, 24, 22, DESK, keys('#d9dde1', '#b4bac0'));
}, { onDesk: true });
model('mouse-pad', 'Mouse pad and mouse (sits on a desk)', 32, 32, 30, ALL4, (v) => {
  v.box(17, 14, DESK, 28, 24, DESK, mat(two('#2b2e35', '#3b82c4', (x, y) => x === 17 || x === 28 || y === 14 || y === 24)));
  v.box(22, 18, DESK + 1, 24, 21, DESK + 2, MAT.white);
}, { onDesk: true });
model('plant-cactus', 'Cactus plant', 32, 32, 36, FLAT, (v) => {
  v.cyl(16, 16, 6, 0, 8, MAT.pot).cyl(16, 16, 6.6, 7, 9, mat('#a8522e')).cyl(16, 16, 5, 9, 9, MAT.soil);
  const C = mat((x, y, z) => (hash(x, y + z * 5, 31) > 0.9 ? hex('#e8e0c0') : ((x + y) & 1 ? hex('#3d7a3d') : hex('#4f9a4a'))));
  v.cyl(16, 16, 3.2, 10, 30, C);
  v.box(10, 15, 16, 13, 17, 17, C).cyl(11, 16, 1.6, 17, 24, C);
  v.box(19, 15, 20, 22, 17, 21, C).cyl(21.5, 16, 1.6, 21, 27, C);
  v.box(15, 15, 31, 16, 16, 31, glow('#ff6fae'));
});
model('plant', 'Plant', 32, 32, 40, FLAT, (v) => {
  v.cyl(16, 16, 6, 0, 11, mat(two('#e9ecef', '#c9ced3', (x, y, z) => z === 9))).cyl(16, 16, 5, 11, 11, MAT.soil);
  v.ell(16, 16, 24, 11, 11, 12, MAT.leaf, (x, y, z) => hash(x, y, z + 50) > 0.18 && z > 11);
});
model('plant-tree', 'Indoor tree', 32, 32, 86, FLAT, (v) => {
  v.cyl(16, 16, 8, 0, 14, mat(two('#9ea2a5', '#8a8e91', (x, y, z) => z % 5 === 0))).cyl(16, 16, 7, 14, 14, MAT.soil);
  v.cyl(16, 16, 1.6, 15, 52, MAT.trunk);
  for (const [cx, cy, cz, r] of [[16, 16, 66, 12], [10, 18, 54, 8], [22, 13, 57, 8], [15, 11, 76, 8]])
    v.ell(cx, cy, cz, r, r, r * 0.85, MAT.leaf, (x, y, z) => hash(x, y, z + 60) > 0.15);
});
model('water-fountain', 'Water fountain', 32, 32, 48, ALL4, (v) => {
  v.box(10, 10, 0, 21, 21, 30, mat((x, y, z, f) => (f === 'y' && z >= 13 && z <= 15 && x >= 12 && x <= 19 ? hex('#3a3e46') : hex('#e9ecef'))));
  v.box(13, 22, 18, 13, 22, 19, MAT.red).box(18, 22, 18, 18, 22, 19, mat('#3b82c4'));
  v.cyl(15.5, 15.5, 1.8, 31, 31, MAT.glassBlue).cyl(15.5, 15.5, 5, 32, 46, MAT.glassBlue);
  v.cyl(15.5, 15.5, 4, 32, 42, mat('#4aa3d8'));
});
model('coffee-machine', 'Coffee machine on a cabinet', 32, 32, 50, ALL4, (v) => {
  v.box(4, 8, 0, 27, 24, 27, mat(two('#6b4329', '#3f2616', (x, y, z, f) => f === 'y' && x === 15)));
  v.box(12, 25, 18, 13, 25, 21, MAT.chrome).box(18, 25, 18, 19, 25, 21, MAT.chrome);
  v.box(3, 7, 28, 28, 25, 29, MAT.white);
  v.box(9, 10, 30, 22, 19, 44, mat((x, y, z, f) => (f === 'y' && z >= 41 && z <= 42 && x >= 12 && x <= 19 ? { c: hex('#42f0ff'), glow: true } : hex('#c3c8cd'))));
  v.box(9, 10, 45, 22, 19, 46, MAT.black);
  v.box(11, 20, 30, 20, 22, 31, MAT.black);
  v.box(15, 20, 37, 16, 21, 39, MAT.black);
  v.box(14, 20, 32, 17, 21, 34, MAT.white);           // cup
});
model('juice-bar', 'Juice bar', 64, 32, 46, ALL4, (v) => {
  v.box(2, 10, 0, 61, 27, 29, mat((x, y, z, f) => (f === 'y' ? ((x >> 2) & 1 ? hex('#7cc04b') : hex('#93d35f')) : hex('#e9ecef'))));
  v.box(1, 9, 30, 62, 28, 31, MAT.woodL);
  v.cyl(10, 18, 5, 32, 33, MAT.white);
  for (const [x, y, c] of [[8, 17, '#ff9f1c'], [12, 19, '#ff9f1c'], [10, 15, '#7cc04b'], [9, 21, '#7cc04b']]) v.ell(x, y, 35, 2.2, 2.2, 2, mat(c));
  v.box(28, 14, 32, 35, 20, 42, MAT.chrome).box(30, 16, 43, 33, 18, 44, MAT.black);
  v.box(40, 15, 32, 45, 20, 39, MAT.glassBlue).box(41, 16, 32, 44, 19, 36, mat('#ffa31a'));
  for (const x of [50, 54, 58]) v.cyl(x, 20, 1.6, 32, 35, mat(two('#e9ecef', '#ff9f1c', (a, b, z) => z < 34)));
});
const BOTTLES = ['#2f7d3a', '#8b2e1f', '#c9a227', '#3b5b8c', '#d9dde1', '#5a3822'];
model('drinks-bar', 'Drinks bar', 64, 32, 56, ALL4, (v) => {
  v.box(2, 12, 0, 61, 27, 30, mat(two('#563420', '#3f2616', (x, y, z, f) => f === 'y' && x % 8 === 0)));
  v.box(2, 28, 4, 61, 29, 5, MAT.brass);
  v.box(1, 11, 31, 62, 28, 32, mat(two('#25272c', '#3a3e46', (x, y) => hash(x, y, 77) > 0.85)));
  for (let i = 0; i < 7; i++) {
    const x = 6 + i * 5, h = 8 + Math.floor(hash(i, 0, 78) * 5), c = mat(BOTTLES[i % BOTTLES.length]);
    v.cyl(x, 15, 1.7, 33, 33 + h, c).cyl(x, 15, 0.8, 34 + h, 37 + h, c);
  }
  v.box(46, 18, 33, 47, 19, 41, MAT.chrome).box(43, 18, 41, 51, 19, 42, MAT.chrome);
  for (const x of [44, 47, 50]) v.box(x, 20, 38, x, 20, 42, MAT.black);
});
model('coffee-table-controller', 'Small coffee table with game controller', 32, 32, 20, ALL4, (v) => {
  v.box(4, 8, 10, 27, 23, 11, MAT.woodL);
  for (const [x, y] of [[5, 9], [25, 9], [5, 21], [25, 21]]) v.box(x, y, 0, x + 1, y + 1, 9, MAT.black);
  const P2 = mat('#2a2d33');
  v.box(12, 13, 12, 19, 16, 12, P2).box(11, 15, 12, 12, 18, 12, P2).box(19, 15, 12, 20, 18, 12, P2);
  v.set(13, 14, 13, mat('#8d949c')); v.set(18, 13, 13, mat('#ff4545')); v.set(18, 15, 13, mat('#3dff7a'));
  v.set(17, 14, 13, mat('#2fd5ff')); v.set(19, 14, 13, mat('#ffe14d'));
});
model('game-console', 'Game console (PS5-style, stands on the floor)', 32, 32, 20, ALL4, (v) => {
  v.box(13, 11, 0, 18, 22, 15, MAT.black);
  v.box(12, 10, 0, 12, 23, 17, MAT.white).box(19, 10, 0, 19, 23, 17, MAT.white);
  v.box(15, 23, 2, 16, 23, 14, glow('#2fd5ff'));
});
const ARC_ART = mat((x, y, z, f) => (f === 'x' || f === '-x' ? (((y + z) >> 2) % 3 === 0 ? hex('#ff4fd8') : ((y + z) >> 2) % 3 === 1 ? hex('#ffd23f') : hex('#5b2a86')) : hex('#3b1d5c')));
const PLAY = textPixels('PLAY', 0, 0);
model('arcade-machine', 'Old arcade machine', 32, 32, 62, ALL4, (v) => {
  v.box(5, 4, 0, 26, 24, 29, ARC_ART);
  v.box(5, 4, 30, 26, 28, 33, ARC_ART);
  v.box(5, 4, 34, 26, 21, 50, ARC_ART);
  v.box(5, 4, 51, 26, 26, 60, ARC_ART);
  v.box(8, 22, 36, 23, 22, 49, screenMat((a, b) => {
    const h = hash(a >> 1, b >> 1, 301);
    if (b >= 10 && Math.abs(a - 7) <= (b - 10)) return hex('#42f0ff');      // player ship
    return h > 0.93 ? hex('#ff4545') : h > 0.86 ? hex('#ffe14d') : hex('#0b0c1a');
  }, 8, 23, 36, 49));
  v.box(6, 27, 51, 25, 27, 59, mat((x, y, z, f) => (f === 'y' && PLAY.has(`${x - 8},${58 - z}`) ? { c: hex('#ffffff'), glow: true }
    : f === 'y' ? { c: z > 55 ? hex('#ff9f1c') : hex('#ff4fd8'), glow: true } : hex('#3b1d5c'))));
  v.box(10, 25, 34, 10, 25, 35, MAT.red).set(10, 25, 36, mat('#ff4545'));
  for (const [x, c] of [[15, '#ffe14d'], [18, '#2fd5ff'], [21, '#3dff7a']]) v.set(x, 26, 34, mat(c));
  v.box(13, 25, 8, 18, 25, 18, mat((x, y, z, f) => (f === 'y' && (x === 14 || x === 17) && z >= 14 && z <= 16 ? { c: hex('#ff9f1c'), glow: true } : hex('#1b1d22'))));
});
const SCORE = textPixels('999', 0, 0);
model('boxing-machine', 'Old boxing machine', 32, 32, 64, ALL4, (v) => {
  v.box(6, 8, 0, 25, 24, 30, mat((x, y, z, f) => (f === 'y' && z >= 20 && z <= 23 ? hex('#ffd23f') : hex('#c4302b'))));
  v.box(12, 10, 31, 19, 16, 51, MAT.red);
  v.box(10, 9, 52, 21, 17, 62, mat((x, y, z, f) => (f === 'y' && SCORE.has(`${x - 11},${60 - z}`) ? { c: hex('#ff4545'), glow: true } : hex('#1b1d22'))));
  v.box(14, 17, 40, 17, 21, 42, MAT.chrome);
  v.ell(15.5, 24, 39, 4.5, 3.5, 6, mat(two('#8b2e1f', '#a8402c', (x, y, z) => z > 41)));
});
model('ping-pong-table', 'Ping pong table', 96, 64, 32, TWO, (v) => {
  v.box(4, 7, 24, 91, 56, 25, mat((x, y, z, f) => (f === 'top' && (x === 4 || x === 91 || y === 7 || y === 56 || y === 31 || y === 32) ? hex('#f2f3f4') : hex('#1f4e8c'))));
  v.box(47, 5, 26, 48, 58, 29, mat('#f2f3f4', { glass: true })).box(47, 5, 30, 48, 58, 30, MAT.white);
  v.box(47, 4, 24, 48, 5, 30, MAT.black).box(47, 58, 24, 48, 59, 30, MAT.black);
  for (const [x, y] of [[10, 11], [10, 50], [84, 11], [84, 50]]) v.box(x, y, 0, x + 1, y + 1, 23, MAT.black);
  v.box(10, 11, 10, 11, 51, 11, MAT.black).box(84, 11, 10, 85, 51, 11, MAT.black);
});
const OFFICE = textPixels('OFFICE', 0, 0);
model('container-office', 'Container office', 96, 96, 84, ALL4, (v) => {
  v.box(4, 9, 0, 91, 86, 79, mat((x, y, z, f) => {
    if (f === 'top') return (x >> 2) & 1 ? hex('#b85424') : hex('#c85d29');
    const r = f === 'x' || f === '-x' ? y : x;
    if (f === 'y' && x >= 55 && x <= 80 && z >= 64 && z <= 72) return OFFICE.has(`${x - 57},${70 - z}`) ? { c: hex('#ffffff'), glow: true } : hex('#1b1d22');
    if (f === 'y' && x >= 60 && x <= 75 && z <= 60) {                    // glass door
      if (x === 60 || x === 75 || z === 60) return hex('#25272c');
      if (x === 72 && z >= 28 && z <= 32) return hex('#c3c8cd');
      return mod(x - z, 9) < 2 ? hex('#5d7d99') : hex('#2b3f55');
    }
    if (f === 'y' && x >= 16 && x <= 48 && z >= 30 && z <= 56) {        // window
      if (x === 16 || x === 48 || z === 30 || z === 56 || x === 32) return hex('#25272c');
      return mod(x - z, 11) < 2 ? hex('#5d7d99') : hex('#2b3f55');
    }
    return (r >> 1) & 1 ? hex('#d9682b') : hex('#b85424');
  }));
  for (const [x, y] of [[4, 9], [89, 9], [4, 84], [89, 84]]) for (const z of [0, 77]) v.box(x, y, z, x + 2, y + 2, z + 2, MAT.charcoal);
});
model('safe-door', 'Bank safe door (on the wall)', 32, 32, 80, WALL, (v) => {
  const C = 16, Z0 = 36;
  for (let z = Z0 - 15; z <= Z0 + 15; z++) for (let x = 0; x < 32; x++) {
    const r = Math.hypot(x + 0.5 - C, z + 0.5 - Z0);
    if (r <= 14.5) v.box(x, 0, z, x, 1, z, mat('#5b6068'));
    if (r <= 12.2) v.box(x, 2, z, x, 4, z, mat((a, b, c, f) => (f === 'y' && Math.abs(Math.hypot(a + 0.5 - C, c + 0.5 - Z0) - 8.5) < 0.6 ? hex('#6f767e') : hex('#9aa1a8'))));
    if (r > 10.5 && r <= 12 && Math.round(Math.atan2(z - Z0, x - C) / (Math.PI / 6)) % 2 === 0 && r > 11) v.set(x, 5, z, MAT.chrome);
  }
  v.box(14, 5, Z0 - 2, 17, 6, Z0 + 1, MAT.chrome);
  for (const a of [Math.PI / 2, Math.PI * 7 / 6, Math.PI * 11 / 6])
    for (let r = 2; r <= 8; r++) v.set(C - 0.5 + Math.cos(a) * r, 6, Z0 - 0.5 + Math.sin(a) * r, MAT.chrome);
  v.box(1, 2, Z0 - 8, 2, 3, Z0 + 8, MAT.charcoal);    // hinge
});
model('meeting-table', 'Big meeting table', 128, 64, 30, TWO, (v) => {
  const R = 20, x0 = 6, x1 = 121, y0 = 8, y1 = 55;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const cx = Math.min(Math.max(x + 0.5, x0 + R), x1 + 1 - R), cy = (y0 + y1 + 1) / 2;
    if (Math.hypot(x + 0.5 - cx, (y + 0.5 - cy) * (R / ((y1 - y0 + 1) / 2))) <= R) v.box(x, y, 24, x, y, 25, MAT.woodD);
  }
  for (const x of [28, 89]) v.box(x, 26, 0, x + 10, 37, 23, MAT.charcoal).box(x - 6, 22, 0, x + 16, 41, 1, MAT.charcoal);
  v.box(60, 30, 26, 67, 33, 26, MAT.black);
});
model('chair-ergonomic', 'Ergonomic chair', 32, 32, 48, ALL4, (v) => {
  for (let k = 0; k < 5; k++) {
    const a = k * Math.PI * 2 / 5 + 0.3;
    for (let r = 0; r <= 11; r++) v.set(16 + Math.cos(a) * r, 16 + Math.sin(a) * r, 1, MAT.black);
    v.set(16 + Math.cos(a) * 11, 16 + Math.sin(a) * 11, 0, MAT.charcoal);
  }
  v.cyl(16, 16, 1.3, 2, 12, MAT.chrome);
  v.box(8, 9, 13, 23, 25, 16, MAT.mesh);
  v.box(9, 6, 17, 22, 8, 40, MAT.mesh).box(11, 5, 41, 20, 7, 45, MAT.mesh);
  for (const x of [6, 24]) v.box(x + 1, 13, 17, x + 1, 14, 22, MAT.black).box(x, 11, 23, x + 2, 20, 24, MAT.black);
});
model('chair-meeting', 'Meeting chair', 32, 32, 34, ALL4, (v) => {
  for (const [x, y] of [[9, 10], [22, 10], [9, 23], [22, 23]]) v.box(x, y, 0, x, y, 12, MAT.chrome);
  const F = mat(two('#3b5b8c', '#34507b', (x, y, z) => ((x + y + z) & 3) === 0));
  v.box(8, 9, 13, 23, 24, 15, F).box(9, 8, 16, 22, 9, 30, F);
});
model('chair-bar', 'Bar chair', 32, 32, 28, FLAT, (v) => {
  v.cyl(16, 16, 6, 0, 0, MAT.chrome).cyl(16, 16, 1, 1, 22, MAT.chrome);
  for (let a = 0; a < 64; a++) v.set(16 - 0.5 + Math.cos(a / 64 * Math.PI * 2) * 5, 16 - 0.5 + Math.sin(a / 64 * Math.PI * 2) * 5, 9, MAT.chrome);
  v.cyl(16, 16, 6.5, 23, 25, mat(two('#2a2d33', '#3a3e46', (x, y, z, f) => f === 'top' && (x + y) % 5 === 0)));
});
model('pouf-beanbag', 'Pouf (big bean bag)', 32, 32, 24, FLAT, (v) => {
  v.ell(16, 16, 9, 13, 13, 12, mat(two('#e8742c', '#c95f22', (x, y, z) => hash(x, y + z * 3, 88) > 0.8)),
    (x, y, z) => z >= 0 && !(z > 14 && (x - 15.5) ** 2 + (y - 15.5) ** 2 < 30));
});
model('ottoman', 'Ottoman seat', 32, 32, 18, FLAT, (v) => {
  v.cyl(16, 16, 10, 2, 13, mat(two('#2f7d7a', '#286b68', (x, y, z) => z % 4 === 0)));
  v.cyl(16, 16, 10, 14, 14, mat((x, y, z, f) => (f === 'top' && x % 5 === 1 && y % 5 === 1 ? hex('#1f5552') : hex('#3a9590'))));
  v.cyl(16, 16, 8, 0, 1, MAT.black);
});

// ---------------------------------------------------------------- render props in every direction
const DIR_ROT = { sw: 0, se: 1, ne: 2, nw: 3, flat: 0 };
const WALL_ROT = { ne: 0, nw: 1 };
function propsOf(entries) {
  const out = [];
  for (const [name, M] of entries) {
    const base = new Vox(M.X, M.Y, M.Z);
    M.build(base);
    for (const dir of M.dirs) {
      const r = M.noRotate ? 0 : (M.dirs === WALL ? WALL_ROT : DIR_ROT)[dir];
      let v = base;
      for (let k = 0; k < r; k++) v = v.rotated();
      const fx = Math.ceil(v.X / 32), fy = Math.ceil(v.Y / 32);
      out.push({ name: `${name}_${dir}`, label: M.label, fx, fy, onDesk: !!M.onDesk, ...renderVox(v, fx, fy) });
    }
  }
  return out;
}
const props = propsOf(Object.entries(MODELS));

// Variable-size props: shelf-pack onto new sheets (never reopening existing ones).
function appendPacked(list) {
  const fresh = list.filter((t) => !config.frames[t.name]);
  let sheet = null, file, x = 0, y = 0, rowH = 0;
  const flush = () => { if (sheet) { save(file, sheet); config.meta.sheets.push(file); sheet = null; } };
  for (const t of fresh) {
    const big = upscale(t.im, SCALE), w = big.w, h = big.h;
    if (sheet && x + w > ATLAS) { x = 0; y += rowH; rowH = 0; }
    if (sheet && y + h > ATLAS) flush();
    if (!sheet) {
      let n = 3; while (config.meta.sheets.includes(`office_tileset_${n}.png`) || existsSync(join(OUT, `office_tileset_${n}.png`))) n++;
      file = `office_tileset_${n}.png`; sheet = img(ATLAS, ATLAS); x = 0; y = 0; rowH = 0;
    }
    const rel = `${t.folder || 'FURNITURE'}/${t.name}.png`;
    save(rel, big);
    blit(sheet, big, x, y);
    config.frames[t.name] = {
      frame: { x, y, w, h },
      anchor: { x: t.ax * SCALE, y: t.ay * SCALE },
      pivot: { x: +(t.ax / t.W).toFixed(4), y: 1.0, origin: 'top-left' },
      footprint: { x: t.fx, y: t.fy },
      ...(t.onDesk && { on_desk: true, elevation_px: DESK * SCALE }),
      file: rel, label: t.label, ...(t.parts && { parts: t.parts }), image: file,
    };
    x += w; rowH = Math.max(rowH, h);
  }
  flush();
}
appendPacked(props);


// ================================================================ batch 4: stairs, slide, big circle window
const FIRST_MODELS = new Set(Object.keys(MODELS));
// Half stair into the wall: 6 steps up to a landing at half wall height, then a doorway in
// the wall. `along` is the axis the stair runs on; it enters the wall at coordinate 0.
function halfStair(along) {
  return (v) => {
    const P = (a, b, z, m) => (along === 'x' ? v.set(a, b, z, m) : v.set(b, a, z, m));
    const h = (a) => (a < 12 ? 48 : a > 51 ? 0 : 48 - 8 * (1 + Math.floor((a - 12) / 8)));
    const tread = mat('#a06b40'), body = mat(two('#8a8e91', '#7b7f82', (x, y, z) => z % 8 === 0));
    for (let a = 0; a < 52; a++) for (let b = 2; b <= 29; b++) for (let z = 0; z < h(a); z++)
      P(a, b, z, z === h(a) - 1 ? tread : body);
    for (let b = 2; b <= 29; b++) for (let z = 48; z <= 79; z++)                 // doorway in the wall
      P(0, b, z, b <= 3 || b >= 28 || z >= 78 ? mat('#3a3e46') : mat(z < 52 ? '#1d2026' : '#15171c'));
    const rail = (a) => 62 - Math.max(0, a - 12);
    for (let a = 1; a < 52; a++) P(a, 29, rail(a), MAT.chrome);
    for (const a of [4, 15, 31, 47]) for (let z = h(a); z < rail(a); z++) P(a, 29, z, MAT.steel);
  };
}
model('stair-half-into-wall', 'Half stair into the wall (enters the left wall)', 64, 32, 82, ['nw'], halfStair('x'), { noRotate: true });
MODELS['stair-half-into-wall-ne'] = { ...MODELS['stair-half-into-wall'], X: 32, Y: 64, label: 'Half stair into the wall (enters the right wall)', build: halfStair('y'), dirs: ['ne'] };
model('stair-spiral-black', 'Round black spiral stairs', 64, 64, 100, FLAT, (v) => {
  const C = 32, steel = mat('#3a3e46'), tread = mat(two('#4f545d', '#40444c', (x, y) => ((x + y) & 1) === 0));
  v.cyl(C, C, 2.2, 0, 92, steel);
  for (let k = 0; k < 16; k++) {
    const a0 = (k * Math.PI * 2) / 16, z = 4 + k * 5;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const dx = x + 0.5 - C, dy = y + 0.5 - C, r = Math.hypot(dx, dy);
      const da = mod(Math.atan2(dy, dx) - a0, Math.PI * 2);
      if (r >= 2 && r <= 28 && da <= (Math.PI * 2) / 16 + 0.05) v.box(x, y, z, x, y, z + 1, tread);
    }
    const bx = C - 0.5 + Math.cos(a0 + 0.2) * 27, by = C - 0.5 + Math.sin(a0 + 0.2) * 27;
    for (let zz = z + 2; zz < z + 20; zz++) v.set(bx, by, zz, steel);                // baluster
  }
  for (let t = 0; t <= 400; t++) {                                                    // helical handrail
    const a = (t / 400) * Math.PI * 2 + 0.2;
    v.set(C - 0.5 + Math.cos(a) * 27, C - 0.5 + Math.sin(a) * 27, 24 + (t / 400) * 80 - 0.5, MAT.black);
  }
  v.box(C - 4, C - 4, 0, C + 3, C + 3, 1, steel);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {                       // top landing quarter
    const dx = x + 0.5 - C, dy = y + 0.5 - C;
    if (Math.hypot(dx, dy) <= 29 && dx <= 0 && dy <= 0) v.box(x, y, 88, x, y, 89, tread);
  }
});
const props4 = propsOf(Object.entries(MODELS).filter(([n]) => !FIRST_MODELS.has(n)));
const bigCircle = (u, v, n) => {
  const d2 = (u + 0.5 - 32) ** 2 + (v + 0.5 - 42) ** 2;
  if (d2 > 27 * 27) return null;
  if (d2 > 23.5 * 23.5) return u < 32 && v > 42 ? WFL : WF;
  if (u === 31 || u === 32 || v === 41 || v === 42) return WF;
  return sky(mod(u, 32), v, n);
};
const bigWindows = SIDES.flatMap((side) => ['day', 'night'].flatMap((t) => [1, 2].map((p) => ({
  name: `window-circle-big_${side}_${t}_part${p}`, label: `Big circle window (${t})`, folder: 'WINDOWS',
  parts: { index: p, of: 2 }, im: faceTile((u, v) => bigCircle(u, v, t === 'night'), side, (p - 1) * 32, false),
  W: CW, H: CH, ax: CW / 2, ay: CH, fx: 1, fy: 1,
}))));
appendPacked([...bigWindows, ...props4]);

// ================================================================ batch 5: lounge, pets, kitchen
const BEFORE_5 = new Set(Object.keys(MODELS));
const KITCHEN = new Set();
const kmodel = (name, ...a) => { KITCHEN.add(name); model(name, ...a); };
function ergoChair(mesh, frame, caster, metal) {
  return (v) => {
    for (let k = 0; k < 5; k++) {
      const a = k * Math.PI * 2 / 5 + 0.3;
      for (let r = 0; r <= 11; r++) v.set(16 + Math.cos(a) * r, 16 + Math.sin(a) * r, 1, frame);
      v.set(16 + Math.cos(a) * 11, 16 + Math.sin(a) * 11, 0, caster);
    }
    v.cyl(16, 16, 1.3, 2, 12, metal);
    v.box(8, 9, 13, 23, 25, 16, mesh);
    v.box(9, 6, 17, 22, 8, 40, mesh).box(11, 5, 41, 20, 7, 45, mesh);
    for (const x of [6, 24]) v.box(x + 1, 13, 17, x + 1, 14, 22, frame).box(x, 11, 23, x + 2, 20, 24, frame);
  };
}
model('chair-ergonomic-white', 'Ergonomic white chair', 32, 32, 48, ALL4,
  ergoChair(mat(two('#e9ecef', '#d3d8dd', (x, y, z) => ((x + y + z) & 1) === 0)), mat('#c9ced3'), MAT.charcoal, MAT.chrome));
const LEATHER = mat(two('#6b3a22', '#7d4529', (x, y, z, f) => (f === 'top' ? (x + y) % 7 === 0 : (x + z) % 9 === 0)));
model('sofa-leather', 'Big leather sofa', 96, 32, 32, ALL4, (v) => {
  for (const x of [5, 88]) for (const y of [5, 26]) v.box(x, y, 0, x + 1, y + 1, 2, MAT.black);
  v.box(3, 3, 3, 92, 28, 8, LEATHER);
  v.box(8, 9, 9, 87, 28, 13, mat((x, y, z, f) => (f === 'top' && (x === 34 || x === 61) ? hex('#4a2817') : hex('#7d4529'))));
  v.box(3, 3, 9, 92, 8, 28, mat((x, y, z, f) => (f === 'y' && x % 8 === 4 && z % 6 === 3 ? hex('#3f2213') : hex('#6b3a22'))));
  v.box(2, 3, 9, 7, 28, 20, LEATHER).box(88, 3, 9, 93, 28, 20, LEATHER);
});
model('chair-chill', 'Big chilling chair (hanging egg chair)', 32, 32, 78, ALL4, (v) => {
  v.cyl(16, 14, 9, 0, 1, MAT.black);
  v.box(15, 2, 2, 16, 3, 74, MAT.black).box(15, 3, 73, 16, 16, 74, MAT.black).box(15, 16, 61, 16, 16, 72, MAT.chrome);
  const RAT = mat(two('#c9a46a', '#a8834d', (x, y, z) => ((x + z) & 1) === 0));
  v.ell(16, 16, 40, 13, 12, 21, RAT, (x, y, z) => ((x + 0.5 - 16) / 10.5) ** 2 + ((y + 0.5 - 19.5) / 10) ** 2 + ((z + 0.5 - 41) / 17) ** 2 > 1);
  v.ell(16, 17, 27, 9, 8, 5, mat('#2f7d7a'));
});
model('dog-corgi', 'Corgi dog', 32, 32, 22, ALL4, (v) => {
  const W = mat('#f4efe6'), fur = mat((x, y, z) => (z < 6 || (y > 21 && z < 12) ? hex('#f4efe6') : hex('#d98a3d')));
  for (const [x, y] of [[13, 10], [18, 10], [13, 19], [18, 19]]) v.box(x, y, 0, x + 1, y + 1, 4, W);
  v.ell(16, 15, 8.5, 5, 9, 4.5, fur);
  v.ell(16, 24, 12.5, 4, 4, 3.5, fur);
  v.ell(16, 27.5, 11, 2, 2.2, 1.6, W);
  v.box(13, 23, 15, 14, 24, 18, mat('#d98a3d')).box(18, 23, 15, 19, 24, 18, mat('#d98a3d'));
  v.set(14, 27, 13, MAT.black); v.set(18, 27, 13, MAT.black); v.set(16, 29, 11, MAT.black);
  v.box(15, 5, 9, 16, 6, 10, mat('#d98a3d'));
});
model('cat-black', 'Black cat', 32, 32, 22, ALL4, (v) => {
  const fur = mat(two('#1d1f24', '#2c2f36', (x, y, z) => hash(x, y + z * 3, 91) > 0.75));
  v.ell(16, 15, 6, 4.5, 5, 6, fur);
  v.ell(16, 17, 14, 3.6, 3.4, 3.2, fur);
  v.box(14, 16, 17, 14, 17, 18, fur).box(18, 16, 17, 18, 17, 18, fur);
  v.set(15, 20, 14, glow('#c6e64a')); v.set(17, 20, 14, glow('#c6e64a')); v.set(16, 20, 13, mat('#c77a8a'));
  for (let t = 0; t <= 24; t++) { const a = -Math.PI / 2 + (t / 24) * Math.PI * 0.95; v.set(16 + Math.cos(a) * 6.5, 15 + Math.sin(a) * 6.5, 0, fur); }
});
model('pool-table', 'Pool table', 96, 64, 30, TWO, (v) => {
  for (const [x, y] of [[10, 12], [80, 12], [10, 46], [80, 46]]) v.box(x, y, 0, x + 5, y + 5, 17, MAT.woodD);
  v.box(6, 8, 18, 89, 55, 22, MAT.woodD);
  v.box(6, 8, 23, 89, 55, 23, mat((x, y) => (x <= 9 || x >= 86 || y <= 11 || y >= 52 ? hex('#563420') : x === 10 || x === 85 || y === 12 || y === 51 ? hex('#17603a') : hex('#1f7a46'))));
  v.box(6, 8, 24, 89, 11, 25, MAT.woodD).box(6, 52, 24, 89, 55, 25, MAT.woodD).box(6, 8, 24, 9, 55, 25, MAT.woodD).box(86, 8, 24, 89, 55, 25, MAT.woodD);
  for (const [x, y] of [[9, 11], [86, 11], [9, 52], [86, 52], [47.5, 10], [47.5, 53]]) v.cyl(x, y, 2.6, 23, 25, MAT.black);
  const ball = (x, y, c) => v.box(x, y, 24, x + 1, y + 1, 25, mat(c));
  ball(28, 31, '#f4f6f8');
  [['#ffd23f', 64, 31], ['#c4302b', 67, 29], ['#3b5b8c', 67, 33], ['#25272c', 70, 31], ['#c4302b', 70, 27], ['#ffd23f', 70, 35]].forEach(([c, x, y]) => ball(x, y, c));
  v.box(16, 42, 24, 72, 42, 24, mat(two('#e3c98f', '#563420', (x) => x < 30)));
});
model('coat-rack', 'Jacket and hat holder', 32, 32, 72, ALL4, (v) => {
  v.cyl(16, 16, 6, 0, 1, MAT.woodD).cyl(16, 16, 1.2, 2, 64, MAT.woodD);
  for (let k = 0; k < 4; k++) v.set(16 - 0.5 + Math.cos(k * Math.PI / 2) * 3, 16 - 0.5 + Math.sin(k * Math.PI / 2) * 3, 61, MAT.woodD);
  const J = mat(two('#2f4f7f', '#26426b', (x, y, z) => x === 16 && z > 40));
  v.box(11, 18, 30, 21, 21, 57, J).box(10, 18, 34, 10, 21, 54, J).box(22, 18, 34, 22, 21, 54, J);
  v.box(14, 21, 54, 18, 21, 58, mat('#1f3557'));
  v.cyl(16, 16, 5.5, 65, 65, mat('#5a3822')).cyl(16, 16, 3.2, 66, 69, mat('#5a3822')).cyl(16, 16, 3.3, 66, 66, MAT.black);
});
model('lockers', 'Lockers', 64, 32, 66, ALL4, (v) => {
  v.box(2, 8, 0, 61, 24, 1, MAT.charcoal);
  v.box(2, 8, 2, 61, 24, 64, mat((x, y, z, f) => {
    if (f !== 'y') return hex('#5f7d99');
    const lx = (x - 2) % 15;
    if (lx === 0) return hex('#3f5670');
    if (lx >= 4 && lx <= 10 && z >= 50 && z <= 58 && z % 2 === 0) return hex('#3f5670');
    if (lx === 12 && z >= 28 && z <= 34) return hex('#c3c8cd');
    if (lx >= 6 && lx <= 8 && z >= 40 && z <= 42) return hex('#e9ecef');
    return hex('#6f8fad');
  }));
});
model('laptop-silver', 'Silver laptop (sits on a desk)', 32, 32, 40, ALL4, (v) => {
  v.box(10, 12, DESK, 21, 20, DESK, mat((x, y, z, f) => (f === 'top' && x >= 11 && x <= 20 && y >= 13 && y <= 16 ? ((x + y) & 1 ? hex('#2a2d33') : hex('#3a3e46'))
    : f === 'top' && x >= 14 && x <= 17 && y >= 18 && y <= 19 ? hex('#aeb4ba') : hex('#d0d4d8'))));
  const code = codeContent(211);
  v.box(10, 11, DESK, 21, 11, DESK + 9, mat((x, y, z, f) => (f !== 'y' ? hex('#d0d4d8') : x === 10 || x === 21 || z === DESK || z === DESK + 9 ? hex('#1b1d22') : { c: code(x - 11, DESK + 8 - z), glow: true })));
}, { onDesk: true });
model('penguin-big', 'Big penguin', 32, 32, 46, ALL4, (v) => {
  const BW = (cx, w) => mat((x, y, z) => (y > 19 && Math.abs(x + 0.5 - 16) < w && z < 40 ? hex('#f4f6f8') : hex('#1d1f24')));
  v.box(11, 19, 0, 14, 25, 1, mat('#ff9f1c')).box(17, 19, 0, 20, 25, 1, mat('#ff9f1c'));
  v.ell(16, 16, 19, 10, 9, 18, BW(16, 7));
  v.ell(6.5, 16, 21, 2, 4, 9, MAT.black).ell(25.5, 16, 21, 2, 4, 9, MAT.black);
  v.ell(16, 16, 37, 7.5, 7, 7, BW(16, 4));
  v.box(15, 22, 35, 16, 25, 36, mat('#ff9f1c'));
  v.set(13, 21, 39, mat('#ffffff')); v.set(18, 21, 39, mat('#ffffff'));
});
// Kitchen
const MARBLE = mat(two('#eef0f2', '#c9ced3', (x, y) => mod(x - 2 * y, 23) === 0 || mod(x + 3 * y, 31) === 0));
kmodel('kitchen-island', 'Kitchen island', 64, 32, 38, ALL4, (v) => {
  v.box(4, 6, 0, 59, 25, 1, MAT.black);
  v.box(4, 6, 2, 59, 25, 27, mat((x, y, z, f) => ((f === 'y' || f === '-y') && ((x - 4) % 14 === 0 || z === 18) ? hex('#22303f') : hex('#2e4057'))));
  for (const x0 of [8, 22, 36, 50]) v.box(x0, 26, 22, x0 + 4, 26, 22, MAT.brass).box(x0 + 5, 26, 10, x0 + 5, 26, 14, MAT.brass);
  v.box(2, 4, 28, 61, 29, 29, mat((x, y, z, f) => (f === 'top' && x >= 40 && x <= 49 && y >= 10 && y <= 17 ? hex('#3a3e46') : MARBLE.c(x, y, z, f))));
  v.box(44, 8, 30, 45, 9, 36, MAT.chrome).box(44, 9, 35, 45, 12, 36, MAT.chrome);
});
kmodel('kitchen-cabinet-high', 'Kitchen high cabinet', 32, 32, 80, ALL4, (v) => {
  v.box(2, 4, 0, 29, 24, 1, MAT.black);
  v.box(2, 4, 2, 29, 24, 77, mat((x, y, z, f) => (f === 'y' && (x === 15 || z === 40) ? hex('#c9ced3') : hex('#eef0f2'))));
  for (const x of [13, 18]) v.box(x, 25, 44, x, 25, 50, MAT.steel).box(x, 25, 30, x, 25, 36, MAT.steel);
});
kmodel('kitchen-cabinet-low', 'Kitchen low cabinet', 32, 32, 32, ALL4, (v) => {
  v.box(2, 6, 0, 29, 24, 1, MAT.black);
  v.box(2, 6, 2, 29, 24, 27, mat((x, y, z, f) => (f === 'y' && (x === 15 || z === 20) ? hex('#c9ced3') : hex('#eef0f2'))));
  v.box(1, 4, 28, 30, 26, 29, MAT.woodL);
  v.box(6, 25, 23, 10, 25, 23, MAT.steel).box(21, 25, 23, 25, 25, 23, MAT.steel).box(13, 25, 13, 13, 25, 17, MAT.steel).box(18, 25, 13, 18, 25, 17, MAT.steel);
});
kmodel('fridge-50s', "50's fridge", 32, 32, 56, ALL4, (v) => {
  const mint = mat('#9ed9c5');
  for (let z = 2; z <= 52; z++) {
    const d = z - 44, inset = d > 0 ? Math.round(8 - Math.sqrt(Math.max(0, 64 - d * d))) : 0;
    v.box(3 + inset, 5 + inset, z, 28 - inset, 25 - inset, z, mint);
  }
  for (const [x, y] of [[4, 6], [26, 6], [4, 23], [26, 23]]) v.box(x, y, 0, x + 1, y + 1, 1, MAT.chrome);
  v.box(22, 26, 28, 23, 26, 38, MAT.chrome).box(22, 27, 36, 23, 27, 38, MAT.chrome);
  v.box(11, 26, 41, 20, 26, 41, MAT.chrome);
});
kmodel('fridge-modern', 'Modern fridge', 32, 32, 66, ALL4, (v) => {
  v.box(1, 5, 0, 30, 26, 63, mat((x, y, z, f) => {
    if (f !== 'y') return hex('#2a2d33');
    if ((x === 15 && z > 20) || z === 20) return hex('#15171c');
    if (x >= 5 && x <= 10 && z >= 38 && z <= 48) return x === 5 || x === 10 || z === 38 || z === 48 ? hex('#15171c') : z === 46 ? { c: hex('#42f0ff'), glow: true } : hex('#3a3e46');
    return (x + z) % 13 === 0 ? hex('#3a3e46') : hex('#2a2d33');
  }));
  v.box(13, 27, 26, 13, 27, 56, MAT.chrome).box(17, 27, 26, 17, 27, 56, MAT.chrome).box(8, 27, 14, 23, 27, 14, MAT.chrome);
});
kmodel('fridge-aluminium', 'Aluminium fridge', 32, 32, 66, ALL4, (v) => {
  v.box(3, 5, 0, 28, 25, 62, mat((x, y, z, f) => (f === 'y' && z === 40 ? hex('#7d848c')
    : (f === 'y' || f === '-y' ? x : y) % 2 ? hex('#b4bac0') : hex('#c3c8cd'))));
  v.box(24, 26, 12, 25, 26, 36, MAT.steel).box(24, 26, 44, 25, 26, 58, MAT.steel);
});
const kTable = (top, leg) => (v) => {
  v.box(6, 6, 22, 57, 25, 23, top);
  for (const [x, y] of [[8, 8], [54, 8], [8, 22], [54, 22]]) v.box(x, y, 0, x + 1, y + 1, 21, leg);
};
kmodel('kitchen-table-white', 'Kitchen white table', 64, 32, 26, TWO, kTable(MAT.white, mat('#c9ced3')));
kmodel('kitchen-table-wood', 'Kitchen wood table', 64, 32, 26, TWO, kTable(MAT.woodL, MAT.woodD));
kmodel('kitchen-table-round-wood', 'Kitchen round wood table', 32, 32, 26, FLAT, (v) => {
  v.cyl(16, 16, 14, 22, 23, MAT.woodL).cyl(16, 16, 1.8, 3, 21, MAT.woodD).cyl(16, 16, 7, 0, 2, MAT.woodD);
});
kmodel('kitchen-chair', 'Kitchen chair', 32, 32, 36, ALL4, (v) => {
  for (const [x, y] of [[9, 11], [22, 11], [9, 22], [22, 22]]) v.box(x, y, 0, x, y, 12, MAT.woodD);
  v.box(8, 10, 13, 23, 23, 14, MAT.woodL);
  for (const x of [9, 13, 18, 22]) v.box(x, 10, 15, x, 10, 30, MAT.woodD);
  v.box(8, 10, 31, 23, 11, 33, MAT.woodL);
});
kmodel('lamp-pendant-green', 'Low-hanging green pendant lamp (hangs from the ceiling)', 32, 32, 96, FLAT, (v) => {
  v.box(16, 16, 63, 16, 16, 95, MAT.black);
  v.ell(16, 16, 56, 9, 9, 9, mat(two('#2f6b4f', '#3c8463', (x, y, z, f) => f === 'top')),
    (x, y, z) => z >= 56 && ((x + 0.5 - 16) ** 2 + (y + 0.5 - 16) ** 2) / 49 + ((z + 0.5 - 56) / 7) ** 2 > 1);
  v.box(15, 15, 64, 16, 16, 65, MAT.brass);
  v.ell(16, 16, 55, 3, 3, 2.2, glow('#fff3c4'));
}, { hanging: true });
kmodel('picnic-table', 'Garden picnic table', 64, 64, 28, TWO, (v) => {
  const plank = (o) => mat(two('#c48f5a', '#8a5c30', (x, y, z, f) => f === 'top' && (y - o) % 5 === 4));
  v.box(4, 20, 24, 59, 43, 25, plank(20));
  for (const y of [6, 50]) v.box(4, y, 14, 59, y + 7, 15, plank(y));
  for (const x of [10, 52]) {
    for (let z = 0; z <= 23; z++) {
      const ya = Math.round(26 - ((23 - z) * 16) / 23), yb = Math.round(37 + ((23 - z) * 16) / 23);
      v.box(x, ya, z, x + 1, ya + 1, z, MAT.woodD).box(x, yb, z, x + 1, yb + 1, z, MAT.woodD);
    }
    v.box(x, 6, 13, x + 1, 57, 13, MAT.woodD);
  }
});
const props5 = propsOf(Object.entries(MODELS).filter(([n]) => !BEFORE_5.has(n)))
  .map((p) => ({ ...p, folder: KITCHEN.has(p.name.replace(/_[^_]+$/, '')) ? 'KITCHEN' : 'FURNITURE', hanging: !!MODELS[p.name.replace(/_[^_]+$/, '')].hanging }));
appendPacked(props5);

// ================================================================ batch 6: tube slide from the ceiling
const BEFORE_6 = new Set(Object.keys(MODELS));
// Stainless spiral tube: drops through a collar in the ceiling (z 80 = wall height), one
// full turn round a support pole, then runs out towards the front (+y) onto a landing mat.
model('slide-tube', 'Tube slide coming down from the ceiling', 64, 64, 86, ALL4, (v) => {
  const C = 32, R = 20, r = 7;
  const TUBE = mat(two('#b4bac0', '#d6dadf', (x, y, z, f) => f === 'top' || (x + y + z) % 9 === 0));
  const JOINT = mat('#7d848c'), INSIDE = mat('#25272c');
  v.cyl(C, C, 2, 0, 81, MAT.steel);                                                   // support pole
  const path = [];
  for (let z = 80; z >= 72; z -= 0.5) path.push([C + R, C, z]);                       // drop from the ceiling
  for (let k = 0; k <= 900; k++) {                                                     // one turn down
    const a = -Math.PI * 2 + (k / 900) * Math.PI * 2;
    path.push([C + Math.cos(a) * R, C + Math.sin(a) * R, 72 - (k / 900) * 65]);
  }
  for (let y = C; y <= 63; y += 0.5) path.push([C + R, y, 7]);                         // run-out
  path.forEach(([x, y, z], k) => v.ell(x, y, z, r, r, r, k % 120 < 6 ? JOINT : TUBE));
  for (let y = 61; y <= 63; y++) for (let z = 1; z <= 12; z++) for (let x = C + R - 6; x <= C + R + 6; x++)
    if ((x + 0.5 - C - R) ** 2 + (z + 0.5 - 7) ** 2 < 5.2 ** 2) v.set(x, y, z, INSIDE);  // open mouth
  for (let x = C + R - 11; x <= C + R + 11; x++) for (let y = C - 11; y <= C + 11; y++)        // ceiling collar
    if (Math.hypot(x + 0.5 - C - R, y + 0.5 - C) <= 10) v.box(x, y, 84, x, y, 85, Math.hypot(x + 0.5 - C - R, y + 0.5 - C) > 7.5 ? MAT.charcoal : MAT.black);
  for (const [a, z] of [[Math.PI / 2, 57], [Math.PI, 40], [Math.PI * 1.5, 23]])        // brackets
    for (let d = 1; d <= R - r; d++) v.set(C - 0.5 + Math.cos(a) * d, C - 0.5 + Math.sin(a) * d, z, MAT.steel);
  v.box(C + R - 7, 64 - 6, 0, C + R + 7, 63, 0, mat('#3b82c4'));                       // landing mat (in footprint)
});
const props6 = propsOf(Object.entries(MODELS).filter(([n]) => !BEFORE_6.has(n)));
appendPacked(props6);

writeFileSync(join(OUT, CONFIG), JSON.stringify(config, null, 2) + '\n');

// ---------------------------------------------------------------- previews
const byName = Object.fromEntries([...tiles, ...decor, ...screens, ...doorsFor('ne'), ...doorsFor('nw'), ...windows]
  .map((t) => [t.name, t.native]));
// Room of N x N floor tiles; ne[k] / nw[k] = tile names drawn in order on wall tile k
// (k = 0 is the back corner). Saved only if the file does not exist yet.
function room(file, N, floorAt, ne, nw) {
  const PW = N * TW, PH = N * TH + DY + 8, scene = img(PW, PH);
  for (let i = 0; i < scene.d.length; i += 4) scene.d.set([38, 41, 48, 255], i);
  const at = (i, j) => [(i - j) * (TW / 2) + PW / 2 - CW / 2, (i + j) * (TH / 2) + 4];
  for (let s = 0; s <= 2 * (N - 1); s++) for (let i = 0; i < N; i++) {
    const j = s - i;
    if (j >= 0 && j < N) blit(scene, byName[floorAt(i, j)], ...at(i, j));
  }
  for (let k = 0; k < N; k++) {
    for (const n of ne[k] || []) blit(scene, byName[n], ...at(k, 0));
    for (const n of nw[k] || []) blit(scene, byName[n], ...at(0, k));
  }
  save(file, upscale(scene, SCALE));
}
// Wall run with 2-part pieces: part1 is the left piece on screen (ne: lower k, nw: higher k).
function hang(side, walls, items) {
  const out = walls.map((w) => [`${w}_${side}`]);
  items.forEach((name, k) => {
    if (!name) return;
    const base = name.includes('{side}') ? name.replace('{side}', side) : `${name}_${side}`;
    if (byName[base]) return out[k].push(base);
    const [l, r] = side === 'ne' ? [k, k + 1] : [k + 1, k];
    out[l].push(`${base}_part1`);
    out[r].push(`${base}_part2`);
  });
  return out;
}
const run = (w, n) => Array(n).fill(w);
room('preview_room.png', 14,
  (i, j) => `${FLOOR_LIST[Math.min(2, Math.floor(i / 5)) + 3 * (j < 7 ? 0 : 1)][0]}_flat`,
  hang('ne', WALL_LIST.flatMap(([w]) => [w, w]), ['decor-neon-power-up', 'decor-bookshelf', 'decor-tv', null,
    'decor-picture-sea', 'decor-switch-left', 'decor-neon-coffee', 'decor-picture-forest', 'decor-neon-amazing', null,
    'decor-neon-deploy-fridays', 'decor-neon-trust-your-code', 'decor-elevator', 'decor-switch-right']),
  hang('nw', WALL_LIST.flatMap(([w]) => [w, w]), ['decor-neon-force', 'decor-neon-fuck-trump', 'decor-bookshelf',
    'decor-picture-sea', 'decor-elevator', 'decor-switch-left', 'decor-tv', null, 'decor-picture-forest',
    'decor-neon-power-up', 'decor-neon-amazing', null, 'decor-bookshelf', 'decor-switch-right']));
const doorRun = (side, st) => [...DOORS.map(([n]) => `${n}_{side}_${st}`), `door-glass-sliding_{side}_${st}`, null];
room('preview_doors.png', 12, () => 'floor-cement-light_flat',
  hang('ne', run('wall-white', 12), doorRun('ne', 'closed')),
  hang('nw', run('wall-wood-white', 12), doorRun('nw', 'open')));
const winRun = (t) => [`window-full_{side}_${t}`, `window-full_{side}_${t}`, `window-full_{side}_${t}`,
  `window-half_{side}_${t}`, `window-grid_{side}_${t}`, `window-arch_{side}_${t}`, `window-circle_{side}_${t}`];
room('preview_windows_screens.png', 14, () => 'floor-carpet-gray_flat',
  hang('ne', run('wall-white', 14), [...winRun('day'), 'decor-tv-dashboard-dark_{side}', null, 'decor-tv-dashboard-light_{side}', null, 'decor-tv-presentation_{side}', null, null]),
  hang('nw', run('wall-tiles-black-big', 14), [...winRun('night'), 'decor-tv-dashboard-light_{side}', null, 'decor-tv-presentation_{side}', null, 'decor-tv-dashboard-dark_{side}', null, null]));

// Furniture showroom. Each prop is placed by its front tile (i, j) = the tile whose bottom
// vertex is the prop's anchor; it covers tiles i-fx+1..i, j-fy+1..j. Draw order: by i + j
// of the front tile, then desk-top items after their desk.
{
  const propBy = Object.fromEntries(props.map((p) => [p.name, p]));
  const N = 18, PW = N * TW, PH = N * TH + DY + 40, scene = img(PW, PH);
  for (let i = 0; i < scene.d.length; i += 4) scene.d.set([38, 41, 48, 255], i);
  const at = (i, j) => [(i - j) * (TW / 2) + PW / 2 - CW / 2, (i + j) * (TH / 2) + 36];
  for (let s = 0; s <= 2 * (N - 1); s++) for (let i = 0; i < N; i++) {
    const j = s - i;
    if (j < 0 || j >= N) continue;
    const f = i >= 9 && j >= 9 ? 'floor-tiles-black_flat' : i < 9 && j >= 9 ? 'floor-carpet-gray_flat' : j < 9 && i >= 9 ? 'floor-wood_flat' : 'floor-cement-light_flat';
    blit(scene, byName[f], ...at(i, j));
  }
  for (let k = 0; k < N; k++) {
    blit(scene, byName['wall-white_ne'], ...at(k, 0));
    blit(scene, byName[k < 9 ? 'wall-brick_nw' : 'wall-blue-skirting_nw'], ...at(0, k));
  }
  blit(scene, byName['window-full_ne_day'], ...at(4, 0));
  blit(scene, byName['window-full_ne_day'], ...at(5, 0));
  const P = [
    ['plant-tree_flat', 0, 0], ['safe-door_ne', 12, 0], ['safe-door_nw', 0, 13], ['arcade-machine_sw', 14, 1], ['boxing-machine_sw', 15, 1],
    ['desk-wood_sw', 3, 2], ['monitor-multi-arm_sw', 3, 2], ['keyboard_sw', 3, 2], ['mouse-pad_sw', 3, 2],
    ['desk-gamer_sw', 7, 2], ['monitor-large_sw', 7, 2], ['keyboard-ergonomic_sw', 6, 2], ['mouse-pad_sw', 7, 2],
    ['chair-ergonomic_ne', 2, 3], ['chair-ergonomic_ne', 6, 3], ['plant-cactus_flat', 9, 1], ['plant_flat', 16, 2],
    ['coffee-machine_se', 0, 3], ['water-fountain_se', 0, 4], ['cabin-soundproof_se', 0, 7], ['cabin-soundproof_sw', 3, 9],
    ['desk-boss_sw', 12, 5], ['chair-ergonomic_ne', 11, 6],
    ['cubicle-panel_ne', 5, 6], ['cubicle-panel_ne', 6, 6], ['cubicle-panel_ne', 7, 6], ['cubicle-panel_nw', 5, 6], ['cubicle-panel_nw', 5, 7],
    ['meeting-table_sw', 9, 10], ['chair-meeting_sw', 7, 8], ['chair-meeting_sw', 8, 8], ['chair-meeting_ne', 7, 11], ['chair-meeting_ne', 8, 11],
    ['chair-meeting_se', 5, 10], ['chair-meeting_nw', 10, 9],
    ['ping-pong-table_sw', 16, 9], ['pouf-beanbag_flat', 3, 12], ['ottoman_flat', 5, 13], ['coffee-table-controller_sw', 3, 14], ['game-console_sw', 2, 15],
    ['drinks-bar_sw', 9, 14], ['chair-bar_flat', 8, 15], ['chair-bar_flat', 9, 15], ['juice-bar_se', 12, 15],
    ['container-office_sw', 17, 15], ['plant_flat', 14, 13],
  ].map(([n, i, j], k) => ({ p: propBy[n], i, j, k }));
  P.sort((a, b) => a.i + a.j - (b.i + b.j) || a.p.onDesk - b.p.onDesk || a.k - b.k);
  for (const { p, i, j } of P) {
    const [sx, sy] = at(i, j);
    blit(scene, p.im, sx + CW / 2 - p.ax, sy + CH - p.ay);
  }
  save('preview_furniture.png', upscale(scene, SCALE));
}

{
  const pb = Object.fromEntries([...props, ...props4, ...props6].map((p) => [p.name, p]));
  const wb = Object.fromEntries(bigWindows.map((w) => [w.name, w.im]));
  const N = 10, PW = N * TW, PH = N * TH + DY + 40, scene = img(PW, PH);
  for (let i = 0; i < scene.d.length; i += 4) scene.d.set([38, 41, 48, 255], i);
  const at = (i, j) => [(i - j) * (TW / 2) + PW / 2 - CW / 2, (i + j) * (TH / 2) + 36];
  for (let s2 = 0; s2 <= 2 * (N - 1); s2++) for (let i = 0; i < N; i++) {
    const j = s2 - i;
    if (j >= 0 && j < N) blit(scene, byName['floor-wood_flat'], ...at(i, j));
  }
  for (let k = 0; k < N; k++) { blit(scene, byName['wall-white_ne'], ...at(k, 0)); blit(scene, byName['wall-brick_nw'], ...at(0, k)); }
  blit(scene, wb['window-circle-big_ne_day_part1'], ...at(7, 0)); blit(scene, wb['window-circle-big_ne_day_part2'], ...at(8, 0));
  blit(scene, wb['window-circle-big_nw_night_part1'], ...at(0, 7)); blit(scene, wb['window-circle-big_nw_night_part2'], ...at(0, 6));
  const P = [['stair-half-into-wall_nw', 1, 1], ['stair-half-into-wall-ne_ne', 4, 1], ['stair-spiral-black_flat', 6, 5],
    ['slide-tube_sw', 3, 8]].map(([n, i, j]) => ({ p: pb[n], i, j }));
  P.sort((a, b) => a.i + a.j - (b.i + b.j));
  for (const { p, i, j } of P) { const [sx, sy] = at(i, j); blit(scene, p.im, sx + CW / 2 - p.ax, sy + CH - p.ay); }
  save('preview_stairs.png', upscale(scene, SCALE));
}
{
  const pb = Object.fromEntries([...props, ...props5].map((p) => [p.name, p]));
  const N = 12, PW = N * TW, PH = N * TH + DY + 40, scene = img(PW, PH);
  for (let i = 0; i < scene.d.length; i += 4) scene.d.set([38, 41, 48, 255], i);
  const at = (i, j) => [(i - j) * (TW / 2) + PW / 2 - CW / 2, (i + j) * (TH / 2) + 36];
  for (let s2 = 0; s2 <= 2 * (N - 1); s2++) for (let i = 0; i < N; i++) {
    const j = s2 - i;
    if (j >= 0 && j < N) blit(scene, byName[i < 7 ? (j < 9 ? 'floor-tiles-black_flat' : 'floor-wood_flat') : 'floor-carpet-gray_flat'], ...at(i, j));
  }
  for (let k = 0; k < N; k++) { blit(scene, byName[k < 7 ? 'wall-tiles-black-small-white_ne' : 'wall-wood-white_ne'], ...at(k, 0)); blit(scene, byName['wall-white_nw'], ...at(0, k)); }
  const P = [
    ['kitchen-cabinet-high_sw', 0, 0], ['fridge-modern_sw', 1, 0], ['kitchen-cabinet-low_sw', 2, 0], ['kitchen-cabinet-low_sw', 3, 0],
    ['fridge-aluminium_sw', 4, 0], ['fridge-50s_sw', 5, 0], ['lockers_sw', 8, 0], ['coat-rack_sw', 10, 0],
    ['kitchen-island_sw', 4, 3], ['sofa-leather_sw', 11, 2], ['chair-chill_sw', 8, 3],
    ['kitchen-table-wood_sw', 3, 7], ['kitchen-chair_sw', 2, 6], ['kitchen-chair_sw', 3, 6], ['kitchen-chair_ne', 2, 8], ['kitchen-chair_ne', 3, 8],
    ['kitchen-table-round-wood_flat', 6, 6], ['kitchen-chair_se', 5, 6], ['kitchen-chair_nw', 7, 6],
    ['pool-table_sw', 11, 6], ['dog-corgi_sw', 9, 9], ['cat-black_se', 8, 10], ['penguin-big_sw', 11, 9],
    ['kitchen-table-white_sw', 3, 10], ['laptop-silver_sw', 3, 10], ['chair-ergonomic-white_ne', 3, 11],
    ['picnic-table_sw', 7, 11],
    ['lamp-pendant-green_flat', 3, 3], ['lamp-pendant-green_flat', 4, 3], ['lamp-pendant-green_flat', 3, 7],
  ].map(([n, i, j], k) => ({ p: pb[n], i, j, k }));
  P.sort((a, b) => a.p.hanging - b.p.hanging || a.i + a.j - (b.i + b.j) || a.p.onDesk - b.p.onDesk || a.k - b.k);
  for (const { p, i, j } of P) { const [sx, sy] = at(i, j); blit(scene, p.im, sx + CW / 2 - p.ax, sy + CH - p.ay); }
  save('preview_lounge_kitchen.png', upscale(scene, SCALE));
}
{
  const pb = Object.fromEntries(props6.map((p) => [p.name, p]));
  const N = 8, PW = N * TW, PH = N * TH + DY + 40, scene = img(PW, PH);
  for (let i = 0; i < scene.d.length; i += 4) scene.d.set([38, 41, 48, 255], i);
  const at = (i, j) => [(i - j) * (TW / 2) + PW / 2 - CW / 2, (i + j) * (TH / 2) + 36];
  for (let s2 = 0; s2 <= 2 * (N - 1); s2++) for (let i = 0; i < N; i++) {
    const j = s2 - i;
    if (j >= 0 && j < N) blit(scene, byName['floor-cement-light_flat'], ...at(i, j));
  }
  for (let k = 0; k < N; k++) { blit(scene, byName['wall-white_ne'], ...at(k, 0)); blit(scene, byName['wall-white_nw'], ...at(0, k)); }
  for (const [n, i, j] of [['slide-tube_sw', 2, 5], ['slide-tube_se', 6, 2]]) {
    const p = pb[n], [sx, sy] = at(i, j);
    blit(scene, p.im, sx + CW / 2 - p.ax, sy + CH - p.ay);
  }
  save('preview_slide_tube.png', upscale(scene, SCALE));
}
console.log(`files written: ${stats.written}, existing files kept: ${stats.kept}; config frames: ${Object.keys(config.frames).length}, sheets: ${config.meta.sheets.join(', ')}`);
