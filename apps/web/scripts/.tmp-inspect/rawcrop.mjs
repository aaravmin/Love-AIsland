import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
// node rawcrop.mjs <src> <out> <x> <y> <w> <h> <scale>
const [, , src, out, xArg, yArg, wArg, hArg, scaleArg] = process.argv;
const x0 = Number(xArg), y0 = Number(yArg), w = Number(wArg), h = Number(hArg), scale = Number(scaleArg || 4);
const png = PNG.sync.read(readFileSync(src));
const big = new PNG({ width: w * scale, height: h * scale });
for (let i = 0; i < big.data.length; i += 4) { big.data[i]=255;big.data[i+1]=255;big.data[i+2]=255;big.data[i+3]=255; }
for (let y = 0; y < big.height; y++) {
  for (let x = 0; x < big.width; x++) {
    const sx = x0 + Math.floor(x / scale);
    const sy = y0 + Math.floor(y / scale);
    if (sx >= png.width || sy >= png.height) continue;
    const si = (png.width * sy + sx) << 2;
    const di = (big.width * y + x) << 2;
    const a = png.data[si+3];
    let r=png.data[si],g=png.data[si+1],b=png.data[si+2];
    if (a===0){r=255;g=255;b=255;} else if (a<255){
      r=Math.round(r*(a/255)+255*(1-a/255));g=Math.round(g*(a/255)+255*(1-a/255));b=Math.round(b*(a/255)+255*(1-a/255));
    }
    big.data[di]=r;big.data[di+1]=g;big.data[di+2]=b;big.data[di+3]=255;
  }
}
writeFileSync(out, PNG.sync.write(big));
console.log(`wrote ${out}: px[${x0},${y0}] ${w}x${h} -> ${big.width}x${big.height}`);
