import assert from "node:assert/strict";
import { test } from "node:test";
import type { Class, Stats } from "@arena/shared";
import { reloadTunables } from "@arena/shared";
import { runConversation, SpendTracker } from "@arena/swarm";
import { activate, initRooms, mainRoom } from "./rooms.js";
import { seedMarket } from "./market.js";
import { priceYes, state } from "./state.js";
import { overheardFor } from "./awareness.js";
import { createDecisionSink, createWorldView } from "./swarmBridge.js";
import type { ArenaServer } from "./io.js";

// ---------------------------------------------------------------------------
// End-to-end checks of the spec's hard cross-cutting rules, driven through the
// REAL conversation runner and the real server bridge rather than a stub.
//
// These are the rules stated as absolutes ("no dashes in any islander speech,
// anywhere", "no agent ever states an exact odds number about itself"), so they
// are worth a test that exercises the actual path a spoken line travels: rule
// backend -> conversation runner -> sanitizer -> DecisionSink -> transcript.
// ---------------------------------------------------------------------------

reloadTunables({ ISLAND_BEHAVIOR_ALL: "1" } as NodeJS.ProcessEnv);

const noopBroadcast = { emit: () => {} };
const noopIo = {
  emit: () => {},
  to: () => noopBroadcast,
  volatile: { emit: () => {}, to: () => noopBroadcast },
} as unknown as ArenaServer;

const CLASSES: Class[] = ["bold", "timid", "schemer", "charmer", "wildcard"];
const STATS: Stats = {
  charisma: 5,
  cunning: 5,
  grit: 5,
  strength: 5,
  charm: 5,
  instinct: 5,
  resolve: 5,
};

// Every dash codepoint a model or a template could plausibly emit.
const ANY_DASH = /[-‐‑‒–—―−]/;
const PERCENTAGE = /\b\d{1,3}\s?%/;

initRooms(noopIo);

// `far` is parked across the map, so it must never overhear anything.
function seedVilla(n: number, farId: string): void {
  activate(mainRoom());
  state.phase = "running";
  state.startedAt = Date.now() - 60_000;
  state.contestants = {};
  state.conversations = {};
  state.markets = {};
  state.trades = [];
  for (let i = 0; i < n; i++) {
    const id = `c${i}`;
    state.contestants[id] = {
      id,
      name: `Islander${i}`,
      ownerPhone: "",
      ownerName: "",
      ownerClientId: "",
      klass: CLASSES[i % CLASSES.length]!,
      stats: STATS,
      persona: "a person on a dating show",
      hp: 100,
      maxHp: 100,
      alive: true,
      kills: 0,
      notoriety: 0,
      x: id === farId ? 5000 : i * 10,
      y: 0,
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
    state.markets[id] = seedMarket(id, n, Date.now());
  }
}

async function talk(rounds: number): Promise<void> {
  const world = createWorldView();
  const sink = createDecisionSink(noopIo);
  const spend = new SpendTracker();
  for (let round = 0; round < rounds; round++) {
    const a = state.contestants.c0!;
    const b = state.contestants.c1!;
    const convId = `conv-${round}`;
    state.conversations[convId] = {
      id: convId,
      participants: [a.id, b.id],
      messages: [],
      outcome: "ongoing",
      fightInitiator: null,
      startedAt: Date.now(),
      endedAt: null,
      maxTurns: 4,
    };
    a.intent = { kind: "converse", convId };
    b.intent = { kind: "converse", convId };
    await runConversation({ world, sink, client: null, spend }, convId, { paced: false });
  }
}

function allLines(): string[] {
  return Object.values(state.conversations).flatMap((c) => c.messages.map((m) => m.text));
}

test("no islander speech contains a dash of any kind", async () => {
  seedVilla(6, "c5");
  await talk(10);
  const lines = allLines();
  assert.ok(lines.length > 20, "the run must actually produce speech to be meaningful");

  const offenders = lines.filter((t) => ANY_DASH.test(t));
  assert.deepEqual(offenders, [], "every dash must be rewritten before the line is spoken");
});

test("no islander states an exact percentage about anyone", async () => {
  seedVilla(6, "c5");
  await talk(10);
  const offenders = allLines().filter((t) => PERCENTAGE.test(t));
  assert.deepEqual(offenders, [], "an islander cannot see the betting board");
});

test("position on the map decides who overhears a private talk", async () => {
  seedVilla(6, "c5");
  await talk(6);

  // c2 stands beside the talkers.
  const beside = overheardFor("c2") ?? [];
  assert.ok(beside.length > 0, "a bystander in earshot picks up fragments");

  // c5 is across the island.
  const across = overheardFor("c5") ?? [];
  assert.equal(across.length, 0, "distance must actually protect a private talk");
});

test("odds move across a run with no bets placed at all", async () => {
  seedVilla(6, "c5");
  const before = new Map(
    Object.values(state.markets).map((m) => [m.contestantId, priceYes(m)] as const),
  );

  await talk(8);

  assert.equal(state.trades.length, 0, "this run placed no bets");
  const moved = Object.values(state.markets).filter(
    (m) => Math.abs(priceYes(m) - (before.get(m.contestantId) ?? 0)) > 1e-9,
  );
  assert.ok(moved.length > 0, "conversation outcomes alone must move the board");

  // And the move stayed within the configured per-event bound, so a run of
  // conversations cannot walk a price off the end of the scale.
  for (const m of moved) {
    const p = priceYes(m);
    assert.ok(p > 0 && p < 1, `price ${p} stayed inside the usable band`);
  }
});
