import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";

// Crop a tile-aligned region and upscale with gridlines + axis ticks for inspection.
// Usage: node region.mjs <src> <out> <grid> <startCol> <startRow> <cols> <rows> <scale>
const [, , src, out, gridArg, scArg, srArg, colsArg, rowsArg, scaleArg] = process.argv;
const grid = Number(gridArg);
const startCol = Number(scArg);
const startRow = Number(srArg);
const cols = Number(colsArg);
const rows = Number(rowsArg);
const scale = Number(scaleArg || 8);

const png = PNG.sync.read(readFileSync(src));
const x0 = startCol * grid;
const y0 = startRow * grid;
const w = cols * grid;
const h = rows * grid;

const big = new PNG({ width: w * scale, height: h * scale });
// white background so transparent regions are visible
for (let i = 0; i < big.data.length; i += 4) {
  big.data[i] = 255; big.data[i + 1] = 255; big.data[i + 2] = 255; big.data[i + 3] = 255;
}
for (let y = 0; y < big.height; y++) {
  for (let x = 0; x < big.width; x++) {
    const sx = x0 + Math.floor(x / scale);
    const sy = y0 + Math.floor(y / scale);
    if (sx >= png.width || sy >= png.height) continue;
    const si = (png.width * sy + sx) << 2;
    const di = (big.width * y + x) << 2;
    const a = png.data[si + 3];
    let r = png.data[si], g = png.data[si + 1], b = png.data[si + 2];
    if (a === 0) { r = 255; g = 255; b = 255; }
    else {
      r = Math.round(r * (a / 255) + 255 * (1 - a / 255));
      g = Math.round(g * (a / 255) + 255 * (1 - a / 255));
      b = Math.round(b * (a / 255) + 255 * (1 - a / 255));
    }
    const localX = sx - x0, localY = sy - y0;
    if (localX % grid === 0 || localY % grid === 0) { r = 255; g = 0; b = 255; }
    big.data[di] = r; big.data[di + 1] = g; big.data[di + 2] = b; big.data[di + 3] = 255;
  }
}
writeFileSync(out, PNG.sync.write(big));
console.log(`wrote ${out}: tiles col[${startCol}..${startCol + cols - 1}] row[${startRow}..${startRow + rows - 1}] (${w}x${h} native -> ${big.width}x${big.height})`);
