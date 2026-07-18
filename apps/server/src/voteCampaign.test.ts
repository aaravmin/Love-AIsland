import assert from "node:assert/strict";
import { test } from "node:test";
import type { Contestant, Stats } from "@arena/shared";
import { reloadTunables } from "@arena/shared";

import { ousterSupportCount } from "./alliances.js";
import type { ArenaServer } from "./io.js";
import { seedMarket } from "./market.js";
import { activate, initRooms, mainRoom } from "./rooms.js";
import { state } from "./state.js";
import { createDecisionSink } from "./swarmBridge.js";

reloadTunables({ ISLAND_BEHAVIOR_ALL: "1" } as NodeJS.ProcessEnv);

const noopBroadcast = { emit: () => {} };
const noopIo = {
  emit: () => {},
  to: () => noopBroadcast,
  volatile: { emit: () => {}, to: () => noopBroadcast },
} as unknown as ArenaServer;

const STATS: Stats = {
  charisma: 5,
  cunning: 5,
  grit: 5,
  strength: 5,
  charm: 5,
  instinct: 5,
  resolve: 5,
};

function contestant(id: string, x: number): Contestant {
  return {
    id,
    name: id.toUpperCase(),
    ownerPhone: "",
    ownerName: "",
    ownerClientId: "",
    klass: "schemer",
    stats: STATS,
    persona: "",
    hp: 100,
    maxHp: 100,
    alive: true,
    kills: 0,
    notoriety: 0,
    x,
    y: 100,
    intent: { kind: "wander" },
    allies: [],
    memory: [],
    deathIndex: null,
    diedAt: null,
    killedBy: null,
    causeOfDeath: null,
    lastCombatAt: null,
    activeFightId: null,
    nextThinkAt: 0,
  };
}

test("approaching a confidant registers support against the separate vote target", () => {
  const room = initRooms(noopIo);
  activate(room);
  state.phase = "running";
  state.contestants = {
    a: contestant("a", 100),
    b: contestant("b", 110),
    c: contestant("c", 120),
    d: contestant("d", 130),
  };
  state.markets = Object.fromEntries(
    Object.keys(state.contestants).map((id) => [id, seedMarket(id, 4, Date.now())]),
  );

  const sink = createDecisionSink(noopIo);
  sink.applyDecision("a", {
    action: "approach",
    target: "b",
    voteTarget: "d",
    reasoning: "I can get the numbers against D.",
  });

  assert.deepEqual(state.contestants.a!.intent, { kind: "approach", target: "b" });
  assert.equal(ousterSupportCount("d"), 1);

  sink.applyDecision("c", {
    action: "approach",
    target: "b",
    voteTarget: "d",
    reasoning: "A and I can carry this vote.",
  });

  assert.equal(state.contestants.d!.alive, false, "quorum should actually vote the target out");
  assert.equal(state.contestants.d!.causeOfDeath, "voteOff");
  assert.equal(mainRoom().state.contestants.d!.alive, false);
});
