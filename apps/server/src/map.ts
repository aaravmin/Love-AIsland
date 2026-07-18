import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The island map is generated once by apps/web/scripts/generate-assets.mjs
// and shipped as a public asset for the Phaser scene. The server reads the
// exact same artifact for its walkable mask so client rendering and server
// clamping can never disagree. ISLAND_MAP_PATH overrides the default
// monorepo-relative path for deployed layouts where apps/web isn't present.
type IslandMapData = {
  tileSize: number;
  width: number;
  height: number;
  walkable: boolean[][];
  // Each built structure's top-left footprint tile (x,y in TILES). The generator
  // reserves the footprint visually but ships it walkable; the server punches out
  // the solid bases below so contestants path around the structures.
  landmarks?: { kind: string; x: number; y: number }[];
};

const DEFAULT_MAP_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "web",
  "public",
  "assets",
  "island-map.json"
);

const raw = readFileSync(process.env.ISLAND_MAP_PATH ?? DEFAULT_MAP_PATH, "utf8");
const map = JSON.parse(raw) as IslandMapData;

export const TILE_SIZE = map.tileSize;
export const WORLD_WIDTH = map.width * map.tileSize;
export const WORLD_HEIGHT = map.height * map.tileSize;

// The built structures (villa, shrine, garden) are solid and the pond is water:
// contestants must path around all four and never stand on one. We block each
// one's ENTIRE footprint -- keyed off the landmark's top-left tile and its
// tile size -- so the collision matches the full silhouette, not just a base
// cluster. The dock is deliberately omitted: it is a walkable pier the
// islanders board departure boats from. The generator already bakes these same
// cells (structures + pond blocked, dock forced walkable) into map.walkable, so
// this pass is consistent with the shipped JSON, not a second source of truth;
// it never unblocks a cell, only re-asserts the solid footprints. isWalkable()
// and spawn placement both read map.walkable, so blocking these cells is enough.
const LANDMARK_FOOTPRINT_BLOCK: Record<string, { w: number; h: number }> = {
  villa: { w: 6, h: 6 },
  shrine: { w: 6, h: 5 },
  garden: { w: 5, h: 4 },
  pond: { w: 4, h: 5 }, // water: no one stands on it
};

function blockLandmarkFootprints(): void {
  for (const lm of map.landmarks ?? []) {
    const block = LANDMARK_FOOTPRINT_BLOCK[lm.kind];
    if (!block) continue; // dock stays walkable
    for (let dy = 0; dy < block.h; dy++) {
      for (let dx = 0; dx < block.w; dx++) {
        const tx = lm.x + dx;
        const ty = lm.y + dy;
        if (map.walkable[ty]?.[tx] !== undefined) map.walkable[ty]![tx] = false;
      }
    }
  }
}
// Run before the walkable-tile list is built so random spawns also avoid them.
blockLandmarkFootprints();

const walkableTiles: { x: number; y: number }[] = [];
for (let y = 0; y < map.height; y++) {
  for (let x = 0; x < map.width; x++) {
    if (map.walkable[y]?.[x]) walkableTiles.push({ x, y });
  }
}
if (walkableTiles.length === 0) throw new Error("island map has no walkable tiles");

// World-pixel position check, the movement clamp's single source of truth.
export function isWalkable(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= WORLD_WIDTH || y >= WORLD_HEIGHT) return false;
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  return map.walkable[ty]?.[tx] === true;
}

// A contestant occupies more than the single pixel at its feet. Check a small
// octagonal footprint so a valid center point cannot leave the visible body
// hanging over ocean, pond water, or a structure. Keeping this separate from
// isWalkable preserves the exact tile-mask primitive for map tooling and lets
// movement tune the body radius without changing the map artifact.
export function isWalkableFootprint(x: number, y: number, radiusPx: number): boolean {
  const r = Math.max(0, radiusPx);
  if (!isWalkable(x, y)) return false;
  if (r === 0) return true;
  const diagonal = r / Math.SQRT2;
  return [
    [r, 0],
    [-r, 0],
    [0, r],
    [0, -r],
    [diagonal, diagonal],
    [diagonal, -diagonal],
    [-diagonal, diagonal],
    [-diagonal, -diagonal],
  ].every(([dx, dy]) => isWalkable(x + dx!, y + dy!));
}

// Center of a uniformly random walkable tile; spawn placement.
export function randomWalkablePosition(rand: () => number = Math.random): {
  x: number;
  y: number;
} {
  const tile = walkableTiles[Math.floor(rand() * walkableTiles.length)]!;
  return {
    x: tile.x * TILE_SIZE + TILE_SIZE / 2,
    y: tile.y * TILE_SIZE + TILE_SIZE / 2,
  };
}
