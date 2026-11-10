#!/usr/bin/env node
// Voxel-style office tiles — 2:1 dimetric, rounded solids, soft projected shadows, no outlines.
// Zero dependencies (ffmpeg is only used, when present, for the animated day/night preview).
//
//   node scripts/office-voxel.mjs
//
// Brief: STYLES/VOXEL/INDOORS/OFFICE/office.md    Spec: STYLES/VOXEL/INDOORS/OFFICE/TILE-SPEC.md
//
// Rule from the brief: never overwrite an existing file. Existing PNGs (tiles, sheets, previews)
// are kept; new designs go to new 2500x2500 sheets and are appended to office_tileset.json.
// To redraw a tile on purpose, delete its PNG and its config entry first.
//
//   OFFICE_OUT=<dir>    write somewhere else (dry runs)
//   OFFICE_ONLY=<regex> only render the jobs whose id matches
//   OFFICE_JOBS=<n>     worker threads (default: CPU count - 1)

import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  TW, TH, HW, HH, ZS, CELL_W, CELL_H, img, encodePng, decodePng, over, crop, contentBox,
  hex, rgb, mix, mul, clamp, sstep, mod, hash, pnoise, noise3,
  box, cyl, sph, ell, cap, tor, cone, uni, cut, isect, shell, grow, blob, clip, rot, warp,
  Model, textSegs, segDist, floorTile, render, footprint, DIRS,
} from './voxel-engine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OFFICE_OUT || join(ROOT, 'STYLES/VOXEL/INDOORS/OFFICE');
const SHEET = 2500, PAD = 2;
const T = 0.125;       // wall thickness (tiles)
const WH = 2.5;        // wall height
const EPS = 1 / 64;    // walls and full-width pieces overlap the tile behind them by 2px to hide seams
const DESK = 0.75;     // desk-top height; on_desk items are modelled on a surface at this height
const DAY = '#87CEEB', NIGHT = '#041A40';

// ---------------------------------------------------------------- catalogue
// A job renders one model in one direction and yields one or more sprites.
const JOBS = [];
const job = (id, folder, label, outputs, run, meta = {}) => JOBS.push({ id, folder, label, outputs, run, meta });

function floor(name, label, tex) {
  job(`${name}_flat`, 'FLOORS', label, [`${name}_flat`], () => [{ name: `${name}_flat`, im: floorTile(tex), ax: HW, ay: TH }]);
}
// Walls, wall decorations, doors and windows share one fixed 256x512 canvas per tile, anchored
// at the tile's bottom vertex. build(side) returns a Model in the "ne" frame: wall slab on the
// y = 0 edge, face towards +y, x running along the wall. The nw piece is the same model
// turned a quarter. Models two tiles long (X = 2) are cut into _part1 (left on screen) / _part2.
const TILE_CANVAS = { x: -HW, y: TH - CELL_H, w: CELL_W, h: CELL_H };
function tileSprites(name, m, q, tileMask) {
  if (m.X === 1) {
    const r = render(m, { q, canvas: TILE_CANVAS, tileMask });
    return [{ name, im: r.im, ax: HW, ay: CELL_H }];
  }
  const big = { x: q ? -2 * HW : -HW, y: TH - CELL_H, w: CELL_W + HW, h: CELL_H + HH };
  const r = render(m, { q, canvas: big, owner: true });
  return [1, 2].map((p) => {
    const im = img(CELL_W, CELL_H), offx = q ? (p === 1 ? 0 : HW) : (p === 1 ? 0 : HW), offy = q ? (p === 1 ? HH : 0) : (p === 1 ? 0 : HH);
    for (let y = 0; y < CELL_H; y++) for (let x = 0; x < CELL_W; x++) {
      const sx = x + offx, sy = y + offy; if (sx >= big.w || sy >= big.h) continue;
      const o = r.owner[sy * big.w + sx];
      if (o !== o || (o < 1) !== (p === 1)) continue;
      im.d.set(r.im.d.subarray((sy * big.w + sx) * 4, (sy * big.w + sx) * 4 + 4), (y * CELL_W + x) * 4);
    }
    return { name: `${name}_part${p}`, im, ax: HW, ay: CELL_H };
  });
}
// suffix: '' or '_closed' / '_day' ... placed after the side, as in the pixel set.
function wallPiece(folder, name, label, build, suffix = '', X = 1, meta = {}) {
  for (const side of ['ne', 'nw']) {
    const id = `${name}_${side}${suffix}`;
    job(id, folder, label, X === 1 ? [id] : [`${id}_part1`, `${id}_part2`], () => tileSprites(id, build(side), side === 'ne' ? 0 : 1, false), meta);
  }
}
// Free-standing props. dirs: 'sw se ne nw' (the way the front faces), 'flat' (one sprite) or
// 'ne nw' for pieces that stand on a tile edge like a wall.
const QUARTER = { sw: 0, se: 1, ne: 2, nw: 3, flat: 0 };
function prop(folder, name, label, X, Y, dirs, build, extra = {}) {
  const edge = !!extra.edge;
  for (const dir of dirs.split(' ')) {
    const q = edge ? (dir === 'ne' ? 0 : 1) : QUARTER[dir], id = `${name}${extra.infix || ''}_${dir}`;
    const fp = q & 1 ? { x: Y, y: X } : { x: X, y: Y };
    job(id, folder, label, [id], () => {
      const m = new Model(X, Y);
      if (extra.on_desk) { m.gz = DESK; m.catch = [0.04, 0.04, X - 0.04, Y - 0.04]; }
      build(m, edge ? dir : undefined);
      const r = render(m, { q });
      // keep the footprint diamond's bounding box inside the canvas so the anchor is always in it
      const c = contentBox(r.im) || { x: 0, y: 0, w: 1, h: 1 };
      const x0 = Math.min(c.x, Math.floor(r.ax - fp.x * HW)), x1 = Math.max(c.x + c.w, Math.ceil(r.ax + fp.y * HW));
      const y0 = Math.min(c.y, Math.floor(r.ay - (fp.x + fp.y) * HH)), y1 = Math.max(c.y + c.h, Math.ceil(r.ay));
      return [{ name: id, im: crop(r.im, x0, y0, x1 - x0, y1 - y0), ax: r.ax - x0, ay: r.ay - y0 }];
    }, { footprint: fp, ...(extra.on_desk && { on_desk: true }), ...(extra.meta || {}) });
  }
}

// ---------------------------------------------------------------- palette + shared materials
const K = {
  white: '#e3e5e8', cream: '#e6dfd0', black: '#25272c', ink: '#17181c', charcoal: '#3b3e46', gray: '#8b9098', lgray: '#bfc3c9',
  steel: '#a7aeb6', chrome: '#cdd2d8', dsteel: '#6c737c', red: '#c8372f', dred: '#8f241f', orange: '#e8862e', yellow: '#f1c232',
  green: '#4c9c48', dgreen: '#2e6b37', lgreen: '#7cc46a', blue: '#3b82c4', dblue: '#27598c', lblue: '#a7cde7', teal: '#2f9c95',
  pink: '#ec7fa6', purple: '#7a55b8', woodL: '#cfa06a', wood: '#ab7443', woodD: '#6e4529', woodXD: '#4a2e1b', leather: '#7d4a2b',
  brass: '#c9a24a', pot: '#c46f4a', soil: '#4a3526', felt: '#5e6470',
};
const gl = (c, g = 1) => ({ c, glow: g });
const shiny = (c, s = 0.5) => ({ c, gloss: s });
const glassM = (c = '#bfe3f2', a = 0.38) => ({ c, a, gloss: 0.7 });
const METAL = shiny(K.steel, 0.45), CHROME = shiny(K.chrome, 0.7), DARK = shiny(K.black, 0.25);
// Wood with a soft grain running along `axis`.
const woodM = (base, axis = 'x', s = 1) => {
  const A = rgb(base), D = mul(A, 0.84);
  return (x, y, z) => {
    const [a, b, c] = axis === 'x' ? [x, y, z] : axis === 'y' ? [y, x, z] : [z, x, y];
    const g = noise3(a * 3, b * 34, c * 34, s) * 0.7 + noise3(a * 9, b * 70, c * 70, s + 1) * 0.3;
    return mix(D, A, clamp(g * 1.5 - 0.1));
  };
};
// Soft fabric / plaster speckle.
const fuzz = (base, amt = 0.06, f = 40, s = 3) => { const A = rgb(base); return (x, y, z) => mul(A, 1 - amt + 2 * amt * noise3(x * f, y * f, z * f, s)); };

// ================================================================ floors
const P2 = (u, v, n, s) => pnoise(u, v, n, s);
const speck = (u, v, s) => hash(Math.floor(u * 256), Math.floor(v * 256), s);
function carpetTex(base, amt, s) {
  const A = rgb(base);
  return (u, v) => mul(A, 1 - amt + amt * (P2(u, v, 8, s) * 0.5 + P2(u, v, 32, s + 1) * 0.6 + speck(u, v, s) * 0.9));
}
const tileTex = (n, groutW, grout, face) => (u, v) => {
  const iu = Math.floor(u * n), iv = Math.floor(v * n), fu = u * n - iu, fv = v * n - iv, g = groutW * n;
  if (fu < g || fv < g) return rgb(grout);
  return face(iu, iv, (fu - g) / (1 - g), (fv - g) / (1 - g), u, v);
};
floor('floor-wood', 'Wood planks', (u, v) => {
  const p = Math.floor(v * 8), fv = v * 8 - p, uu = mod(u + hash(p, 0, 5) * 0.7, 1), seg = Math.floor(uu * 2), fu = uu * 2 - seg;
  if (fv < 0.035 || fu < 0.008) return hex('#6f4a2c');
  const tone = hash(p, seg, 11), grain = P2(u, v, 4, p) * 0.5 + pnoise(u, v * 16, 16, p + 40) * 0.5;
  return mul(mix(hex('#a66f41'), hex('#c8935a'), tone), 0.9 + grain * 0.18);
});
floor('floor-carpet-gray', 'Gray carpet', carpetTex('#7a7e87', 0.16, 21));
floor('floor-carpet-black', 'Black carpet', carpetTex('#2a2c33', 0.3, 22));
floor('floor-carpet-white-fluffy', 'White fluffy carpet', (u, v) => {
  const a = P2(u + P2(u, v, 8, 71) * 0.06, v, 16, 72), b = pnoise(u * 2, v + a * 0.05, 32, 73), s = speck(u, v, 74);
  return mul(hex('#f4f2ee'), 0.80 + a * 0.12 + b * 0.09 + s * 0.05);
});
floor('floor-carpet-yellow-light', 'Light yellow carpet', carpetTex('#efdf94', 0.12, 23));
floor('floor-tiles-ceramic', 'Ceramic tiles', tileTex(2, 0.012, '#b3aca0', (iu, iv, fu, fv, u, v) => {
  const m = P2(u, v, 4, 31 + iu + iv * 2) * 0.5 + P2(u, v, 16, 32) * 0.5, edge = Math.min(fu, fv, 1 - fu, 1 - fv);
  return mul(mix(hex('#e9e3d6'), hex('#f6f2ea'), m), edge < 0.03 ? 0.96 : 1);
}));
floor('floor-cement-light', 'Light gray cement', (u, v) => {
  const t = P2(u, v, 4, 41) * 0.5 + P2(u, v, 16, 42) * 0.3 + speck(u, v, 43) * 0.2, s = speck(u, v, 44);
  return mul(hex('#c3c6c8'), 0.9 + t * 0.14 - (s > 0.985 ? 0.12 : 0));
});
floor('floor-tiles-black', 'Black tiles', tileTex(2, 0.008, '#4a4e56', (iu, iv, fu, fv) => {
  const sheen = sstep(0.55, 0.0, Math.abs(fu - fv + 0.25)) * 0.16 + (fu < 0.03 || fv < 0.03 ? 0.14 : 0);
  return mul(hex('#2c2f36'), 0.75 + hash(iu, iv, 51) * 0.12 + sheen * 2);
}));
floor('floor-tiles-blue-small', 'Small blue tiles', tileTex(8, 0.012, '#e3eaf0', (iu, iv, fu, fv) => {
  const c = mix(hex('#2b68a4'), hex('#6db1e6'), hash(iu, iv, 61));
  return mul(c, fu < 0.12 || fv < 0.12 ? 1.1 : 1);
}));

// ================================================================ walls
// Each style: cap colour, tex(u, z) for the faces, optional relief(m, xa, xb) and floor glow.
const plaster = (base, s) => { const A = rgb(base); return (u, z) => mul(A, 0.965 + 0.05 * (P2(u, z, 8, s) * 0.6 + P2(u, z, 32, s + 1) * 0.4)); };
const skirt = (m, xa, xb, h, c, d = 0.022) => m.add(clip(box(xa - 0.2, xb + 0.2, T - 0.01, T + d, 0, h, 0.012), 'x', xa, xb), c);
const wallTile = (size, s, grout = '#4b5058') => (u, z) => {
  const n = 1 / size, iu = Math.floor(u * n), iz = Math.floor(z * n), fu = u * n - iu, fz = z * n - iz, g = 0.008 * n;
  if (fu < g || fz < g) return { c: rgb(grout), gloss: 0 };
  const sheen = sstep(0.5, 0, Math.abs(fu + fz - 1.25)) * 0.22 + (fz > 1 - 2 * g || fu < 3 * g ? 0.2 : 0);
  return { c: mul(hex('#2b2e35'), 0.8 + hash(mod(iu, n), iz, s) * 0.15 + sheen * 1.6), gloss: 0.35 };
};
const WHITE_P = plaster('#e4e5e7', 61);
const WALLS = {
  brick: {
    label: 'Brick wall', cap: '#b7a797',
    tex(u, z) {
      const row = Math.floor(z * 12), fz = z * 12 - row, uu = u + (row & 1) * 0.125, bi = Math.floor(uu * 4), fu = uu * 4 - bi;
      if (fz < 0.12 || fu < 0.04) return mul(hex('#c4b6a6'), 0.94 + speck(u, z, 80) * 0.08);
      const tone = hash(mod(bi, 4), row, 82), lip = fz > 0.86 ? 1.08 : fz < 0.22 ? 0.9 : 1;
      return mul(mix(hex('#93402f'), hex('#bd6247'), tone), lip * (0.93 + P2(u, z, 64, 83) * 0.14));
    },
  },
  white: { label: 'White wall', cap: '#eceded', tex: WHITE_P, relief: (m, a, b) => skirt(m, a, b, 0.1, '#c9cdd2') },
  gray: { label: 'Gray wall', cap: '#a3a8ae', tex: plaster('#90959c', 65), relief: (m, a, b) => skirt(m, a, b, 0.1, '#5f646c') },
  red: { label: 'Red wall', cap: '#d2544c', tex: plaster('#c2362f', 66), relief: (m, a, b) => skirt(m, a, b, 0.1, '#e6e7e9') },
  'wood-white': {
    label: 'Wall, wood below and white above', cap: '#eceded',
    tex: (u, z) => WHITE_P(u, z),
    relief(m, a, b) {
      const W = woodM(K.wood, 'z', 7);
      m.add(clip(box(a - 0.2, b + 0.2, T - 0.01, T + 0.018, 0, 1.05, 0.006), 'x', a, b), (x, y, z) => (mod(x, 0.125) < 0.008 ? hex('#7b5030') : W(Math.floor(x * 8) * 3.1 + x, y, z)));
      m.add(clip(box(a - 0.2, b + 0.2, T - 0.01, T + 0.04, 1.05, 1.11, 0.014), 'x', a, b), K.woodD);
      skirt(m, a, b, 0.09, K.woodD, 0.032);
    },
  },
  'blue-skirting': { label: 'Light blue wall with skirting board', cap: '#bcdcf0', tex: plaster('#a4cce6', 67), relief: (m, a, b) => skirt(m, a, b, 0.17, '#eef0f2', 0.03) },
  'white-led': {
    label: 'White wall with LED skirting', cap: '#eceded', glow: [205, 244, 255],
    tex(u, z) { const g = Math.exp(-Math.max(0, z - 0.09) / 0.16); return g > 0.02 ? { c: mix(WHITE_P(u, z), [214, 247, 255], g * 0.8), glow: g * 0.75 } : WHITE_P(u, z); },
    relief(m, a, b) {
      skirt(m, a, b, 0.07, '#2e3138', 0.03);
      m.add(clip(box(a - 0.2, b + 0.2, T - 0.01, T + 0.024, 0.07, 0.092, 0.006), 'x', a, b), gl('#f4feff'));
    },
  },
  'tiles-black-big': { label: 'Big black tiles', cap: '#3a3d45', tex: wallTile(0.5, 101) },
  'tiles-black-small-white': {
    label: 'Small black tiles below, white above', cap: '#eceded',
    tex: (u, z) => (z < 0.875 ? wallTile(0.125, 111)(u, z) : WHITE_P(u, z)),
    relief: (m, a, b) => m.add(clip(box(a - 0.2, b + 0.2, T - 0.01, T + 0.016, 0.875, 0.905, 0.008), 'x', a, b), CHROME),
  },
};
const wallExt = (side, X = 1) => (side === 'ne' ? [-EPS, X] : [0, X + EPS]);
function wallModel(style, side) {
  const st = WALLS[style], m = new Model(1, 1), [a, b] = wallExt(side), capC = rgb(st.cap);
  m.add(clip(box(a - 0.2, b + 0.2, 0, T, -0.1, WH, 0.014), 'x', a, b), (x, y, z, nx, ny, nz) => (nz > 0.6 ? capC : st.tex(Math.abs(nx) > Math.abs(ny) ? y : x, z)));
  st.relief?.(m, a, b);
  return m;
}
// Floor under a wall: contact shadow on the lit (ne) side, a soft shadow band along the nw wall.
const aoNe = (d) => (d < 0 ? 0 : 0.34 * Math.exp(-d / 0.05));
const bandNw = (d) => (d < 0 ? 0 : 1 - (1 - 0.36 * (1 - sstep(0.22, 0.8, d))) * (1 - 0.3 * Math.exp(-d / 0.05)));
const wallGround = (st, kind) => (x, y) => {
  const a = kind === 'ne' ? aoNe(y - T) : kind === 'nw' ? bandNw(y - T) : 1 - (1 - aoNe(y - T)) * (1 - bandNw(x - T));
  if (st.glow) {
    const d = kind === 'corner' ? Math.min(x, y) - T : y - T, g = d < 0 ? 0 : 0.55 * Math.exp(-d / 0.11);
    if (g > a * 0.5) return [...st.glow, g];
  }
  return a > 0.004 ? [10, 13, 22, a] : null;
};
// Turn a model built in the ne frame into its nw position inside a q = 0 scene (for corners).
function asNw(m) {
  return m.parts.map((p) => {
    const c = p.mat.c, b = p.bb;
    return {
      d: (x, y, z) => p.d(1 - y, x, z), bb: [b[1], 1 - b[3], b[2], b[4], 1 - b[0], b[5]],
      mat: typeof c === 'function' ? { ...p.mat, c: (x, y, z, nx, ny, nz) => c(1 - y, x, z, -ny, nx, nz) } : p.mat,
    };
  });
}
for (const [style, st] of Object.entries(WALLS)) {
  for (const side of ['ne', 'nw']) {
    const id = `wall-${style}_${side}`;
    job(id, 'WALLS', st.label, [id], () => { const m = wallModel(style, side); m.ground = wallGround(st, side); return tileSprites(id, m, side === 'ne' ? 0 : 1, true); });
  }
  const id = `wall-${style}_corner`;
  job(id, 'WALLS', `${st.label} (corner: ne + nw on one tile)`, [id], () => {
    const m = wallModel(style, 'ne'); m.parts.push(...asNw(wallModel(style, 'nw'))); m.ground = wallGround(st, 'corner');
    return tileSprites(id, m, 0, true);
  });
}

// ================================================================ wall pieces: shared parts
// Every piece carries an invisible copy of the wall (a mask): it hides what is behind the wall
// face and shades the piece like the real wall would, but leaves its own pixels transparent.
const MASK = { c: [0, 0, 0], mask: true };
function piece(side, X = 1, ...holes) {
  const m = new Model(X, 1), [a, b] = wallExt(side, X);
  m.ground = 'none'; m.side = side; m.xa = a; m.xb = b;
  m.add(cut(clip(box(a - 0.2, b + 0.2, 0, T, -0.1, WH, 0.014), 'x', a, b), ...holes), MASK);
  return m;
}
// Soft light on the wall around a lamp or sign: a decal (thin, see-through layer).
const halo = (m, cx, cz, rx, rz, c, strength = 0.5) => m.add(box(cx - rx * 2.2, cx + rx * 2.2, T, T + 0.003, Math.max(0.02, cz - rz * 2.2), Math.min(WH - 0.02, cz + rz * 2.2), 0), {
  decal: true, c: (x, y, z) => ({ c: rgb(c), glow: 1, a: strength * Math.exp(-(((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2)) }),
});
const inR = (u, v, x0, y0, x1, y1) => u >= x0 && u < x1 && v >= y0 && v < y1;
const H = (s) => hex(s);
// Screen on the +y face of a box: content(u, v) with (0, 0) at the top-left.
const screenM = (x0, x1, z0, z1, content, bezel = '#15161a') => {
  const B = hex(bezel);
  return (x, y, z, nx, ny) => (ny > 0.5 && x > x0 && x < x1 && z > z0 && z < z1 ? { c: content((x - x0) / (x1 - x0), (z1 - z) / (z1 - z0)), glow: 0.92 } : { c: B, gloss: 0.3 });
};
const CODE = ['#7fd1ff', '#ff8ad8', '#ffd36b', '#8cf59b', '#c7d2e0'].map(H);
function codeScreen(u, v) {
  const bg = H('#1c2030');
  if (v < 0.07) return u < 0.3 ? H('#3a4160') : H('#272c40');
  if (u < 0.15) { const r = Math.floor(v / 0.06), f = v / 0.06 - r; return f > 0.3 && f < 0.6 && u > 0.02 && u < 0.04 + hash(r, 3, 5) * 0.09 ? H('#6f7896') : H('#232839'); }
  const row = Math.floor((v - 0.1) / 0.052), f = (v - 0.1) / 0.052 - row;
  if (row < 0 || f < 0.25 || f > 0.7) return bg;
  if (u < 0.185) return u > 0.165 ? H('#4a5170') : bg;
  let x = 0.2 + Math.floor(hash(row, 1, 7) * 4) * 0.035;
  for (let k = 0; k < 4; k++) {
    const len = 0.04 + hash(row, k, 8) * 0.13;
    if (u >= x && u < x + len) return CODE[Math.floor(hash(row, k, 9) * 5)];
    x += len + 0.018;
    if (hash(row, k, 10) > 0.72) break;
  }
  return bg;
}
const dashScreen = (dark) => (u, v) => {
  const bg = H(dark ? '#12151d' : '#eef1f5'), card = H(dark ? '#1e2431' : '#ffffff'), ink = H(dark ? '#8f9bb5' : '#7c8799'), grid = H(dark ? '#2a3142' : '#e3e7ee');
  const ACC = ['#4f9dff', '#35d39a', '#ffb547', '#ff5f7a', '#a47bff'].map(H);
  if (v < 0.1) return inR(u, v, 0.03, 0.035, 0.2, 0.07) ? ACC[0] : u > 0.9 && Math.hypot((u - 0.95) * 1.78, (v - 0.05)) < 0.03 ? ACC[2] : card;
  for (let k = 0; k < 4; k++) {                                   // KPI cards
    const x0 = 0.03 + k * 0.2425;
    if (inR(u, v, x0, 0.14, x0 + 0.2175, 0.34)) {
      if (inR(u, v, x0 + 0.02, 0.17, x0 + 0.1, 0.2)) return ink;
      if (inR(u, v, x0 + 0.02, 0.23, x0 + 0.13, 0.3)) return ACC[k];
      const sx = (u - x0 - 0.14) / 0.065; if (sx > 0 && sx < 1 && Math.abs(v - (0.29 - sx * 0.06 - Math.sin(sx * 9 + k) * 0.015)) < 0.008) return ACC[k];
      return card;
    }
  }
  if (inR(u, v, 0.03, 0.38, 0.5, 0.95)) {                          // bar chart
    const bu = (u - 0.05) / 0.43, bv = (0.92 - v) / 0.48, i = Math.floor(bu * 9), f = bu * 9 - i;
    if (bu > 0 && bu < 1 && bv > 0 && f > 0.2 && f < 0.8 && bv < 0.25 + hash(i, 2, 14) * 0.7) return ACC[i % 2 ? 1 : 0];
    return bv > 0 && mod(bv, 0.25) < 0.012 ? grid : card;
  }
  if (inR(u, v, 0.53, 0.38, 0.97, 0.66)) {                         // line chart
    const lu = (u - 0.55) / 0.4, f = (t) => 0.57 - 0.1 * Math.sin(t * 5) - 0.06 * Math.sin(t * 13 + 1) - t * 0.05;
    if (lu > 0 && lu < 1) { const y = f(lu); if (Math.abs(v - y) < 0.011) return ACC[4]; if (v > y && v < 0.64) return mix(card, ACC[4], 0.22); }
    return card;
  }
  if (inR(u, v, 0.53, 0.7, 0.97, 0.95)) {                          // donut + legend
    const dx = (u - 0.62) * 1.78, dy = v - 0.825, r = Math.hypot(dx, dy);
    if (r > 0.055 && r < 0.105) { const a = Math.atan2(dy, dx) / (2 * Math.PI) + 0.5; return ACC[a < 0.42 ? 0 : a < 0.7 ? 1 : a < 0.88 ? 2 : 3]; }
    for (let k = 0; k < 3; k++) { if (inR(u, v, 0.74, 0.755 + k * 0.055, 0.76, 0.78 + k * 0.055)) return ACC[k]; if (inR(u, v, 0.775, 0.76 + k * 0.055, 0.86 + k * 0.03, 0.775 + k * 0.055)) return ink; }
    return card;
  }
  return bg;
};
function slideScreen(u, v) {
  const W = H('#f7f8fa');
  if (v < 0.17) return inR(u, v, 0.06, 0.06, 0.5, 0.12) ? H('#ffffff') : H('#2b5fb8');
  if (v > 0.93) return u > 0.86 ? H('#ff8a3c') : H('#dfe4ec');
  for (let k = 0; k < 4; k++) {
    const y = 0.27 + k * 0.14;
    if (Math.hypot((u - 0.075) * 1.78, v - y - 0.02) < 0.017) return H('#2b5fb8');
    if (inR(u, v, 0.1, y, 0.28 + hash(k, 1, 31) * 0.2, y + 0.04)) return H('#4b5568');
    if (inR(u, v, 0.1, y + 0.06, 0.2 + hash(k, 2, 31) * 0.2, y + 0.085)) return H('#aab2c0');
  }
  const dx = (u - 0.76) * 1.78, dy = v - 0.56, r = Math.hypot(dx, dy);
  if (r < 0.24) { const a = Math.atan2(dy, dx) / (2 * Math.PI) + 0.5; return a < 0.45 ? H('#2b5fb8') : a < 0.75 ? H('#ff8a3c') : H('#35b48a'); }
  return W;
}

// ================================================================ wall decorations
const deco = (name, label, build, X = 1) => wallPiece('DECOR', name, label, build, '', X);
const tvPiece = (content) => (side) => {
  const m = piece(side, 2);
  m.b(0.14, 1.86, T, T + 0.045, 0.95, 1.95, screenM(0.165, 1.835, 0.975, 1.925, content), 0.016);
  m.b(0.8, 1.2, T, T + 0.02, 1.2, 1.7, K.charcoal, 0.01);
  return m;
};
deco('decor-tv', 'Big TV screen', tvPiece(codeScreen), 2);
const NEONS = [
  ['decor-neon-amazing', ['EVERYTHING IS', 'GOING TO BE', 'FUCKING', 'AMAZING'], 2, '#ff4fd8'],
  ['decor-neon-fuck-trump', ['FUCK', 'TRUMP'], 1, '#ff4545'],
  ['decor-neon-trust-your-code', ['TRUST', 'YOUR', 'CODE'], 1, '#42f0ff'],
  ['decor-neon-coffee', ['100%', 'COFFEE', 'MADE'], 1, '#ffb43c'],
  ['decor-neon-deploy-fridays', ['DEPLOY', 'ON', 'FRIDAYS'], 1, '#5cff7c'],
  ['decor-neon-force', ['MAY THE', 'FORCE', 'BE WITH', 'YOU'], 1, '#62a8ff'],
  ['decor-neon-power-up', ['POWER', 'UP'], 1, '#fff24d'],
];
const sentence = (l) => l.join(' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
// Neon tubes: a white-hot core, the colour around it and a glow on the wall.
function neonM(segs, color, r = 0.011) {
  const C = rgb(color), W = [255, 255, 255];
  return (x, y, z) => {
    const d = segDist(segs, x, z);
    if (d < r) return { c: mix(W, C, sstep(0.2, 1, d / r) * 0.75), glow: 1, a: 1 };
    const a = 0.62 * Math.exp(-(d - r) / 0.03);
    return { c: C, glow: 1, a: a < 0.015 ? 0 : a };
  };
}
for (const [name, lines, X, color] of NEONS) deco(name, `Neon sign "${sentence(lines)}"`, (side) => {
  const m = piece(side, X), len = Math.max(...lines.map((l) => l.length)), size = Math.min(0.19, (0.86 * X) / (len * 0.933));
  const segs = textSegs(lines, X / 2, 1.5, size), hgt = lines.length * size * 1.45;
  m.add(box(0.02, X - 0.02, T, T + 0.004, 1.5 - hgt / 2 - 0.12, 1.5 + hgt / 2 + 0.12, 0), { decal: true, c: neonM(segs, color, size * 0.075) });
  return m;
}, X);
const BOOKC = ['#c8372f', '#3b82c4', '#f1c232', '#4c9c48', '#7a55b8', '#e8862e', '#e3e5e8', '#2f9c95', '#25272c', '#ec7fa6'];
// A row of books standing along x on a shelf at height z, backs against y0.
function books(m, x0, x1, y0, z, seed, depth = 0.15, lean = true) {
  let x = x0, k = 0;
  while (x < x1 - 0.03) {
    const w = 0.028 + hash(k, seed, 1) * 0.03, h = 0.17 + hash(k, seed, 2) * 0.1, c = BOOKC[Math.floor(hash(k, seed, 3) * BOOKC.length)];
    if (hash(k, seed, 4) > 0.86 && lean) { x += 0.03; k++; continue; }
    m.b(x, Math.min(x + w, x1), y0, y0 + depth - hash(k, seed, 5) * 0.03, z, z + h, c, 0.005);
    x += w + 0.003; k++;
  }
}
deco('decor-bookshelf', 'Mounted wood bookshelf', (side) => {
  const m = piece(side), W = woodM(K.wood, 'x', 4);
  for (const z of [1.05, 1.5]) {
    m.b(0.08, 0.92, T, T + 0.2, z, z + 0.035, W, 0.01);
    for (const x of [0.16, 0.84]) m.b(x - 0.012, x + 0.012, T, T + 0.16, z - 0.12, z, K.charcoal, 0.006);
  }
  books(m, 0.11, 0.62, T + 0.01, 1.085, 1);
  books(m, 0.3, 0.89, T + 0.01, 1.535, 2);
  m.n(0.76, T + 0.1, 1.085, 1.17, 0.04, 0.055, K.pot);
  m.add(blob(0.03, sph(0.76, T + 0.1, 1.23, 0.06), sph(0.72, T + 0.12, 1.28, 0.045), sph(0.8, T + 0.09, 1.29, 0.04)), fuzz(K.green, 0.12, 60));
  m.b(0.12, 0.26, T + 0.02, T + 0.17, 1.535, 1.575, K.white, 0.006); m.b(0.13, 0.25, T + 0.03, T + 0.16, 1.575, 1.6, K.blue, 0.006);
  return m;
});
for (const [k, cx] of [['left', 0.2], ['right', 0.8]]) deco(`decor-switch-${k}`, `Light switch (${k})`, (side) => {
  const m = piece(side);
  m.b(cx - 0.04, cx + 0.04, T, T + 0.012, 1.14, 1.27, '#f0f1f2', 0.01);
  m.b(cx - 0.018, cx + 0.018, T, T + 0.022, 1.17, 1.24, '#dcdfe3', 0.006);
  m.b(cx - 0.006, cx + 0.006, T + 0.02, T + 0.024, 1.222, 1.232, gl('#58d68d'), 0.002);
  return m;
});
function painting(kind) {
  if (kind === 'sea') return (u, v) => {
    if (Math.hypot(u - 0.7, v - 0.22) < 0.085) return H('#fff3c4');
    if (v < 0.46) return mix(H('#7ec4ee'), H('#fbe3c0'), sstep(0, 0.46, v));
    if (v > 0.8 + 0.03 * Math.sin(u * 9)) return mul(H('#ecd9a8'), 0.94 + 0.08 * hash(u * 90, v * 90, 3));
    const w = Math.sin((v - 0.46) * 110 + Math.sin(u * 14) * 2.2);
    return w > 0.86 ? H('#e9f8ff') : mix(H('#2f86c9'), H('#1c5fa3'), sstep(0.46, 0.8, v) * 0.6 + (w > 0.2 ? 0 : 0.2));
  };
  return (u, v) => {
    let c = mix(H('#bfe3f6'), H('#f3ecd2'), sstep(0, 0.6, v));
    if (v > 0.45 + 0.07 * Math.sin(u * 7 + 1)) c = H('#8fb6a8');
    if (v > 0.57 + 0.05 * Math.sin(u * 11)) c = H('#5d927a');
    for (let k = 0; k < 9; k++) {                                   // pines, far to near
      const cx = hash(k, 1, 21) * 1.0, base = 0.72 + (k / 9) * 0.26, hgt = 0.3 + hash(k, 2, 21) * 0.22, t = (base - v) / hgt;
      if (t > 0 && t < 1 && Math.abs(u - cx) < (1 - t) * 0.085 * (0.8 + 0.4 * mod(t * 4, 1))) c = mix(H('#2f6b45'), H('#1d4a33'), k / 9);
      if (t <= 0 && t > -0.08 && Math.abs(u - cx) < 0.008) c = H('#4a3526');
    }
    return v > 0.94 ? H('#2a5a3a') : c;
  };
}
for (const [k, fr] of [['sea', K.woodL], ['forest', K.woodD]]) deco(`decor-picture-${k}`, `Framed picture (${k})`, (side) => {
  const m = piece(side), art = painting(k);
  m.add(cut(box(0.18, 0.82, T, T + 0.04, 1.12, 1.88, 0.012), box(0.225, 0.775, T + 0.014, T + 0.1, 1.165, 1.835, 0.004)), woodM(fr, 'z', 9));
  m.b(0.2, 0.8, T, T + 0.016, 1.14, 1.86, (x, y, z) => { const u = (x - 0.225) / 0.55, v = (1.835 - z) / 0.67; return u < 0.06 || u > 0.94 || v < 0.05 || v > 0.95 ? H('#f3f1ea') : art((u - 0.06) / 0.88, (v - 0.05) / 0.9); }, 0);
  return m;
});
deco('decor-tv-dashboard-dark', 'TV dashboard with charts, dark mode', tvPiece(dashScreen(true)), 2);
deco('decor-tv-dashboard-light', 'TV dashboard with charts, light mode', tvPiece(dashScreen(false)), 2);
deco('decor-tv-presentation', 'Meeting room TV with a presentation', tvPiece(slideScreen), 2);
deco('decor-lamp-modern', 'Modern wall lamp', (side) => {
  const m = piece(side);
  halo(m, 0.5, 1.6, 0.22, 0.42, '#fff1d0', 0.6);
  m.b(0.47, 0.53, T, T + 0.025, 1.3, 1.9, K.charcoal, 0.012);
  m.k(0.5, T + 0.05, 1.33, 0.5, T + 0.05, 1.87, 0.024, gl('#fff6e0'));
  return m;
});
deco('decor-lamp-classic', 'Classic wall lamp', (side) => {
  const m = piece(side), B = shiny(K.brass, 0.6);
  halo(m, 0.5, 1.72, 0.26, 0.3, '#ffe2a8', 0.55);
  m.add(cyl(0.5, 1.45, T, T + 0.02, 0.055, 0.006, 'y'), B);
  m.k(0.5, T + 0.02, 1.45, 0.5, T + 0.14, 1.42, 0.012, B); m.k(0.5, T + 0.14, 1.42, 0.5, T + 0.16, 1.56, 0.012, B);
  m.c(0.5, T + 0.16, 1.55, 1.58, 0.04, B);
  m.n(0.5, T + 0.16, 1.58, 1.78, 0.115, 0.065, gl('#f7e3b5', 0.7));
  return m;
});
deco('decor-lamp-old', 'Old wall lantern', (side) => {
  const m = piece(side), I = '#2a2a2e', y = T + 0.17;
  halo(m, 0.5, 1.55, 0.24, 0.3, '#ffb866', 0.55);
  m.b(0.47, 0.53, T, T + 0.02, 1.5, 1.86, I, 0.008);
  m.k(0.5, T + 0.02, 1.82, 0.5, y, 1.86, 0.012, I); m.k(0.5, y, 1.86, 0.5, y, 1.76, 0.008, I);
  m.n(0.5, y, 1.68, 1.76, 0.1, 0.02, I);
  m.b(0.43, 0.57, y - 0.07, y + 0.07, 1.44, 1.68, gl('#ffc977', 0.85), 0.006);
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) m.b(0.5 + dx * 0.07 - 0.008, 0.5 + dx * 0.07 + 0.008, y + dy * 0.07 - 0.008, y + dy * 0.07 + 0.008, 1.42, 1.69, I, 0.004);
  m.b(0.415, 0.585, y - 0.085, y + 0.085, 1.4, 1.44, I, 0.008);
  return m;
});

// ================================================================ doors
// Opening 0.62 x 1.85 tiles in the wall, lined with a casing. hl = hinge on the left.
const DX0 = 0.19, DX1 = 0.81, DH = 1.85;
const voidM = (top = '#262a33', bottom = '#0e1014') => { const A = hex(top), B = hex(bottom); return (x, y, z) => ({ c: mix(B, A, clamp(z / 2)), glow: 1 }); };
const hole = (x0, x1, z1, z0 = -0.2) => box(x0, x1, -0.1, T + 0.1, z0, z1, 0);
function doorFrame(side, casing, x0 = DX0, x1 = DX1, h = DH, X = 1, back = voidM()) {
  const m = piece(side, X, hole(x0, x1, h));
  m.add(cut(box(x0 - 0.045, x1 + 0.045, 0.004, T + 0.022, -0.1, h + 0.045, 0.01), hole(x0, x1, h)), casing);
  m.b(x0 - 0.02, x1 + 0.02, 0, 0.012, 0, h + 0.02, back, 0);
  m.b(x0, x1, 0.01, T, -0.05, 0.004, '#3c3f47', 0);
  return m;
}
// Leaf parts are built closed, then swung 90° into the room when open.
function hang(m, open, hl, shapes) {
  const px = hl ? DX0 : DX1;
  for (const [s, mat] of shapes) m.add(open ? rot(s, 'z', hl ? 90 : -90, px, T) : s, mat);
}
const lever = (hl, z = 0.98) => { const x = hl ? DX1 - 0.07 : DX0 + 0.07, d = hl ? -1 : 1; return [[uni(cyl(x, z, T - 0.02, T + 0.02, 0.02, 0.004, 'y'), cap(x, T + 0.022, z, x + d * 0.1, T + 0.022, z, 0.011)), CHROME]]; };
const Y0 = T - 0.06, Y1 = T - 0.015; // closed leaf, slightly recessed in the casing
const panelLeaf = (c) => (hl) => [
  [cut(box(DX0 + 0.004, DX1 - 0.004, Y0, Y1, 0.006, DH - 0.004, 0.006), box(DX0 + 0.09, DX1 - 0.09, Y1 - 0.008, Y1 + 0.05, 1.0, DH - 0.12, 0.012), box(DX0 + 0.09, DX1 - 0.09, Y1 - 0.008, Y1 + 0.05, 0.14, 0.86, 0.012)), c],
  ...lever(hl),
];
const woodLeaf = (c) => (hl) => [
  [cut(box(DX0 + 0.004, DX1 - 0.004, Y0, Y1, 0.006, DH - 0.004, 0.006), ...[0.45, 0.9, 1.35].map((z) => box(DX0, DX1, Y1 - 0.005, Y1 + 0.05, z - 0.006, z + 0.006, 0))), woodM(c, 'z', 12)],
  ...lever(hl),
];
const DOORS = {
  glass: {
    label: 'Glass door', casing: METAL, back: voidM('#4a5c70', '#27313d'),
    leaf: (hl) => [
      [cut(box(DX0 + 0.004, DX1 - 0.004, Y0, Y1, 0.006, DH - 0.004, 0.006), box(DX0 + 0.05, DX1 - 0.05, Y0 - 0.1, Y1 + 0.1, 0.08, DH - 0.06, 0.004)), METAL],
      [box(DX0 + 0.04, DX1 - 0.04, Y0 + 0.016, Y1 - 0.016, 0.07, DH - 0.05, 0.002), glassM('#bfe6f5', 0.42)],
      [uni(cap(hl ? DX1 - 0.09 : DX0 + 0.09, Y1 + 0.03, 0.7, hl ? DX1 - 0.09 : DX0 + 0.09, Y1 + 0.03, 1.25, 0.012), cap(hl ? DX1 - 0.09 : DX0 + 0.09, Y1, 0.75, hl ? DX1 - 0.09 : DX0 + 0.09, Y1 + 0.03, 0.75, 0.008), cap(hl ? DX1 - 0.09 : DX0 + 0.09, Y1, 1.2, hl ? DX1 - 0.09 : DX0 + 0.09, Y1 + 0.03, 1.2, 0.008)), CHROME],
    ],
  },
  white: { label: 'White door', casing: '#d5d8dc', leaf: panelLeaf('#e9eaec') },
  black: { label: 'Black door', casing: '#3a3d44', leaf: panelLeaf(shiny('#2a2c31', 0.2)) },
  gray: { label: 'Gray door', casing: '#6d727a', leaf: panelLeaf('#969ba3') },
  red: { label: 'Red door', casing: '#e3e5e8', leaf: panelLeaf(shiny('#c2302a', 0.2)) },
  'wood-dark': { label: 'Dark wood door', casing: K.woodXD, leaf: woodLeaf('#6a4229') },
  'wood-light': { label: 'Light wood door', casing: '#b98f5e', leaf: woodLeaf('#d2a56f') },
  emergency: {
    label: 'Emergency door with EXIT sign', casing: '#59606a',
    leaf: () => [
      [cut(box(DX0 + 0.004, DX1 - 0.004, Y0, Y1, 0.006, DH - 0.004, 0.006), box(DX0 + 0.2, DX1 - 0.2, Y0 - 0.1, Y1 + 0.1, 1.3, 1.62, 0.008)), '#8d969e'],
      [box(DX0 + 0.19, DX1 - 0.19, Y0 + 0.015, Y1 - 0.015, 1.29, 1.63, 0), glassM('#cfe6ee', 0.5)],
      [box(DX0 + 0.05, DX1 - 0.05, Y1, Y1 + 0.04, 0.96, 1.03, 0.014), shiny('#d2261f', 0.4)],
      [uni(box(DX0 + 0.05, DX0 + 0.09, Y1 - 0.01, Y1 + 0.03, 0.93, 1.06, 0.006), box(DX1 - 0.09, DX1 - 0.05, Y1 - 0.01, Y1 + 0.03, 0.93, 1.06, 0.006)), K.charcoal],
    ],
    extra(m) {
      const segs = textSegs(['EXIT'], 0.5, 2.06, 0.085);
      m.b(0.3, 0.7, T, T + 0.035, 1.97, 2.15, (x, y, z, nx, ny) => (ny > 0.5 && segDist(segs, x, z) < 0.012 ? { c: [255, 255, 255], glow: 1 } : { c: H('#1faa55'), glow: ny > 0.5 ? 0.8 : 0.3 }), 0.012);
    },
  },
};
for (const [k, d] of Object.entries(DOORS)) for (const open of [false, true]) {
  wallPiece('DOORS', `door-${k}`, `${d.label} (${open ? 'open' : 'closed'})`, (side) => {
    const m = doorFrame(side, d.casing, DX0, DX1, DH, 1, d.back), hl = side === 'ne';
    hang(m, open, hl, d.leaf(hl));
    d.extra?.(m);
    return m;
  }, open ? '_open' : '_closed');
}
// Elevator: steel portal, two sliding panels, floor indicator. Open = lit cabin.
function elevator(side, open, lobby) {
  const x0 = 0.15, x1 = 0.85, h = 1.9, F = lobby ? shiny(K.brass, 0.55) : METAL;
  const cabin = (x, y, z) => {
    if (z > 1.78) return { c: H('#fff8e0'), glow: 1 };
    if (Math.abs(z - 0.9) < 0.025) return { c: H('#b9bfc6'), glow: 0.8 };
    return { c: mul(mod(x - x0, 0.175) < 0.008 ? H('#8e826a') : H('#d9ccb0'), z < 0.12 ? 0.6 : 1), glow: 0.8 };
  };
  const m = doorFrame(side, F, x0, x1, h, 1, open ? cabin : voidM());
  if (!open) for (const [a, b] of [[x0, 0.498], [0.502, x1]]) m.b(a, b, T - 0.07, T - 0.03, 0.004, h, (x, y, z) => mul(H('#aeb5bd'), 0.93 + 0.07 * noise3(x * 90, 0, z * 3, 8)), 0.004);
  else for (const [a, b] of [[x0, x0 + 0.05], [x1 - 0.05, x1]]) m.b(a, b, T - 0.07, T - 0.03, 0.004, h, '#aeb5bd', 0.004);
  const segs = textSegs([lobby ? '1' : '3'], 0.5, 2.09, 0.09);
  m.b(0.36, 0.64, T, T + 0.03, 1.99, 2.19, (x, y, z, nx, ny) => (ny > 0.5 && (segDist(segs, x, z) < 0.012 || (Math.abs(x - 0.59) + Math.abs(z - 2.09) * 0.8 < 0.03 && z > 2.07)) ? { c: H('#ffb43c'), glow: 1 } : { c: H('#17181c') }), 0.01);
  m.b(0.91, 0.97, T, T + 0.016, 1.02, 1.22, F, 0.008);
  m.add(cyl(0.94, 1.16, T + 0.012, T + 0.024, 0.014, 0.003, 'y'), gl(open ? '#ffb43c' : '#e8eaee', open ? 1 : 0.4));
  m.add(cyl(0.94, 1.08, T + 0.012, T + 0.024, 0.014, 0.003, 'y'), '#e8eaee');
  return m;
}
for (const open of [false, true]) wallPiece('DOORS', 'door-elevator', `Elevator door (${open ? 'open' : 'closed'})`, (side) => elevator(side, open, false), open ? '_open' : '_closed');
deco('decor-elevator', 'Elevator', (side) => elevator(side, false, true));
// Big glass door, two tiles wide: the panels slide into the wall.
for (const open of [false, true]) wallPiece('DOORS', 'door-glass-sliding', `Big sliding glass door (${open ? 'open' : 'closed'})`, (side) => {
  const x0 = 0.14, x1 = 1.86, h = 2.0, m = doorFrame(side, METAL, x0, x1, h, 2, voidM('#4a5c70', '#27313d'));
  const panel = (a, b) => {
    m.add(cut(box(a, b, T - 0.07, T - 0.035, 0.006, h - 0.004, 0.004), box(a + 0.035, b - 0.035, T - 0.2, T + 0.1, 0.06, h - 0.05, 0.003)), METAL);
    m.b(a + 0.03, b - 0.03, T - 0.058, T - 0.047, 0.05, h - 0.04, glassM('#bfe6f5', 0.4), 0.002);
  };
  if (open) { panel(x0, x0 + 0.07); panel(x1 - 0.07, x1); } else { panel(x0, 0.999); panel(1.001, x1); }
  m.b(0.9, 1.1, T, T + 0.05, h + 0.05, h + 0.11, K.charcoal, 0.012);
  m.add(cyl(1, h + 0.08, T + 0.045, T + 0.055, 0.012, 0.002, 'y'), gl(open ? '#58d68d' : '#ff5f5f'));
  return m;
}, open ? '_open' : '_closed', 2);
// Bunker blast door: hazard-striped frame, thick steel leaf with a wheel.
for (const open of [false, true]) wallPiece('DOORS', 'door-bunker', `Bunker safe door (${open ? 'open' : 'closed'})`, (side) => {
  const hl = side === 'ne', stripes = (x, y, z) => (mod(x + z, 0.16) < 0.08 ? H('#f1c232') : H('#25272c'));
  const m = doorFrame(side, stripes, DX0, DX1, DH), S = (x, y, z) => mul(H('#7f8892'), 0.9 + 0.12 * noise3(x * 14, y * 14, z * 14, 5));
  const cx = 0.5, cz = 1.0, yf = T + 0.035, sh = [[box(DX0 - 0.02, DX1 + 0.02, T - 0.05, yf, 0.01, DH + 0.02, 0.02), { c: S, gloss: 0.3 }]];
  sh.push([box(DX0 + 0.06, DX1 - 0.06, yf - 0.01, yf + 0.018, 0.12, DH - 0.1, 0.012), { c: S, gloss: 0.3 }]);
  const bolts = [];
  for (const z of [0.2, 0.6, 1.4, 1.72]) for (const x of [DX0 + 0.03, DX1 - 0.03]) bolts.push(sph(x, yf, z, 0.018));
  sh.push([uni(...bolts), K.dsteel]);
  const spokes = [0, 60, 120].map((a) => cap(cx - Math.cos(a * Math.PI / 180) * 0.13, yf + 0.07, cz - Math.sin(a * Math.PI / 180) * 0.13, cx + Math.cos(a * Math.PI / 180) * 0.13, yf + 0.07, cz + Math.sin(a * Math.PI / 180) * 0.13, 0.011));
  sh.push([uni(tor(cx, yf + 0.07, cz, 0.13, 0.016, 'y'), ...spokes, cyl(cx, cz, yf, yf + 0.085, 0.032, 0.006, 'y')), shiny('#c9302a', 0.4)]);
  const hx = hl ? DX0 - 0.02 : DX1 + 0.02;
  sh.push([uni(cyl(hx, yf, 0.3, 0.52, 0.03), cyl(hx, yf, 1.3, 1.52, 0.03)), K.dsteel]);
  hang(m, open, hl, sh);
  return m;
}, open ? '_open' : '_closed');
// Iris door: round opening closed by overlapping blades.
for (const open of [false, true]) wallPiece('DOORS', 'door-iris', `Iris door (${open ? 'open' : 'closed'})`, (side) => {
  const cx = 0.5, cz = 1.0, R = 0.44, port = cyl(cx, cz, -0.1, T + 0.1, R, 0, 'y');
  const m = piece(side, 1, port);
  m.add(cut(cyl(cx, cz, 0.004, T + 0.03, R + 0.06, 0.012, 'y'), port), (x, y, z) => { const a = Math.atan2(z - cz, x - cx); return mod(a * 12 / Math.PI, 2) < 0.16 ? H('#59606a') : H('#8d969e'); });
  m.add(cyl(cx, cz, 0, 0.012, R + 0.02, 0, 'y'), voidM());
  const rIn = open ? R - 0.06 : 0.012;
  m.add(cut(cyl(cx, cz, T - 0.06, T - 0.03, R + 0.005, 0.002, 'y'), cyl(cx, cz, -0.1, T + 0.1, rIn, 0, 'y')), {
    gloss: 0.35, c: (x, y, z) => {
      const dx = x - cx, dz = z - cz, r = Math.hypot(dx, dz), a = Math.atan2(dz, dx) + (open ? 0.2 : r * 2.6);
      const f = mod(a * 4 / Math.PI, 1);                              // 8 blades, edges spiral inwards
      return mul(H('#aab2ba'), f < 0.06 ? 0.55 : 0.82 + f * 0.22);
    },
  });
  for (let k = 0; k < 8; k++) { const a = (k + 0.5) * Math.PI / 4; m.add(cyl(cx + Math.cos(a) * (R + 0.03), cz + Math.sin(a) * (R + 0.03), T + 0.02, T + 0.04, 0.014, 0.004, 'y'), K.dsteel); }
  m.b(0.9, 0.96, T, T + 0.02, 1.0, 1.16, K.charcoal, 0.008);
  m.add(cyl(0.93, 1.11, T + 0.015, T + 0.027, 0.014, 0.003, 'y'), gl(open ? '#58d68d' : '#ff5f5f'));
  return m;
}, open ? '_open' : '_closed');

// ================================================================ windows
function skyM(night, moon) {
  const D = hex(DAY), N = hex(NIGHT);
  return (x, y, z) => {
    let c;
    if (night) {
      c = mix(H('#0c2c63'), N, sstep(0.2, 1.7, z));
      const gx = Math.floor(mod(x, 1) * 56), gz = Math.floor(z * 56), h = hash(gx, gz, 91);
      if (h > 0.985 && Math.hypot(mod(x, 1) * 56 - gx - 0.5, z * 56 - gz - 0.5) < 0.42) c = mix(c, [255, 250, 225], 0.55 + (h - 0.985) * 30);
      if (moon && Math.hypot(x - moon[0], z - moon[1]) < 0.12 && Math.hypot(x - moon[0] - 0.05, z - moon[1] - 0.03) > 0.11) c = [250, 244, 214];
    } else {
      c = mix(H('#cfeefa'), D, sstep(0.1, 1.5, z));
      const n = pnoise(x, z * 2.2, 2, 93) * 0.55 + pnoise(x, z * 2.2, 5, 94) * 0.3 + pnoise(x, z * 2.2, 11, 95) * 0.15;
      c = mix(c, [255, 255, 255], sstep(0.55, 0.78, n) * 0.9);
    }
    const s = mod(x * 1.3 + z * 0.65, 1);                           // glare streaks on the glass
    return { c: s > 0.3 && s < 0.37 || s > 0.42 && s < 0.44 ? mix(c, [255, 255, 255], night ? 0.07 : 0.2) : c, glow: 1 };
  };
}
const WFR = '#eceef0';
// Window from an opening shape: lined frame, sky pane set back in the wall, optional extras.
function windowPiece(side, X, open, night, opts = {}) {
  const m = piece(side, X, open), xa = m.xa, xb = m.xb;
  const liner = cut(clip(grow(open, 0.04), 'y', 0.004, T + 0.022), open);
  m.add(opts.full ? clip(liner, 'x', xa, xb) : liner, WFR);
  m.add(clip(open, 'y', 0.025, 0.035), skyM(night, opts.moon));
  opts.extra?.(m, xa, xb);
  return m;
}
const bar = (m, x0, x1, z0, z1) => m.b(x0, x1, 0.03, 0.06, z0, z1, WFR, 0.004);
const WINDOWS = {
  full: { label: 'Full window', X: 1, make: (side, night) => { const [a, b] = wallExt(side); return windowPiece(side, 1, box(a - 0.1, b + 0.1, -0.1, T + 0.1, 0.1, 2.38, 0), night, { full: true, extra: (m) => bar(m, 0, 0.03, 0.1, 2.38) }); } },
  half: { label: 'Half window', X: 1, make: (side, night) => windowPiece(side, 1, box(0.13, 0.87, -0.1, T + 0.1, 1.0, 2.0, 0), night, { extra: (m) => m.b(0.07, 0.93, T - 0.01, T + 0.06, 0.93, 0.965, WFR, 0.012) }) },
  grid: {
    label: 'Window with white grid supports', X: 1,
    make: (side, night) => windowPiece(side, 1, box(0.13, 0.87, -0.1, T + 0.1, 0.7, 2.1, 0), night, {
      extra: (m) => { for (const x of [0.377, 0.623]) bar(m, x - 0.012, x + 0.012, 0.7, 2.1); for (const z of [1.05, 1.4, 1.75]) bar(m, 0.13, 0.87, z - 0.012, z + 0.012); },
    }),
  },
  arch: {
    label: 'Window with top arch', X: 1,
    make: (side, night) => windowPiece(side, 1, uni(box(0.2, 0.8, -0.1, T + 0.1, 0.7, 1.75, 0), cyl(0.5, 1.75, -0.1, T + 0.1, 0.3, 0, 'y')), night, {
      extra: (m) => { bar(m, 0.488, 0.512, 0.7, 2.05); bar(m, 0.2, 0.8, 1.738, 1.762); m.b(0.14, 0.86, T - 0.01, T + 0.06, 0.63, 0.665, WFR, 0.012); },
    }),
  },
  circle: { label: 'Circle window', X: 1, make: (side, night) => windowPiece(side, 1, cyl(0.5, 1.45, -0.1, T + 0.1, 0.36, 0, 'y'), night) },
  'circle-big': {
    label: 'Big circle window', X: 2,
    make: (side, night) => windowPiece(side, 2, cyl(1, 1.3, -0.1, T + 0.1, 0.86, 0, 'y'), night, { moon: [1.42, 1.72], extra: (m) => { bar(m, 0.986, 1.014, 0.44, 2.16); bar(m, 0.14, 1.86, 1.286, 1.314); } }),
  },
};
for (const [k, w] of Object.entries(WINDOWS)) for (const night of [false, true]) {
  wallPiece('WINDOWS', `window-${k}`, `${w.label} (${night ? 'night' : 'day'})`, (side) => w.make(side, night), night ? '_night' : '_day', w.X);
}

// ================================================================ office elements (props)
// Models are in tile units, front = +y, origin at the footprint's back corner.
const F = 'FURNITURE', ALL = 'sw se ne nw', D = DESK;
const office = (name, label, X, Y, dirs, build, extra) => prop(F, name, label, X, Y, dirs, build, extra);
const leg = (m, x, y, z1, c, r = 0.025, z0 = 0) => m.c(x, y, z0, z1, r, c);
const legs4 = (m, x0, x1, y0, y1, z1, c, r) => { for (const x of [x0, x1]) for (const y of [y0, y1]) leg(m, x, y, z1, c, r); };
// Cabinet fronts: thin dark seams on the +y face at the given x / z positions.
const fronts = (base, xs = [], zs = []) => { const A = rgb(base), S = mul(A, 0.62); return (x, y, z, nx, ny) => (ny > 0.5 && (xs.some((s) => Math.abs(x - s) < 0.006) || zs.some((s) => Math.abs(z - s) < 0.006)) ? S : A); };
const lightPool = (c, r = 0.55, a = 0.3) => (x, y) => { const d = ((x - 0.5) ** 2 + (y - 0.5) ** 2) / (r * r); return d > 2.5 ? null : [...rgb(c), a * Math.exp(-d * 1.6)]; };
// A flat screen standing on the +y side of a thin box (monitor, TV).
const monitor = (m, x0, x1, y, z0, z1, content, deg = 0, px = 0) => {
  const s = box(x0, x1, y, y + 0.03, z0, z1, 0.012);
  m.add(deg ? rot(s, 'z', deg, px, y) : s, screenM(x0 + 0.015, x1 - 0.015, z0 + 0.015, z1 - 0.015, content));
};

office('lamp-floor', 'Floor lamp', 1, 1, 'flat', (m) => {
  m.c(0.5, 0.5, 0, 0.03, 0.17, DARK, 0.012); m.c(0.5, 0.5, 0.03, 1.4, 0.016, CHROME);
  m.s(0.5, 0.5, 1.46, 0.06, gl('#fff6d8'));
  m.add(cut(cone(0.5, 0.5, 1.36, 1.68, 0.21, 0.13), cone(0.5, 0.5, 1.34, 1.66, 0.195, 0.115)), gl('#f3e2bd', 0.6));
});
office('lamp-desk', 'Desk lamp', 1, 1, ALL, (m) => {
  const G = shiny('#2f7d5b', 0.5);
  m.c(0.5, 0.36, D, D + 0.022, 0.1, G, 0.01);
  m.k(0.5, 0.36, D + 0.02, 0.5, 0.26, D + 0.32, 0.012, CHROME); m.k(0.5, 0.26, D + 0.32, 0.5, 0.56, D + 0.46, 0.012, CHROME);
  m.s(0.5, 0.26, D + 0.32, 0.02, G);
  m.add(rot(cut(cone(0.5, 0.6, D + 0.36, D + 0.48, 0.1, 0.035), cone(0.5, 0.6, D + 0.35, D + 0.465, 0.088, 0.02)), 'x', 20, 0, 0.6, D + 0.46), G);
  m.s(0.5, 0.62, D + 0.39, 0.035, gl('#fff3cf'));
}, { on_desk: true });
office('lamp-ceiling', 'Ceiling lamp', 1, 1, 'flat', (m) => {
  m.ground = lightPool('#fff0c8', 0.5, 0.26);
  m.c(0.5, 0.5, 2.44, 2.5, 0.06, K.white); m.k(0.5, 0.5, 2.46, 0.5, 0.5, 2.16, 0.007, K.black);
  m.add(cut(sph(0.5, 0.5, 2.0, 0.24), sph(0.5, 0.5, 1.99, 0.225), box(0, 1, 0, 1, 1.6, 2.0, 0)), shiny('#f4f4f2', 0.3));
  m.s(0.5, 0.5, 2.03, 0.08, gl('#fff3cf'));
});
office('desk-gamer', 'Gamer desk', 2, 1, ALL, (m) => {
  const CB = (x, y, z) => mul(H('#26282d'), 0.92 + 0.1 * ((Math.floor(x * 60) + Math.floor(y * 60)) & 1));
  m.b(0.05, 1.95, 0.1, 0.9, 0.71, 0.75, { c: CB, gloss: 0.25 }, 0.02);
  const rgbStrip = (x) => { const t = mod(x * 0.9, 1) * 3, i = Math.floor(t), f = t - i, C = [H('#ff3d6e'), H('#7a5cff'), H('#2de2e6'), H('#ff3d6e')]; return { c: mix(C[i], C[i + 1], f), glow: 1 }; };
  m.b(0.07, 1.93, 0.882, 0.9, 0.692, 0.708, rgbStrip, 0.004); m.b(0.07, 1.93, 0.1, 0.118, 0.692, 0.708, rgbStrip, 0.004);
  for (const x of [0.14, 1.86]) {
    m.b(x - 0.04, x + 0.04, 0.14, 0.86, 0, 0.045, DARK, 0.016); m.b(x - 0.035, x + 0.035, 0.4, 0.6, 0.04, 0.71, DARK, 0.014);
    m.b(x - 0.042, x + 0.042, 0.43, 0.57, 0.3, 0.42, shiny('#d92b3a', 0.3), 0.01);
  }
  m.b(0.18, 1.82, 0.47, 0.53, 0.5, 0.6, DARK, 0.012);
  m.b(1.38, 1.7, 0.2, 0.8, 0.05, 0.6, (x, y, z, nx, ny) => { const r = Math.hypot(x - 1.54, z - 0.2), r2 = Math.hypot(x - 1.54, z - 0.44); return ny > 0.5 && (Math.abs(r - 0.08) < 0.018 || Math.abs(r2 - 0.08) < 0.018) ? { c: H('#2de2e6'), glow: 1 } : { c: H('#1b1c20'), gloss: 0.4 }; }, 0.016);
  m.b(0.5, 1.5, 0.42, 0.86, 0.75, 0.757, (x, y) => (x < 0.515 || x > 1.485 || y < 0.435 || y > 0.845 ? H('#d92b3a') : H('#17181c')), 0.003);
  m.c(0.2, 0.76, 0.75, 0.87, 0.04, shiny('#d92b3a', 0.5), 0.012);
});
office('desk-wood', 'Wood desk', 2, 1, ALL, (m) => {
  const W = woodM(K.woodL, 'x', 21), Wd = woodM(K.wood, 'x', 22);
  m.b(0.06, 1.94, 0.1, 0.9, 0.705, 0.75, W, 0.016);
  legs4(m, 0.13, 1.87, 0.17, 0.83, 0.71, K.woodD, 0.03);
  m.b(1.36, 1.84, 0.16, 0.84, 0.14, 0.7, (x, y, z, nx, ny) => (ny > 0.5 && [0.33, 0.52].some((s) => Math.abs(z - s) < 0.006) ? H('#5a3a22') : Wd(x, y, z)), 0.012);
  for (const z of [0.235, 0.425, 0.61]) m.k(1.54, 0.85, z, 1.66, 0.85, z, 0.01, CHROME);
  m.b(0.16, 1.36, 0.14, 0.17, 0.36, 0.7, Wd, 0.008);
});
office('desk-boss', 'Big boss desk', 3, 2, ALL, (m) => {
  const W = woodM('#5c3a24', 'x', 31), B = shiny(K.brass, 0.6);
  m.b(0.16, 2.84, 0.46, 1.64, 0.72, 0.79, { c: woodM('#6b4329', 'x', 30), gloss: 0.35 }, 0.03);
  for (const x0 of [0.24, 2.06]) {
    m.b(x0, x0 + 0.7, 0.54, 1.56, 0.02, 0.72, fronts2(W, [0.26, 0.5]), 0.016);
    for (const z of [0.14, 0.38, 0.61]) m.k(x0 + 0.28, 1.57, z, x0 + 0.42, 1.57, z, 0.011, B);
  }
  m.b(0.94, 2.06, 0.54, 0.6, 0.12, 0.72, W, 0.01);
  m.b(1.1, 1.9, 1.08, 1.54, 0.79, 0.797, '#2c4a37', 0.004);
  m.c(0.52, 0.86, 0.79, 0.81, 0.085, B, 0.008); m.k(0.52, 0.86, 0.8, 0.52, 0.86, 1.0, 0.012, B);
  m.add(cut(ell(0.52, 0.92, 1.04, 0.17, 0.085, 0.06), box(0, 1, 0, 2, 0.9, 1.02, 0)), shiny('#1f7a4d', 0.6));
  m.b(0.4, 0.64, 0.9, 0.95, 1.012, 1.022, gl('#fff3cf'), 0.004);
  m.b(1.28, 1.72, 0.52, 0.56, 0.79, 0.86, B, 0.008);
  m.c(2.5, 0.8, 0.79, 0.9, 0.04, K.black, 0.008);
  for (const [dx, c] of [[-0.012, K.yellow], [0.01, K.red], [0, K.blue]]) m.k(2.5 + dx, 0.8 + dx, 0.88, 2.5 + dx * 3, 0.8 - dx * 2, 0.99, 0.006, c);
});
function fronts2(W, zs) { return (x, y, z, nx, ny) => (ny > 0.5 && zs.some((s) => Math.abs(z - s) < 0.006) ? H('#2e1c11') : W(x, y, z)); }
office('cabin-soundproof', 'Sound proof cabin', 1, 1, ALL, (m) => {
  const felt = fuzz('#56657a', 0.08, 50), W = H('#e7e8ea');
  const inside = (x, y, z) => x > 0.11 && x < 0.89 && y > 0.11 && z > 0.07 && z < 2.1;
  m.add(cut(box(0.05, 0.95, 0.05, 0.95, 0, 2.2, 0.05), box(0.12, 0.88, 0.12, 1.2, 0.08, 2.09, 0.02)), (x, y, z) => (inside(x, y, z) ? (z < 0.1 ? H('#3d4450') : felt(x, y, z)) : W));
  m.b(0.3, 0.7, 0.3, 0.7, 2.07, 2.09, gl('#fff6dc'), 0.004);
  m.b(0.12, 0.88, 0.12, 0.36, 0.98, 1.02, woodM(K.woodL, 'x', 3), 0.008);
  m.c(0.5, 0.56, 0.08, 0.5, 0.025, CHROME); m.c(0.5, 0.56, 0.5, 0.56, 0.15, fuzz('#e8862e', 0.08, 50), 0.025);
  m.b(0.13, 0.87, 0.915, 0.93, 0.08, 2.09, glassM('#c9ecf7', 0.3), 0.003);
  m.k(0.76, 0.945, 0.9, 0.76, 0.945, 1.25, 0.012, CHROME);
  m.b(0.3, 0.7, 0.3, 0.7, 2.2, 2.23, K.lgray, 0.01);
});
office('cubicle-panel', 'Cubicle wall', 1, 1, 'ne nw', (m) => {
  m.add(clip(box(-0.2, 1.2, 0.01, 0.07, 0.04, 1.4, 0.012), 'x', 0, 1), fuzz('#7f93a8', 0.07, 70));
  m.add(clip(box(-0.2, 1.2, 0, 0.08, 1.38, 1.43, 0.012), 'x', 0, 1), METAL);
  m.add(clip(box(-0.2, 1.2, 0, 0.08, 0, 0.06, 0.008), 'x', 0, 1), K.charcoal);
  m.b(0.47, 0.53, 0, 0.08, 0.06, 1.38, METAL, 0.006);
}, { edge: true });
office('monitor-multi-arm', 'Multi monitor with arm holders', 2, 1, ALL, (m) => {
  m.b(0.94, 1.06, 0.1, 0.2, D, D + 0.03, DARK, 0.008); m.c(1, 0.16, D, D + 0.5, 0.02, DARK);
  for (const [x, zz] of [[0.42, 0.42], [1, 0.4], [1.58, 0.42]]) m.k(1, 0.16, D + zz, x, 0.28, D + 0.4, 0.014, DARK);
  monitor(m, 0.68, 1.32, 0.3, D + 0.2, D + 0.6, codeScreen);
  monitor(m, 0.04, 0.66, 0.3, D + 0.2, D + 0.6, dashScreen(true), -22, 0.66);
  monitor(m, 1.34, 1.96, 0.3, D + 0.2, D + 0.6, dashScreen(false), 22, 1.34);
}, { on_desk: true });
office('monitor-large', 'Big large monitor', 1, 1, ALL, (m) => {
  m.b(0.34, 0.66, 0.2, 0.42, D, D + 0.016, METAL, 0.008); m.k(0.5, 0.3, D + 0.01, 0.5, 0.3, D + 0.3, 0.018, METAL);
  monitor(m, 0.02, 0.98, 0.32, D + 0.14, D + 0.58, codeScreen);
}, { on_desk: true });
const keysM = (base, key, x0, y0, n = 26) => { const A = H(base), Kc = H(key); return (x, y, z, nx, ny, nz) => (nz > 0.5 && mod((x - x0) * n, 1) > 0.22 && mod((y - y0) * n, 1) > 0.22 ? Kc : A); };
office('keyboard', 'Normal keyboard', 1, 1, ALL, (m) => {
  m.b(0.16, 0.84, 0.52, 0.76, D, D + 0.022, keysM('#1d1e22', '#3a3d45', 0.16, 0.52), 0.006);
}, { on_desk: true });
office('keyboard-ergonomic', 'Ergonomic keyboard', 1, 1, ALL, (m) => {
  const KM = keysM('#e3e5e8', '#b9bec6', 0, 0);
  m.add(rot(rot(box(0.12, 0.47, 0.5, 0.74, D, D + 0.024, 0.008), 'y', -7, 0.47, 0, D), 'z', 12, 0.47, 0.62), KM);
  m.add(rot(rot(box(0.53, 0.88, 0.5, 0.74, D, D + 0.024, 0.008), 'y', 7, 0.53, 0, D), 'z', -12, 0.53, 0.62), KM);
  m.add(blob(0.04, ell(0.3, 0.84, D + 0.006, 0.16, 0.06, 0.014), ell(0.7, 0.84, D + 0.006, 0.16, 0.06, 0.014)), K.charcoal);
}, { on_desk: true });
office('mouse-pad', 'Mouse pad and mouse', 1, 1, ALL, (m) => {
  m.b(0.2, 0.8, 0.38, 0.84, D, D + 0.006, '#1f2126', 0.003);
  m.e(0.54, 0.62, D + 0.02, 0.04, 0.062, 0.022, shiny('#e9eaec', 0.4)); m.b(0.537, 0.543, 0.635, 0.665, D + 0.036, D + 0.044, K.gray, 0.002);
}, { on_desk: true });
const potM = (m, r0, r1, h, c) => { m.n(0.5, 0.5, 0, h, r0, r1, c); m.c(0.5, 0.5, h - 0.03, h + 0.004, r1 - 0.015, K.soil, 0.004); };
office('plant-cactus', 'Cactus plant', 1, 1, 'flat', (m) => {
  potM(m, 0.13, 0.18, 0.3, K.pot);
  const ribs = (x, y, z) => mul(H('#4f9e52'), 0.86 + 0.16 * Math.cos(Math.atan2(y - 0.5, x - 0.5) * 9) ** 2);
  m.add(blob(0.04, cap(0.5, 0.5, 0.3, 0.5, 0.5, 0.92, 0.1), cap(0.5, 0.5, 0.55, 0.28, 0.5, 0.58, 0.055), cap(0.28, 0.5, 0.58, 0.28, 0.5, 0.78, 0.055), cap(0.5, 0.5, 0.68, 0.7, 0.5, 0.7, 0.05), cap(0.7, 0.5, 0.7, 0.7, 0.5, 0.86, 0.05)), ribs);
  m.s(0.5, 0.5, 1.03, 0.035, K.pink); m.s(0.28, 0.5, 0.84, 0.025, K.pink); m.s(0.7, 0.5, 0.915, 0.022, '#ffd36b');
});
office('plant', 'Normal plant', 1, 1, 'flat', (m) => {
  potM(m, 0.14, 0.19, 0.32, K.white);
  const G = (x, y, z) => mul(mix(H('#3f8f47'), H('#6dbb5c'), noise3(x * 9, y * 9, z * 9, 2)), 1);
  const leaves = [];
  for (let k = 0; k < 9; k++) { const a = k * 40 + (k % 2) * 13, t = k % 2 ? -52 : -30, l = k % 2 ? 0.2 : 0.26; leaves.push(rot(rot(ell(0.5 + l, 0.5, 0.36, l, 0.085, 0.016), 'y', t, 0.5, 0.5, 0.36), 'z', a, 0.5, 0.5)); }
  m.add(uni(...leaves), G);
  m.add(rot(ell(0.5, 0.5, 0.62, 0.07, 0.03, 0.2), 'z', 30, 0.5, 0.5), G);
});
office('plant-tree', 'Indoor tree', 1, 1, 'flat', (m) => {
  potM(m, 0.17, 0.23, 0.4, shiny('#e9eaec', 0.3));
  m.k(0.5, 0.5, 0.38, 0.52, 0.48, 0.9, 0.035, K.woodD); m.k(0.52, 0.48, 0.9, 0.48, 0.52, 1.4, 0.03, K.woodD);
  m.k(0.5, 0.5, 1.0, 0.66, 0.44, 1.3, 0.018, K.woodD); m.k(0.5, 0.5, 1.1, 0.36, 0.58, 1.38, 0.018, K.woodD);
  const G = (x, y, z) => mul(mix(H('#2f7a3d'), H('#62b257'), noise3(x * 14, y * 14, z * 14, 5) * 0.8 + (z - 1.2) * 0.25), 1);
  m.add(blob(0.1, sph(0.5, 0.5, 1.62, 0.3), sph(0.7, 0.42, 1.42, 0.2), sph(0.3, 0.6, 1.5, 0.21), sph(0.42, 0.34, 1.52, 0.19), sph(0.62, 0.66, 1.56, 0.2), sph(0.5, 0.5, 1.9, 0.2)), G);
});
office('water-fountain', 'Water fountain', 1, 1, ALL, (m) => {
  m.b(0.3, 0.7, 0.28, 0.7, 0, 1.0, (x, y, z, nx, ny) => (ny > 0.5 && x > 0.36 && x < 0.64 && z > 0.56 && z < 0.86 ? H('#3a3d44') : H('#e7e8ea')), 0.04);
  m.c(0.5, 0.49, 1.0, 1.05, 0.09, K.lgray); m.c(0.5, 0.49, 1.05, 1.42, 0.16, { c: '#6fc3ec', a: 0.6, gloss: 0.7 }, 0.05);
  m.c(0.5, 0.49, 1.4, 1.44, 0.07, '#4aa3d6', 0.012);
  m.b(0.41, 0.46, 0.7, 0.74, 0.78, 0.82, K.blue, 0.008); m.b(0.54, 0.59, 0.7, 0.74, 0.78, 0.82, K.red, 0.008);
  m.b(0.37, 0.63, 0.7, 0.78, 0.55, 0.575, K.lgray, 0.008);
  m.c(0.5, 0.74, 0.575, 0.65, 0.025, K.white, 0.004);
});
const cup = (m, x, y, z, c = K.white) => m.add(cut(cone(x, y, z, z + 0.07, 0.022, 0.03), cone(x, y, z + 0.012, z + 0.09, 0.016, 0.026)), c);
office('coffee-machine', 'Coffee machine', 1, 1, ALL, (m) => {
  m.b(0.1, 0.9, 0.18, 0.84, 0.04, 0.84, fronts(woodM(K.woodL, 'z', 5)(0.3, 0.3, 0.3), [0.5], [0.66]), 0.014);
  m.b(0.07, 0.93, 0.15, 0.87, 0.84, 0.88, shiny('#2a2c31', 0.4), 0.012);
  m.k(0.3, 0.85, 0.74, 0.42, 0.85, 0.74, 0.008, CHROME); m.k(0.58, 0.85, 0.74, 0.7, 0.85, 0.74, 0.008, CHROME);
  m.b(0.22, 0.72, 0.24, 0.58, 0.88, 1.3, shiny('#b9c0c7', 0.6), 0.03);
  m.b(0.22, 0.72, 0.5, 0.74, 0.88, 0.93, K.charcoal, 0.01);
  m.b(0.24, 0.7, 0.5, 0.7, 1.16, 1.3, shiny('#2a2c31', 0.4), 0.02);
  for (const x of [0.36, 0.58]) { m.c(x, 0.64, 1.08, 1.16, 0.035, K.charcoal, 0.006); cup(m, x, 0.64, 0.93); }
  m.c(0.47, 0.41, 1.3, 1.46, 0.1, { c: '#6b4a34', a: 0.75, gloss: 0.6 }, 0.02); m.c(0.47, 0.41, 1.45, 1.48, 0.105, K.black, 0.008);
  m.add(cyl(0.3, 1.23, 0.69, 0.705, 0.014, 0.003, 'y'), gl('#ff5f5f')); m.add(cyl(0.64, 1.23, 0.69, 0.705, 0.014, 0.003, 'y'), gl('#58d68d'));
  for (const [x, y] of [[0.8, 0.3], [0.82, 0.42]]) cup(m, x, y, 0.88); cup(m, 0.81, 0.36, 0.95);
});
const bottle = (m, x, y, z, c, h = 0.24, r = 0.032) => { m.c(x, y, z, z + h * 0.62, r, { c, gloss: 0.7 }, 0.012); m.n(x, y, z + h * 0.6, z + h * 0.78, r, r * 0.38, { c, gloss: 0.7 }); m.c(x, y, z + h * 0.76, z + h, r * 0.38, { c, gloss: 0.7 }, 0.004); };
office('juice-bar', 'Juice bar', 2, 1, ALL, (m) => {
  const ST = ['#f08a2e', '#f6f1e4', '#7cc46a', '#f6f1e4', '#f1c232', '#f6f1e4'].map(H);
  m.b(0.06, 1.94, 0.3, 0.86, 0, 1.0, (x, y, z, nx, ny) => (Math.abs(ny) > 0.5 && z > 0.08 ? ST[Math.floor(mod(x * 9, 6))] : H('#f1ece0')), 0.02);
  m.b(0.02, 1.98, 0.25, 0.92, 1.0, 1.05, woodM(K.woodL, 'x', 41), 0.02);
  for (const [x, c] of [[0.34, '#f79a2e'], [0.66, '#8fd15a']]) {
    m.b(x - 0.12, x + 0.12, 0.42, 0.68, 1.05, 1.13, shiny('#d7dade', 0.5), 0.016);
    m.b(x - 0.105, x + 0.105, 0.44, 0.66, 1.13, 1.48, { c, a: 0.72, gloss: 0.7 }, 0.02);
    m.b(x - 0.115, x + 0.115, 0.43, 0.67, 1.48, 1.52, K.charcoal, 0.012); m.b(x - 0.015, x + 0.015, 0.68, 0.72, 1.12, 1.17, K.charcoal, 0.006);
  }
  m.n(1.08, 0.56, 1.05, 1.15, 0.085, 0.07, K.charcoal); m.n(1.08, 0.56, 1.15, 1.42, 0.05, 0.085, glassM('#f7b5d0', 0.6)); m.c(1.08, 0.56, 1.42, 1.45, 0.088, K.charcoal, 0.008);
  m.add(cut(sph(1.6, 0.56, 1.17, 0.17), sph(1.6, 0.56, 1.19, 0.155), box(1.3, 1.9, 0.3, 0.9, 1.17, 1.5, 0)), shiny('#e9eaec', 0.4));
  for (const [dx, dy, dz, c] of [[-0.06, 0, 0.02, K.orange], [0.05, 0.04, 0.02, K.orange], [0, -0.06, 0.03, '#d43d3a'], [0.01, 0.01, 0.09, K.orange], [-0.08, 0.07, 0.04, '#9ccc3c']]) m.s(1.6 + dx, 0.56 + dy, 1.14 + dz, 0.05, c);
  for (let k = 0; k < 4; k++) m.n(1.34, 0.8, 1.05 + k * 0.02, 1.13 + k * 0.02, 0.026, 0.036, k % 2 ? '#f6f1e4' : '#f08a2e');
});
office('drinks-bar', 'Drinks bar', 2, 1, ALL, (m) => {
  const W = woodM('#5c3a24', 'z', 51), B = shiny(K.brass, 0.6);
  m.b(0.06, 1.94, 0.52, 0.9, 0, 1.05, (x, y, z, nx, ny) => (Math.abs(ny) > 0.5 && (mod(x - 0.06, 0.47) < 0.012 || Math.abs(z - 0.16) < 0.006 || Math.abs(z - 0.95) < 0.006) ? H('#2e1c11') : W(x, y, z)), 0.016);
  m.b(0.02, 1.98, 0.46, 0.97, 1.05, 1.1, shiny('#1f2024', 0.6), 0.02);
  m.k(0.1, 0.96, 0.17, 1.9, 0.96, 0.17, 0.016, B); for (const x of [0.2, 1, 1.8]) m.k(x, 0.9, 0.17, x, 0.96, 0.17, 0.012, B);
  m.add(cut(box(0.06, 1.94, 0.04, 0.3, 0, 1.95, 0.016), box(0.1, 1.9, 0.08, 0.5, 1.12, 1.48, 0.008), box(0.1, 1.9, 0.08, 0.5, 1.52, 1.9, 0.008)), woodM('#4a2e1b', 'x', 52));
  const BC = ['#2f6b37', '#7a4a24', '#c9d6dc', '#27598c', '#a8322c', '#d9a441'];
  for (let k = 0; k < 9; k++) { bottle(m, 0.2 + k * 0.2, 0.19, 1.12, BC[k % 6], 0.26 + hash(k, 1, 3) * 0.06); bottle(m, 0.2 + k * 0.2, 0.19, 1.52, BC[(k + 3) % 6], 0.24 + hash(k, 2, 3) * 0.08); }
  m.b(1.44, 1.56, 0.62, 0.74, 1.1, 1.14, B, 0.01); m.c(1.5, 0.68, 1.14, 1.42, 0.03, B); m.b(1.4, 1.6, 0.655, 0.705, 1.4, 1.46, B, 0.016);
  for (const x of [1.44, 1.56]) { m.k(x, 0.71, 1.42, x, 0.78, 1.38, 0.009, B); m.k(x, 0.73, 1.46, x, 0.73, 1.56, 0.011, K.black); }
  for (const [x, y] of [[0.4, 0.7], [0.56, 0.76], [0.72, 0.68]]) m.n(x, y, 1.1, 1.22, 0.025, 0.036, glassM('#f3c56b', 0.7));
  bottle(m, 1.1, 0.7, 1.1, BC[0], 0.3);
});
const controller = (m, x, y, z, c = '#e9eaec') => {
  m.add(blob(0.035, ell(x - 0.06, y, z + 0.022, 0.045, 0.04, 0.022), ell(x + 0.06, y, z + 0.022, 0.045, 0.04, 0.022), ell(x - 0.085, y + 0.045, z + 0.016, 0.028, 0.045, 0.02), ell(x + 0.085, y + 0.045, z + 0.016, 0.028, 0.045, 0.02)), shiny(c, 0.3));
  m.s(x - 0.04, y + 0.012, z + 0.044, 0.014, K.ink); m.s(x + 0.04, y + 0.012, z + 0.044, 0.014, K.ink);
};
office('coffee-table-controller', 'Small coffee table with game controller', 1, 1, ALL, (m) => {
  m.c(0.5, 0.5, 0.37, 0.41, 0.38, woodM(K.woodL, 'x', 61), 0.016);
  for (const a of [90, 210, 330]) { const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180); m.k(0.5 + c * 0.2, 0.5 + s * 0.2, 0.38, 0.5 + c * 0.32, 0.5 + s * 0.32, 0.02, 0.02, K.black); }
  controller(m, 0.5, 0.6, 0.41);
  m.c(0.34, 0.36, 0.41, 0.5, 0.04, K.red, 0.008); m.t(0.385, 0.36, 0.455, 0.025, 0.007, K.red, 'y');
  m.b(0.52, 0.72, 0.28, 0.42, 0.41, 0.425, K.blue, 0.004); m.b(0.53, 0.71, 0.29, 0.41, 0.425, 0.437, K.yellow, 0.004);
});
office('game-console', 'PS5', 1, 1, ALL, (m) => {
  m.b(0.14, 0.86, 0.26, 0.78, 0, 0.3, shiny('#e9eaec', 0.3), 0.03); m.b(0.18, 0.82, 0.76, 0.785, 0.06, 0.24, K.charcoal, 0.004);
  m.b(0.42, 0.54, 0.34, 0.68, 0.3, 0.98, shiny('#17181c', 0.6), 0.016);
  for (const [x0, d] of [[0.365, -4], [0.54, 4]]) m.add(rot(box(x0, x0 + 0.055, 0.31, 0.71, 0.3, 1.03, 0.026), 'y', d, 0.48, 0, 0.3), shiny('#f1f2f4', 0.45));
  m.b(0.425, 0.535, 0.345, 0.675, 0.975, 0.985, gl('#4f9dff'), 0.003);
  m.c(0.48, 0.51, 0.3, 0.315, 0.1, K.black, 0.004);
  controller(m, 0.72, 0.56, 0.3);
});
office('arcade-machine', 'Old arcade machine', 1, 1, ALL, (m) => {
  const side = (x, y, z, nx) => (Math.abs(nx) > 0.5 ? (mod(z * 1.4 + y * 2.2, 0.5) < 0.09 ? H('#ffcf3f') : mod(z * 1.4 + y * 2.2, 0.5) < 0.18 ? H('#e8452e') : H('#27306b')) : H('#1d2350'));
  const tx = textSegs(['ARCADE'], 0.5, 1.84, 0.1);
  m.b(0.17, 0.83, 0.16, 0.74, 0, 0.95, side, 0.02); m.b(0.17, 0.83, 0.16, 0.6, 0.9, 1.74, side, 0.02);
  m.add(rot(box(0.17, 0.83, 0.52, 0.9, 0.9, 0.99, 0.02), 'x', -8, 0, 0.6, 0.95), side);
  m.b(0.22, 0.78, 0.6, 0.63, 1.06, 1.56, (x, y, z, nx, ny) => {
    if (ny < 0.4) return H('#111216');
    const u = (x - 0.24) / 0.52, v = (1.54 - z) / 0.46, gx = Math.floor(u * 11), gy = Math.floor(v * 10);
    if (u < 0 || u > 1 || v < 0 || v > 1) return H('#111216');
    if (gy < 4 && gx > 0 && gx < 10 && (gx + gy) % 2 === 0) return { c: [H('#ff5f7a'), H('#ffd36b'), H('#58d68d'), H('#4f9dff')][gy], glow: 1 };
    if (gy === 8 && gx === 5) return { c: H('#e9f8ff'), glow: 1 };
    if (gy === 6 && gx === 5 && mod(u * 11, 1) > 0.4 && mod(u * 11, 1) < 0.6) return { c: H('#ffffff'), glow: 1 };
    return { c: H('#0d1030'), glow: 0.9 };
  }, 0.012);
  m.b(0.17, 0.83, 0.16, 0.7, 1.72, 1.96, (x, y, z, nx, ny) => (ny > 0.5 ? (segDist(tx, x, z) < 0.013 ? { c: H('#e8452e'), glow: 1 } : { c: H('#ffdf6b'), glow: 0.95 }) : side(x, y, z, nx)), 0.02);
  m.k(0.34, 0.72, 0.98, 0.34, 0.73, 1.07, 0.01, CHROME); m.s(0.34, 0.73, 1.09, 0.03, shiny(K.red, 0.6));
  for (const [x, y, c] of [[0.52, 0.7, K.yellow], [0.6, 0.74, K.blue], [0.68, 0.7, K.green]]) m.c(x, y, 0.975, 1.0, 0.022, shiny(c, 0.5), 0.006);
  m.b(0.38, 0.62, 0.735, 0.75, 0.38, 0.66, (x, y, z) => (Math.abs(x - 0.5) < 0.05 && Math.abs(z - 0.56) < 0.04 ? { c: H('#ff9b3c'), glow: 0.9 } : H('#3a3d44')), 0.006);
});
office('boxing-machine', 'Old boxing machine', 1, 1, ALL, (m) => {
  const R = shiny('#c4302a', 0.3), tx = textSegs(['999'], 0.5, 1.52, 0.1);
  m.b(0.22, 0.78, 0.14, 0.56, 0, 1.95, (x, y, z, nx, ny) => {
    if (ny > 0.5 && x > 0.3 && x < 0.7 && z > 1.4 && z < 1.64) return segDist(tx, x, z) < 0.013 ? { c: H('#ff4a3a'), glow: 1 } : { c: H('#190c0c'), glow: 0.5 };
    if (z < 0.2) return mod(x + y + z, 0.14) < 0.07 ? H('#f1c232') : H('#25272c');
    return ny > 0.5 && Math.abs(x - 0.5) < 0.012 && z > 0.3 && z < 1.3 ? H('#f1c232') : H('#c4302a');
  }, 0.03);
  m.b(0.22, 0.78, 0.14, 0.9, 1.72, 1.95, R, 0.04);
  m.k(0.5, 0.74, 1.72, 0.5, 0.74, 1.52, 0.012, CHROME);
  m.e(0.5, 0.74, 1.34, 0.13, 0.13, 0.2, shiny('#5a2a1c', 0.45));
  m.b(0.6, 0.72, 0.56, 0.58, 0.8, 1.0, K.charcoal, 0.006); m.b(0.64, 0.68, 0.575, 0.585, 0.88, 0.96, gl('#ffd36b', 0.8), 0.003);
  m.b(0.16, 0.84, 0.1, 0.94, 0, 0.05, K.charcoal, 0.016);
});
office('ping-pong-table', 'Ping-pong table', 3, 2, 'sw se', (m) => {
  m.b(0.13, 2.87, 0.24, 1.76, 0.72, 0.76, (x, y, z, nx, ny, nz) => (nz > 0.5 && (x < 0.16 || x > 2.84 || y < 0.27 || y > 1.73 || Math.abs(y - 1) < 0.008) ? H('#f2f4f6') : H('#1f6fb2')), 0.01);
  m.b(1.492, 1.508, 0.16, 1.84, 0.76, 0.92, { c: (x, y, z) => (z > 0.9 ? H('#f2f4f6') : mod(y * 40, 1) < 0.5 === mod(z * 40, 1) < 0.5 ? H('#2a2c31') : H('#5a5e66')), a: 0.85 }, 0.002);
  for (const y of [0.17, 1.83]) m.c(1.5, y, 0.7, 0.93, 0.014, K.black);
  for (const x of [0.55, 2.45]) { for (const y of [0.42, 1.58]) m.k(x, y, 0.72, x, y, 0.03, 0.025, METAL); m.k(x, 0.42, 0.25, x, 1.58, 0.25, 0.018, METAL); }
  m.c(0.6, 0.6, 0.76, 0.775, 0.085, shiny('#c8372f', 0.3), 0.006); m.k(0.6, 0.69, 0.768, 0.6, 0.79, 0.768, 0.014, K.woodL);
  m.c(2.35, 1.4, 0.76, 0.775, 0.085, shiny('#25272c', 0.3), 0.006); m.k(2.35, 1.31, 0.768, 2.35, 1.21, 0.768, 0.014, K.woodL);
  m.s(0.82, 0.74, 0.782, 0.022, '#ffa23c');
});
office('container-office', 'Container office', 3, 3, ALL, (m) => {
  const TEAL = H('#2c8a94'), inside = (x, y, z) => x > 0.2 && x < 2.8 && y > 0.5 && y < 2.62 && z > 0.12 && z < 2.34;
  const body = (x, y, z, nx, ny) => {
    if (inside(x, y, z)) return z < 0.16 ? { c: H('#b98f5e'), glow: 0.35 } : { c: H('#f1ead8'), glow: 0.45 };
    const u = Math.abs(nx) > 0.5 ? y : x;
    return mul(TEAL, Math.abs(nx) > 0.5 || Math.abs(ny) > 0.5 ? (mod(u * 12, 1) < 0.5 ? 1.05 : 0.86) : 1);
  };
  m.add(cut(box(0.1, 2.9, 0.4, 2.7, 0, 2.45, 0.02), box(0.2, 2.8, 0.5, 2.62, 0.14, 2.34, 0.01), box(1.0, 2.66, 2.5, 2.8, 0.3, 2.1, 0.01)), body);
  m.b(1.0, 2.66, 2.63, 2.65, 0.3, 2.1, glassM('#bfe6f5', 0.3), 0.002);
  for (const x of [1.0, 1.83, 2.66]) m.b(x - 0.02, x + 0.02, 2.62, 2.7, 0.28, 2.12, K.black, 0.006);
  m.b(0.98, 2.68, 2.62, 2.7, 0.27, 0.31, K.black, 0.006); m.b(0.98, 2.68, 2.62, 2.7, 2.09, 2.13, K.black, 0.006);
  m.b(0.28, 0.84, 2.69, 2.72, 0.08, 2.08, shiny('#1f6a73', 0.2), 0.008); m.k(0.74, 2.735, 1.0, 0.74, 2.735, 1.2, 0.012, CHROME);
  m.b(0.3, 0.82, 2.7, 2.98, 0, 0.07, K.dsteel, 0.008);
  for (const x of [0.1, 2.78]) for (const y of [0.4, 2.58]) for (const z of [0, 2.33]) m.b(x, x + 0.12, y, y + 0.12, z, z + 0.12, '#1c5a62', 0.01);
  m.b(1.3, 2.5, 0.75, 1.3, 0.14, 0.86, woodM(K.woodL, 'x', 71), 0.01);
  monitor(m, 1.6, 2.2, 0.9, 0.95, 1.3, codeScreen);
  m.c(2.56, 2.3, 0.14, 0.4, 0.1, K.white); m.s(2.56, 2.3, 0.62, 0.2, fuzz(K.green, 0.15, 30));
  m.b(2.1, 2.7, 0.7, 1.3, 2.45, 2.72, K.lgray, 0.03); m.c(2.4, 1.0, 2.72, 2.735, 0.2, K.charcoal, 0.004);
});
office('safe-door', 'Bank safe door', 1, 1, 'ne nw', (m) => {
  const y0 = T, S = (x, y, z) => mul(H('#8b949e'), 0.92 + 0.1 * noise3(x * 12, y * 12, z * 12, 3)), G = shiny(K.brass, 0.6);
  m.b(0.03, 0.97, y0, y0 + 0.05, 0, 2.02, { c: S, gloss: 0.2 }, 0.012);
  m.add(cyl(0.5, 1.02, y0 + 0.04, y0 + 0.1, 0.46, 0.012, 'y'), K.dsteel);
  m.add(cyl(0.5, 1.02, y0 + 0.09, y0 + 0.2, 0.4, 0.03, 'y'), { c: (x, y, z) => { const r = Math.hypot(x - 0.5, z - 1.02); return mul(H('#b4bcc5'), 0.9 + 0.1 * Math.cos(r * 160) ** 2); }, gloss: 0.5 });
  for (let k = 0; k < 10; k++) { const a = k * Math.PI / 5; m.add(cyl(0.5 + Math.cos(a) * 0.34, 1.02 + Math.sin(a) * 0.34, y0 + 0.19, y0 + 0.215, 0.022, 0.006, 'y'), K.dsteel); }
  const sp = [0, 45, 90, 135].map((a) => cap(0.5 - Math.cos(a * Math.PI / 180) * 0.15, y0 + 0.27, 1.02 - Math.sin(a * Math.PI / 180) * 0.15, 0.5 + Math.cos(a * Math.PI / 180) * 0.15, y0 + 0.27, 1.02 + Math.sin(a * Math.PI / 180) * 0.15, 0.012));
  m.add(uni(tor(0.5, y0 + 0.27, 1.02, 0.15, 0.018, 'y'), ...sp, cyl(0.5, 1.02, y0 + 0.2, y0 + 0.29, 0.04, 0.008, 'y')), G);
  m.c(0.08, y0 + 0.13, 0.72, 1.32, 0.04, K.dsteel, 0.012);
  m.b(0.07, 0.2, y0 + 0.1, y0 + 0.16, 0.8, 0.88, K.dsteel, 0.01); m.b(0.07, 0.2, y0 + 0.1, y0 + 0.16, 1.16, 1.24, K.dsteel, 0.01);
}, { edge: true });
office('meeting-table', 'Big meeting table', 4, 2, 'sw se', (m) => {
  m.add(uni(box(0.95, 3.05, 0.34, 1.66, 0.7, 0.75, 0.016), cyl(0.95, 1, 0.7, 0.75, 0.66, 0.016), cyl(3.05, 1, 0.7, 0.75, 0.66, 0.016)), { c: woodM('#b98450', 'x', 81), gloss: 0.25 });
  for (const x of [1.0, 3.0]) { m.b(x - 0.1, x + 0.1, 0.7, 1.3, 0.03, 0.7, DARK, 0.03); m.b(x - 0.22, x + 0.22, 0.55, 1.45, 0, 0.04, DARK, 0.016); }
  m.b(1.02, 2.98, 0.97, 1.03, 0.3, 0.38, DARK, 0.012);
  m.b(1.6, 2.4, 0.94, 1.06, 0.75, 0.758, K.black, 0.004);
  m.add(blob(0.06, sph(2, 1, 0.76, 0.05), sph(1.9, 0.94, 0.755, 0.04), sph(2.1, 0.94, 0.755, 0.04), sph(2, 1.1, 0.755, 0.04)), shiny('#2a2c31', 0.4));
  m.b(0.9, 1.14, 0.84, 1.16, 0.75, 0.756, K.white, 0.003); m.b(2.86, 3.1, 0.84, 1.16, 0.75, 0.756, K.white, 0.003);
});
// Swivel chairs share one skeleton.
function ergoChair(m, o) {
  for (let k = 0; k < 5; k++) { const a = (k * 72 + 18) * Math.PI / 180, x = 0.5 + Math.cos(a) * 0.28, y = 0.5 + Math.sin(a) * 0.28; m.k(0.5, 0.5, 0.1, x, y, 0.07, 0.022, o.frame); m.s(x, y, 0.036, 0.036, K.ink); }
  m.c(0.5, 0.5, 0.08, 0.42, 0.028, CHROME); m.c(0.5, 0.5, 0.36, 0.43, 0.07, o.frame, 0.012);
  m.b(0.27, 0.73, 0.3, 0.76, 0.42, 0.5, o.seat, 0.04);
  m.k(0.5, 0.34, 0.42, 0.5, 0.22, 0.6, 0.026, o.frame);
  const tilt = (s) => rot(s, 'x', 9, 0, 0.26, 0.55);
  if (o.split) {
    m.add(tilt(box(0.3, 0.7, 0.22, 0.28, 0.55, 0.8, 0.03)), o.mesh); m.add(tilt(box(0.29, 0.71, 0.21, 0.27, 0.84, 1.14, 0.03)), o.mesh);
    m.add(tilt(box(0.47, 0.53, 0.19, 0.23, 0.5, 1.1, 0.012)), o.accent);
  } else m.add(tilt(box(0.29, 0.71, 0.22, 0.28, 0.55, 1.12, 0.04)), o.mesh);
  m.add(tilt(box(0.38, 0.62, 0.2, 0.26, 1.17, 1.31, 0.03)), o.seat); m.add(tilt(cap(0.5, 0.22, 1.08, 0.5, 0.22, 1.2, 0.014)), o.frame);
  for (const x of [0.25, 0.75]) { m.k(x, 0.5, 0.46, x, 0.5, 0.67, 0.014, o.frame); m.b(x - 0.035, x + 0.035, 0.38, 0.66, 0.67, 0.7, o.arm || o.frame, 0.014); }
}
const meshM = (c) => { const A = H(c); return (x, y, z) => mul(A, 0.9 + 0.12 * ((Math.floor(x * 90) + Math.floor(z * 90)) & 1)); };
office('chair-ergonomic', 'Ergonomic black chair', 1, 1, ALL, (m) => ergoChair(m, { frame: DARK, seat: fuzz('#2f3138', 0.08, 60), mesh: meshM('#33363d') }));
office('chair-ergonomic-white', 'Ergonomic white chair', 1, 1, ALL, (m) => ergoChair(m, { frame: shiny('#e9eaec', 0.3), seat: fuzz('#c9ced6', 0.06, 60), mesh: meshM('#dfe2e6') }));
office('chair-libernovo-white', 'LiberNovo white ergonomic chair', 1, 1, ALL, (m) => ergoChair(m, { frame: shiny('#f1f2f4', 0.35), seat: fuzz('#e2e4e8', 0.05, 60), mesh: meshM('#eceef1'), accent: '#31b7a8', arm: '#6b7078', split: true }));
office('chair-meeting', 'Meeting chair', 1, 1, ALL, (m) => {
  const Fb = fuzz('#5d6470', 0.08, 60);
  for (const x of [0.27, 0.73]) { m.k(x, 0.3, 0.02, x, 0.74, 0.02, 0.016, CHROME); m.k(x, 0.74, 0.02, x, 0.74, 0.44, 0.016, CHROME); m.k(x, 0.74, 0.44, x, 0.3, 0.44, 0.016, CHROME); m.k(x, 0.3, 0.44, x, 0.24, 0.92, 0.016, CHROME); }
  m.b(0.27, 0.73, 0.3, 0.76, 0.44, 0.5, Fb, 0.03);
  m.add(rot(box(0.27, 0.73, 0.23, 0.28, 0.62, 0.94, 0.03), 'x', 7, 0, 0.26, 0.62), Fb);
});
office('chair-bar', 'Bar chair', 1, 1, 'flat', (m) => {
  m.c(0.5, 0.5, 0, 0.025, 0.21, CHROME, 0.01); m.c(0.5, 0.5, 0.02, 0.7, 0.025, CHROME); m.t(0.5, 0.5, 0.3, 0.15, 0.012, CHROME);
  for (const a of [0, 120, 240]) m.k(0.5, 0.5, 0.3, 0.5 + Math.cos(a * Math.PI / 180) * 0.15, 0.5 + Math.sin(a * Math.PI / 180) * 0.15, 0.3, 0.008, CHROME);
  m.c(0.5, 0.5, 0.69, 0.78, 0.18, shiny('#b23a2e', 0.35), 0.035);
});
office('pouf-beanbag', 'Pouf, big bean bag', 1, 1, 'flat', (m) => {
  m.add(blob(0.22, ell(0.5, 0.5, 0.19, 0.42, 0.42, 0.2), ell(0.5, 0.44, 0.42, 0.25, 0.25, 0.2), ell(0.5, 0.62, 0.3, 0.2, 0.16, 0.08)), fuzz('#2f9c95', 0.07, 45));
  m.s(0.5, 0.44, 0.63, 0.02, '#237a74');
});
office('ottoman', 'Ottoman seat', 1, 1, 'flat', (m) => {
  m.c(0.5, 0.5, 0.07, 0.42, 0.34, fuzz('#d9a441', 0.07, 50), 0.09);
  for (const [x, y] of [[0.5, 0.5], [0.36, 0.42], [0.64, 0.42], [0.36, 0.6], [0.64, 0.6]]) m.s(x, y, 0.418, 0.016, '#a87826');
  for (const a of [45, 135, 225, 315]) m.n(0.5 + Math.cos(a * Math.PI / 180) * 0.24, 0.5 + Math.sin(a * Math.PI / 180) * 0.24, 0, 0.09, 0.016, 0.028, K.woodD);
});
office('sofa-leather', 'Big leather sofa', 3, 1, ALL, (m) => {
  const L = { c: (x, y, z) => mul(H('#7d4a2b'), 0.93 + 0.1 * noise3(x * 6, y * 6, z * 6, 9)), gloss: 0.3 };
  m.b(0.1, 2.9, 0.14, 0.9, 0.08, 0.36, L, 0.05); m.b(0.1, 2.9, 0.1, 0.34, 0.2, 0.86, L, 0.08);
  for (const x of [0.06, 2.64]) m.b(x, x + 0.3, 0.1, 0.93, 0.08, 0.62, L, 0.1);
  for (let k = 0; k < 3; k++) { const x = 0.36 + k * 0.763; m.b(x, x + 0.75, 0.3, 0.95, 0.33, 0.5, L, 0.07); m.b(x + 0.01, x + 0.74, 0.25, 0.44, 0.46, 0.84, L, 0.08); }
  for (const x of [0.16, 2.84]) for (const y of [0.2, 0.84]) m.c(x, y, 0, 0.09, 0.025, CHROME);
});
office('chair-chill', 'Big chilling chair (hanging egg chair)', 1, 1, ALL, (m) => {
  m.t(0.5, 0.52, 0.03, 0.36, 0.03, DARK);
  m.k(0.5, 0.16, 0.03, 0.5, 0.08, 1.5, 0.028, DARK); m.k(0.5, 0.08, 1.5, 0.5, 0.2, 1.92, 0.028, DARK); m.k(0.5, 0.2, 1.92, 0.5, 0.52, 2.02, 0.028, DARK);
  m.k(0.5, 0.52, 2.02, 0.5, 0.52, 1.72, 0.008, CHROME);
  m.add(cut(shell(ell(0.5, 0.52, 1.08, 0.37, 0.35, 0.64), 0.018), ell(0.5, 1.02, 1.14, 0.52, 0.5, 0.52)), (x, y, z) => mul(H('#c39258'), mod(z * 22 + Math.atan2(y - 0.52, x - 0.5) * 3, 1) < 0.5 === mod(z * 22 - Math.atan2(y - 0.52, x - 0.5) * 3, 1) < 0.5 ? 1 : 0.78));
  m.e(0.5, 0.52, 0.66, 0.29, 0.27, 0.15, fuzz('#efe6d2', 0.05, 50)); m.e(0.5, 0.33, 1.06, 0.25, 0.1, 0.32, fuzz('#efe6d2', 0.05, 50));
  m.e(0.5, 0.5, 0.86, 0.13, 0.07, 0.11, fuzz('#e8862e', 0.06, 50));
});
office('chair-egg-white-red', 'Egg white chair with red interior', 1, 1, ALL, (m) => {
  const front = rot(box(0, 1, 0.74, 1.6, 0, 2, 0), 'x', -14, 0, 0.74, 0.8);
  m.add(cut(sph(0.5, 0.48, 0.8, 0.46), sph(0.5, 0.5, 0.81, 0.42), front), shiny('#f1f2f4', 0.45));
  m.add(cut(sph(0.5, 0.5, 0.81, 0.425), sph(0.5, 0.54, 0.84, 0.37), front), fuzz('#c9302a', 0.07, 50));
  m.e(0.5, 0.56, 0.52, 0.3, 0.26, 0.09, fuzz('#d93a32', 0.06, 50)); m.e(0.5, 0.3, 0.82, 0.26, 0.1, 0.24, fuzz('#d93a32', 0.06, 50));
  m.c(0.5, 0.5, 0, 0.03, 0.26, shiny('#f1f2f4', 0.45), 0.012); m.n(0.5, 0.5, 0.03, 0.38, 0.1, 0.05, shiny('#f1f2f4', 0.45));
});
office('fatboy-puff', 'Fatboy puff', 2, 1, ALL, (m) => {
  const R = fuzz('#d6342c', 0.05, 35);
  m.add(blob(0.2, grow(box(0.4, 1.6, 0.42, 0.74, 0.13, 0.17, 0), 0.12), grow(rot(box(0.42, 1.58, 0.24, 0.3, 0.2, 0.62, 0), 'x', 24, 0, 0.3, 0.2), 0.11)), R);
  m.b(1.5, 1.62, 0.872, 0.884, 0.14, 0.2, K.white, 0.003);
});
office('dog-corgi', 'Corgi dog', 1, 1, ALL, (m) => {
  const O = fuzz('#e09a4a', 0.06, 60), Wh = fuzz('#f4efe6', 0.04, 60);
  m.add(blob(0.07, ell(0.5, 0.46, 0.27, 0.14, 0.26, 0.13), sph(0.5, 0.76, 0.42, 0.115), ell(0.5, 0.22, 0.3, 0.07, 0.06, 0.07)), O);
  m.e(0.5, 0.66, 0.24, 0.11, 0.1, 0.12, Wh); m.e(0.5, 0.875, 0.39, 0.055, 0.08, 0.05, Wh); m.s(0.5, 0.95, 0.4, 0.02, K.ink);
  for (const x of [0.43, 0.57]) { m.n(x, 0.74, 0.5, 0.66, 0.05, 0.01, O); m.s(x - (x < 0.5 ? -0.01 : 0.01), 0.855, 0.455, 0.014, K.ink); }
  for (const x of [0.41, 0.59]) for (const y of [0.3, 0.64]) m.c(x, y, 0, 0.18, 0.04, Wh, 0.03);
  m.e(0.5, 0.93, 0.345, 0.018, 0.012, 0.03, K.pink);
});
office('cat-black', 'Black cat', 1, 1, ALL, (m) => {
  const B = { c: fuzz('#26272c', 0.1, 60), gloss: 0.15 };
  m.add(blob(0.06, ell(0.5, 0.46, 0.2, 0.13, 0.16, 0.2), sph(0.5, 0.56, 0.47, 0.1), ell(0.5, 0.4, 0.1, 0.15, 0.17, 0.1)), B);
  for (const x of [0.44, 0.56]) { m.n(x, 0.55, 0.53, 0.65, 0.04, 0.005, B); m.c(x, 0.6, 0, 0.2, 0.03, B, 0.025); m.s(x + (x < 0.5 ? 0.012 : -0.012), 0.648, 0.49, 0.016, gl('#c8e04a')); }
  m.s(0.5, 0.66, 0.455, 0.012, K.pink);
  m.k(0.6, 0.3, 0.05, 0.72, 0.4, 0.04, 0.026, B); m.k(0.72, 0.4, 0.04, 0.7, 0.56, 0.04, 0.024, B);
});
office('penguin-big', 'Big penguin', 1, 1, ALL, (m) => {
  const B = shiny('#23262d', 0.25), Wh = fuzz('#f4f4f1', 0.03, 50);
  m.add(blob(0.1, ell(0.5, 0.48, 0.6, 0.27, 0.25, 0.58), sph(0.5, 0.5, 1.18, 0.2)), B);
  m.e(0.5, 0.58, 0.56, 0.21, 0.19, 0.48, Wh); m.e(0.5, 0.63, 1.16, 0.13, 0.1, 0.12, Wh);
  m.add(rot(cone(0.5, 0.74, 1.1, 1.26, 0.05, 0.004), 'x', -90, 0, 0.72, 1.14), shiny('#f08a2e', 0.4));
  for (const x of [0.43, 0.57]) { m.s(x, 0.7, 1.22, 0.022, K.ink); m.e(x - (x < 0.5 ? 0.03 : -0.03), 0.68, 0.035, 0.085, 0.13, 0.035, shiny('#f08a2e', 0.3)); }
  m.add(rot(ell(0.22, 0.48, 0.66, 0.05, 0.13, 0.33), 'y', 10, 0.22, 0, 0.95), B); m.add(rot(ell(0.78, 0.48, 0.66, 0.05, 0.13, 0.33), 'y', -10, 0.78, 0, 0.95), B);
});
office('pool-table', 'Pool table', 3, 2, 'sw se', (m) => {
  const W = { c: woodM('#6b4329', 'x', 91), gloss: 0.3 };
  m.b(0.16, 2.84, 0.26, 1.74, 0.46, 0.8, W, 0.04);
  m.add(cut(box(0.14, 2.86, 0.24, 1.76, 0.76, 0.87, 0.03), box(0.29, 2.71, 0.39, 1.61, 0.81, 0.95, 0.01)), W);
  m.b(0.27, 2.73, 0.37, 1.63, 0.78, 0.812, fuzz('#1f8a4c', 0.06, 70), 0);
  for (const x of [0.29, 1.5, 2.71]) for (const y of [0.39, 1.61]) m.c(x, y, 0.8, 0.876, 0.07, { c: K.ink, glow: 0.6 }, 0);
  for (const x of [0.36, 2.64]) for (const y of [0.44, 1.56]) m.n(x, y, 0, 0.47, 0.06, 0.1, W);
  const BALL = ['#f1c232', '#27598c', '#c8372f', '#7a55b8', '#e8862e', '#2e6b37', '#8f241f', '#17181c', '#f1c232', '#27598c'];
  let b = 0;
  for (let r = 0; r < 4; r++) for (let k = 0; k <= r; k++) m.s(2.0 + r * 0.056, 1 + (k - r / 2) * 0.064, 0.842, 0.03, shiny(BALL[b++], 0.7));
  m.s(0.9, 1.0, 0.842, 0.03, shiny('#f4f4f1', 0.7));
  m.k(0.42, 1.36, 0.9, 1.5, 0.62, 0.885, 0.012, woodM(K.woodL, 'x', 92));
});
office('coat-rack', 'Jacket and hat holder', 1, 1, ALL, (m) => {
  const W = woodM(K.wood, 'z', 95);
  m.c(0.5, 0.5, 0, 0.035, 0.2, W, 0.014); m.c(0.5, 0.5, 0.03, 1.76, 0.022, W);
  for (const a of [0, 90, 180, 270]) { const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180); m.k(0.5, 0.5, 1.5, 0.5 + c * 0.16, 0.5 + s * 0.16, 1.62, 0.012, W); m.s(0.5 + c * 0.16, 0.5 + s * 0.16, 1.63, 0.02, W); }
  m.add(blob(0.08, ell(0.68, 0.5, 1.26, 0.09, 0.16, 0.3), ell(0.66, 0.34, 1.2, 0.06, 0.05, 0.26), ell(0.66, 0.66, 1.2, 0.06, 0.05, 0.26)), fuzz('#2f5f9c', 0.07, 50));
  m.k(0.5, 0.66, 1.62, 0.5, 0.7, 1.1, 0.03, fuzz('#c8372f', 0.07, 50));
  m.c(0.5, 0.5, 1.76, 1.775, 0.16, fuzz('#b99866', 0.05, 60), 0.006); m.c(0.5, 0.5, 1.77, 1.88, 0.09, fuzz('#b99866', 0.05, 60), 0.03); m.c(0.5, 0.5, 1.775, 1.8, 0.093, K.woodXD, 0.004);
});
office('lockers', 'Lockers', 2, 1, ALL, (m) => {
  const DC = ['#3b82c4', '#f1c232', '#c8372f', '#4c9c48'].map(H), body = H('#8d98a5');
  m.b(0.04, 1.96, 0.2, 0.76, 0.06, 1.9, (x, y, z, nx, ny) => {
    if (ny < 0.5) return body;
    const u = (x - 0.04) / 0.48, i = Math.floor(u), f = u - i;
    if (f < 0.03 || f > 0.97 || z < 0.1 || z > 1.86) return mul(body, 0.7);
    if (z > 1.5 && z < 1.7 && f > 0.25 && f < 0.75 && mod(z * 50, 1) < 0.4) return mul(DC[i & 3], 0.6);
    return DC[i & 3];
  }, 0.014);
  for (let k = 0; k < 4; k++) { m.b(0.42 + k * 0.48, 0.45 + k * 0.48, 0.76, 0.785, 0.95, 1.1, CHROME, 0.006); m.b(0.2 + k * 0.48, 0.34 + k * 0.48, 0.755, 0.765, 1.36, 1.42, K.white, 0.003); }
  for (const x of [0.1, 1.9]) for (const y of [0.26, 0.7]) m.c(x, y, 0, 0.07, 0.025, K.charcoal);
});
office('laptop-silver', 'MacBook silver', 1, 1, ALL, (m) => {
  const S = shiny('#c9cdd3', 0.5);
  m.b(0.24, 0.76, 0.4, 0.76, D, D + 0.016, (x, y, z, nx, ny, nz) => (nz > 0.5 && x > 0.27 && x < 0.73 && y > 0.43 && y < 0.6 ? (mod(x * 28, 1) > 0.25 && mod(y * 28, 1) > 0.25 ? H('#2a2c31') : H('#9a9fa6')) : nz > 0.5 && Math.abs(x - 0.5) < 0.08 && y > 0.63 && y < 0.73 ? H('#b4b8be') : H('#c9cdd3')), 0.006);
  m.add(rot(box(0.24, 0.76, 0.385, 0.4, D + 0.012, D + 0.36, 0.006), 'x', -14, 0, 0.4, D + 0.012), (x, y, z, nx, ny) => (ny > 0.4 && x > 0.255 && x < 0.745 && z > D + 0.03 && z < D + 0.335 ? { c: codeScreen((x - 0.255) / 0.49, (D + 0.335 - z) / 0.305), glow: 0.92 } : S.c ? { c: H('#c9cdd3'), gloss: 0.5 } : S));
}, { on_desk: true });
office('aquarium', 'Aquarium', 2, 1, ALL, (m) => {
  m.b(0.1, 1.9, 0.24, 0.8, 0, 0.7, fronts(K.woodXD, [0.7, 1.3], []), 0.014);
  m.b(0.14, 1.86, 0.28, 0.76, 0.7, 0.76, (x, y, z) => mul(H('#d9c9a0'), 0.85 + 0.25 * hash(x * 160, y * 160, 3)), 0.02);
  m.b(0.12, 1.88, 0.26, 0.78, 0.7, 1.36, { c: '#4fb4e4', a: 0.22, gloss: 0.8 }, 0.008);
  m.add(cut(box(0.1, 1.9, 0.24, 0.8, 1.35, 1.42, 0.012), box(0.2, 1.8, 0.32, 0.72, 1.3, 1.5, 0.01)), shiny('#1f2024', 0.3));
  
  m.add(blob(0.05, sph(0.5, 0.5, 0.8, 0.1), sph(0.62, 0.46, 0.78, 0.08), sph(0.42, 0.56, 0.77, 0.06)), '#7d8790');
  for (const [x, y, h, c] of [[0.3, 0.42, 0.4, '#3fa35a'], [0.36, 0.6, 0.3, '#59c26e'], [1.5, 0.44, 0.44, '#3fa35a'], [1.62, 0.6, 0.34, '#59c26e'], [1.0, 0.36, 0.5, '#2f8a4a'], [1.08, 0.4, 0.3, '#59c26e']])
    m.k(x, y, 0.74, x + 0.04, y, 0.74 + h, 0.02, c);
  const fish = (x, y, z, c, s = 1) => { m.e(x, y, z, 0.09 * s, 0.035 * s, 0.05 * s, gl(c, 0.7)); m.e(x - 0.11 * s, y, z, 0.03 * s, 0.012 * s, 0.05 * s, gl(c, 0.7)); };
  fish(0.7, 0.52, 1.1, '#ff8a2e'); fish(1.2, 0.46, 0.98, '#ffd23c', 0.8); fish(1.4, 0.58, 1.18, '#ff5f7a', 0.9); fish(0.95, 0.6, 0.92, '#e9f1ff', 0.7); fish(0.4, 0.5, 1.2, '#ff8a2e', 0.7);
  for (const z of [0.86, 0.98, 1.08, 1.2, 1.28]) m.s(1.74 + Math.sin(z * 30) * 0.015, 0.5, z, 0.012, gl('#e9fbff', 0.6));
});
office('table-books', 'Table with books', 1, 1, ALL, (m) => {
  m.b(0.14, 0.86, 0.2, 0.8, 0.39, 0.43, woodM(K.woodL, 'x', 97), 0.014);
  legs4(m, 0.2, 0.8, 0.26, 0.74, 0.4, K.black, 0.018); m.b(0.2, 0.8, 0.26, 0.74, 0.12, 0.14, woodM(K.wood, 'x', 98), 0.008);
  const stack = (x, y, z, n, s) => { for (let k = 0; k < n; k++) { const w = 0.24 - hash(k, s, 1) * 0.05, d = 0.17 - hash(k, s, 2) * 0.03, h = 0.028 + hash(k, s, 3) * 0.02; m.add(rot(box(x - w / 2, x + w / 2, y - d / 2, y + d / 2, z, z + h, 0.005), 'z', (hash(k, s, 4) - 0.5) * 30, x, y), BOOKC[Math.floor(hash(k, s, 5) * BOOKC.length)]); m.add(rot(box(x - w / 2 + 0.006, x + w / 2 + 0.004, y - d / 2 + 0.006, y + d / 2 - 0.006, z + 0.006, z + h - 0.006, 0.002), 'z', 0, x, y), '#f4f1e8'); z += h; } };
  stack(0.36, 0.5, 0.43, 6, 1); stack(0.66, 0.42, 0.43, 3, 2); stack(0.5, 0.5, 0.14, 4, 3);
  m.add(cut(cone(0.68, 0.66, 0.43, 0.52, 0.03, 0.04), cone(0.68, 0.66, 0.45, 0.54, 0.024, 0.034)), K.blue);
});
office('printer-3d', '3D printer', 1, 1, ALL, (m) => {
  m.b(0.08, 0.92, 0.12, 0.88, 0.64, 0.68, woodM(K.woodL, 'x', 99), 0.012); legs4(m, 0.14, 0.86, 0.18, 0.82, 0.65, K.black, 0.022);
  m.b(0.12, 0.88, 0.16, 0.84, 0.2, 0.22, woodM(K.wood, 'x', 100), 0.008);
  m.b(0.24, 0.76, 0.24, 0.76, 0.68, 0.76, (x, y, z, nx, ny) => (ny > 0.5 && x > 0.3 && x < 0.48 && z > 0.695 && z < 0.745 ? { c: H('#3fd0ff'), glow: 0.9 } : H('#25272c')), 0.012);
  for (const x of [0.26, 0.74]) for (const y of [0.26, 0.74]) m.b(x - 0.018, x + 0.018, y - 0.018, y + 0.018, 0.76, 1.34, DARK, 0.006);
  for (const y of [0.26, 0.74]) m.b(0.26, 0.74, y - 0.018, y + 0.018, 1.31, 1.345, DARK, 0.006);
  for (const x of [0.26, 0.74]) m.b(x - 0.018, x + 0.018, 0.26, 0.74, 1.31, 1.345, DARK, 0.006);
  m.b(0.3, 0.7, 0.3, 0.7, 0.78, 0.795, shiny('#3a3d44', 0.4), 0.004);
  m.add(blob(0.02, cone(0.5, 0.5, 0.795, 0.9, 0.06, 0.085), cone(0.5, 0.5, 0.9, 0.98, 0.085, 0.05)), (x, y, z) => mul(H('#f08a2e'), mod(z * 120, 1) < 0.5 ? 1 : 0.9));
  m.b(0.26, 0.74, 0.485, 0.515, 1.1, 1.13, CHROME, 0.006); m.b(0.44, 0.56, 0.45, 0.55, 1.02, 1.14, DARK, 0.012);
  m.n(0.5, 0.5, 0.985, 1.02, 0.004, 0.02, shiny(K.brass, 0.6));
  m.t(0.8, 0.5, 1.12, 0.085, 0.04, '#f08a2e', 'x'); m.add(cyl(0.5, 1.12, 0.74, 0.86, 0.03, 0.006, 'x'), K.charcoal);
});
office('laser-cutter', 'Laser cutter', 2, 1, ALL, (m) => {
  const inside = (x, y, z) => x > 0.2 && x < 1.5 && y > 0.22 && y < 0.8 && z > 0.6;
  m.b(0.14, 1.86, 0.2, 0.84, 0, 0.36, fronts(K.charcoal, [1.0], []), 0.014);
  m.add(cut(box(0.08, 1.92, 0.14, 0.9, 0.36, 1.0, 0.03), box(0.2, 1.5, 0.22, 0.8, 0.62, 1.2, 0.008)), (x, y, z) => (inside(x, y, z) ? (z < 0.64 ? mul(H('#3a3d44'), mod(x * 40, 1) < 0.5 === mod(y * 40, 1) < 0.5 ? 1 : 0.75) : H('#d9dbe0')) : H('#d2362c')));
  m.b(0.34, 1.3, 0.3, 0.72, 0.62, 0.635, (x, y, z, nx, ny, nz) => (nz > 0.5 && (Math.abs(Math.hypot(x - 0.6, y - 0.5) - 0.1) < 0.006 || (Math.abs(x - 1.0) < 0.12 && Math.abs(y - 0.5) < 0.12 && (Math.abs(Math.abs(x - 1.0) - 0.12) < 0.008 || Math.abs(Math.abs(y - 0.5) - 0.12) < 0.008))) ? H('#4a2e1b') : woodM('#dcb98a', 'x', 103)(x, y, z)), 0.002);
  m.b(0.2, 1.5, 0.48, 0.53, 0.86, 0.9, CHROME, 0.006); m.b(0.56, 0.66, 0.46, 0.56, 0.78, 0.92, DARK, 0.01); m.s(0.61, 0.51, 0.77, 0.014, gl('#ff3b30'));
  m.b(0.18, 1.52, 0.2, 0.82, 0.985, 1.005, { c: '#f39a3d', a: 0.5, gloss: 0.8 }, 0.004);
  m.k(0.6, 0.83, 1.01, 1.1, 0.83, 1.01, 0.012, CHROME);
  m.b(1.56, 1.88, 0.28, 0.76, 1.0, 1.02, (x, y, z, nx, ny, nz) => (nz > 0.5 && x > 1.6 && x < 1.84 && y > 0.32 && y < 0.5 ? { c: H('#3fd0ff'), glow: 0.9 } : H('#1f2024')), 0.006);
  m.c(1.72, 0.64, 1.02, 1.06, 0.04, shiny('#d2261f', 0.5), 0.012); m.c(1.72, 0.64, 1.0, 1.025, 0.055, K.yellow, 0.004);
  m.b(0.9, 1.1, 0.895, 0.905, 0.5, 0.6, K.yellow, 0.003);
});
office('pencil-big-yellow', 'Big yellow pencil', 1, 1, 'flat', (m) => {
  const hexF = (base) => (x, y, z) => mul(H(base), 0.84 + 0.2 * Math.cos(Math.atan2(y - 0.5, x - 0.5) * 3) ** 2);
  m.c(0.5, 0.5, 0, 0.12, 0.1, fuzz('#f08fa8', 0.04, 60), 0.035);
  m.c(0.5, 0.5, 0.11, 0.26, 0.105, { c: (x, y, z) => mul(H('#c9ced4'), mod(z * 40, 1) < 0.3 ? 0.75 : 1), gloss: 0.6 }, 0.006);
  m.c(0.5, 0.5, 0.25, 1.7, 0.1, hexF('#f6c62b'), 0.006);
  m.n(0.5, 0.5, 1.69, 1.96, 0.1, 0.028, woodM('#e3bd8a', 'z', 105)); m.n(0.5, 0.5, 1.95, 2.05, 0.028, 0.002, '#2a2c31');
});

// ================================================================ kitchen
const KI = 'KITCHEN';
const kitchen = (name, label, X, Y, dirs, build, extra) => prop(KI, name, label, X, Y, dirs, build, extra);
const CAB = '#eceef0', TOP = { c: (x, y, z) => mul(H('#d8d3ca'), 0.94 + 0.1 * noise3(x * 7, y * 7, z * 7, 4)), gloss: 0.4 };
kitchen('kitchen-island', 'Kitchen island', 2, 1, ALL, (m) => {
  m.b(0.12, 1.88, 0.22, 0.84, 0, 0.08, K.charcoal, 0.008);
  m.b(0.1, 1.9, 0.2, 0.86, 0.08, 0.88, (x, y, z, nx, ny) => (Math.abs(ny) > 0.5 && ([0.55, 1.0, 1.45].some((s) => Math.abs(x - s) < 0.006) || Math.abs(z - 0.7) < 0.006) ? H('#aeb3ba') : H(CAB)), 0.014);
  m.add(cut(box(0.04, 1.96, 0.13, 0.93, 0.88, 0.93, 0.016), box(0.24, 0.76, 0.34, 0.72, 0.84, 1, 0.03)), TOP);
  m.add(cut(box(0.22, 0.78, 0.32, 0.74, 0.74, 0.9, 0.02), box(0.25, 0.75, 0.35, 0.71, 0.77, 1, 0.03)), shiny('#b9c0c7', 0.6));
  m.k(0.5, 0.28, 0.93, 0.5, 0.28, 1.2, 0.014, CHROME); m.k(0.5, 0.28, 1.2, 0.5, 0.44, 1.22, 0.014, CHROME); m.k(0.5, 0.44, 1.22, 0.5, 0.46, 1.12, 0.012, CHROME);
  m.b(1.14, 1.78, 0.28, 0.78, 0.93, 0.937, { gloss: 0.7, c: (x, y) => { for (const [cx, cy, on] of [[1.3, 0.4, 0], [1.62, 0.4, 1], [1.3, 0.66, 0], [1.62, 0.66, 0]]) { const r = Math.hypot(x - cx, y - cy); if (Math.abs(r - 0.085) < 0.007 || Math.abs(r - 0.045) < 0.005) return on ? { c: H('#ff5a36'), glow: 1 } : H('#5a5e66'); } return H('#17181c'); } }, 0.003);
  for (const x of [0.32, 0.78, 1.22, 1.68]) m.k(x - 0.06, 0.87, 0.78, x + 0.06, 0.87, 0.78, 0.009, CHROME);
  m.c(0.96, 0.6, 0.93, 1.06, 0.05, shiny('#c8372f', 0.4), 0.012); m.c(0.96, 0.6, 1.06, 1.075, 0.053, K.charcoal, 0.004);
});
kitchen('kitchen-cabinet-high', 'Kitchen high cabinet', 1, 1, ALL, (m) => {
  m.b(0.07, 0.93, 0.12, 0.72, 0, 0.08, K.charcoal, 0.008);
  m.b(0.05, 0.95, 0.1, 0.74, 0.08, 2.15, fronts(CAB, [0.5], [0.9, 1.6]), 0.014);
  for (const [z0, z1] of [[1.05, 1.35], [0.45, 0.75], [1.7, 1.9]]) for (const x of [0.45, 0.55]) m.k(x, 0.75, z0, x, 0.75, z1, 0.009, CHROME);
});
kitchen('kitchen-cabinet-low', 'Kitchen low cabinet', 1, 1, ALL, (m) => {
  m.b(0.07, 0.93, 0.12, 0.74, 0, 0.08, K.charcoal, 0.008);
  m.b(0.05, 0.95, 0.1, 0.76, 0.08, 0.86, fronts(CAB, [0.5], [0.66]), 0.014);
  m.b(0.02, 0.98, 0.06, 0.8, 0.86, 0.9, woodM(K.woodL, 'x', 111), 0.014);
  for (const x of [0.28, 0.72]) m.k(x - 0.07, 0.77, 0.76, x + 0.07, 0.77, 0.76, 0.009, CHROME);
  for (const x of [0.43, 0.57]) m.k(x, 0.77, 0.36, x, 0.77, 0.56, 0.009, CHROME);
  m.c(0.25, 0.4, 0.9, 1.08, 0.055, shiny('#e9eaec', 0.4), 0.014); for (const [dx, c] of [[-0.02, K.woodL], [0.02, K.steel], [0, K.woodD]]) m.k(0.25 + dx, 0.4, 1.06, 0.25 + dx * 3, 0.4 + dx, 1.22, 0.008, c);
  m.b(0.52, 0.86, 0.3, 0.56, 0.9, 0.925, woodM(K.wood, 'x', 112), 0.008); m.s(0.62, 0.42, 0.965, 0.045, K.red); m.s(0.74, 0.46, 0.96, 0.04, '#9ccc3c');
});
const fridgeBody = (m, c, r, h = 1.9) => m.b(0.12, 0.88, 0.14, 0.8, 0.04, h, c, r);
kitchen('fridge-50s', "50's fridge", 1, 1, ALL, (m) => {
  const C = H('#8fd6c4');
  fridgeBody(m, { gloss: 0.55, c: (x, y, z, nx, ny) => (ny > 0.5 && Math.abs(z - 1.28) < 0.008 ? mul(C, 0.6) : C) }, 0.11, 1.74);
  m.k(0.76, 0.82, 1.36, 0.76, 0.82, 1.58, 0.016, CHROME); m.k(0.76, 0.82, 0.86, 0.76, 0.82, 1.2, 0.016, CHROME);
  for (const z of [1.36, 1.58, 0.86, 1.2]) m.k(0.76, 0.78, z, 0.76, 0.82, z, 0.012, CHROME);
  m.b(0.24, 0.44, 0.795, 0.808, 1.6, 1.64, CHROME, 0.004);
  for (const x of [0.2, 0.8]) for (const y of [0.22, 0.72]) m.c(x, y, 0, 0.06, 0.03, CHROME);
});
kitchen('fridge-modern', 'Modern fridge', 1, 1, ALL, (m) => {
  fridgeBody(m, { gloss: 0.6, c: (x, y, z, nx, ny) => { if (ny < 0.5) return H('#e9eaec'); if (Math.abs(z - 0.66) < 0.006 || (z > 0.66 && Math.abs(x - 0.5) < 0.005)) return H('#9aa0a8'); if (x > 0.2 && x < 0.4 && z > 1.3 && z < 1.5) return { c: mix(H('#0f1a2c'), H('#3fd0ff'), z > 1.42 && x > 0.23 && x < 0.37 ? 0.9 : 0.1), glow: 0.9 }; return H('#f1f2f4'); } }, 0.02);
  m.b(0.455, 0.475, 0.8, 0.815, 0.8, 1.7, K.charcoal, 0.004); m.b(0.525, 0.545, 0.8, 0.815, 0.8, 1.7, K.charcoal, 0.004); m.b(0.3, 0.7, 0.8, 0.815, 0.58, 0.6, K.charcoal, 0.004);
});
kitchen('fridge-aluminium', 'Aluminium fridge', 1, 1, ALL, (m) => {
  const A = (x, y, z) => mul(H('#b9c0c7'), 0.92 + 0.1 * noise3(x * 2, y * 2, z * 90, 6));
  fridgeBody(m, { gloss: 0.6, c: (x, y, z, nx, ny) => { if (ny < 0.5) return A(x, y, z); if (Math.abs(x - 0.42) < 0.005 || (x > 0.42 && Math.abs(z - 0.7) < 0.005)) return H('#6c737c'); if (x > 0.18 && x < 0.36 && z > 1.0 && z < 1.4) return z > 1.3 ? { c: H('#3fd0ff'), glow: 0.8 } : H('#25272c'); return A(x, y, z); } }, 0.016);
  m.k(0.385, 0.83, 0.5, 0.385, 0.83, 1.7, 0.012, CHROME); m.k(0.455, 0.83, 0.85, 0.455, 0.83, 1.7, 0.012, CHROME); m.k(0.5, 0.83, 0.56, 0.8, 0.83, 0.56, 0.012, CHROME);
});
const kTable = (top, legC) => (m) => {
  m.b(0.1, 1.9, 0.12, 0.88, 0.71, 0.75, top, 0.016); m.b(0.18, 1.82, 0.2, 0.8, 0.63, 0.71, legC, 0.008);
  for (const [x, dx] of [[0.2, -0.04], [1.8, 0.04]]) for (const [y, dy] of [[0.22, -0.04], [0.78, 0.04]]) m.k(x, y, 0.68, x + dx, y + dy, 0.02, 0.026, legC);
};
kitchen('kitchen-table-white', 'Kitchen white table', 2, 1, 'sw se', (m) => { kTable(shiny('#f1f2f4', 0.4), woodM(K.woodL, 'z', 121))(m); m.c(1, 0.5, 0.75, 0.78, 0.16, woodM(K.wood, 'x', 122), 0.008); for (const [dx, dy, c] of [[-0.05, 0, '#d43d3a'], [0.05, 0.03, '#9ccc3c'], [0, -0.06, K.orange]]) m.s(1 + dx, 0.5 + dy, 0.82, 0.045, c); });
kitchen('kitchen-table-wood', 'Kitchen wood table', 2, 1, 'sw se', (m) => { kTable(woodM(K.wood, 'x', 123), woodM(K.woodD, 'z', 124))(m); m.n(1, 0.5, 0.75, 0.93, 0.035, 0.05, shiny('#3b82c4', 0.5)); for (const [dx, dy, c] of [[-0.04, 0, K.yellow], [0.04, 0.02, K.pink], [0, -0.04, K.white]]) { m.k(1, 0.5, 0.92, 1 + dx, 0.5 + dy, 1.08, 0.006, K.dgreen); m.s(1 + dx, 0.5 + dy, 1.09, 0.03, c); } });
kitchen('kitchen-table-round-wood', 'Kitchen wood round table', 1, 1, 'flat', (m) => {
  m.c(0.5, 0.5, 0.71, 0.75, 0.47, woodM(K.wood, 'x', 125), 0.016); m.c(0.5, 0.5, 0.04, 0.71, 0.045, woodM(K.woodD, 'z', 126)); m.n(0.5, 0.5, 0, 0.06, 0.26, 0.06, woodM(K.woodD, 'x', 127));
});
kitchen('kitchen-chair', 'Kitchen chair', 1, 1, ALL, (m) => {
  const W = woodM(K.woodL, 'z', 128);
  for (const x of [0.3, 0.7]) { m.k(x, 0.7, 0, x, 0.68, 0.44, 0.02, W); m.k(x, 0.3, 0, x, 0.32, 0.44, 0.02, W); m.k(x, 0.32, 0.44, x, 0.27, 0.95, 0.02, W); }
  m.b(0.27, 0.73, 0.28, 0.74, 0.43, 0.48, shiny('#f1f2f4', 0.3), 0.02);
  for (const z of [0.66, 0.78, 0.9]) m.add(rot(box(0.3, 0.7, 0.275, 0.3, z - 0.035, z + 0.035, 0.01), 'x', 5, 0, 0.29, 0.44), W);
});
kitchen('lamp-pendant-green', 'Kitchen low ceiling green lamp', 1, 1, 'flat', (m) => {
  m.ground = lightPool('#fff0c8', 0.48, 0.3);
  m.c(0.5, 0.5, 2.46, 2.5, 0.05, K.charcoal); m.k(0.5, 0.5, 2.47, 0.5, 0.5, 1.56, 0.01, K.black);
  m.add(cut(cone(0.5, 0.5, 1.3, 1.58, 0.22, 0.045), cone(0.5, 0.5, 1.28, 1.56, 0.205, 0.03)), shiny('#2f8f5b', 0.6));
  m.s(0.5, 0.5, 1.36, 0.06, gl('#fff3cf'));
});
kitchen('picnic-table', 'Garden picnic table', 2, 2, 'sw se', (m) => {
  const W = woodM('#c79a63', 'x', 131), planks = (x, y, z) => (mod(y - 0.61, 0.156) < 0.012 ? H('#8a6238') : W(x, y + Math.floor(y * 6.4) * 3, z));
  m.b(0.2, 1.8, 0.61, 1.39, 0.71, 0.76, planks, 0.008);
  for (const y of [0.34, 1.66]) m.b(0.2, 1.8, y - 0.14, y + 0.14, 0.41, 0.46, W, 0.01);
  for (const x of [0.48, 1.52]) {
    m.k(x, 0.3, 0.02, x, 0.78, 0.7, 0.035, W); m.k(x, 1.7, 0.02, x, 1.22, 0.7, 0.035, W);
    m.b(x - 0.03, x + 0.03, 0.2, 1.8, 0.35, 0.41, W, 0.008);
  }
  m.k(0.48, 1, 0.68, 1.52, 1, 0.68, 0.025, W);
});

// ================================================================ stairs and slide
// Half stair into the wall, modelled for the ne wall (y = 0 edge); the nw piece is the same turned.
function halfStair(m) {
  const Wt = woodM(K.woodL, 'x', 141), body = '#e7e8ea', d = 0.26, y0 = 0.7;
  m.b(0.08, 0.92, T, y0, 0, 1.47, body, 0.006); m.b(0.06, 0.94, T, y0 + 0.02, 1.47, 1.5, Wt, 0.006);
  for (let s = 0; s < 5; s++) { const h = 1.25 - s * 0.25, a = y0 + s * d; m.b(0.08, 0.92, a - 0.01, a + d, 0, h - 0.03, body, 0.006); m.b(0.06, 0.94, a - 0.01, a + d + 0.02, h - 0.03, h, Wt, 0.006); }
  m.b(0.14, 0.86, T, T + 0.012, 1.5, WH - 0.04, voidM(), 0);
  m.add(cut(box(0.1, 0.9, T, T + 0.03, 1.5, WH, 0.008), box(0.14, 0.86, T - 0.1, T + 0.1, 1.4, WH - 0.04, 0)), '#d5d8dc');
  const x = 0.9;
  for (let s = 0; s <= 5; s++) { const yy = s === 0 ? T + 0.06 : y0 + (s - 0.5) * d, h = s === 0 ? 1.5 : 1.25 - (s - 1) * 0.25; m.c(x, yy, h - 0.02, h + 0.8, 0.014, DARK); }
  m.k(x, T + 0.06, 2.3, x, y0 - 0.02, 2.3, 0.022, DARK); m.k(x, y0 - 0.02, 2.3, x, y0 + 4.5 * d, 1.05, 0.022, DARK);
}
prop(F, 'stair-half-into-wall-ne', 'Half stair into the wall (enters the right wall)', 1, 2, 'ne', halfStair, { edge: true });
prop(F, 'stair-half-into-wall', 'Half stair into the wall (enters the left wall)', 1, 2, 'nw', halfStair, { edge: true });
office('stair-spiral-black', 'Round black stairs', 2, 2, 'flat', (m) => {
  const N = 14, RISE = WH / N, B = shiny('#26282d', 0.3), pts = [];
  m.c(1, 1, 0, WH + 0.1, 0.055, B); m.c(1, 1, 0, 0.03, 0.16, B, 0.01);
  for (let k = 0; k < N; k++) {
    const a = 100 + k * 26, z = (k + 1) * RISE, r = (a * Math.PI) / 180, bx = 1 + Math.cos(r) * 0.84, by = 1 + Math.sin(r) * 0.84;
    m.add(rot(box(1.03, 1.9, 0.86, 1.14, z - 0.035, z, 0.01), 'z', a, 1, 1), k === N - 1 ? B : woodM('#3a2a20', 'x', 150 + k));
    m.c(bx, by, z, z + 0.9, 0.012, B); pts.push([bx, by, z + 0.9]);
  }
  for (let k = 0; k < N - 1; k++) m.k(...pts[k], ...pts[k + 1], 0.022, B);
});
office('slide-tube', 'Tube slide coming down from the ceiling', 2, 2, ALL, (m) => {
  const C = 1, R = 0.62, r = 0.2, pts = [[C + R, C, WH], [C + R, C, 2.25]], S1 = shiny('#b8bfc6', 0.7), S2 = shiny('#a3abb3', 0.7);
  for (let k = 1; k <= 30; k++) { const a = (k / 30) * 2 * Math.PI; pts.push([C + Math.cos(a) * R, C - Math.sin(a) * R, 2.25 - (k / 30) * 1.99]); }
  pts.push([C + R, 1.4, 0.26], [C + R, 1.94, 0.26]);
  for (let k = 0; k < pts.length - 1; k++) { const s = cap(...pts[k], ...pts[k + 1], r); m.add(k === pts.length - 2 ? clip(s, 'y', 0, 1.94) : k === 0 ? clip(s, 'z', 0, WH) : s, k % 5 === 0 ? S2 : S1); }
  m.add(cyl(C + R, 0.26, 1.935, 1.945, r - 0.03, 0, 'y'), { c: K.ink, glow: 0.7 });
  m.add(tor(C + R, 1.94, 0.26, r - 0.012, 0.016, 'y'), S2);
  m.c(C + R, C, WH - 0.06, WH, 0.3, K.charcoal, 0.01); m.c(C + R, C, WH - 0.01, WH + 0.004, r - 0.02, { c: K.ink, glow: 0.7 }, 0);
  m.c(C, C, 0, 2.3, 0.045, METAL); m.c(C, C, 0, 0.03, 0.14, METAL, 0.01);
  for (const [a, z] of [[90, 1.75], [180, 1.26], [270, 0.76]]) m.k(C, C, z, C + Math.cos(a * Math.PI / 180) * (R - r), C - Math.sin(a * Math.PI / 180) * (R - r), z, 0.018, METAL);
  m.b(C + R - 0.32, C + R + 0.32, 1.5, 1.98, 0, 0.035, fuzz('#3b82c4', 0.06, 50), 0.012);
});


// ================================================================ previews
// A scene is a list of placements { n: sprite name, i, j } on tile (i, j); a sprite's anchor
// goes on the bottom vertex of its (front) tile. Floors first, then back to front.
function composeScene(scene, get) {
  const list = [];
  scene.forEach((p, k) => {
    const s = get(p.n); if (!s) { console.warn(`preview: missing sprite ${p.n}`); return; }
    const x = (p.i - p.j) * HW - s.ax, y = (p.i + p.j + 2) * HH - s.ay;
    list.push({ s, x, y, key: (p.n.startsWith('floor') ? 0 : 1e6) + (p.i + p.j) * 100 + (p.z || 0), k });
  });
  if (!list.length) return null;
  list.sort((a, b) => a.key - b.key || a.k - b.k);
  const x0 = Math.min(...list.map((l) => l.x)) - 24, y0 = Math.min(...list.map((l) => l.y)) - 24;
  const x1 = Math.max(...list.map((l) => l.x + l.s.im.w)) + 24, y1 = Math.max(...list.map((l) => l.y + l.s.im.h)) + 24;
  const im = img(x1 - x0, y1 - y0), bg = hex(scene.bg || '#23262e');
  for (let i = 0; i < im.d.length; i += 4) { im.d[i] = bg[0]; im.d[i + 1] = bg[1]; im.d[i + 2] = bg[2]; im.d[i + 3] = 255; }
  for (const l of list) over(im, l.s.im, l.x - x0, l.y - y0);
  return im;
}
// Room of N x M tiles: floorAt(i, j) -> floor name; ne[i] / nw[j] -> wall style per tile;
// neOn[i] / nwOn[j] -> piece (or list of pieces) hung on that wall, '{side}' is replaced; items = extra placements.
function room(N, M, floorAt, ne, nw, neOn = [], nwOn = [], items = [], bg) {
  const sc = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) sc.push({ n: `${floorAt(i, j)}_flat`, i, j });
  const hang = (list, side, i, j) => [].concat(list || []).forEach((n, k) => sc.push({ n: n.replace('{side}', side), i, j, z: 2 + k }));
  sc.push({ n: `wall-${ne[0]}_corner`, i: 0, j: 0, z: 1 });
  for (let i = 1; i < N; i++) sc.push({ n: `wall-${ne[i]}_ne`, i, j: 0, z: 1 });
  for (let j = 1; j < M; j++) sc.push({ n: `wall-${nw[j]}_nw`, i: 0, j, z: 1 });
  for (let i = 0; i < N; i++) hang(neOn[i], 'ne', i, 0);
  for (let j = 0; j < M; j++) hang(nwOn[j], 'nw', 0, j);
  for (const it of items) sc.push({ z: 10, ...it });
  sc.bg = bg;
  return sc;
}
const fill = (v, n) => Array(n).fill(v);
const PREVIEWS = {};
{
  const st = Object.keys(WALLS), fl = JOBS.filter((j) => j.folder === 'FLOORS').map((j) => j.id.replace('_flat', ''));
  PREVIEWS['preview_walls_floors.png'] = room(9, 9, (i, j) => fl[j % fl.length], st, st);
}
{
  const neon = NEONS.map(([n, , X]) => (X === 2 ? [`${n}_{side}_part1`, `${n}_{side}_part2`] : [`${n}_{side}`])).flat();
  const two = (n) => [`${n}_{side}_part1`, `${n}_{side}_part2`];
  const ne = [...two('decor-tv'), ...neon, ...['decor-bookshelf', 'decor-switch-left', 'decor-elevator'].map((n) => `${n}_{side}`)];
  const nw = [...two('decor-tv-dashboard-dark'), ...two('decor-tv-dashboard-light'), ...two('decor-tv-presentation'), ...['decor-picture-sea', 'decor-picture-forest', 'decor-switch-right', 'decor-lamp-modern', 'decor-lamp-classic', 'decor-lamp-old', 'decor-bookshelf', 'decor-elevator'].map((n) => `${n}_{side}`)];
  // nw parts run towards the viewer: part1 is the tile nearer the viewer
  const flip = (l) => { const o = l.slice(); for (let i = 0; i < o.length - 1; i++) if (o[i]?.endsWith('part1') && o[i + 1]?.endsWith('part2')) { [o[i], o[i + 1]] = [o[i + 1], o[i]]; i++; } return o; };
  PREVIEWS['preview_decor.png'] = room(14, 14, () => 'floor-wood', fill('white', 14), fill('gray', 14), [null, ...ne], [null, ...flip(nw)]);
  const dn = Object.keys(DOORS).concat('elevator', 'bunker', 'iris').map((k) => `door-${k}`);
  const run = (st) => [null, ...dn.map((n) => `${n}_{side}_${st}`), `door-glass-sliding_{side}_${st}_part1`, `door-glass-sliding_{side}_${st}_part2`];
  PREVIEWS['preview_doors.png'] = room(15, 15, () => 'floor-cement-light', fill('white', 15), fill('blue-skirting', 15), run('closed'), flip(run('open')));
  const win = (t) => [null, 'full', 'full', 'full', 'half', 'grid', 'arch', 'circle'].map((k) => k && `window-${k}_{side}_${t}`).concat(two(`window-circle-big`).map((n) => n.replace('_part', `_${t}_part`)));
  PREVIEWS['preview_windows.png'] = room(11, 11, () => 'floor-carpet-gray', fill('white', 11), fill('white', 11), win('day'), flip(win('night')));
}
{
  // every prop once (first direction), on a grid with room for its footprint
  const first = new Map();
  for (const j of JOBS) if (j.meta.footprint) { const base = j.id.replace(/_(sw|se|ne|nw|flat)$/, ''); if (!first.has(base)) first.set(base, j); }
  const grid = (list, cols, fl) => {
    const sc = []; let i = 1, j = 1, rowD = 0, maxI = 0;
    for (const jb of list) {
      const fp = jb.meta.footprint;
      if (i + fp.x > cols) { i = 1; j += rowD + 1; rowD = 0; }
      sc.push({ n: jb.id, i: i + fp.x - 1, j: j + fp.y - 1, z: 10 });
      i += fp.x + 1; rowD = Math.max(rowD, fp.y); maxI = Math.max(maxI, i);
    }
    const N = Math.min(cols, maxI), M = j + rowD + 1;
    for (let a = 0; a < N; a++) for (let b = 0; b < M; b++) sc.push({ n: `${fl}_flat`, i: a, j: b });
    return sc;
  };
  const all = [...first.values()];
  PREVIEWS['preview_furniture.png'] = grid(all.filter((j) => j.folder === 'FURNITURE' && !j.meta.on_desk), 22, 'floor-cement-light');
  PREVIEWS['preview_kitchen.png'] = grid(all.filter((j) => j.folder === 'KITCHEN'), 14, 'floor-tiles-ceramic');
}
{
  const showcase = (t) => {
    const ne = [...fill('brick', 6), ...fill('white', 6)], nw = fill('white-led', 10);
    const neOn = [null, 'decor-tv_{side}_part1', 'decor-tv_{side}_part2', 'decor-neon-trust-your-code_{side}', 'decor-neon-coffee_{side}', 'decor-lamp-old_{side}',
      `window-full_{side}_${t}`, `window-full_{side}_${t}`, `window-full_{side}_${t}`, 'decor-bookshelf_{side}', 'door-glass_{side}_closed', 'decor-lamp-modern_{side}'];
    const nwOn = [null, 'decor-picture-sea_{side}', 'decor-tv-dashboard-dark_{side}_part2', 'decor-tv-dashboard-dark_{side}_part1', 'door-wood-light_{side}_open', 'decor-switch-right_{side}',
      `window-arch_{side}_${t}`, 'door-elevator_{side}_closed', 'decor-lamp-classic_{side}', 'decor-picture-forest_{side}'];
    const it = (n, i, j, z = 10) => ({ n, i, j, z });
    const items = [
      it('desk-wood_sw', 3, 2), it('monitor-multi-arm_sw', 3, 2, 11), it('keyboard_sw', 2, 2, 12), it('mouse-pad_sw', 3, 2, 12), it('chair-ergonomic_ne', 2, 3),
      it('desk-gamer_sw', 6, 2), it('monitor-large_sw', 5, 2, 11), it('keyboard-ergonomic_sw', 5, 2, 12), it('lamp-desk_sw', 6, 2, 12), it('chair-libernovo-white_ne', 5, 3),
      it('plant-tree_flat', 1, 1), it('plant_flat', 8, 1), it('arcade-machine_sw', 11, 1),
      it('sofa-leather_sw', 9, 5), it('coffee-table-controller_sw', 8, 7), it('pouf-beanbag_flat', 10, 7), it('chair-egg-white-red_nw', 11, 6), it('lamp-floor_flat', 6, 5),
      it('cat-black_sw', 7, 7), it('dog-corgi_se', 5, 5), it('penguin-big_se', 1, 9), it('water-fountain_se', 1, 5),
      it('meeting-table_sw', 5, 8), it('chair-meeting_sw', 3, 6), it('chair-meeting_sw', 4, 6), it('chair-meeting_ne', 3, 9), it('chair-meeting_ne', 4, 9), it('lamp-ceiling_flat', 4, 8, 50),
      it('slide-tube_sw', 11, 9),
    ];
    return room(12, 10, (i, j) => (i >= 6 && j >= 4 ? 'floor-carpet-gray' : 'floor-wood'), ne, nw, neOn, nwOn, items, t === 'day' ? '#23262e' : '#0b1020');
  };
  PREVIEWS['preview_room.png'] = showcase('day');
  PREVIEWS['preview_room_night.png'] = showcase('night');
}
// Animated day / night preview. Needs ffmpeg on the PATH; skipped silently without it.
function afterPreviews(stats) {
  const out = join(OUT, 'preview_day_night.gif'), a = join(OUT, 'preview_room.png'), b = join(OUT, 'preview_room_night.png');
  if (existsSync(out) || !existsSync(a) || !existsSync(b)) return;
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-t', '3', '-i', a, '-loop', '1', '-t', '3', '-i', b, '-filter_complex',
    '[0][1]xfade=transition=fade:duration=1:offset=2[x];[1][0]xfade=transition=fade:duration=1:offset=2[y];[x][y]concat=n=2,fps=10,scale=1000:-1:flags=lanczos,split[p][q];[p]palettegen=max_colors=128[pal];[q][pal]paletteuse=dither=bayer', out]);
  if (r.status === 0) stats.written++; else if (!r.error) console.warn(`ffmpeg: ${String(r.stderr).trim()}`);
}


// ================================================================ main / worker
if (!isMainThread) {
  const byId = new Map(JOBS.map((j) => [j.id, j]));
  parentPort.on('message', (id) => {
    const t0 = Date.now(), res = byId.get(id).run();
    parentPort.postMessage({ id, ms: Date.now() - t0, sprites: res.map((s) => ({ name: s.name, w: s.im.w, h: s.im.h, d: s.im.d, ax: Math.round(s.ax), ay: Math.round(s.ay) })) }, res.map((s) => s.im.d.buffer));
  });
} else {
  await main();
}

async function main() {
  const CONFIG = 'office_tileset.json', t0 = Date.now();
  const config = existsSync(join(OUT, CONFIG)) ? JSON.parse(readFileSync(join(OUT, CONFIG), 'utf8')) : {
    meta: {
      style: 'voxel', projection: '2:1 dimetric', ground_angle_deg: 26.565, sheet_size: { w: SHEET, h: SHEET },
      tile: { w: TW, h: TH }, unit_elevation_px: ZS, wall_height_px: WH * ZS, wall_thickness_px: T * HW,
      cell: { w: CELL_W, h: CELL_H }, day_color: DAY, night_color: NIGHT,
      generator: 'scripts/office-voxel.mjs', sheets: [],
    },
    frames: {},
  };
  const only = process.env.OFFICE_ONLY ? new RegExp(process.env.OFFICE_ONLY) : null;
  const ids = new Set();
  for (const j of JOBS) { if (ids.has(j.id)) throw new Error(`duplicate job ${j.id}`); ids.add(j.id); }
  const pending = JOBS.filter((j) => (!only || only.test(j.id)) && j.outputs.some((n) => !config.frames[n]));
  const stats = { written: 0, kept: 0 };
  const sprites = new Map(); // name -> { im, ax, ay } for everything rendered or loaded this run
  const fileOf = (j, name) => `${j.folder}/${name}.png`;
  const done = [];
  if (pending.length) {
    const nw = Math.max(1, Math.min(pending.length, +process.env.OFFICE_JOBS || availableParallelism() - 1));
    console.log(`rendering ${pending.length} of ${JOBS.length} jobs on ${nw} threads...`);
    const byId = new Map(JOBS.map((j) => [j.id, j]));
    // biggest first is not known up front; a shared queue keeps all threads busy
    const queue = pending.map((j) => j.id);
    await Promise.all(Array.from({ length: nw }, () => new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url));
      const next = () => { const id = queue.shift(); if (id === undefined) { w.terminate(); resolve(); } else w.postMessage(id); };
      w.on('message', (msg) => {
        const j = byId.get(msg.id);
        for (const s of msg.sprites) {
          const rel = fileOf(j, s.name), p = join(OUT, rel);
          let im = { w: s.w, h: s.h, d: new Uint8Array(s.d.buffer, s.d.byteOffset, s.d.length) };
          if (existsSync(p)) {       // never overwrite: the file on disk wins
            const old = decodePng(readFileSync(p));
            if (old.w !== im.w || old.h !== im.h) console.warn(`! ${rel} exists with another size; its anchor may be off`);
            im = old; stats.kept++;
          } else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, encodePng(im)); stats.written++; }
          sprites.set(s.name, { im, ax: s.ax, ay: s.ay });
        }
        done.push(j);
        if (done.length % 20 === 0 || msg.ms > 60000) console.log(`  ${done.length}/${pending.length}  (${msg.id} ${(msg.ms / 1000).toFixed(1)}s)`);
        next();
      });
      w.on('error', reject);
      next();
    })));
  }

  // ---- pack the new sprites on new sheets (shelf packing, trimmed frames, catalogue order kept per shelf)
  const fresh = [];
  for (const j of JOBS.filter((x) => done.includes(x))) for (const name of j.outputs) {
    if (config.frames[name]) continue;
    const s = sprites.get(name), c = contentBox(s.im) || { x: 0, y: 0, w: 1, h: 1 };
    fresh.push({ name, j, s, c });
  }
  if (fresh.length) {
    const sheetName = () => {
      for (let n = 1; ; n++) { const f = n === 1 ? 'office_tileset.png' : `office_tileset_${n}.png`; if (!config.meta.sheets.includes(f) && !existsSync(join(OUT, f))) return f; }
    };
    const order = fresh.map((f, i) => ({ f, i })).sort((a, b) => b.f.c.h - a.f.c.h || a.i - b.i).map((o) => o.f);
    let sheet = null, file = null, x = 0, y = 0, rowH = 0;
    const flush = () => { if (!sheet) return; writeFileSync(join(OUT, file), encodePng(sheet)); stats.written++; config.meta.sheets.push(file); sheet = null; };
    const placed = new Map();
    for (const f of order) {
      const w = f.c.w + PAD, h = f.c.h + PAD;
      if (w > SHEET || h > SHEET) throw new Error(`${f.name} is larger than a sheet`);
      if (sheet && x + w > SHEET) { x = 0; y += rowH; rowH = 0; }
      if (sheet && y + h > SHEET) flush();
      if (!sheet) { sheet = img(SHEET, SHEET); file = sheetName(); x = 0; y = 0; rowH = 0; }
      over(sheet, crop(f.s.im, f.c.x, f.c.y, f.c.w, f.c.h), x, y);
      placed.set(f.name, { x, y, file });
      x += w; rowH = Math.max(rowH, h);
    }
    flush();
    for (const f of fresh) {   // config entries in catalogue order
      const p = placed.get(f.name), ax = f.s.ax - f.c.x, ay = f.s.ay - f.c.y;
      config.frames[f.name] = {
        frame: { x: p.x, y: p.y, w: f.c.w, h: f.c.h },
        anchor: { x: ax, y: ay },
        pivot: { x: +(ax / f.c.w).toFixed(4), y: +(ay / f.c.h).toFixed(4), origin: 'top-left' },
        sourceSize: { w: f.s.im.w, h: f.s.im.h }, spriteSourceSize: { x: f.c.x, y: f.c.y, w: f.c.w, h: f.c.h },
        file_anchor: { x: f.s.ax, y: f.s.ay },
        file: fileOf(f.j, f.name), label: f.j.label, ...f.j.meta, image: p.file,
      };
    }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, CONFIG), JSON.stringify(config, null, 2) + '\n');
  }

  // ---- previews (append-only as well)
  const get = (name) => {
    if (sprites.has(name)) return sprites.get(name);
    const f = config.frames[name];
    if (!f || !existsSync(join(OUT, f.file))) return null;
    const s = { im: decodePng(readFileSync(join(OUT, f.file))), ax: f.file_anchor.x, ay: f.file_anchor.y };
    sprites.set(name, s);
    return s;
  };
  if (!only) for (const [file, scene] of Object.entries(typeof PREVIEWS === 'undefined' ? {} : PREVIEWS)) {
    if (existsSync(join(OUT, file))) { stats.kept++; continue; }
    const im = composeScene(scene, get);
    if (im) { writeFileSync(join(OUT, file), encodePng(im)); stats.written++; }
  }
  if (!only && typeof afterPreviews === 'function') afterPreviews(stats);
  console.log(`office-voxel: ${stats.written} files written, ${stats.kept} existing files kept, ${Object.keys(config.frames).length} frames in ${CONFIG} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
