import assert from "node:assert/strict";
import { test } from "node:test";
import { readTunables, applyOutcome, emptyRelationship, decayRelationship } from "@arena/shared";
import {
  breakTie,
  createSocialState,
  drainEventsFor,
  peekEventsFor,
  pushWorldEvent,
  useSocial,
  worldStateView,
} from "./social.js";

// ---------------------------------------------------------------------------
// The two invariants the behavior spec is strictest about, pinned so a later
// change cannot quietly break them:
//
//   1. All flags off means today's behavior. Every flag the spec adds must
//      default to off, so a build with no configuration is the old build.
//   2. The tie rule is total and deterministic. A tie that cannot be broken
//      would deadlock the sim, so the seeded fallback must always decide.
// ---------------------------------------------------------------------------

// WS-A inverted ISLAND_BEHAVIOR_ALL's default from off to on, so the shipped
// game is the lively one (see tunables.ts's header for why). "All flags off
// means today's behavior" is still a REACHABLE configuration, just no longer
// the bare-environment default -- so this test now asserts it explicitly via
// ISLAND_BEHAVIOR_ALL=0 rather than via an empty env.
test("ISLAND_BEHAVIOR_ALL=0 restores every flag to off", () => {
  const t = readTunables({ ISLAND_BEHAVIOR_ALL: "0" } as NodeJS.ProcessEnv);
  for (const [name, value] of Object.entries(t.flags)) {
    assert.equal(value, false, `flag ${name} must be off under ISLAND_BEHAVIOR_ALL=0`);
  }
});

test("the bare environment defaults every flag on (ISLAND_BEHAVIOR_ALL defaults true)", () => {
  const t = readTunables({} as NodeJS.ProcessEnv);
  for (const [name, value] of Object.entries(t.flags)) {
    assert.equal(value, true, `flag ${name} must default to on`);
  }
});

test("one switch turns the whole spec on, and single flags still override", () => {
  const all = readTunables({ ISLAND_BEHAVIOR_ALL: "1" } as NodeJS.ProcessEnv);
  assert.ok(Object.values(all.flags).every((v) => v === true));

  // An individual flag must be able to opt back out of the blanket switch,
  // which is what makes bisecting a misbehaving feature possible.
  const mixed = readTunables({
    ISLAND_BEHAVIOR_ALL: "1",
    ISLAND_OVERHEARING: "0",
  } as NodeJS.ProcessEnv);
  assert.equal(mixed.flags.overhearing, false);
  assert.equal(mixed.flags.selfOdds, true);
});

test("the tie rule breaks on health first", () => {
  useSocial(createSocialState(99));
  const weak = { id: "a", hp: 10 };
  const strong = { id: "b", hp: 40 };
  assert.ok(breakTie(weak, strong) < 0, "lower health is eliminated first");
  assert.ok(breakTie(strong, weak) > 0);
});

test("a health tie falls through to the seed and never returns zero", () => {
  useSocial(createSocialState(4242));
  const a = { id: "alpha", hp: 25 };
  const b = { id: "beta", hp: 25 };
  const first = breakTie(a, b);
  assert.notEqual(first, 0, "an unbroken tie would deadlock the sim");
  // Antisymmetric, so a sort using it is well defined.
  assert.equal(Math.sign(breakTie(b, a)), -Math.sign(first));
  // Stable across calls, so the same run replays identically.
  assert.equal(breakTie(a, b), first);
});

test("the same seed replays the same tie, a different seed may not", () => {
  useSocial(createSocialState(1));
  const a = { id: "alpha", hp: 25 };
  const b = { id: "beta", hp: 25 };
  const withSeed1 = Math.sign(breakTie(a, b));

  useSocial(createSocialState(1));
  assert.equal(Math.sign(breakTie(a, b)), withSeed1, "same seed must replay");
});

test("relationship outcomes accumulate and fade without being erased", () => {
  const now = 1_000_000;
  const r = emptyRelationship("a", "b", now);

  applyOutcome(r, "fight", now);
  const afterFight = r.trust;
  assert.ok(afterFight < 0, "a fight costs trust");
  assert.ok(r.threat > 0, "a fight registers as threat");

  // Tension and amicable are the easy ones to drop, so assert they land.
  const r2 = emptyRelationship("a", "c", now);
  applyOutcome(r2, "tension", now);
  assert.ok(r2.affinity < 0, "tension must persist, not be discarded");
  const r3 = emptyRelationship("a", "d", now);
  applyOutcome(r3, "amicable", now);
  assert.ok(r3.affinity > 0, "amicable must persist, not be discarded");

  // Fading moves the number toward neutral but never wipes the record.
  decayRelationship(r, now + 10 * 60_000);
  assert.ok(r.trust > afterFight, "old outcomes fade in weight");
  assert.ok(r.trust < 0, "but the grudge is not erased");
  assert.equal(r.history.length, 1, "history survives the fade");
});

test("history is bounded but the accumulators keep everything", () => {
  const now = 2_000_000;
  const r = emptyRelationship("a", "b", now);
  for (let i = 0; i < 50; i++) applyOutcome(r, "amicable", now + i);
  assert.ok(r.history.length <= 12, "the recall window stays bounded");
  assert.ok(r.affinity > 0.5, "but the accumulated feeling reflects all of it");
});

// ---------------------------------------------------------------------------
// The peek/drain split. This is the highest-value fix in this workstream: an
// agentContext read (which conversation.ts calls multiple times per
// conversation just to read a display name) must never advance a cursor,
// or a real "think" consumer would find its own events already gone.
// ---------------------------------------------------------------------------

test("peekEventsFor is idempotent: five reads return the same events", () => {
  useSocial(createSocialState(1));
  pushWorldEvent("amicable", ["a", "b"], "a and b had a good chat", 1000);
  pushWorldEvent("tension", ["a", "c"], "a and c argued", 1001);

  const first = peekEventsFor("a");
  assert.equal(first.length, 2, "both events are unread");
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(peekEventsFor("a"), first, "peeking never advances the cursor");
  }
});

test("drainEventsFor once, then peek returns empty", () => {
  useSocial(createSocialState(2));
  pushWorldEvent("amicable", ["a", "b"], "a and b had a good chat", 1000);

  const drained = drainEventsFor("a");
  assert.equal(drained.length, 1, "the one pending event is drained");
  assert.deepEqual(peekEventsFor("a"), [], "nothing left unread after a drain");
  assert.deepEqual(drainEventsFor("a"), [], "a second drain also finds nothing new");
});

test("an agentContext-shaped read (peek, repeated) leaves a 4-turn conversation's cursors untouched", () => {
  useSocial(createSocialState(3));
  // One event lands before the conversation starts, exactly as a purge or a
  // death firing mid-run would.
  pushWorldEvent("death", ["z"], "z died", 500);

  // Simulate what packages/swarm/src/conversation.ts does across a 4-turn
  // conversation: agentContext (here, a peek) gets called for the speaker
  // every turn and for the partner's display name every turn too, so up to
  // eight reads happen against two participants' cursors before either of
  // them ever actually "thinks" again.
  for (let turn = 0; turn < 4; turn++) {
    peekEventsFor("a"); // speaker context
    peekEventsFor("b"); // partner-name lookup
    peekEventsFor("b"); // speaker context (roles swap turn to turn)
    peekEventsFor("a"); // partner-name lookup
  }

  // Both participants' unread events are exactly what they were before the
  // conversation started: nothing was silently consumed.
  assert.equal(peekEventsFor("a").length, 1, "a's cursor was not advanced by the conversation");
  assert.equal(peekEventsFor("b").length, 1, "b's cursor was not advanced by the conversation");
  // The real think path can still drain them afterward.
  assert.equal(drainEventsFor("a").length, 1);
  assert.equal(drainEventsFor("b").length, 1);
});

test("worldStateView().recent is non-empty after a death is pushed", () => {
  useSocial(createSocialState(4));
  assert.deepEqual(worldStateView(1000).recent, [], "nothing has happened yet");
  pushWorldEvent("death", ["a"], "a died", 1000);
  const view = worldStateView(1001);
  assert.equal(view.recent.length, 1, "the death shows up in the snapshot's own feed tail");
  assert.equal(view.recent[0]!.kind, "death");
});
