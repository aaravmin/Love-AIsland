import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import type { Contestant } from "@arena/shared";
import { reloadTunables, tunables } from "@arena/shared";
import {
  allianceOf,
  allianceViewFor,
  campaignForOuster,
  cohesionBand,
  creditBetrayal,
  creditGoodOutcome,
  creditJointVote,
  defect,
  expireOusterSupport,
  joinOrFormAlliance,
  ousterIsWinnable,
  ousterQuorum,
  ousterSupportCount,
  supportOuster,
  tickAlliances,
} from "./alliances.js";
import { createSocialState, recordOutcome, useSocial } from "./social.js";
import { createGameState, replaceState, state } from "./state.js";

// ESM hoists imports above module-scope statements, so setting process.env here
// would land after the modules under test had already captured it. Re-resolving
// the shared tunables in place is the supported way to do this, and it is the
// same mechanism the client uses to adopt the server's flags.
const ALL_ON = { ISLAND_BEHAVIOR_ALL: "1" } as NodeJS.ProcessEnv;
reloadTunables(ALL_ON);

// ---------------------------------------------------------------------------
// Task C acceptance: alliances of three or more, cohesion that actually tracks
// something, defection that follows a member's own survival, and an ouster
// board that can accumulate support at all.
//
// Most of these run with the flags forced on, because what matters is that the
// mechanics do what the spec says when they are enabled. The flags-off path is
// covered in social.test.ts, plus the explicit no-op case at the bottom of this
// file and the degenerate flag COMBINATION that used to freeze cohesion.
// ---------------------------------------------------------------------------

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

// The seed is a parameter because the statistical defection tests need each
// trial to draw a different sequence; a fixed seed would make every trial
// produce the identical outcome and the "mostly does not" half of the
// assertion would be measuring nothing.
function seedVilla(ids: string[], seed = 7): Record<string, Contestant> {
  replaceState(createGameState());
  useSocial(createSocialState(seed));
  for (const id of ids) state.contestants[id] = mk(id);
  return state.contestants;
}

// Build the three-person bloc used by most of the cohesion tests.
function bloc3(now = 1000): void {
  joinOrFormAlliance(state.contestants.a!, state.contestants.b!, now);
  joinOrFormAlliance(state.contestants.b!, state.contestants.c!, now);
}

beforeEach(() => {
  reloadTunables(ALL_ON);
  seedVilla(["a", "b", "c", "d", "e", "f"]);
});

// ---------------------------------------------------------------------------
// Group formation. These predate this workstream and must keep passing.
// ---------------------------------------------------------------------------

test("two alliances of two merge into one bloc of three or more", () => {
  const { a, b, c } = state.contestants as Record<string, Contestant>;
  const now = 1000;

  joinOrFormAlliance(a!, b!, now);
  assert.equal(allianceOf("a")?.memberIds.length, 2);

  // C allies with someone already in a bloc, so the bloc grows rather than a
  // second parallel pair being created.
  joinOrFormAlliance(b!, c!, now);
  const bloc = allianceOf("a");
  assert.ok(bloc, "a should still be in a bloc");
  assert.equal(bloc!.memberIds.length, 3, "the bloc absorbed the third member");

  // The group invariant: every member is a pairwise ally of every other, which
  // is what keeps combat and the vote working unchanged.
  for (const x of ["a", "b", "c"]) {
    for (const y of ["a", "b", "c"]) {
      if (x === y) continue;
      assert.ok(
        state.contestants[x]!.allies.includes(y),
        `${x} must list ${y} as an ally for old code to see the bloc`,
      );
    }
  }
});

test("a bloc respects the size cap instead of silently dropping a member", () => {
  const now = 1000;
  const ids = ["a", "b", "c", "d", "e", "f"];
  for (let i = 1; i < ids.length; i++) {
    joinOrFormAlliance(state.contestants[ids[0]!]!, state.contestants[ids[i]!]!, now);
  }
  const bloc = allianceOf("a");
  assert.ok(bloc!.memberIds.length <= 5, "the cap holds");
  // Nobody who was admitted got quietly evicted to make room.
  for (const m of bloc!.memberIds) {
    assert.ok(state.contestants[m], "every member is a real islander");
  }
});

test("a defector is cut loose from the bloc's pairwise links", () => {
  const now = 1000;
  joinOrFormAlliance(state.contestants.a!, state.contestants.b!, now);
  joinOrFormAlliance(state.contestants.b!, state.contestants.c!, now);
  assert.equal(allianceOf("a")?.memberIds.length, 3);

  defect("c", now, "walked");
  assert.equal(allianceOf("c"), undefined, "the defector is out of the bloc");
  assert.ok(!state.contestants.a!.allies.includes("c"), "and out of the ally arrays");
  assert.ok(!state.contestants.c!.allies.includes("a"), "in both directions");
  assert.equal(allianceOf("a")?.memberIds.length, 2, "the rest hold together");
});

// ---------------------------------------------------------------------------
// The alliance view: the seam that makes a group speakable.
// ---------------------------------------------------------------------------

test("allianceViewFor reports the bloc as a group, with a band and never a number", () => {
  bloc3();
  const view = allianceViewFor("a");
  assert.ok(view, "a member of a three-person bloc has a view of it");
  assert.equal(view!.size, 3, "the view names the group's real size");
  assert.equal(view!.memberNames.length, 3, "memberNames length always equals size");
  // The agent's own name is included, so a prompt builder never has to reason
  // about an off-by-one between the list and the count.
  assert.ok(view!.memberNames.includes("A"), "the agent sees itself in its own bloc");
  for (const n of ["B", "C"]) assert.ok(view!.memberNames.includes(n), `${n} is named`);

  // A joined third member dilutes the bloc below cohesionStart, so the honest
  // band here is "strained" rather than "solid".
  assert.equal(view!.cohesionBand, "strained");
  assert.ok(
    !Object.values(view!).some((v) => typeof v === "number" && v > 0 && v < 1),
    "no raw cohesion score leaks into the view",
  );

  assert.equal(allianceViewFor("d"), undefined, "an islander in no bloc has no view");
});

test("the cohesion bands are derived from the config's own boundaries", () => {
  const { defectionFloor, cohesionStart } = tunables.social;
  assert.equal(cohesionBand(defectionFloor - 0.01), "fracturing");
  assert.equal(cohesionBand(defectionFloor), "strained");
  assert.equal(cohesionBand(cohesionStart - 0.01), "strained");
  assert.equal(cohesionBand(cohesionStart), "solid");
  assert.equal(cohesionBand(1), "solid");
});

test("a dead member is not named in the view", () => {
  bloc3();
  state.contestants.c!.alive = false;
  const view = allianceViewFor("a");
  assert.equal(view!.size, 2, "the view counts the living");
  assert.ok(!view!.memberNames.includes("C"), "and does not name a corpse");
});

// ---------------------------------------------------------------------------
// Cohesion drivers.
// ---------------------------------------------------------------------------

test("cohesion rises after a successful joint vote", () => {
  bloc3();
  const g = allianceOf("a")!;
  const before = g.cohesion;

  // Two of the three converged on a target who actually went.
  const credited = creditJointVote(["a", "b", "d"], true, 2000);
  assert.deepEqual(credited, [g.id], "the bloc that moved together is the one credited");
  assert.ok(g.cohesion > before, "proving it can move a vote holds the bloc together");
});

test("a joint vote that eliminated nobody, or that one member cast alone, credits nothing", () => {
  bloc3();
  const g = allianceOf("a")!;
  const before = g.cohesion;

  assert.deepEqual(creditJointVote(["a", "b"], false, 2000), [], "no elimination, no proof");
  assert.equal(g.cohesion, before);

  assert.deepEqual(creditJointVote(["a", "d", "e"], true, 2000), [], "one member is not a bloc");
  assert.equal(g.cohesion, before);
});

test("ordinary warmth between two members strengthens the group, once per window", () => {
  bloc3();
  const g = allianceOf("a")!;
  const before = g.cohesion;

  assert.equal(creditGoodOutcome("a", "b", "amicable", 2000), true);
  assert.ok(g.cohesion > before, "warmth counts even without a formal re-alliance");

  const afterFirst = g.cohesion;
  assert.equal(
    creditGoodOutcome("a", "b", "amicable", 2001),
    false,
    "a chatty pair cannot pin cohesion at 1 by talking constantly",
  );
  assert.equal(g.cohesion, afterFirst);

  // Past the window it counts again.
  assert.equal(
    creditGoodOutcome("a", "b", "amicable", 2000 + tunables.alliances.cohesionScanMs),
    true,
  );
  assert.ok(g.cohesion > afterFirst);

  // Someone outside the bloc is not the bloc's business.
  assert.equal(creditGoodOutcome("a", "d", "amicable", 999_000), false);
  // And an outcome that is not warmth is not warmth.
  assert.equal(creditGoodOutcome("a", "b", "tension", 999_000), false);
});

test("a betrayal inside the bloc costs cohesion, and a bad enough one costs membership", () => {
  bloc3();
  const g = allianceOf("a")!;

  // Absorbed: a strong bloc takes the hit and holds.
  g.cohesion = 1;
  creditBetrayal("a", "b", 2000);
  assert.ok(g.cohesion < 1, "hitting your own ally costs the group");
  assert.equal(
    g.cohesion,
    1 - tunables.social.cohesionLossPerBetrayal,
    "exactly the configured loss",
  );
  assert.ok(allianceOf("a"), "a bloc that can absorb it keeps the betrayer");

  // Breaking: the same act on an already shaky bloc pushes it under the floor
  // and the betrayer does not get to keep the protection.
  g.cohesion = tunables.social.defectionFloor + 0.05;
  creditBetrayal("a", "b", 3000);
  assert.equal(allianceOf("a"), undefined, "the betrayer is out");
  assert.ok(!state.contestants.b!.allies.includes("a"), "and out of the ally arrays");
});

test("a betrayal between two people who share no bloc is not a bloc's problem", () => {
  bloc3();
  const g = allianceOf("a")!;
  const before = g.cohesion;
  creditBetrayal("a", "d", 2000);
  assert.equal(g.cohesion, before);
});

// ---------------------------------------------------------------------------
// The fixed-point trap. multiAlliances on with relationshipMemory off is a
// reachable production config, and it used to freeze cohesion at exactly 0.5
// forever, which put defection permanently out of reach.
// ---------------------------------------------------------------------------

test("with relationshipMemory off, cohesion does not pin above the defection floor", () => {
  reloadTunables({ ISLAND_BEHAVIOR_ALL: "1", ISLAND_RELATIONSHIP_MEMORY: "0" } as NodeJS.ProcessEnv);
  try {
    seedVilla(["a", "b", "c", "d", "e", "f"]);
    bloc3();
    const g = allianceOf("a")!;
    // A joined third member dilutes the starting value, so the bloc begins just
    // under cohesionStart and well above the floor.
    assert.ok(g.cohesion > tunables.social.defectionFloor);

    // Scan for a while with nothing sustaining the bloc.
    let now = 1000;
    let sawSubFloor = false;
    for (let i = 0; i < 40; i++) {
      now += tunables.alliances.cohesionScanMs;
      tickAlliances(now);
      const live = allianceOf("a") ?? allianceOf("b");
      if (!live) {
        // The bloc cracked, which is itself the property under test.
        sawSubFloor = true;
        break;
      }
      if (live.cohesion < tunables.social.defectionFloor) sawSubFloor = true;
      assert.notEqual(
        live.cohesion,
        0.5,
        "cohesion must not sit at the old fixed point forever",
      );
    }
    assert.ok(sawSubFloor, "an unsustained bloc must be able to reach the defection floor");
  } finally {
    reloadTunables(ALL_ON);
  }
});

test("a bloc that keeps earning cohesion does not erode away", () => {
  reloadTunables({ ISLAND_BEHAVIOR_ALL: "1", ISLAND_RELATIONSHIP_MEMORY: "0" } as NodeJS.ProcessEnv);
  try {
    seedVilla(["a", "b", "c", "d", "e", "f"]);
    bloc3();
    let now = 1000;
    for (let i = 0; i < 20; i++) {
      now += tunables.alliances.cohesionScanMs;
      creditGoodOutcome("a", "b", "amicable", now);
      tickAlliances(now);
    }
    const g = allianceOf("a");
    assert.ok(g, "a bloc that keeps earning it survives");
    assert.ok(
      g!.cohesion >= tunables.social.defectionFloor,
      "and stays above the floor",
    );
  } finally {
    reloadTunables(ALL_ON);
  }
});

// ---------------------------------------------------------------------------
// Defection follows the member's own survival, not the group number alone.
// ---------------------------------------------------------------------------

// Drive one fracturing bloc through one scan and report whether anyone walked.
// `precarious` decides whether member `a` has a personal reason to leave: real
// fights on the record with three outsiders, and health almost gone.
function defectionTrial(seed: number, precarious: boolean): boolean {
  seedVilla(["a", "b", "c", "d", "e", "f"], seed);
  bloc3();
  const g = allianceOf("a")!;
  // Put the bloc under the floor directly. Getting there through trust decay is
  // covered above; what is under test here is who walks once it is there.
  g.cohesion = 0.05;

  if (precarious) {
    for (const other of ["d", "e", "f"]) recordOutcome("a", other, "fight", 900);
    state.contestants.a!.hp = 10;
  }

  tickAlliances(10_000);
  return allianceOf("a") === undefined;
}

test("a fracturing bloc loses its precarious member far more often than a comfortable one", () => {
  const TRIALS = 300;
  let precariousWalks = 0;
  let comfortableWalks = 0;
  for (let i = 0; i < TRIALS; i++) {
    if (defectionTrial(1000 + i, true)) precariousWalks++;
    if (defectionTrial(5000 + i, false)) comfortableWalks++;
  }

  // Possible, not constant: the spec is explicit that defection is the source
  // of most drama precisely because it does not fire every time.
  assert.ok(precariousWalks > 0, "a member whose survival points elsewhere does walk");
  assert.ok(
    precariousWalks < TRIALS,
    "but not every time, or it stops being drama and becomes a rule",
  );
  assert.ok(
    comfortableWalks < precariousWalks / 2,
    `a fracturing bloc of comfortable members mostly holds ` +
      `(comfortable ${comfortableWalks} vs precarious ${precariousWalks} of ${TRIALS})`,
  );
});

test("above the defection floor nobody walks, however precarious they feel", () => {
  seedVilla(["a", "b", "c", "d", "e", "f"], 42);
  bloc3();
  const g = allianceOf("a")!;
  g.cohesion = 1;
  for (const other of ["d", "e", "f"]) recordOutcome("a", other, "fight", 900);
  state.contestants.a!.hp = 5;
  for (let now = 10_000; now < 200_000; now += tunables.alliances.cohesionScanMs) {
    tickAlliances(now);
  }
  assert.ok(allianceOf("a"), "a solid bloc holds its frightened member");
});

// ---------------------------------------------------------------------------
// The ouster board.
// ---------------------------------------------------------------------------

test("an ouster needs a third of the living field, not one angry islander", () => {
  // Six alive, so a third is two.
  const quorum = ousterQuorum();
  assert.ok(quorum >= 2, "one agent can never be enough on its own");

  // One supporter must not reach quorum in a six-person villa.
  assert.equal(supportOuster("a", "f"), false, "a single voice does not remove anyone");

  // Piling on eventually does.
  let reached = false;
  for (const s of ["b", "c", "d", "e"]) {
    if (supportOuster(s, "f")) {
      reached = true;
      break;
    }
  }
  assert.ok(reached, "enough agreement does reach quorum");
});

test("support is idempotent so one agent cannot stuff the board", () => {
  for (let i = 0; i < 10; i++) supportOuster("a", "f");
  // Ten pushes from the same agent is still one voice; if it were not, a single
  // agent could manufacture quorum by itself and the threshold would be
  // meaningless.
  assert.equal(supportOuster("a", "f"), false);
});

test("support accumulates from zero to quorum through the campaign entry point", () => {
  // THE REGRESSION. The production path asked "is this winnable" BEFORE putting
  // the first name on the board, and winnability is count + 1 >= quorum with
  // quorum floored at 2. So the first supporter always evaluated 0 + 1 >= 2 and
  // returned without registering, support never left zero, and the guard stayed
  // false forever. This asserts the two halves of that: the winnability check
  // really is false on an empty board, and campaigning registers anyway.
  assert.equal(ousterSupportCount("f"), 0);
  assert.equal(
    ousterIsWinnable("f", 1),
    false,
    "an empty board is not yet winnable, which is exactly why it must not gate registration",
  );

  const first = campaignForOuster("a", "f", 1000);
  assert.equal(first.registered, true, "the first voice goes on the board");
  assert.equal(first.reachedQuorum, false);
  assert.equal(first.keepCampaigning, true, "one more voice would carry it, so keep pushing");
  assert.equal(ousterSupportCount("f"), 1, "support left zero");

  const second = campaignForOuster("b", "f", 1100);
  assert.equal(second.reachedQuorum, true, "and reached quorum through the same path");
  assert.equal(ousterSupportCount("f"), 2);
});

test("campaigning is still one voice per agent", () => {
  for (let i = 0; i < 10; i++) campaignForOuster("a", "f", 1000 + i);
  assert.equal(ousterSupportCount("f"), 1);
});

test("stale support expires so the villa can move on", () => {
  const ttl = tunables.alliances.ousterSupportTtlMs;
  campaignForOuster("a", "f", 1000);
  campaignForOuster("b", "f", 1000 + ttl);
  assert.equal(ousterSupportCount("f"), 2);

  expireOusterSupport(1000 + ttl);
  assert.equal(ousterSupportCount("f"), 1, "the opening-minute grudge stopped counting");

  expireOusterSupport(1000 + ttl * 2);
  assert.equal(ousterSupportCount("f"), 0, "and so did the later one");
});

test("expiry runs on the alliance scan, not only when someone dies", () => {
  const ttl = tunables.alliances.ousterSupportTtlMs;
  campaignForOuster("a", "f", 1000);
  campaignForOuster("b", "f", 1000);
  assert.equal(ousterSupportCount("f"), 2);
  tickAlliances(1000 + ttl + 1);
  assert.equal(ousterSupportCount("f"), 0);
});

// ---------------------------------------------------------------------------
// Flags off.
// ---------------------------------------------------------------------------

test("with the flags off every group mechanic is a no-op", () => {
  reloadTunables({ ISLAND_BEHAVIOR_ALL: "0" } as NodeJS.ProcessEnv);
  try {
    seedVilla(["a", "b", "c", "d", "e", "f"]);
    assert.equal(joinOrFormAlliance(state.contestants.a!, state.contestants.b!, 1000), null);
    assert.equal(allianceOf("a"), undefined, "no bloc object is created");
    assert.deepEqual(state.contestants.a!.allies, [], "the caller's own pairwise push is all there is");
    assert.equal(allianceViewFor("a"), undefined, "and nothing reaches the agent context");
    assert.deepEqual(creditJointVote(["a", "b"], true, 1000), []);
    assert.equal(creditGoodOutcome("a", "b", "amicable", 1000), false);
    assert.equal(supportOuster("a", "f", 1000), false, "the ouster board is closed too");
    assert.equal(ousterSupportCount("f"), 0);
  } finally {
    reloadTunables(ALL_ON);
  }
});
