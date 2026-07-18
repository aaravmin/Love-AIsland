import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

// For each tile in [startCol..startCol+cols) x [startRow..startRow+rows),
// sample an NxN grid of points and print a compact ASCII map classifying
// each sample as one of a few known colors. Helps identify autotile corner
// shapes precisely instead of eyeballing upscaled renders.
const [, , src, gridArg, scArg, srArg, colsArg, rowsArg] = process.argv;
const grid = Number(gridArg);
const startCol = Number(scArg);
const startRow = Number(srArg);
const cols = Number(colsArg);
const rows = Number(rowsArg);
const N = 6; // sample grid resolution per tile

const png = PNG.sync.read(readFileSync(src));

function px(x, y) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return null;
  const i = (png.width * y + x) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

function classify([r, g, b, a]) {
  if (a < 128) return ".";
  // rough hue/lightness buckets
  if (r > 200 && g > 180 && b < 160) return "S"; // sand/tan
  if (r > 130 && r < 210 && g < 130 && b < 110) return "D"; // dirt brown
  if (b > r && b > g) {
    if (g > 150) return "w"; // shallow/cyan water
    return "W"; // deep water
  }
  if (g > r && g > b) return "g"; // grass
  if (r > 200 && g > 200 && b > 200) return "_"; // white/empty-ish
  return "?";
}

for (let ty = 0; ty < rows; ty++) {
  const rowLines = Array.from({ length: N }, () => []);
  for (let tx = 0; tx < cols; tx++) {
    const ox = (startCol + tx) * grid;
    const oy = (startRow + ty) * grid;
    for (let sy = 0; sy < N; sy++) {
      let line = "";
      for (let sx = 0; sx < N; sx++) {
        const x = ox + Math.floor((sx + 0.5) * (grid / N));
        const y = oy + Math.floor((sy + 0.5) * (grid / N));
        line += classify(px(x, y));
      }
      rowLines[sy].push(line);
    }
  }
  console.log(`-- row ${startRow + ty} -- cols ${startCol}..${startCol + cols - 1}`);
  for (let sy = 0; sy < N; sy++) console.log(rowLines[sy].join(" "));
}
