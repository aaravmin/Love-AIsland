import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
const tileset = PNG.sync.read(readFileSync("public/assets/tileset.png"));
const map = JSON.parse(readFileSync("public/assets/island-map.json", "utf8"));
const { tileSize, width, height, ground, decor } = map;
const PACK_COLS = tileset.width / tileSize;
const out = new PNG({ width: width * tileSize, height: height * tileSize });
function blit(idx, dx, dy) {
  if (idx < 0) return;
  const sc = idx % PACK_COLS, sr = Math.floor(idx / PACK_COLS);
  for (let y = 0; y < tileSize; y++) for (let x = 0; x < tileSize; x++) {
    const si = (tileset.width * (sr*tileSize+y) + (sc*tileSize+x)) << 2;
    const di = (out.width * (dy*tileSize+y) + (dx*tileSize+x)) << 2;
    const a = tileset.data[si+3];
    if (a === 0) continue;
    out.data[di]=tileset.data[si]; out.data[di+1]=tileset.data[si+1]; out.data[di+2]=tileset.data[si+2]; out.data[di+3]=255;
  }
}
for (let y=0;y<height;y++) for (let x=0;x<width;x++) blit(ground[y][x], x, y);
for (let y=0;y<height;y++) for (let x=0;x<width;x++) if (decor[y][x]>=0) blit(decor[y][x], x, y);
writeFileSync("/Users/aaravminocha/.claude/jobs/82cbd959/tmp/inspect/island_preview.png", PNG.sync.write(out));
console.log("wrote island_preview.png", out.width, out.height);
