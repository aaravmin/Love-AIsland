import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentContextView } from "./swarm.js";

// The base fixture: every field this type had BEFORE the behavior spec's
// optional additions (world, recentEvents, relationships, spatial, overheard,
// selfOdds, alliance). If this object still type-checks as a complete
// AgentContextView, none of the spec's additions became required, which is
// the contract WS-B promises every other workstream: with all flags off, the
// context shape a consumer sees is byte-for-byte what it was before this
// change.
const baseFixture: AgentContextView = {
  self: {
    id: "a",
    name: "Alex",
    klass: "bold",
    stats: {
      charisma: 1,
      cunning: 1,
      grit: 1,
      strength: 1,
      charm: 1,
      instinct: 1,
      resolve: 1,
    },
    persona: "test",
    hp: 10,
    maxHp: 10,
    hpFraction: 1,
    kills: 0,
    notoriety: 0,
    priceYes: 0.5,
    allies: [],
    x: 0,
    y: 0,
  },
  nearby: [],
  memory: [],
  event: null,
  phase: "running",
};

test("AgentContextView's base (all-optional-fields-absent) shape is unchanged by the behavior spec's additions", () => {
  const keys = Object.keys(baseFixture).sort();
  assert.deepEqual(keys, ["event", "memory", "nearby", "phase", "self"]);
  // None of the new optional fields (world, recentEvents, relationships,
  // spatial, overheard, selfOdds, alliance) are present when omitted -- this
  // is what "optional" buys: a consumer that never sets a flag gets exactly
  // the old key set, not the old keys plus a pile of `undefined`s.
  for (const newField of [
    "world",
    "recentEvents",
    "relationships",
    "spatial",
    "overheard",
    "selfOdds",
    "alliance",
  ]) {
    assert.equal(newField in baseFixture, false, `${newField} should be absent, not just undefined`);
  }
});
