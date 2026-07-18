import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentContextView, AgentDecision, ConvOutcome } from "@arena/shared";
import { applyTunables, tunables } from "@arena/shared";
import { clampLine, decideBatchOrFanOut, type ModelBackend } from "../backend.js";
import { createCallBudget } from "../budget.js";
import { readSwarmConfig } from "../config.js";
import {
  createBackend,
  createHostedBackend,
  createOllamaBackend,
  createResilientBackend,
  createRuleBackend,
} from "./index.js";

// ---------------------------------------------------------------------------
// The seam's load-bearing promise is that the sim never stops: whatever the
// configuration and whatever the model does, a decision and a line come back.
// These cover the paths that promise rests on.
// ---------------------------------------------------------------------------

const ALLOWED: ConvOutcome["outcome"][] = ["alliance", "truce", "nothing"];
const rand = () => 0.42;

function ctx(
  self: Partial<AgentContextView["self"]> = {},
  partner: Partial<AgentContextView["nearby"][number]> = {},
  event: AgentContextView["event"] = null,
): AgentContextView {
  return {
    self: {
      id: "a1",
      name: "Priya",
      klass: "charmer",
      stats: { charisma: 7, cunning: 4, grit: 5, strength: 4, charm: 8, instinct: 5, resolve: 5 },
      persona: "",
      hp: 100,
      maxHp: 100,
      hpFraction: 1,
      kills: 0,
      notoriety: 0,
      priceYes: 0.5,
      allies: [],
      x: 0,
      y: 0,
      ...self,
    },
    nearby: [
      {
        id: "b2",
        name: "Marcus",
        klass: "bold",
        hpFraction: 0.9,
        kills: 0,
        notoriety: 0,
        priceYes: 0.4,
        allied: false,
        distance: 20,
        allyCount: 0,
        ...partner,
      },
    ],
    memory: [],
    event,
    phase: "running",
  };
}

// A backend that always fails, standing in for an unreachable or broken model.
const deadBackend = {
  name: "dead",
  billable: false,
  healthy: async () => false,
  decide: async () => {
    throw new Error("unreachable");
  },
  converse: async () => {
    throw new Error("unreachable");
  },
  resolve: async () => {
    throw new Error("unreachable");
  },
};

test("config defaults to the local backend and honors the flag", () => {
  const dflt = readSwarmConfig({});
  assert.equal(dflt.backend, "local");
  assert.equal(dflt.enabled, true);
  assert.equal(dflt.backendExplicit, false);

  assert.equal(readSwarmConfig({ SWARM_BACKEND_ENABLED: "0" }).enabled, false);
  assert.equal(readSwarmConfig({ SWARM_BACKEND_ENABLED: "false" }).enabled, false);
  assert.equal(readSwarmConfig({ SWARM_BACKEND: "rules" }).backend, "rules");
  assert.equal(readSwarmConfig({ SWARM_BACKEND: "anthropic" }).backend, "anthropic");
  assert.equal(readSwarmConfig({ SWARM_BACKEND: "hosted" }).backend, "hosted");
  // An unrecognized value must not silently disable the game's brain.
  assert.equal(readSwarmConfig({ SWARM_BACKEND: "banana" }).backend, "local");
  // Reads the passed environment, not process.env.
  assert.equal(readSwarmConfig({ SWARM_LOCAL_MODEL: "phi4" }).local.model, "phi4");
  // An unset SWARM_LOCAL_MODEL no longer hardcodes a name: the local backend
  // auto-detects, so config just reports "unset" here.
  assert.equal(readSwarmConfig({}).local.model, undefined);
});

test("SWARM_BACKEND order of preference when unset: anthropic if keyed, else local", () => {
  assert.equal(readSwarmConfig({ ANTHROPIC_API_KEY: "sk-test" }).backend, "anthropic");
  assert.equal(readSwarmConfig({}).backend, "local");
  // An explicit choice always wins over the key, in either direction, and is
  // reported as explicit so the boot warning can tell the two cases apart.
  const explicitLocal = readSwarmConfig({ SWARM_BACKEND: "local", ANTHROPIC_API_KEY: "sk-test" });
  assert.equal(explicitLocal.backend, "local");
  assert.equal(explicitLocal.backendExplicit, true);
  assert.equal(readSwarmConfig({ ANTHROPIC_API_KEY: "sk-test" }).backendExplicit, false);
});

test("a failing primary falls through to the rule engine", async () => {
  const backend = createResilientBackend({ primary: deadBackend, rules: createRuleBackend() });

  const d = await backend.decide(ctx(), rand);
  assert.ok(d.value.action, "a decision still came back");
  assert.equal(d.fallback, true);

  const c = await backend.converse(ctx(), "Marcus", [], rand);
  assert.ok(c.value.text.length > 0, "a line still came back");

  const r = await backend.resolve(ctx(), "Marcus", [], ALLOWED, rand);
  assert.ok(ALLOWED.includes(r.value.outcome), "outcome stayed inside the allowed set");
});

test("the breaker stops paying for a primary that is down", async () => {
  let calls = 0;
  const counting = {
    ...deadBackend,
    decide: async () => {
      calls++;
      throw new Error("down");
    },
  };
  const backend = createResilientBackend({ primary: counting, rules: createRuleBackend() });

  for (let i = 0; i < 20; i++) await backend.decide(ctx(), rand);
  // Opens after a few consecutive failures and stays open for the cooldown.
  assert.ok(calls < 20, `primary was skipped once the breaker opened (called ${calls}/20)`);
});

test("a saturated local primary serves overflow from rules without queueing", async () => {
  let primaryCalls = 0;
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const local: ModelBackend = {
    ...deadBackend,
    name: "local",
    maxConcurrency: 1,
    async decide() {
      primaryCalls += 1;
      await firstReleased;
      return {
        value: { action: "wander", target: null, reasoning: "model answer" } as AgentDecision,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        latencyMs: 1,
        cached: false,
        backend: "local",
        fallback: false,
      };
    },
  };
  const backend = createResilientBackend({ primary: local, rules: createRuleBackend() });

  const first = backend.decide(ctx(), rand);
  const overflow = await backend.decide(ctx({ id: "a2", name: "Jules" }), rand);
  assert.equal(primaryCalls, 1, "overflow never entered the saturated primary");
  assert.equal(overflow.fallback, true, "overflow received an immediate complete rule decision");

  releaseFirst();
  const admitted = await first;
  assert.equal(admitted.fallback, false, "the admitted primary call still completed normally");
});

test("every configuration still produces a decision and a line", async () => {
  for (const kind of ["rules", "local", "anthropic", "hosted"] as const) {
    const backend = createBackend(
      readSwarmConfig({
        SWARM_BACKEND: kind,
        SWARM_LOCAL_HOST: "http://127.0.0.1:9",
        SWARM_LOCAL_TIMEOUT_MS: "300",
        SWARM_HOSTED_BASE_URL: "http://127.0.0.1:9",
        SWARM_HOSTED_TIMEOUT_MS: "300",
      }),
    );
    const d = await backend.decide(ctx(), rand);
    const c = await backend.converse(ctx(), "Marcus", [], rand);
    assert.ok(d.value.action, `${kind}: decision`);
    assert.ok(c.value.text.length > 0, `${kind}: line`);
  }
});

test("hosted backend constructs and is selected on SWARM_BACKEND=hosted", () => {
  const config = readSwarmConfig({
    SWARM_BACKEND: "hosted",
    SWARM_HOSTED_BASE_URL: "http://127.0.0.1:9999/v1",
  });
  assert.equal(config.backend, "hosted");
  const backend = createBackend(config);
  // Wrapped in the resilient rule fallback, same as every other primary.
  assert.ok(backend.name.includes("hosted"));
});

test("hosted backend produces valid speech and decisions against a stub OpenAI-compatible server", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/models")) return new Response("{}", { status: 200 });
    // A minimal OpenAI-compatible chat-completions reply: the JSON payload
    // the caller asked for, already stringified into message.content.
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: { content: string }[] };
    const wantsDecision = body.messages[1]?.content.includes("Choose the one action");
    const content = wantsDecision
      ? JSON.stringify({ action: "wander", target: null, reasoning: "taking it all in" })
      : JSON.stringify({ text: "Hey, how are you finding the villa so far", tone: "friendly", wantsToEnd: false });
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const backend = createHostedBackend({
      baseUrl: "http://stub/v1",
      model: "stub-model",
      apiKey: undefined,
      timeoutMs: 1000,
    });
    const d = await backend.decide(ctx(), rand);
    assert.equal(d.value.action, "wander");
    const c = await backend.converse(ctx(), "Marcus", [], rand);
    assert.ok(c.value.text.length > 0);
    assert.equal(c.value.tone, "friendly");
  } finally {
    globalThis.fetch = original;
  }
});

test("rule speech and outcomes follow the relationship and world state", async () => {
  const rules = createRuleBackend();
  const say = async (c: AgentContextView) => (await rules.converse(c, "Marcus", [], rand)).value;

  // An ally in trouble is spoken to differently than a stranger.
  const stranger = await say(ctx());
  const ally = await say(ctx({}, { allied: true }));
  assert.notEqual(stranger.text, ally.text);

  // A hostile island forces the fight outcome and a hostile tone.
  const endgame = ctx({}, {}, { kind: "hostile", secondsUntil: null, line: "brutal" });
  const fin = await rules.resolve(endgame, "Marcus", [], ["fight", "nothing"], rand);
  assert.equal(fin.value.outcome, "fight");
  assert.equal(fin.value.tone, "hostile");

  // Allies stay within the legal outcome set passed in; "nothing" is now the
  // modal outcome across the sim (spec line 80), so this no longer pins
  // allies to alliance/truce specifically, only to a legal outcome.
  const withAlly = await rules.resolve(ctx({}, { allied: true }), "Marcus", [], ALLOWED, rand);
  assert.ok(ALLOWED.includes(withAlly.value.outcome));

  // The partner's name is templated into the line, not left as a placeholder.
  const named = await say(ctx({}, { allied: true, hpFraction: 0.2 }));
  assert.ok(!named.text.includes("{p}"), "placeholders were filled");
});

test("a speaker does not repeat a line already in the transcript", async () => {
  const rules = createRuleBackend();
  const c = ctx({}, { allied: true });
  const transcript: { speaker: string; text: string }[] = [];
  // Drain more turns than the intent pool holds to prove dedupe is doing work.
  for (let i = 0; i < 5; i++) {
    const line = (await rules.converse(c, "Marcus", transcript, Math.random)).value.text;
    assert.ok(!transcript.some((t) => t.text === line), `turn ${i} repeated a line`);
    transcript.push({ speaker: "Priya", text: line });
  }
});

test("rule decisions are deterministic under a seeded rand", async () => {
  const rules = createRuleBackend();
  const a = await rules.decide(ctx(), () => 0.77);
  const b = await rules.decide(ctx(), () => 0.77);
  assert.deepEqual(a.value, b.value);
});

test("the rule engine never bills the spend cap", async () => {
  const rules = createRuleBackend();
  assert.equal(rules.billable, false);
  const d = await rules.decide(ctx(), rand);
  assert.equal(d.usage.inputTokens + d.usage.outputTokens, 0);
});

test("truncated model JSON is salvaged rather than discarded", async () => {
  const backend = createOllamaBackend({ host: "http://stub", model: "stub", timeoutMs: 1000 });
  const original = globalThis.fetch;
  const reply = (content: string) =>
    (globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: { content } }), { status: 200 })) as typeof fetch);

  try {
    for (const [label, payload] of [
      ["complete", '{"action":"approach","target":"Marcus","reasoning":"ok"}'],
      [
        "cut mid-string",
        '{"action":"approach","target":"Marcus","reasoning":"it was getting late and',
      ],
      ["cut after comma", '{"action":"attack","target":"Marcus","reasoning":"he had it coming",'],
      ["dangling key", '{"action":"wander","target":null,"reasoning":"bored","note'],
      ["dangling colon", '{"action":"wander","target":null,"reasoning":"bored","note":'],
    ] as const) {
      reply(payload);
      const d = await backend.decide(ctx(), rand);
      assert.ok(d.value.action, `${label}: recovered an action`);
    }

    // Genuine garbage must still fail, so the caller drops to the rules.
    reply("not json at all");
    await assert.rejects(() => backend.decide(ctx(), rand));
  } finally {
    globalThis.fetch = original;
  }
});

test("clampLine keeps user-visible text tidy", () => {
  // Short lines pass through untouched.
  assert.equal(clampLine("Short and sweet."), "Short and sweet.");
  // Long lines break on a boundary, never mid-word.
  const long = clampLine(`${"word ".repeat(60)}end`);
  assert.ok(long.length <= 163, "bounded");
  assert.ok(!/\bwor$|\bwo$/.test(long), "did not cut mid-word");
  // A sentence end is preferred over a bare word boundary.
  assert.ok(clampLine(`${"a".repeat(80)}. ${"b".repeat(200)}`).endsWith("."));
});

test("clampLine emits no dash for any input containing em or en dashes", () => {
  // The house rule for islander speech is absolute: no dash of any kind,
  // ever - not even the plain ASCII dash the old rewrite substituted in.
  const noDash = /[–—-]/;
  const cases = [
    "well—no, wait–yes",
    "a strong-willed islander",
    "out-swim, out-talk, and out-flirt you",
    "the vote—if it happens—goes to Marcus",
    "twenty-two years old, born and raised here",
  ];
  for (const input of cases) {
    const out = clampLine(input);
    assert.ok(!noDash.test(out), `clampLine(${JSON.stringify(input)}) -> ${JSON.stringify(out)} still has a dash`);
  }
  // Rephrasing must not glue two words together either.
  assert.equal(clampLine("well—no, wait–yes"), "well no, wait yes");
  assert.equal(clampLine("a strong-willed islander"), "a strong willed islander");
});

test("an unset SWARM_BACKEND still resolves per the documented default", () => {
  assert.equal(readSwarmConfig({}).backend, "local");
  assert.equal(readSwarmConfig({ ANTHROPIC_API_KEY: "sk-live" }).backend, "anthropic");
});

test("createCallBudget: over-budget calls degrade rather than throw", () => {
  applyTunables({ flags: { ...tunables.flags, perTickCallBudget: true } });
  try {
    const budget = createCallBudget(() => 2);
    assert.equal(budget.tryAcquire(), true);
    assert.equal(budget.tryAcquire(), true);
    // Exhausted: false, not a throw, so the caller can degrade to rules.
    assert.equal(budget.tryAcquire(), false);
    assert.equal(budget.remaining(), 0);
    budget.refillTick();
    assert.equal(budget.remaining(), 2);
    assert.equal(budget.tryAcquire(), true);
  } finally {
    applyTunables({ flags: { ...tunables.flags, perTickCallBudget: false } });
  }
});

test("createCallBudget: the flag gates enforcement, not existence", () => {
  applyTunables({ flags: { ...tunables.flags, perTickCallBudget: false } });
  const budget = createCallBudget(() => 1);
  assert.equal(budget.tryAcquire(), true);
  assert.equal(budget.tryAcquire(), true, "flag off admits every call regardless of the counter");
});

test("a harness with callsPerTick=2 degrades to rule speech rather than stalling", async () => {
  applyTunables({ flags: { ...tunables.flags, perTickCallBudget: true } });
  try {
    const budget = createCallBudget(() => 2);
    const backend = createResilientBackend({ primary: deadBackend, rules: createRuleBackend() });
    const results = [];
    for (let i = 0; i < 5; i++) {
      const served = budget.tryAcquire() ? backend : createRuleBackend();
      results.push(await served.decide(ctx(), rand));
    }
    assert.equal(results.length, 5, "the run completed without stalling");
    assert.ok(results.every((r) => r.value.action), "every turn still produced a decision");
  } finally {
    applyTunables({ flags: { ...tunables.flags, perTickCallBudget: false } });
  }
});

test("decideBatch's default fan-out matches N single calls", async () => {
  const backend = createRuleBackend(); // rules never implements decideBatch
  assert.equal(backend.decideBatch, undefined);
  const contexts = [ctx(), ctx({ id: "a2", name: "Jules" })];
  const batched = await decideBatchOrFanOut(backend)(contexts, rand);
  const singles = await Promise.all(contexts.map((c) => backend.decide(c, rand)));
  assert.equal(batched.length, singles.length);
  for (let i = 0; i < batched.length; i++) {
    assert.deepEqual(batched[i]!.value, singles[i]!.value);
  }
});

test("decideBatchOrFanOut prefers the backend's own batching when it implements one", async () => {
  let batchCalls = 0;
  const batching: ModelBackend = {
    ...deadBackend,
    decide: async () => {
      throw new Error("should not fan out when decideBatch exists");
    },
    async decideBatch(contexts) {
      batchCalls++;
      return contexts.map(() => ({
        value: { action: "wander", target: null, reasoning: "" } as AgentDecision,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        latencyMs: 0,
        cached: false,
      }));
    },
  };
  const out = await decideBatchOrFanOut(batching)([ctx(), ctx()], rand);
  assert.equal(batchCalls, 1);
  assert.equal(out.length, 2);
});

test("resilient backend reports degraded() once the breaker opens", async () => {
  const backend = createResilientBackend({ primary: deadBackend, rules: createRuleBackend() });
  assert.equal(backend.degraded?.(), false);
  for (let i = 0; i < 5; i++) await backend.decide(ctx(), rand);
  assert.equal(backend.degraded?.(), true);
});
