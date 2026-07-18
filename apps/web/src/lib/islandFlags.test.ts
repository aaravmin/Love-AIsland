import { test } from "node:test";
import assert from "node:assert/strict";
import { readTunables } from "@arena/shared";
import { adoptServerFlags, islandFlags } from "./islandFlags";

// WS-P acceptance: "islandFlags mirrors every server flag (assert key parity
// against Tunables['flags'] in a test)". readTunables({}) resolves the full
// set of 23 flags with ISLAND_BEHAVIOR_ALL defaulting on, which is exactly
// the shape the server publishes on Snapshot.flags.

test("islandFlags has exactly the same keys as Tunables['flags']", () => {
  const full = readTunables({ ...process.env });
  const serverKeys = Object.keys(full.flags).sort();
  const clientKeys = Object.keys(islandFlags).sort();
  assert.deepEqual(clientKeys, serverKeys);
});

test("adoptServerFlags copies every key from the server payload", () => {
  const full = readTunables({ ...process.env, ISLAND_BEHAVIOR_ALL: "0", ISLAND_FOLLOW_CAMERA: "1" });
  adoptServerFlags(full.flags);
  assert.equal(islandFlags.followCamera, true);
  assert.equal(islandFlags.stripDashes, false);
  for (const key of Object.keys(full.flags) as (keyof typeof full.flags)[]) {
    assert.equal(islandFlags[key], full.flags[key], `mismatch on ${key}`);
  }
});

test("adoptServerFlags is a no-op for an undefined payload (older server)", () => {
  islandFlags.stripDashes = true;
  adoptServerFlags(undefined);
  assert.equal(islandFlags.stripDashes, true);
});
