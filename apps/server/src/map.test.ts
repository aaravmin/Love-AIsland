import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isWalkable,
  isWalkableFootprint,
  TILE_SIZE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./map.js";

test("a walkable center cannot leave a contestant footprint hanging over water", () => {
  let edge: { x: number; y: number } | null = null;
  for (let y = 1; y < WORLD_HEIGHT - 1 && !edge; y++) {
    for (let x = 1; x < WORLD_WIDTH - 1; x++) {
      if (isWalkable(x, y) && !isWalkableFootprint(x, y, 5)) {
        edge = { x, y };
        break;
      }
    }
  }
  assert.ok(edge, "the coastline should expose a center-only collision edge");
  assert.equal(isWalkable(edge.x, edge.y), true);
  assert.equal(isWalkableFootprint(edge.x, edge.y, 5), false);
});

test("the two-tile dock remains usable with footprint collision", () => {
  // The generated dock's usable pier is tiles x=37..38, y=48..50.
  const x = 37 * TILE_SIZE + TILE_SIZE / 2;
  const y = 49 * TILE_SIZE + TILE_SIZE / 2;
  assert.equal(isWalkableFootprint(x, y, 5), true);
});
