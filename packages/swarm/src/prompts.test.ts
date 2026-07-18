import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AgentContextView,
  OverheardFragment,
  RelationshipSummary,
  WorldEvent,
  WorldStateView,
} from "@arena/shared";
import { reloadTunables, tunables } from "@arena/shared";

import {
  buildConversationUser,
  buildDecisionUser,
  buildPersonaBlock,
  DECIDE_TOOL,
  promptRules,
  setOverheardUsedHook,
  sharedRules,
  SPEAK_TOOL,
} from "./prompts.js";
import { fallbackDecision } from "./fallback.js";

// ---------------------------------------------------------------------------
// Fixtures.
//
// Every test below builds two contexts that differ in exactly one field, which
// is the only way to prove a prompt actually READS that field. The regression
// these guard is not "the prompt is wrong" but "the prompt is identical when it
// should not be": before this workstream, every optional awareness field on the
// context was populated by the server on every think and read by nothing, so
// two islanders with three fights between them produced a byte-identical
// conversation prompt to two who had just met.
// ---------------------------------------------------------------------------

function baseCtx(over: Partial<AgentContextView> = {}): AgentContextView {
  return {
    self: {
      id: "a1",
      name: "Ava",
      klass: "schemer",
      stats: { charisma: 5, cunning: 6, grit: 4, strength: 4, charm: 5, instinct: 6, resolve: 5 },
      persona: "",
      hp: 80,
      maxHp: 100,
      hpFraction: 0.8,
      kills: 0,
      notoriety: 0,
      priceYes: 0.43,
      allies: [],
      x: 100,
      y: 100,
    },
    nearby: [
      {
        id: "b1",
        name: "Bo",
        klass: "bold",
        hpFraction: 0.9,
        kills: 1,
        notoriety: 12,
        priceYes: 0.51,
        allied: false,
        distance: 40,
        allyCount: 1,
      },
    ],
    memory: [],
    event: null,
    phase: "running",
    ...over,
  };
}

function rel(over: Partial<RelationshipSummary> = {}): RelationshipSummary {
  return {
    id: "b1",
    name: "Bo",
    trust: 0,
    threat: 0,
    affinity: 0,
    recent: [],
    line: null,
    ...over,
  };
}

function world(over: Partial<WorldStateView> = {}): WorldStateView {
  return {
    livingCount: 4,
    startingCount: 12,
    runElapsedMs: 120_000,
    phase: "mid",
    posture: "none",
    eventKind: null,
    secondsUntilEvent: null,
    recent: [],
    ...over,
  };
}

function fragment(over: Partial<OverheardFragment> = {}): OverheardFragment {
  return {
    t: 1000,
    heardAt: 1000,
    speakerId: "b1",
    speakerName: "Bo",
    aboutId: null,
    text: "she is the one to watch",
    fresh: true,
    ...over,
  };
}

// Flags come from the environment at import time. Force them all on for the
// body of a test and restore afterwards, so one test's flags cannot leak into
// the next through the shared mutable tunables object.
function withFlagsOn<T>(fn: () => T): T {
  const before = { ...tunables.flags };
  reloadTunables({ ISLAND_BEHAVIOR_ALL: "1" });
  try {
    return fn();
  } finally {
    Object.assign(tunables.flags, before);
    promptRules();
  }
}

// ---------------------------------------------------------------------------

test("reloadTunables after import changes the emitted rules", () => {
  const before = { ...tunables.flags };
  try {
    reloadTunables({ ISLAND_BEHAVIOR_ALL: "1" });
    const on = sharedRules();
    const onHint = DECIDE_TOOL.input_schema.properties.reasoning.description;

    reloadTunables({ ISLAND_BEHAVIOR_ALL: "0" });
    const off = sharedRules();
    const offHint = DECIDE_TOOL.input_schema.properties.reasoning.description;

    // This is the regression the module-load consts hid completely: with the
    // rule text captured at import, both reads returned the same string and a
    // test could not tell the two builds apart.
    assert.notEqual(on, off, "shared rules must track a flag change made after import");
    assert.notEqual(onHint, offHint, "tool descriptions must track a flag change too");
    assert.ok(on.includes("Never state a percentage"), "selfOdds rule missing with flags on");
    assert.ok(!off.includes("Never state a percentage"), "selfOdds rule leaked with flags off");
  } finally {
    Object.assign(tunables.flags, before);
    promptRules();
  }
});

test("SHARED_RULES live binding and SPEAK_TOOL description stay in sync with the flags", () => {
  withFlagsOn(() => {
    const r = promptRules();
    assert.equal(sharedRules(), r.sharedRules);
    assert.equal(SPEAK_TOOL.input_schema.properties.text.description.includes(r.noDashHint), true);
  });
});

test("two contexts differing only in relationship history produce different prompts", () => {
  withFlagsOn(() => {
    const strangers = baseCtx({ relationships: [] });
    const enemies = baseCtx({
      relationships: [
        rel({
          trust: -0.7,
          threat: 0.6,
          affinity: -0.5,
          recent: ["fight", "tension", "fight"],
          line: "Bo: you do not trust them, you dislike them, they are dangerous to you, you fought 3 times.",
        }),
      ],
    });

    const a = buildConversationUser("Bo", [], "Ava", false, null, strangers);
    const b = buildConversationUser("Bo", [], "Ava", false, null, enemies);
    assert.notEqual(a, b, "history must change the conversation prompt");
    assert.ok(b.includes("you fought 3 times"), "the pre-rendered relationship line must be injected");
    assert.ok(b.includes("a fight"), "the recent outcome window must be injected");
    assert.ok(!a.includes("you fought"), "a pair with no history must get no history clause");
  });
});

test("the relationship block picks the partner out by name, not the strongest feeling", () => {
  withFlagsOn(() => {
    const ctx = baseCtx({
      relationships: [
        rel({ id: "c1", name: "Cass", trust: -0.9, line: "Cass: you do not trust them." }),
        rel({ id: "b1", name: "Bo", trust: 0.6, line: "Bo: you trust them." }),
      ],
    });
    const out = buildConversationUser("Bo", [], "Ava", false, null, ctx);
    assert.ok(out.includes("Bo: you trust them."));
    assert.ok(!out.includes("Cass"), "a conversation prompt must not narrate an absent third party");
  });
});

test("a context with a world snapshot mentions the living count", () => {
  withFlagsOn(() => {
    const ctx = baseCtx({ world: world({ livingCount: 4 }) });
    for (const out of [
      buildDecisionUser(ctx),
      buildConversationUser("Bo", [], "Ava", false, null, ctx),
    ]) {
      assert.ok(out.includes("4 of you are left"), "the world block must reach both builders");
    }
  });
});

test("the aftermath of an event has a voice", () => {
  withFlagsOn(() => {
    const death: WorldEvent = {
      id: 1,
      t: 5,
      kind: "death",
      actorIds: ["z9"],
      line: "someone died",
      livingAfter: 4,
    };
    const ctx = baseCtx({
      world: world({ posture: "justPassed" }),
      recentEvents: [death],
    });
    const out = buildConversationUser("Bo", [], "Ava", false, null, ctx);
    assert.ok(out.includes("it just happened"), "the just-passed posture must be narrated");
    assert.ok(out.includes("someone just died"), "the recent event must be narrated");
    assert.ok(out.includes("Nobody in here is over it yet"), "the aftermath steer is missing");
  });
});

test("an overheard fragment reaches the prompt and retires only when it does", () => {
  withFlagsOn(() => {
    const used: string[] = [];
    setOverheardUsedHook((listenerId, f) => used.push(`${listenerId}:${f.text}`));
    try {
      const ctx = baseCtx({ overheard: [fragment()] });
      const out = buildConversationUser("Bo", [], "Ava", false, null, ctx);
      assert.ok(out.includes("she is the one to watch"), "the fragment text must be injected");
      assert.ok(out.includes("You overheard Bo"), "the speaker must be named");
      assert.deepEqual(used, ["a1:she is the one to watch"]);

      // A fragment already passed on is not passed on again.
      used.length = 0;
      const stale = baseCtx({ overheard: [fragment({ fresh: false })] });
      const out2 = buildConversationUser("Bo", [], "Ava", false, null, stale);
      assert.ok(!out2.includes("she is the one to watch"));
      assert.deepEqual(used, []);
    } finally {
      setOverheardUsedHook(null);
    }
  });
});

test("a throwing overheard hook cannot take the prompt down", () => {
  withFlagsOn(() => {
    setOverheardUsedHook(() => {
      throw new Error("store exploded");
    });
    try {
      const ctx = baseCtx({ overheard: [fragment()] });
      const out = buildConversationUser("Bo", [], "Ava", false, null, ctx);
      assert.ok(out.includes("she is the one to watch"));
    } finally {
      setOverheardUsedHook(null);
    }
  });
});

test("the room and the bloc are narrated, and per personality", () => {
  withFlagsOn(() => {
    const secluded = baseCtx({ spatial: { density: "secluded", neighborCount: 0 } });
    const crowded = baseCtx({ spatial: { density: "crowded", neighborCount: 6 } });
    const a = buildDecisionUser(secluded);
    const b = buildDecisionUser(crowded);
    assert.notEqual(a, b, "density must change the prompt");
    assert.ok(a.includes("Nobody is within earshot"), "the schemer's secluded steer is missing");
    assert.ok(b.includes("Too many ears here"), "the schemer's crowded steer is missing");

    // Same room, different personality, different steer.
    const boldCrowd = buildDecisionUser({
      ...crowded,
      self: { ...crowded.self, klass: "bold" },
    });
    assert.ok(boldCrowd.includes("This is where you perform"));

    const bloc = baseCtx({
      alliance: {
        id: "g1",
        size: 4,
        memberNames: ["Ava", "Bo", "Cass", "Dee"],
        cohesionBand: "fracturing",
      },
    });
    const out = buildDecisionUser(bloc);
    assert.ok(out.includes("You are one of four"), "the bloc must be speakable as a group");
    assert.ok(out.includes("coming apart"), "the cohesion band must be narrated");
    assert.ok(!out.includes("Ava,"), "the agent must not be listed as its own bloc mate");
  });
});

test("no prompt on any path states a percentage about the agent itself", () => {
  const check = (label: string, out: string) => {
    // The nearby block legitimately quotes other islanders' public favor, so
    // the assertion is specifically about the self line, which is line one.
    // The HP percentage on that line is health, not odds: an islander can see
    // its own bruises. Strip it before looking for a forbidden number.
    const selfLine = (out.split("\n")[0] ?? "").replace(/HP \d+\/\d+ \(\d+%\)\./, "");
    assert.ok(
      !/\d+\s*%/.test(selfLine),
      `${label}: a self percentage leaked into the prompt: ${selfLine}`,
    );
    assert.ok(!out.includes("Your market:"), `${label}: the raw market price leaked`);
  };

  const before = { ...tunables.flags };
  try {
    // Both directions of the master switch. The raw-price branch used to be
    // the DEFAULT path, reached whenever selfOdds was off, which made an
    // absolute cross-cutting prohibition conditional on a feature flag.
    for (const all of ["1", "0"]) {
      reloadTunables({ ISLAND_BEHAVIOR_ALL: all });
      check(`flags=${all} no band`, buildDecisionUser(baseCtx()));
      check(
        `flags=${all} with band`,
        buildDecisionUser(
          baseCtx({
            selfOdds: {
              band: "precarious",
              allianceCount: 0,
              fallenOutCount: 2,
              activity: 0.2,
              worried: true,
            },
          }),
        ),
      );
    }
  } finally {
    Object.assign(tunables.flags, before);
    promptRules();
  }
});

test("the standing sentence varies between agents in the same band", () => {
  withFlagsOn(() => {
    const odds = {
      band: "steady" as const,
      allianceCount: 2,
      fallenOutCount: 0,
      activity: 0.5,
      worried: false,
    };
    const seen = new Set<string>();
    for (const id of ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]) {
      const out = buildDecisionUser(
        baseCtx({ selfOdds: odds, self: { ...baseCtx().self, id } }),
      );
      seen.add(out.split("\n")[0] ?? "");
    }
    assert.ok(seen.size > 1, "one fixed sentence per band anchors the model onto one thought");
  });
});

test("the added dynamic context stays inside its token budget", () => {
  withFlagsOn(() => {
    const bare = baseCtx();
    const loaded = baseCtx({
      world: world({ posture: "justPassed", recent: [] }),
      recentEvents: [
        { id: 1, t: 1, kind: "death", actorIds: ["z"], line: "x", livingAfter: 5 },
        { id: 2, t: 2, kind: "purge", actorIds: ["y"], line: "x", livingAfter: 4 },
        { id: 3, t: 3, kind: "fight", actorIds: ["a1"], line: "x", livingAfter: 4 },
      ],
      relationships: [
        rel({
          recent: ["fight", "tension", "fight"],
          line: "Bo: you do not trust them, you dislike them, they are dangerous to you, you fought 3 times.",
        }),
      ],
      alliance: {
        id: "g1",
        size: 3,
        memberNames: ["Ava", "Bo", "Cass"],
        cohesionBand: "strained",
      },
      overheard: [fragment()],
      spatial: { density: "crowded", neighborCount: 7 },
    });
    const added =
      buildConversationUser("Bo", [], "Ava", false, null, loaded).length -
      buildConversationUser("Bo", [], "Ava", false, null, bare).length;
    // The budget is a character ceiling standing in for ~180 tokens. This is a
    // per-call cost on every backend because the dynamic block is uncached by
    // construction, so it has to be bounded rather than merely small today.
    assert.ok(added > 0, "a fully populated context must actually add something");
    assert.ok(added <= 720, `added context was ${added} characters, over the budget`);
  });
});

test("with the behavior flags off the optional context adds nothing", () => {
  const before = { ...tunables.flags };
  try {
    reloadTunables({ ISLAND_BEHAVIOR_ALL: "0" });
    const bare = baseCtx();
    const loaded = baseCtx({
      world: world(),
      relationships: [rel({ line: "Bo: you fought once." })],
      alliance: { id: "g1", size: 3, memberNames: ["Ava", "Bo", "Cass"], cohesionBand: "solid" },
      overheard: [fragment()],
      spatial: { density: "crowded", neighborCount: 7 },
    });
    assert.equal(
      buildConversationUser("Bo", [], "Ava", false, null, loaded),
      buildConversationUser("Bo", [], "Ava", false, null, bare),
      "flags off must reproduce the pre-spec conversation prompt",
    );
  } finally {
    Object.assign(tunables.flags, before);
    promptRules();
  }
});

test("the persona block still carries an owner blurb when one exists", () => {
  const ctx = baseCtx({ self: { ...baseCtx().self, persona: "a chaotic ex barista" } });
  const out = buildPersonaBlock(ctx);
  assert.ok(out.includes("a chaotic ex barista"));
  assert.ok(out.includes("Class: SCHEMER"));
});

test("no prompt text this module emits contains a dash of any kind", () => {
  withFlagsOn(() => {
    const ctx = baseCtx({
      world: world({ posture: "justPassed" }),
      relationships: [rel({ line: "Bo: you fought once." })],
      alliance: { id: "g1", size: 3, memberNames: ["Ava", "Bo", "Cass"], cohesionBand: "solid" },
      overheard: [fragment()],
      spatial: { density: "secluded", neighborCount: 0 },
      selfOdds: {
        band: "shaky",
        allianceCount: 1,
        fallenOutCount: 1,
        activity: 0.4,
        worried: true,
      },
    });
    const texts = [
      sharedRules(),
      buildPersonaBlock(ctx),
      buildDecisionUser(ctx),
      buildConversationUser("Bo", [], "Ava", false, null, ctx),
      DECIDE_TOOL.input_schema.properties.reasoning.description,
      SPEAK_TOOL.input_schema.properties.text.description,
    ];
    for (const t of texts) {
      // Telling a model never to use a dash while showing it dashes is asking
      // it to ignore the rule. The one exception is the hyphen inside words we
      // did not author, which this fixture has none of.
      assert.ok(!/[—–]/.test(t), `an em or en dash survived: ${t.slice(0, 80)}`);
      assert.ok(!/ - /.test(t), `a spaced dash survived: ${t.slice(0, 80)}`);
    }
  });
});

test("a feasible fallback campaign carries the rival separately from the confidant", () => {
  withFlagsOn(() => {
    const context = baseCtx({
      self: {
        ...baseCtx().self,
        allies: ["c1", "d1"],
      },
      nearby: [
        {
          ...baseCtx().nearby[0]!,
          id: "b1",
          name: "Bo",
          kills: 3,
          notoriety: 40,
          allied: false,
          distance: 45,
        },
        {
          ...baseCtx().nearby[0]!,
          id: "c1",
          name: "Cass",
          kills: 0,
          notoriety: 0,
          allied: true,
          distance: 20,
        },
      ],
      event: { kind: "weakestLink", secondsUntil: 30, line: "The Vote is coming." },
      world: world({ phase: "mid", posture: "imminent", eventKind: "weakestLink" }),
    });

    const decision = fallbackDecision(context, () => 0);
    assert.equal(decision.action, "approach");
    assert.equal(decision.target, "c1", "the physical target is the confidant");
    assert.equal(decision.voteTarget, "b1", "the social target is the rival");
  });
});
