#!/usr/bin/env node
// Deterministic generator for Love AIsland's art, built from the licensed
// Sunnyside World asset pack (apps/web/assets-src/sunnyside/, not
// redistributed -- only crops baked into public/assets/ are shipped):
//   - public/assets/tileset.png    (repacked 16x16 terrain/decor tiles)
//   - public/assets/contestant.png (repacked 24x22 character animation frames)
//   - public/assets/island-map.json (baked ~60x60 island: ground, decor, walkable)
//
// Re-run with `node scripts/generate-assets.mjs` whenever the map layout
// needs to change. Output is committed so the client (and, later, the sim
// server) can consume island-map.json without re-running this or touching
// the source pack.
//
// ---------------------------------------------------------------------------
// Sunnyside source map (coordinates into assets-src/sunnyside/tileset_beta_1280.png,
// a 1280x1280 sheet on a 16px grid -- 80 columns x 80 rows). Found by cropping
// grid-aligned regions with scripts/.tmp-inspect tooling (not committed) and
// sampling pixel colors to identify clean, isolated 16x16 cells:
//
//   Flat grass            col 34, row 10  (rgb 99,199,77; col35/36 row10 are pixel-identical --
//                                          note col31 row9 is the *same* color but has a baked-in
//                                          shadow band along its bottom edge, so it's avoided)
//   Flat shallow water    col 39, row 9   (rgb 50,184,232 -- matches the shore tiles' water tone)
//   Flat sand             col 6,  row 1   (palette-reference swatch strip)
//   Flat sand (speckled)  col 11, row 1   (same strip, has dot texture baked in)
//   Grass/water straight  col 37, row 9   (west half grass, east half water -- rotated x4 for N/E/S/W)
//     edge template
//   Grass/water diagonal  col 30, row 9   (NE grass / SW water -- rotated x4 for the 4 outer corners)
//     corner template
//   Bush icon              col 34, row 3   (small round shrub, single 16x16 tile)
//   Rock icon              col 41, row 5   (grey boulder, single 16x16 tile)
//   Flower A (warm)         col 39, row 4
//   Flower B (pale)         col 43, row 4
//   Flower C (daisy)        px (704,62) -- raw crop, shifted 2px up from its nominal cell
//   Sand/dirt patch decal  px (90,670) 80x80  (free-form octagonal path patch, not tile-aligned
//                                              in the source -- copied as raw pixels, then each
//                                              16x16 slice is alpha-composited onto flat grass so
//                                              every ground-layer cell it produces is opaque)
//
// Trees are NOT packed into the 16px tileset -- the pack's actual tree art is
// a multi-tile canopy, much bigger than one grid cell, so each variant is
// cropped at its native size (flood-fill bbox, not grid-aligned) and shipped
// as its own standalone PNG. IslandScene places these as plain Phaser Image
// game objects positioned from the `trees` array baked into island-map.json,
// not as tilemap tiles:
//   Tree big A  assets-src/sunnyside/tileset_v01_1024.png, raw px (11,43) 90x83
//               (full rounded canopy over a mound/shadow base)
//   Tree big B  assets-src/sunnyside/tileset_beta_1280.png, raw px (1020,20) 40x40
//               (rounder, smaller canopy -- an isolated unit lifted out of the
//               sheet's hex-packed forest cluster near its top-right corner)
//
// Coastline: a 1-tile sand ring runs between grass and water all the way
// around the island (see buildTerrainGrid). Since this pack ships no
// dedicated grass/sand or sand/water autotile art, the grass/water edge and
// corner templates above are reused as *shape* masks only -- each mask pixel
// is reclassified as "near" or "far" (same isWaterish split used to sort the
// 4 rotations into N/E/S/W and NE/NW/SE/SW) and then recolored flat with
// whichever two terrain colors actually meet at that boundary, producing a
// grass<->sand edge/corner set and a separate sand<->water edge/corner set
// from the exact same jagged shapes without any new source art.
//
// Character source: assets-src/sunnyside/character/PNG/WITH_FX/spr_*_stripN.png,
// 96x64 per frame. The character silhouette sits inside px [37,19]-[61,41] of
// every frame across idle/walking/death (union alpha bbox), so all three
// strips are cropped to that one 24x22 box for a consistent spritesheet.
// ---------------------------------------------------------------------------

import { PNG } from "pngjs";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "assets");
const SRC_DIR = path.join(ROOT, "assets-src", "sunnyside");
mkdirSync(OUT_DIR, { recursive: true });

const TILE = 16;
const SEED = 1337;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) so every run of this script produces byte-identical
// output. Nothing in this file uses Math.random().
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp255(v) {
  return Math.max(0, Math.min(255, v | 0));
}

// ---------------------------------------------------------------------------
// Raw RGBA tile buffers (16x16x4). Small, dependency-free image ops so we can
// crop/rotate/composite pack pixels without dragging in a canvas library.
// ---------------------------------------------------------------------------
function makeTile(size = TILE) {
  return { size, data: Buffer.alloc(size * size * 4) };
}

function tileGetPx(tile, x, y) {
  const i = (tile.size * y + x) << 2;
  return [tile.data[i], tile.data[i + 1], tile.data[i + 2], tile.data[i + 3]];
}
function tileSetPx(tile, x, y, r, g, b, a) {
  const i = (tile.size * y + x) << 2;
  tile.data[i] = r;
  tile.data[i + 1] = g;
  tile.data[i + 2] = b;
  tile.data[i + 3] = a;
}

// Crop a size x size tile out of a source PNG at tile-grid (col,row).
function cropTile(sheet, col, row, size = TILE) {
  const out = makeTile(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = (sheet.width * (row * size + y) + (col * size + x)) << 2;
      const di = (y * size + x) << 2;
      sheet.data.copy(out.data, di, si, si + 4);
    }
  }
  return out;
}

// Crop a size x size tile out of a source PNG at raw pixel coordinates
// (used for the free-form sand-patch decal, which isn't grid-aligned).
function cropTileRaw(sheet, px, py, size = TILE) {
  const out = makeTile(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = px + x;
      const sy = py + y;
      if (sx < 0 || sy < 0 || sx >= sheet.width || sy >= sheet.height) continue;
      const si = (sheet.width * sy + sx) << 2;
      const di = (y * size + x) << 2;
      sheet.data.copy(out.data, di, si, si + 4);
    }
  }
  return out;
}

// Crop an arbitrary w x h rectangle out of a source PNG at raw pixel
// coordinates (used for the tree variants, which aren't square and aren't
// grid-aligned). Returns a plain {width,height,data} buffer, not a `tile`
// (tile helpers below all assume square).
function cropRect(sheet, px, py, w, h) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = px + x;
      const sy = py + y;
      if (sx < 0 || sy < 0 || sx >= sheet.width || sy >= sheet.height) continue;
      const si = (sheet.width * sy + sx) << 2;
      const di = (y * w + x) << 2;
      sheet.data.copy(data, di, si, si + 4);
    }
  }
  return { width: w, height: h, data };
}

function cloneTile(tile) {
  return { size: tile.size, data: Buffer.from(tile.data) };
}

// Rotate a square tile 90 degrees. Direction doesn't matter here -- callers
// apply this 0-3 times and self-detect which cardinal/corner each result
// represents (see classifyEdgeWaterSide/classifyCornerWaterCorner), so an
// accidental CW/CCW mixup would still land on 4 distinct, correctly-labeled
// orientations.
function rotate90(tile) {
  const { size, data } = tile;
  const out = makeTile(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = y;
      const sy = size - 1 - x;
      const si = (size * sy + sx) << 2;
      const di = (size * y + x) << 2;
      data.copy(out.data, di, si, si + 4);
    }
  }
  return out;
}

// Alpha-composite `top` over `bottom`, returning a new opaque-where-bottom-is
// tile. Used to lay the transparent-cornered sand-patch decal over flat grass
// so every resulting ground-layer cell is fully opaque.
function compositeOver(bottom, top) {
  const out = cloneTile(bottom);
  for (let y = 0; y < out.size; y++) {
    for (let x = 0; x < out.size; x++) {
      const [tr, tg, tb, ta] = tileGetPx(top, x, y);
      if (ta === 0) continue;
      if (ta === 255) {
        tileSetPx(out, x, y, tr, tg, tb, 255);
        continue;
      }
      const [br, bg, bb] = tileGetPx(out, x, y);
      const a = ta / 255;
      tileSetPx(
        out,
        x,
        y,
        Math.round(tr * a + br * (1 - a)),
        Math.round(tg * a + bg * (1 - a)),
        Math.round(tb * a + bb * (1 - a)),
        255,
      );
    }
  }
  return out;
}

// A pixel "reads" as water rather than grass/sand when it's bluer than it is
// green. Cheap and reliable for this pack's flat, saturated terrain colors.
function isWaterish([, g, b, a]) {
  return a > 10 && b > g;
}

// Build a boolean per-pixel mask (true = the "far" side, e.g. the water half
// of a grass/water edge template) so an edge/corner template's *shape* can be
// reused for a different pair of colors. See recolorFromMask.
function buildFarMask(tile) {
  const mask = [];
  for (let y = 0; y < tile.size; y++) {
    const row = [];
    for (let x = 0; x < tile.size; x++) row.push(isWaterish(tileGetPx(tile, x, y)));
    mask.push(row);
  }
  return mask;
}

// Flat-recolor a mask built by buildFarMask: `near` color where the mask is
// false, `far` color where it's true. Both colors are opaque solids sampled
// from this pack's own flat tiles, so this produces a same-shaped edge/corner
// tile for a terrain pair (e.g. sand/water) that has no dedicated source art.
function recolorFromMask(mask, size, near, far) {
  const out = makeTile(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = mask[y][x] ? far : near;
      tileSetPx(out, x, y, c[0], c[1], c[2], 255);
    }
  }
  return out;
}

// Recolor a terrain mask, then ink both sides of the seam. The earlier flat
// two-color boundaries made the coast look like a prototype cutout; a dark
// lip on the land side plus a bright rim on the far side gives grass depth
// and turns the sand/water boundary into readable pixel foam.
function recolorOutlinedBoundary(mask, size, near, far, nearEdge, farEdge) {
  const out = recolorFromMask(mask, size, near, far);
  const touchesOpposite = (x, y) => {
    const here = mask[y][x];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < size && ny < size && mask[ny][nx] !== here) return true;
    }
    return false;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!touchesOpposite(x, y)) continue;
      const c = mask[y][x] ? farEdge : nearEdge;
      // Skip a regular subset of far-side pixels so foam/highlights retain a
      // hand-dithered edge rather than reading as a vector stroke.
      if (mask[y][x] && (x + y) % 4 === 0) continue;
      tileSetPx(out, x, y, c[0], c[1], c[2], 255);
    }
  }
  return out;
}

// Straight-edge templates split the tile into a water half and a grass half
// along one full border. Detect which border (N/E/S/W) is ~100% water.
function classifyEdgeWaterSide(tile) {
  const n = tile.size;
  const sides = {
    N: Array.from({ length: n }, (_, x) => tileGetPx(tile, x, 0)),
    S: Array.from({ length: n }, (_, x) => tileGetPx(tile, x, n - 1)),
    W: Array.from({ length: n }, (_, y) => tileGetPx(tile, 0, y)),
    E: Array.from({ length: n }, (_, y) => tileGetPx(tile, n - 1, y)),
  };
  let best = null;
  let bestFrac = -1;
  for (const [dir, pixels] of Object.entries(sides)) {
    const frac = pixels.filter(isWaterish).length / pixels.length;
    if (frac > bestFrac) {
      bestFrac = frac;
      best = dir;
    }
  }
  if (bestFrac < 0.85) throw new Error(`edge template: no clean water side found (best ${bestFrac})`);
  return best;
}

// Diagonal-corner templates put water in one quadrant. Detect which 4x4
// corner block is most water-dominant.
function classifyCornerWaterCorner(tile) {
  const n = tile.size;
  const half = n / 2;
  const corners = {
    NW: { x0: 0, y0: 0 },
    NE: { x0: half, y0: 0 },
    SW: { x0: 0, y0: half },
    SE: { x0: half, y0: half },
  };
  let best = null;
  let bestFrac = -1;
  for (const [dir, { x0, y0 }] of Object.entries(corners)) {
    let water = 0;
    let total = 0;
    for (let y = y0; y < y0 + half; y++) {
      for (let x = x0; x < x0 + half; x++) {
        total++;
        if (isWaterish(tileGetPx(tile, x, y))) water++;
      }
    }
    const frac = water / total;
    if (frac > bestFrac) {
      bestFrac = frac;
      best = dir;
    }
  }
  if (bestFrac < 0.6) throw new Error(`corner template: no clean water corner found (best ${bestFrac})`);
  return best;
}

function rotationsOf(tile) {
  const r0 = tile;
  const r1 = rotate90(r0);
  const r2 = rotate90(r1);
  const r3 = rotate90(r2);
  return [r0, r1, r2, r3];
}

// Deterministic per-pixel speckle: nudges a color toward `tint` on a subset
// of pixels, seeded so re-running the script is byte-identical. Used to turn
// one sourced flat-grass tile into 2 more variants without inventing colors.
function speckleTile(tile, rand, tint, chance, amount) {
  const out = cloneTile(tile);
  for (let y = 0; y < out.size; y++) {
    for (let x = 0; x < out.size; x++) {
      const [r, g, b, a] = tileGetPx(out, x, y);
      if (a === 0 || rand() >= chance) continue;
      const t = amount;
      tileSetPx(
        out,
        x,
        y,
        clamp255(r + (tint[0] - r) * t),
        clamp255(g + (tint[1] - g) * t),
        clamp255(b + (tint[2] - b) * t),
        a,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Load the Sunnyside sheet and build every named tile the map needs.
// ---------------------------------------------------------------------------
const sheet = PNG.sync.read(readFileSync(path.join(SRC_DIR, "tileset_beta_1280.png")));
const sheetV01 = PNG.sync.read(readFileSync(path.join(SRC_DIR, "tileset_v01_1024.png")));
const rand = mulberry32(SEED);

// (31,9) is the same green but has a baked-in darker band along its bottom
// edge (it sits under a shadow in the source's example scene); tiled
// repeatedly that band reads as an ugly horizontal stripe pattern. (34,10)
// is pixel-identical in color but genuinely flat, so use that instead.
const grass1 = cropTile(sheet, 34, 10);
const grass2 = speckleTile(grass1, rand, [72, 168, 60], 0.22, 0.55); // darker clover fleck
const grass3 = speckleTile(grass1, rand, [140, 214, 96], 0.16, 0.5); // lighter sun-fleck
const water = cropTile(sheet, 39, 9);
function addWaterRipples(tile, phase) {
  const out = cloneTile(tile);
  const light = [91, 207, 238];
  const deep = [35, 161, 218];
  for (let y = 2 + phase; y < TILE; y += 6) {
    const x0 = (y * 3 + phase * 5) % 11;
    for (let x = x0; x < Math.min(TILE, x0 + 4); x++) {
      const c = x === x0 || x === x0 + 3 ? deep : light;
      tileSetPx(out, x, y, c[0], c[1], c[2], 255);
    }
  }
  return out;
}
const water2 = addWaterRipples(water, 0);
const water3 = addWaterRipples(water, 2);
// Both sand cells in the reference swatch strip share a defect the previous
// 1px patch didn't actually fix: rows 0-3 of the 16px cell are fully
// transparent (a strip-layout margin, not specific to this swatch), and the
// flat swatch additionally bleeds the neighboring water swatch's blue across
// columns 0-3 of its opaque rows -- sampled and confirmed with a per-pixel
// scan, not assumed. Since "flat sand" is meant to be a single solid color
// anyway, build it from one confirmed-clean interior pixel instead of
// trusting the raw crop.
const sandFlatRaw = cropTile(sheet, 6, 1);
const sandFlatColor = tileGetPx(sandFlatRaw, 10, 10); // inside the clean rows/cols, past both defects
const sandFlat = makeTile();
for (let y = 0; y < sandFlat.size; y++) {
  for (let x = 0; x < sandFlat.size; x++) tileSetPx(sandFlat, x, y, ...sandFlatColor);
}
// The speckled swatch's dot texture is genuine and worth keeping (unlike the
// flat one, it has no color bleed), so patch only its transparent top margin
// by wrapping its own clean band upward instead of flattening it.
const sandSpeckleRaw = cropTile(sheet, 11, 1);
const SAND_CLEAN_TOP = 4; // rows [0, SAND_CLEAN_TOP) are the transparent strip margin
const sandSpeckle = cloneTile(sandSpeckleRaw);
const speckleBandHeight = sandSpeckle.size - SAND_CLEAN_TOP;
for (let y = 0; y < SAND_CLEAN_TOP; y++) {
  const srcY = SAND_CLEAN_TOP + (y % speckleBandHeight);
  for (let x = 0; x < sandSpeckle.size; x++) {
    tileSetPx(sandSpeckle, x, y, ...tileGetPx(sandSpeckleRaw, x, srcY));
  }
}
const blank = makeTile(); // fully transparent; data is already zeroed

const edgeSource = cropTile(sheet, 37, 9);
const edgeByDir = {};
for (const variant of rotationsOf(edgeSource)) {
  edgeByDir[classifyEdgeWaterSide(variant)] = variant;
}
for (const dir of ["N", "E", "S", "W"]) {
  if (!edgeByDir[dir]) throw new Error(`missing rotated edge tile for direction ${dir}`);
}

const cornerSource = cropTile(sheet, 30, 9);
const cornerByDir = {};
for (const variant of rotationsOf(cornerSource)) {
  cornerByDir[classifyCornerWaterCorner(variant)] = variant;
}
for (const dir of ["NE", "NW", "SE", "SW"]) {
  if (!cornerByDir[dir]) throw new Error(`missing rotated corner tile for corner ${dir}`);
}

// Recolored edge/corner sets for the beach ring (see the big comment block up
// top): the grass/water templates loaded above are reused purely for their
// jagged shape, recolored flat per terrain pair. Colors are sampled straight
// from this pack's own flat tiles, not hand-picked, so they always match.
const grassColor = tileGetPx(grass1, 8, 8);
const sandColor = sandFlatColor;
const waterColor = tileGetPx(water, 8, 8);

const grassSandEdgeByDir = {};
const sandWaterEdgeByDir = {};
for (const dir of ["N", "E", "S", "W"]) {
  const mask = buildFarMask(edgeByDir[dir]);
  grassSandEdgeByDir[dir] = recolorOutlinedBoundary(mask, TILE, grassColor, sandColor, [50, 145, 47], [255, 224, 119]);
  sandWaterEdgeByDir[dir] = recolorOutlinedBoundary(mask, TILE, sandColor, waterColor, [205, 166, 70], [177, 235, 244]);
}

const grassSandCornerByDir = {};
const sandWaterCornerByDir = {};
for (const dir of ["NE", "NW", "SE", "SW"]) {
  const mask = buildFarMask(cornerByDir[dir]);
  grassSandCornerByDir[dir] = recolorOutlinedBoundary(mask, TILE, grassColor, sandColor, [50, 145, 47], [255, 224, 119]);
  sandWaterCornerByDir[dir] = recolorOutlinedBoundary(mask, TILE, sandColor, waterColor, [205, 166, 70], [177, 235, 244]);
}

// Foliage: cropped at native (non-16px-grid) size and shipped as standalone
// PNGs, rendered by IslandScene as Image objects (not tilemap tiles) so a
// canopy can overhang the sprites beneath it. All three are lifted from the
// v01 sheet's isolated foliage column (found via scripts/.tmp-inspect
// connected-component bbox tooling), so every one carries the pack's own soft
// contact shadow and grass tufts around its base -- that built-in shadow is
// what makes them read as planted in the ground instead of pasted on top of
// it.
//
// Both earlier variants were bad crops and are gone: the old tree1 was a
// 40x40 slice out of a hex-packed forest cluster (hard rectangular edge, a
// chopped-off neighbor's trunk along its base), and the old tree0 wasn't a
// tree at all -- it was the pack's octagonal walled planter/platform (flat
// top, brown retaining walls, a ramp), which read as a fenced pit dropped
// onto the grass. The pack ships no cleanly-isolable *big* tree (its larger
// trees only exist hex-packed into an overlapping grove), so the design is a
// canopy of these three well-blended small/medium pieces rather than one
// mis-cropped landmark.
//   tree0  medium green tree with a trunk + shadow (the staple)
//   tree1  medium fruit tree (orange blooms) -- a color accent
//   tree2  low round bush with a shadow (the small-foliage variant)
const treeMed = cropRect(sheetV01, 67, 342, 26, 34);
const treeFruit = cropRect(sheetV01, 35, 342, 26, 34);
const treeBush = cropRect(sheetV01, 67, 310, 25, 21);
// IslandScene places each with origin (0.5, 1): the bottom-center of the
// image (the center of its baked contact shadow) lands on the trunk tile.
export const TREE_VARIANTS = [
  { file: "tree0.png", image: treeMed },
  { file: "tree1.png", image: treeFruit },
  { file: "tree2.png", image: treeBush },
];

// Large set pieces from the same source pack. These stay standalone so their
// multi-tile silhouettes, contact shadows, and overhangs remain intact.
// Map placement reserves their footprints, so they add visual structure
// without changing the movement engine's grid contract.
export const LANDMARK_VARIANTS = [
  { kind: "villa", file: "landmark-villa.png", image: cropRect(sheetV01, 476, 41, 88, 84), tilesW: 6, tilesH: 6 },
  { kind: "pond", file: "landmark-pond.png", image: cropRect(sheetV01, 94, 125, 52, 69), tilesW: 4, tilesH: 5 },
  { kind: "garden", file: "landmark-garden.png", image: cropRect(sheetV01, 16, 240, 80, 61), tilesW: 5, tilesH: 4 },
  { kind: "shrine", file: "landmark-shrine.png", image: cropRect(sheetV01, 112, 240, 96, 80), tilesW: 6, tilesH: 5 },
  { kind: "dock", file: "landmark-dock.png", image: cropRect(sheetV01, 202, 128, 28, 61), tilesW: 2, tilesH: 4 },
];

const bush = cropTile(sheet, 34, 3);
const rock = cropTile(sheet, 41, 5);
// These 3 flower icons aren't grid-aligned in the source (their bounding
// boxes spill a pixel or two past the nominal 16px cell), so each is picked
// individually and the daisy is a raw-pixel crop offset by the 2px it's
// shifted up from its cell.
const flowerA = cropTile(sheet, 39, 4); // warm yellow/orange bloom
const flowerB = cropTile(sheet, 43, 4); // pale blue-grey and yellow bloom
const flowerC = cropTileRaw(sheet, 44 * TILE, 4 * TILE - 2); // white daisy, orange center

// Sand/dirt patch decal: an 80x80 free-form octagonal path, composited onto
// flat grass tile-by-tile so it can be stamped into the (opaque) ground layer.
const PATCH_TILES = 5; // 5x5 = 80x80
const sandPatch = [];
for (let ty = 0; ty < PATCH_TILES; ty++) {
  const row = [];
  for (let tx = 0; tx < PATCH_TILES; tx++) {
    const raw = cropTileRaw(sheet, 90 + tx * TILE, 670 + ty * TILE);
    row.push(compositeOver(grass1, raw));
  }
  sandPatch.push(row);
}

// ---------------------------------------------------------------------------
// Pack everything into one small served sheet. 8 columns; ground/decor
// singles in rows 0-2, the 5x5 sand-patch block in rows 3-7.
//
// Each cell is extruded by 1px: the tile's own edge pixels are duplicated
// into a 1px border around it, and cells are laid out with that border as
// spacing (tileWidth=16, margin=1, spacing=2 -- see IslandScene's
// addTilesetImage call). Without this, sampling the tileset at the
// non-integer zoom levels the fit-to-viewport ladder rung produces bleeds a
// sliver of the *next* tile in the atlas into the edge of the current one,
// showing up as thin seam lines across the map at small fit-zoom.
// ---------------------------------------------------------------------------
const PACK_COLS = 8;
const PACK_ROWS = 8;
const EXTRUDE = 1;
const STRIDE = TILE + EXTRUDE * 2;
const packed = new PNG({ width: PACK_COLS * STRIDE, height: PACK_ROWS * STRIDE });
for (let i = 0; i < packed.data.length; i += 4) packed.data[i + 3] = 0; // transparent base

function setPackedPx(x, y, r, g, b, a) {
  const di = (packed.width * y + x) << 2;
  packed.data[di] = r;
  packed.data[di + 1] = g;
  packed.data[di + 2] = b;
  packed.data[di + 3] = a;
}

function blit(tile, col, row) {
  const ox = col * STRIDE + EXTRUDE;
  const oy = row * STRIDE + EXTRUDE;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const [r, g, b, a] = tileGetPx(tile, x, y);
      setPackedPx(ox + x, oy + y, r, g, b, a);
    }
  }
  // Extrude: duplicate the outermost row/col/corner pixels into the 1px
  // border so nearest-neighbor sampling just outside the tile's UV rect
  // (which happens at non-integer zoom) still reads the tile's own edge
  // color instead of bleeding in whatever sits next to it in the atlas.
  for (let x = 0; x < TILE; x++) {
    setPackedPx(ox + x, oy - 1, ...tileGetPx(tile, x, 0));
    setPackedPx(ox + x, oy + TILE, ...tileGetPx(tile, x, TILE - 1));
  }
  for (let y = 0; y < TILE; y++) {
    setPackedPx(ox - 1, oy + y, ...tileGetPx(tile, 0, y));
    setPackedPx(ox + TILE, oy + y, ...tileGetPx(tile, TILE - 1, y));
  }
  setPackedPx(ox - 1, oy - 1, ...tileGetPx(tile, 0, 0));
  setPackedPx(ox + TILE, oy - 1, ...tileGetPx(tile, TILE - 1, 0));
  setPackedPx(ox - 1, oy + TILE, ...tileGetPx(tile, 0, TILE - 1));
  setPackedPx(ox + TILE, oy + TILE, ...tileGetPx(tile, TILE - 1, TILE - 1));
}
const idx = (col, row) => row * PACK_COLS + col;
export const TILESET_MARGIN = EXTRUDE;
export const TILESET_SPACING = EXTRUDE * 2;

export const TILE_INDEX = {
  GRASS_1: idx(0, 0),
  GRASS_2: idx(1, 0),
  GRASS_3: idx(2, 0),
  WATER: idx(3, 0),
  WATER_2: idx(7, 0),
  SAND: idx(4, 0),
  SAND_SPECKLE: idx(5, 0),
  BLANK: idx(6, 0), // reserved fully-transparent cell, safe "no decoration" sentinel

  // Grass <-> sand ring boundary (inner edge of the beach).
  GRASS_SAND_EDGE_N: idx(0, 1),
  GRASS_SAND_EDGE_E: idx(1, 1),
  GRASS_SAND_EDGE_S: idx(2, 1),
  GRASS_SAND_EDGE_W: idx(3, 1),
  GRASS_SAND_CORNER_NE: idx(4, 1),
  GRASS_SAND_CORNER_NW: idx(5, 1),
  GRASS_SAND_CORNER_SE: idx(6, 1),
  GRASS_SAND_CORNER_SW: idx(7, 1),

  BUSH: idx(1, 2),
  ROCK: idx(2, 2),
  FLOWER_A: idx(3, 2),
  FLOWER_B: idx(4, 2),
  FLOWER_C: idx(5, 2),
  WATER_3: idx(0, 2),

  // Sand <-> water ring boundary (outer/coast edge of the beach). Free slots
  // outside the 5x5 sand-patch block (which only occupies cols 0-4 of rows 3-7).
  SAND_WATER_EDGE_N: idx(5, 3),
  SAND_WATER_EDGE_E: idx(6, 3),
  SAND_WATER_EDGE_S: idx(7, 3),
  SAND_WATER_EDGE_W: idx(5, 4),
  SAND_WATER_CORNER_NE: idx(6, 4),
  SAND_WATER_CORNER_NW: idx(7, 4),
  SAND_WATER_CORNER_SE: idx(5, 5),
  SAND_WATER_CORNER_SW: idx(6, 5),
};
// 5x5 sand-patch block base (top-left tile index) + stride, rows 3-7 cols 0-4.
export const SAND_PATCH_BASE = idx(0, 3);
export const SAND_PATCH_SIZE = PATCH_TILES;
export const PACK_COLS_EXPORT = PACK_COLS;

blit(grass1, 0, 0);
blit(grass2, 1, 0);
blit(grass3, 2, 0);
blit(water, 3, 0);
blit(water2, 7, 0);
blit(sandFlat, 4, 0);
blit(sandSpeckle, 5, 0);
blit(blank, 6, 0);

blit(grassSandEdgeByDir.N, 0, 1);
blit(grassSandEdgeByDir.E, 1, 1);
blit(grassSandEdgeByDir.S, 2, 1);
blit(grassSandEdgeByDir.W, 3, 1);
blit(grassSandCornerByDir.NE, 4, 1);
blit(grassSandCornerByDir.NW, 5, 1);
blit(grassSandCornerByDir.SE, 6, 1);
blit(grassSandCornerByDir.SW, 7, 1);

blit(bush, 1, 2);
blit(rock, 2, 2);
blit(flowerA, 3, 2);
blit(flowerB, 4, 2);
blit(flowerC, 5, 2);
blit(water3, 0, 2);

for (let ty = 0; ty < PATCH_TILES; ty++) {
  for (let tx = 0; tx < PATCH_TILES; tx++) {
    blit(sandPatch[ty][tx], tx, 3 + ty);
  }
}

blit(sandWaterEdgeByDir.N, 5, 3);
blit(sandWaterEdgeByDir.E, 6, 3);
blit(sandWaterEdgeByDir.S, 7, 3);
blit(sandWaterEdgeByDir.W, 5, 4);
blit(sandWaterCornerByDir.NE, 6, 4);
blit(sandWaterCornerByDir.NW, 7, 4);
blit(sandWaterCornerByDir.SE, 5, 5);
blit(sandWaterCornerByDir.SW, 6, 5);

writeFileSync(path.join(OUT_DIR, "tileset.png"), PNG.sync.write(packed));

// Tree canopies ship as standalone (non-atlas, non-extruded) PNGs -- each is
// the only content in its file, so there's no neighboring-tile bleed risk to
// guard against at fractional zoom.
for (const variant of TREE_VARIANTS) {
  const out = new PNG({ width: variant.image.width, height: variant.image.height });
  variant.image.data.copy(out.data);
  writeFileSync(path.join(OUT_DIR, variant.file), PNG.sync.write(out));
}
for (const variant of LANDMARK_VARIANTS) {
  const out = new PNG({ width: variant.image.width, height: variant.image.height });
  variant.image.data.copy(out.data);
  writeFileSync(path.join(OUT_DIR, variant.file), PNG.sync.write(out));
}

// ---------------------------------------------------------------------------
// Character spritesheet: idle/walking/death strips from the Sunnyside base
// character, cropped to one consistent 24x22 box (px [37,19]-[61,41] of the
// source's 96x64 frames -- the union alpha bbox across all three strips) so
// the frame size and feet position stay stable across animations.
// ---------------------------------------------------------------------------
const CHAR_SRC_FRAME_W = 96; // source frames are 96x64; only the width is needed to step between frames
const CHAR_CROP_X = 37;
const CHAR_CROP_Y = 19;
export const CHAR_FRAME_W = 24;
export const CHAR_FRAME_H = 22;
// Feet sit at source y=38 (consistent across idle/walking/death); as a
// fraction of the cropped frame height, that's the sprite's vertical origin.
export const CHAR_ORIGIN_Y = (38 - CHAR_CROP_Y) / CHAR_FRAME_H;

function loadCharStrip(fxDir, name) {
  return PNG.sync.read(readFileSync(path.join(SRC_DIR, "character", "PNG", fxDir, name)));
}

// cropTileRaw assumes square tiles; character frames are 24x22, so crop by hand.
function cropCharFrame(png, frameIndex) {
  const ox = frameIndex * CHAR_SRC_FRAME_W + CHAR_CROP_X;
  const oy = CHAR_CROP_Y;
  const out = { w: CHAR_FRAME_W, h: CHAR_FRAME_H, data: Buffer.alloc(CHAR_FRAME_W * CHAR_FRAME_H * 4) };
  for (let y = 0; y < CHAR_FRAME_H; y++) {
    for (let x = 0; x < CHAR_FRAME_W; x++) {
      const sx = ox + x;
      const sy = oy + y;
      const si = (png.width * sy + sx) << 2;
      const di = (out.w * y + x) << 2;
      png.data.copy(out.data, di, si, si + 4);
    }
  }
  return out;
}

const idleStrip = loadCharStrip("WITH_FX", "spr_idle_strip9.png");
const walkStrip = loadCharStrip("WITH_FX", "spr_walking_strip8.png");
const deathStrip = loadCharStrip("WITH_FX", "spr_death_strip13.png");

const IDLE_FRAMES = 9;
const WALK_FRAMES = 8;
const DEATH_FRAMES = 13;

export const CHAR_ANIM = {
  idle: { start: 0, end: IDLE_FRAMES - 1 },
  walk: { start: IDLE_FRAMES, end: IDLE_FRAMES + WALK_FRAMES - 1 },
  death: { start: IDLE_FRAMES + WALK_FRAMES, end: IDLE_FRAMES + WALK_FRAMES + DEATH_FRAMES - 1 },
};
const TOTAL_FRAMES = IDLE_FRAMES + WALK_FRAMES + DEATH_FRAMES;

const charSheet = new PNG({ width: TOTAL_FRAMES * CHAR_FRAME_W, height: CHAR_FRAME_H });
for (let i = 0; i < charSheet.data.length; i += 4) charSheet.data[i + 3] = 0;

function blitChar(frame, frameIndex) {
  for (let y = 0; y < CHAR_FRAME_H; y++) {
    for (let x = 0; x < CHAR_FRAME_W; x++) {
      const si = (frame.w * y + x) << 2;
      const di = (charSheet.width * y + (frameIndex * CHAR_FRAME_W + x)) << 2;
      charSheet.data[di] = frame.data[si];
      charSheet.data[di + 1] = frame.data[si + 1];
      charSheet.data[di + 2] = frame.data[si + 2];
      charSheet.data[di + 3] = frame.data[si + 3];
    }
  }
}

let fi = 0;
for (let f = 0; f < IDLE_FRAMES; f++) blitChar(cropCharFrame(idleStrip, f), fi++);
for (let f = 0; f < WALK_FRAMES; f++) blitChar(cropCharFrame(walkStrip, f), fi++);
for (let f = 0; f < DEATH_FRAMES; f++) blitChar(cropCharFrame(deathStrip, f), fi++);

writeFileSync(path.join(OUT_DIR, "contestant.png"), PNG.sync.write(charSheet));

// ---------------------------------------------------------------------------
// Island map: radial falloff + smooth value noise, thresholded into a single
// water/grass split (organic coastline), then autotiled with the sourced
// edge/corner pieces above. Decor (tree/bush/rock/flowers) and a few sand
// patches are scattered through the grass interior.
// ---------------------------------------------------------------------------
const MAP_W = 60;
const MAP_H = 60;

function buildNoiseGrid(rand, gw, gh) {
  const g = [];
  for (let j = 0; j < gh; j++) {
    const row = [];
    for (let i = 0; i < gw; i++) row.push(rand());
    g.push(row);
  }
  return g;
}

function sampleNoise(grid, gw, gh, u, v) {
  const fx = u * (gw - 1);
  const fy = v * (gh - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(gw - 1, x0 + 1);
  const y1 = Math.min(gh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const lerp = (a, b, t) => a + (b - a) * t;
  const top = lerp(grid[y0][x0], grid[y0][x1], tx);
  const bot = lerp(grid[y1][x0], grid[y1][x1], tx);
  return lerp(top, bot, ty);
}

// Majority-neighbor smoothing on the boolean land grid: kills single-cell
// noise (stray 1-tile islands/lakes) while preserving the organic coastline.
function smoothLand(land, w, h, passes) {
  let cur = land;
  for (let p = 0; p < passes; p++) {
    const next = cur.map((row) => row.slice());
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let landCount = 0;
        let total = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            total++;
            if (cur[ny][nx]) landCount++;
          }
        }
        next[y][x] = landCount * 2 >= total;
      }
    }
    cur = next;
  }
  return cur;
}

function buildLandGrid(rand) {
  const cx = (MAP_W - 1) / 2;
  const cy = (MAP_H - 1) / 2;
  const maxR = 23;
  const noiseGrid = buildNoiseGrid(rand, 10, 10);

  const land = [];
  for (let y = 0; y < MAP_H; y++) {
    const row = [];
    for (let x = 0; x < MAP_W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy) / maxR;
      const falloff = 1 - r;
      const n = sampleNoise(noiseGrid, 10, 10, x / MAP_W, y / MAP_H);
      const elevation = falloff * 1.15 + (n - 0.5) * 0.42;
      row.push(elevation > 0.22);
    }
    land.push(row);
  }
  return smoothLand(land, MAP_W, MAP_H, 2);
}

// Terrain has 3 tiers now, not 2: WATER / SAND (a 1-tile beach ring) / GRASS
// (everything else). A cell is SAND when it's land but has a water cell
// among its 8 neighbors (diagonal included, so the ring stays continuous
// through outer convex corners, not just the 4 cardinal directions) -- this
// guarantees grass never touches water directly, so the two autotile passes
// below (grass<->sand, sand<->water) never need to handle a 3-color cell.
function buildTerrainGrid(land) {
  const isLand = (x, y) => {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false; // OOB reads as water
    return land[y][x];
  };
  const terrain = [];
  for (let y = 0; y < MAP_H; y++) {
    const row = [];
    for (let x = 0; x < MAP_W; x++) {
      if (!isLand(x, y)) {
        row.push("water");
        continue;
      }
      let touchesWater = false;
      for (let dy = -1; dy <= 1 && !touchesWater; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!isLand(x + dx, y + dy)) {
            touchesWater = true;
            break;
          }
        }
      }
      row.push(touchesWater ? "sand" : "grass");
    }
    terrain.push(row);
  }
  return terrain;
}

// Shared bits-pattern autotile: given a predicate for "the far terrain" among
// a cell's 4 cardinal neighbors, pick a flat/edge/corner tile from the
// supplied sets. `flat()` supplies the flat fallback (used for bits===0 and
// for the rare opposite-pair/3-4-side cases the straight+diagonal tile set
// can't represent).
function pickBoundaryTile(isFar, edgeByDir, cornerByDir, flat) {
  const n = isFar(0, -1);
  const e = isFar(1, 0);
  const s = isFar(0, 1);
  const w = isFar(-1, 0);
  const bits = (n ? 1 : 0) + (e ? 1 : 0) + (s ? 1 : 0) + (w ? 1 : 0);

  if (bits === 0) return flat();
  if (bits === 1) {
    if (n) return edgeByDir.N;
    if (e) return edgeByDir.E;
    if (s) return edgeByDir.S;
    return edgeByDir.W;
  }
  if (bits === 2) {
    if (n && e) return cornerByDir.NE;
    if (n && w) return cornerByDir.NW;
    if (s && e) return cornerByDir.SE;
    if (s && w) return cornerByDir.SW;
    return flat(); // opposite-side pair (N+S or E+W): rare sliver, fall back flat
  }
  return flat(); // 3-4 sides: isolated peninsula tip, fall back flat
}

function pickGroundTile(terrain, x, y, rand) {
  const at = (dx, dy) => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) return "water"; // OOB reads as water
    return terrain[ny][nx];
  };
  const here = terrain[y][x];

  const grassVariant = () => {
    const roll = rand();
    if (roll < 0.6) return TILE_INDEX.GRASS_1;
    if (roll < 0.82) return TILE_INDEX.GRASS_2;
    return TILE_INDEX.GRASS_3;
  };
  const sandVariant = () => (rand() < 0.7 ? TILE_INDEX.SAND : TILE_INDEX.SAND_SPECKLE);

  if (here === "water") {
    const roll = rand();
    return roll < 0.62 ? TILE_INDEX.WATER : roll < 0.82 ? TILE_INDEX.WATER_2 : TILE_INDEX.WATER_3;
  }

  if (here === "grass") {
    return pickBoundaryTile(
      (dx, dy) => at(dx, dy) !== "grass",
      {
        N: TILE_INDEX.GRASS_SAND_EDGE_N,
        E: TILE_INDEX.GRASS_SAND_EDGE_E,
        S: TILE_INDEX.GRASS_SAND_EDGE_S,
        W: TILE_INDEX.GRASS_SAND_EDGE_W,
      },
      {
        NE: TILE_INDEX.GRASS_SAND_CORNER_NE,
        NW: TILE_INDEX.GRASS_SAND_CORNER_NW,
        SE: TILE_INDEX.GRASS_SAND_CORNER_SE,
        SW: TILE_INDEX.GRASS_SAND_CORNER_SW,
      },
      grassVariant,
    );
  }

  // here === "sand"
  return pickBoundaryTile(
    (dx, dy) => at(dx, dy) === "water",
    {
      N: TILE_INDEX.SAND_WATER_EDGE_N,
      E: TILE_INDEX.SAND_WATER_EDGE_E,
      S: TILE_INDEX.SAND_WATER_EDGE_S,
      W: TILE_INDEX.SAND_WATER_EDGE_W,
    },
    {
      NE: TILE_INDEX.SAND_WATER_CORNER_NE,
      NW: TILE_INDEX.SAND_WATER_CORNER_NW,
      SE: TILE_INDEX.SAND_WATER_CORNER_SE,
      SW: TILE_INDEX.SAND_WATER_CORNER_SW,
    },
    sandVariant,
  );
}

function buildLandmarks(terrain) {
  const reserved = new Set();
  const blocked = new Set();
  const key = (x, y) => `${x},${y}`;
  const specs = [
    { kind: "villa", tilesW: 6, tilesH: 6, targetX: 27, targetY: 11 },
    { kind: "pond", tilesW: 4, tilesH: 5, targetX: 18, targetY: 27 },
    { kind: "garden", tilesW: 5, tilesH: 4, targetX: 37, targetY: 27 },
    { kind: "shrine", tilesW: 6, tilesH: 5, targetX: 27, targetY: 40 },
  ];
  const landmarks = [];

  for (const spec of specs) {
    let best = null;
    let bestDistance = Infinity;
    for (let y = 2; y <= MAP_H - spec.tilesH - 2; y++) {
      for (let x = 2; x <= MAP_W - spec.tilesW - 2; x++) {
        let valid = true;
        for (let dy = -1; dy <= spec.tilesH && valid; dy++) {
          for (let dx = -1; dx <= spec.tilesW; dx++) {
            const gx = x + dx;
            const gy = y + dy;
            if (terrain[gy]?.[gx] !== "grass" || reserved.has(key(gx, gy))) {
              valid = false;
              break;
            }
          }
        }
        if (!valid) continue;
        const distance = Math.hypot(x - spec.targetX, y - spec.targetY);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x, y };
        }
      }
    }
    if (!best) continue;
    landmarks.push({ kind: spec.kind, x: best.x, y: best.y });
    for (let dy = -1; dy <= spec.tilesH; dy++) {
      for (let dx = -1; dx <= spec.tilesW; dx++) reserved.add(key(best.x + dx, best.y + dy));
    }
    for (let dy = 0; dy < spec.tilesH; dy++) {
      for (let dx = 0; dx < spec.tilesW; dx++) blocked.add(key(best.x + dx, best.y + dy));
    }
  }

  // A south-facing dock needs a specific terrain transition: grass inland,
  // one sand tile at its head, then open water for its full length.
  let dock = null;
  let dockDistance = Infinity;
  for (let y = 2; y < MAP_H - 4; y++) {
    for (let x = 2; x < MAP_W - 2; x++) {
      if (
        terrain[y][x] !== "sand" ||
        terrain[y - 1][x] !== "grass" ||
        terrain[y + 1][x] !== "water" ||
        terrain[y + 2][x] !== "water" ||
        terrain[y + 3][x] !== "water"
      ) continue;
      const distance = Math.hypot(x - 38, y - 47);
      if (distance < dockDistance) {
        dockDistance = distance;
        dock = { x: x - 1, y };
      }
    }
  }
  // The dock is a wooden pier the islanders walk out onto to board departure
  // boats, so its planks stay walkable -- forced on in buildIslandMap so they
  // override the water underneath. It is reserved (keeps trees/patches off it)
  // but deliberately NOT added to `blocked`.
  const dockCells = new Set();
  if (dock) {
    landmarks.push({ kind: "dock", x: dock.x, y: dock.y });
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        reserved.add(key(dock.x + dx, dock.y + dy));
        dockCells.add(key(dock.x + dx, dock.y + dy));
      }
    }
  }
  return { landmarks, reserved, blocked, dockCells };
}

// Big tree canopies are placed as Phaser Image objects, not tilemap tiles
// (see the TREE_VARIANTS/TILE_INDEX comment up top), so this only needs to
// pick believable trunk positions -- small clusters, biased well inland of
// the beach ring -- and mark each trunk tile unwalkable. `exclude` keeps
// trunks off cells already claimed by a sand patch.
function buildTrees(rand, terrain, exclude, bannedCells) {
  // Multi-source BFS: tile distance from the nearest non-grass (sand/water)
  // cell, used to keep trees off the immediate coastline.
  const coastDist = [];
  for (let y = 0; y < MAP_H; y++) coastDist.push(new Array(MAP_W).fill(Infinity));
  const queue = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (terrain[y][x] !== "grass") {
        coastDist[y][x] = 0;
        queue.push([x, y]);
      }
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const [x, y] = queue[qi++];
    const d = coastDist[y][x] + 1;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      if (d < coastDist[ny][nx]) {
        coastDist[ny][nx] = d;
        queue.push([nx, ny]);
      }
    }
  }

  const key = (x, y) => `${x},${y}`;
  const isCandidate = (x, y, minCoastDist, claimed) =>
    terrain[y][x] === "grass" && coastDist[y][x] >= minCoastDist && !exclude.has(key(x, y)) && !claimed.has(key(x, y));

  const CLUSTER_SIZES = [4, 4, 4, 4, 3, 3]; // 22 readable trees, grouped without merging into canopy walls
  const centerCandidates = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (isCandidate(x, y, 4, exclude)) centerCandidates.push({ x, y });
    }
  }
  const centers = pickSpaced(rand, centerCandidates, CLUSTER_SIZES.length, 12);

  const trees = [];
  const trunkCells = new Set();
  centers.forEach((center, ci) => {
    const clusterSize = CLUSTER_SIZES[ci] ?? 3;
    const radius = 4;
    const local = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = center.x + dx;
        const y = center.y + dy;
        if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
        if (isCandidate(x, y, 2, trunkCells)) local.push({ x, y });
      }
    }
    const spots = pickSpaced(rand, local, clusterSize, 3);
    for (const spot of spots) {
      if (trunkCells.has(key(spot.x, spot.y))) continue;
      // One rand() draw per tree (unchanged draw count, so tree positions and
      // all downstream placement RNG stay byte-identical to before), mapped to
      // a weighted 3-way variant pick: green tree is the staple, fruit tree is
      // an occasional color accent, bushes fill in as low foliage.
      const r = rand();
      const variant = r < 0.55 ? 0 : r < 0.75 ? 1 : 2;
      // Drop trees that land on the villa or the apron in front of it -- the
      // rand() draw above is still consumed so the layout stays byte-identical
      // apart from the omitted tree.
      if (bannedCells.has(key(spot.x, spot.y))) continue;
      trees.push({ x: spot.x, y: spot.y, variant });
      trunkCells.add(key(spot.x, spot.y));
    }
  });
  return { trees, trunkCells };
}

function buildIslandMap(rand) {
  const land = buildLandGrid(rand);
  const terrain = buildTerrainGrid(land);
  const { landmarks, reserved, blocked, dockCells } = buildLandmarks(terrain);
  const ground = [];
  const decor = [];
  const walkable = [];

  for (let y = 0; y < MAP_H; y++) {
    ground.push(new Array(MAP_W).fill(TILE_INDEX.WATER));
    decor.push(new Array(MAP_W).fill(-1));
    walkable.push(new Array(MAP_W).fill(false));
  }

  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      ground[y][x] = pickGroundTile(terrain, x, y, rand);
      walkable[y][x] = land[y][x]; // sand and grass are both walkable
      if (blocked.has(`${x},${y}`)) walkable[y][x] = false;
      if (dockCells.has(`${x},${y}`)) walkable[y][x] = true; // pier planks over water
    }
  }

  // Sand/dirt patches: stamp the 5x5 decal onto a handful of interior grass
  // regions, well clear of the coastline so it never collides with shore tiles.
  const isInteriorGrass = (x, y) => {
    if (x < 2 || y < 2 || x + SAND_PATCH_SIZE + 2 > MAP_W || y + SAND_PATCH_SIZE + 2 > MAP_H) return false;
    for (let dy = -2; dy < SAND_PATCH_SIZE + 2; dy++) {
      for (let dx = -2; dx < SAND_PATCH_SIZE + 2; dx++) {
        if (terrain[y + dy]?.[x + dx] !== "grass" || reserved.has(`${x + dx},${y + dy}`)) return false;
      }
    }
    return true;
  };
  const patchCandidates = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (isInteriorGrass(x, y)) patchCandidates.push({ x, y });
    }
  }
  const patchSpots = pickSpaced(rand, patchCandidates, 4, 14);
  const patchCells = new Set(reserved);
  for (const spot of patchSpots) {
    for (let dy = 0; dy < SAND_PATCH_SIZE; dy++) {
      for (let dx = 0; dx < SAND_PATCH_SIZE; dx++) {
        const gx = spot.x + dx;
        const gy = spot.y + dy;
        ground[gy][gx] = SAND_PATCH_BASE + dy * PACK_COLS_EXPORT + dx;
        patchCells.add(`${gx},${gy}`);
      }
    }
  }

  // Keep trees off the villa and the apron of tiles directly in front of
  // (south of) it, so no canopy ever hides the house. buildTrees skips these
  // at emit time (after its variant rand() draw) so the RNG draw sequence --
  // and the rest of the island layout -- stays stable.
  const treeBan = new Set();
  const villa = landmarks.find((l) => l.kind === "villa");
  if (villa) {
    const VILLA_W = 6;
    const VILLA_H = 6;
    const APRON = 4; // front-yard rows kept clear below the villa footprint
    for (let dy = -1; dy <= VILLA_H + APRON; dy++) {
      for (let dx = -1; dx <= VILLA_W; dx++) treeBan.add(`${villa.x + dx},${villa.y + dy}`);
    }
  }

  const { trees, trunkCells } = buildTrees(rand, terrain, patchCells, treeBan);
  for (const t of trees) walkable[t.y][t.x] = false; // trunk tile only, not the whole canopy footprint

  // Decor: only on flat interior grass (bits===0 equivalent), skipping patch
  // cells and tree trunks so nothing is drawn over the sand or under a tree.
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const cellKey = `${x},${y}`;
      if (terrain[y][x] !== "grass" || patchCells.has(cellKey) || trunkCells.has(cellKey)) continue;
      const isFlatInterior =
        ground[y][x] === TILE_INDEX.GRASS_1 ||
        ground[y][x] === TILE_INDEX.GRASS_2 ||
        ground[y][x] === TILE_INDEX.GRASS_3;
      if (!isFlatInterior) continue;

      const roll = rand();
      let tile = -1;
      let blocking = false;
      if (roll < 0.015) {
        tile = TILE_INDEX.ROCK;
        blocking = true;
      } else if (roll < 0.06) {
        tile = TILE_INDEX.BUSH;
      } else if (roll < 0.14) {
        const f = rand();
        tile = f < 0.34 ? TILE_INDEX.FLOWER_A : f < 0.67 ? TILE_INDEX.FLOWER_B : TILE_INDEX.FLOWER_C;
      }
      decor[y][x] = tile;
      if (blocking) walkable[y][x] = false;
    }
  }

  return { tileSize: TILE, width: MAP_W, height: MAP_H, ground, decor, walkable, trees, landmarks };
}

// Greedy min-distance sampling (deterministic Fisher-Yates shuffle, then
// take-if-far-enough) -- reused for sand-patch placement so patches don't
// cluster or overlap.
function pickSpaced(rand, candidates, count, startMinDist) {
  for (let minDist = startMinDist; minDist >= 1; minDist--) {
    const shuffled = candidates.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    const chosen = [];
    for (const t of shuffled) {
      if (chosen.length >= count) break;
      const farEnough = chosen.every((c) => Math.hypot(c.x - t.x, c.y - t.y) >= minDist);
      if (farEnough) chosen.push(t);
    }
    if (chosen.length >= count) return chosen;
  }
  return candidates.slice(0, count);
}

const islandMap = buildIslandMap(rand);
writeFileSync(path.join(OUT_DIR, "island-map.json"), JSON.stringify(islandMap));

let walkableCount = 0;
let waterCount = 0;
for (let y = 0; y < islandMap.height; y++) {
  for (let x = 0; x < islandMap.width; x++) {
    if (islandMap.walkable[y][x]) walkableCount++;
    if (islandMap.ground[y][x] === TILE_INDEX.WATER) waterCount++;
  }
}

console.log(`tileset.png       -> ${packed.width}x${packed.height} (packed from Sunnyside World)`);
console.log(`contestant.png    -> ${charSheet.width}x${charSheet.height} (${TOTAL_FRAMES} frames @ ${CHAR_FRAME_W}x${CHAR_FRAME_H})`);
for (const variant of TREE_VARIANTS) {
  console.log(`${variant.file.padEnd(18)} -> ${variant.image.width}x${variant.image.height}`);
}
console.log(`trees placed      -> ${islandMap.trees.length}`);
console.log(`landmarks placed  -> ${islandMap.landmarks.map((l) => l.kind).join(", ")}`);
console.log(
  `island-map.json   -> ${islandMap.width}x${islandMap.height}, walkable=${walkableCount} (${(
    (100 * walkableCount) /
    (islandMap.width * islandMap.height)
  ).toFixed(1)}%), water=${waterCount}`,
);
