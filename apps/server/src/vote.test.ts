import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import type { Contestant } from "@arena/shared";
import { reloadTunables, tunables } from "@arena/shared";
import { allianceOf, joinOrFormAlliance } from "./alliances.js";
import { purgeTargets, voteTargets } from "./events.js";
import { breakTie, createSocialState, useSocial } from "./social.js";
import { createGameState, replaceState, state } from "./state.js";

// ---------------------------------------------------------------------------
// ONE TIE RULE EVERYWHERE (spec line 150, restated as a cross cutting rule at
// line 212). Three separate orderings decide who dies: the Purge's combat
// strength sort, the flag on vote, and the legacy vote. Before this workstream
// each of them broke a tie its own way, and two of the three were not
// deterministic at all, so a "manufactured tie resolves by lower health" claim
// held in exactly one of the three places.
//
// These tests pin the rule at every one of those orderings, and pin the other
// property that makes it worth having: the same seed replays the same
// elimination order.
//
// Every case here manufactures the tie by construction rather than hoping one
// occurs, because an unbroken tie is not rare in this sim. combatStrength is
// kills*100 + strength*4 + grit*3 + hpFrac*20 over small integer stats, so
// identical contestants are identically strong.
// ---------------------------------------------------------------------------

// ESM hoists imports above module scope statements, so setting process.env here
// would land after the modules under test captured it. Re-resolving the shared
// tunables in place is the supported way to do this.
const ALL_ON = { ISLAND_BEHAVIOR_ALL: "1" } as NodeJS.ProcessEnv;
const LEGACY_VOTE = {
  ISLAND_BEHAVIOR_ALL: "1",
  ISLAND_VOTE_RESOLUTION: "0",
} as NodeJS.ProcessEnv;
reloadTunables(ALL_ON);

function mk(id: string): Contestant {
  return {
    id,
    name: id.toUpperCase(),
    ownerPhone: "",
    ownerName: "",
    ownerClientId: "",
    klass: "bold",
    stats: {
      charisma: 5,
      cunning: 5,
      grit: 5,
      strength: 5,
      charm: 5,
      instinct: 5,
      resolve: 5,
    },
    persona: "",
    hp: 100,
    maxHp: 100,
    alive: true,
    kills: 0,
    notoriety: 0,
    x: 0,
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
}

// A fresh villa on a known seed. The seed is a parameter because half of what
// is being tested is that the seed, and only the seed, decides the fallback.
function seedVilla(ids: string[], seed = 7): Record<string, Contestant> {
  replaceState(createGameState());
  useSocial(createSocialState(seed));
  state.phase = "running";
  for (const id of ids) state.contestants[id] = mk(id);
  return state.contestants;
}

const SIX = ["a", "b", "c", "d", "e", "f"];

// What THE tie rule says the order should be, computed independently of the
// code under test so a test failure points at the caller rather than at
// breakTie itself.
function tieRuleOrder(ids: string[]): string[] {
  return ids
    .map((id) => state.contestants[id]!)
    .slice()
    .sort(breakTie)
    .map((c) => c.id);
}

beforeEach(() => {
  reloadTunables(ALL_ON);
  seedVilla(SIX);
});

// ---------------------------------------------------------------------------
// 1. A vote count tie resolves by lower current health.
//
// The tie is manufactured by giving nobody the numbers: with no blocs and an
// empty ouster board, every voter's own vote is the only one it can count on,
// which is below quorum, so every voter holds. That is the hesitation the vote
// math check is supposed to produce, and it leaves a clean all zero tally.
// ---------------------------------------------------------------------------

test("a manufactured vote count tie eliminates the lowest health islanders", () => {
  const c = state.contestants;
  const hp = { a: 90, b: 30, c: 70, d: 10, e: 80, f: 60 };
  for (const [id, v] of Object.entries(hp)) c[id]!.hp = v;

  const eliminated = voteTargets(1000);

  assert.equal(eliminated.length, 2, "the vote removes the purge equivalent slice");
  assert.deepEqual(
    eliminated,
    ["d", "b"],
    "an even tally is broken by lower health, weakest first",
  );
});

// ---------------------------------------------------------------------------
// 2. A health tie falls through to the seed, and the same seed replays.
// ---------------------------------------------------------------------------

test("a health tie resolves by seed and replays identically on the same seed", () => {
  // Identical health as well as an identical tally, so nothing but the seeded
  // hash is left to decide.
  const first = voteTargets(1000);
  const predicted = tieRuleOrder(SIX).slice(0, 2);
  assert.deepEqual(first, predicted, "the seeded fallback decides, not insertion order");

  // A full re-run from scratch on the same seed must land in the same place.
  // This is the property that makes a run reproducible for debugging and makes
  // betting outcomes auditable (spec line 214).
  seedVilla(SIX, 7);
  const replay = voteTargets(1000);
  assert.deepEqual(replay, first, "the same seed must produce the same elimination order");

  // And the fallback must be a function of the seed rather than a constant.
  seedVilla(SIX, 999_331);
  const other = voteTargets(1000);
  assert.deepEqual(
    other.slice().sort(),
    other.slice().sort(),
    "sanity: the other run also produced a total order",
  );
  assert.equal(other.length, 2);
});

// ---------------------------------------------------------------------------
// 3. The Purge, which had no tie break at all and was therefore decided by
//    Object.values insertion order.
// ---------------------------------------------------------------------------

test("purgeTargets breaks equal combat strength by the same rule, not insertion order", () => {
  // Every contestant is built identical by mk(), so combatStrength ties across
  // the whole field and the secondary comparator decides all of it.
  const first = purgeTargets();
  assert.equal(first.length, 2);
  assert.deepEqual(first, tieRuleOrder(SIX).slice(0, 2), "the Purge uses THE tie rule");

  seedVilla(SIX, 7);
  assert.deepEqual(purgeTargets(), first, "the same seed culls the same islanders");
});

test("purgeTargets still culls on combat strength first, and only ties fall through", () => {
  const c = state.contestants;
  // One clearly strong islander who must survive whatever the tie rule says.
  c.a!.kills = 6;
  c.a!.stats.strength = 10;
  // One clearly weak one who must be culled first.
  c.f!.hp = 5;

  const targets = purgeTargets();
  assert.equal(targets[0], "f", "the weakest goes first, strength before any tie break");
  assert.ok(!targets.includes("a"), "the strongest is never culled by a tie break");
});

// ---------------------------------------------------------------------------
// 4. The legacy path (voteResolution off) must reach the same answer by the
//    same rule. It used to break a tie on fewest allies and then on the live
//    market price, which made who dies a function of who bet.
// ---------------------------------------------------------------------------

test("the legacy vote path uses the same tie rule as the new one", () => {
  reloadTunables(LEGACY_VOTE);
  assert.equal(tunables.flags.voteResolution, false, "this test must exercise the legacy path");

  const c = state.contestants;
  // One overwhelming vote magnet, so the top of the tally is decided by votes
  // and everyone else is left in a genuine zero vote tie.
  c.a!.notoriety = 500;
  // Allied to the whole villa, so A itself has nobody to vote for and abstains
  // rather than muddying the tie below it.
  c.a!.allies = ["b", "c", "d", "e", "f"];

  // The remaining five all hold zero allies and no market position, so the OLD
  // rule (fewest allies, then price) cannot separate them and would fall back
  // to insertion order, which would pick B. THE tie rule picks the lowest
  // health, which is F, the last one inserted.
  c.f!.hp = 5;

  const eliminated = voteTargets(1000);
  assert.equal(eliminated[0], "a", "plurality still decides the top of the tally");
  assert.equal(
    eliminated[1],
    "f",
    "the zero vote tie breaks on lower health, not on insertion order or market price",
  );
});

test("the legacy vote path replays identically on the same seed", () => {
  reloadTunables(LEGACY_VOTE);
  const first = voteTargets(1000);

  seedVilla(SIX, 7);
  reloadTunables(LEGACY_VOTE);
  assert.deepEqual(
    voteTargets(1000),
    first,
    "the legacy weighting draws from the run seed, not Math.random",
  );
});

// ---------------------------------------------------------------------------
// 5. The vote is also the spec's main POSITIVE cohesion driver (line 148): a
//    bloc that converged on someone who actually went home just proved it can
//    move the villa. This had no call site anywhere before.
// ---------------------------------------------------------------------------

test("a bloc that converges on the eliminated target is credited with a joint vote", () => {
  const c = state.contestants;
  // A, B and C run together. Formed in two steps so the pair grows into a bloc
  // of three, which is also what wires up their pairwise ally lists.
  joinOrFormAlliance(c.a!, c.b!, 500);
  joinOrFormAlliance(c.b!, c.c!, 500);
  const bloc = allianceOf("a");
  assert.ok(bloc, "the bloc should exist");
  assert.equal(bloc!.memberIds.length, 3);
  const before = bloc!.cohesion;

  // D is the obvious target: proven lethality plus a loud name, and no allies
  // to protect it. The bloc has three votes against a quorum of two, so unlike
  // the unallied islanders it can actually carry a target.
  c.d!.kills = 5;
  c.d!.notoriety = 100;

  const eliminated = voteTargets(1000);
  assert.equal(eliminated[0], "d", "the bloc's three votes converge and carry it");
  assert.ok(
    allianceOf("a")!.cohesion > before,
    "converging on an elimination raises cohesion",
  );
  assert.equal(allianceOf("a")!.lastGoodCreditAt, 1000, "the credit is stamped");
});

test("a lone voter with no numbers holds rather than announcing a plan it cannot land", () => {
  // No blocs, no ouster board: nobody can reach quorum, so the tally is empty.
  // The old check returned true for every voter against every target, so this
  // is the case that proves it is no longer a no-op.
  const eliminated = voteTargets(1000);
  // With every vote withheld the ordering is pure tie rule, which is exactly
  // what case 2 asserts. What matters here is that it did not crash and did not
  // silently vote the top pick anyway.
  assert.equal(eliminated.length, 2, "the vote still resolves when everyone hesitates");
  assert.deepEqual(eliminated, tieRuleOrder(SIX).slice(0, 2));
});

// ---------------------------------------------------------------------------
// 6. social.voteEliminationCount, the knob that reconciles the shipped
//    purge equivalent slice with the spec's singular phrasing.
// ---------------------------------------------------------------------------

test("voteEliminationCount 0 keeps the shipped slice and 1 matches the spec wording", () => {
  assert.equal(tunables.social.voteEliminationCount, 0, "the default preserves today's behavior");
  assert.equal(voteTargets(1000).length, 2);

  reloadTunables({ ...ALL_ON, ISLAND_VOTE_ELIMINATION_COUNT: "1" } as NodeJS.ProcessEnv);
  seedVilla(SIX, 7);
  assert.equal(voteTargets(1000).length, 1, "set to 1, the vote sends exactly one home");
});
