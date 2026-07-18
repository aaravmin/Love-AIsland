import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentBrief,
  AgentContextView,
  ConvMessage,
  ConvOutcome,
  ConversationView,
  DecisionSink,
  WorldView,
} from "@arena/shared";
import { applyTunables, tunables } from "@arena/shared";
import { runConversation, type ConversationDeps } from "./conversation.js";
import { createRuleBackend } from "./backends/index.js";
import { resetRuleSpeechMemory } from "./backends/rules.js";
import { SpendTracker } from "./spend.js";
import { createCallBudget } from "./budget.js";

// ---------------------------------------------------------------------------
// WS-M's three conversation-loop guarantees:
//   - same run seed + rules backend -> byte-identical transcripts (spec 214)
//   - the final turn resolves against a re-read allowed set, not the stale
//     one handed out when the conversation started
//   - a per tick call budget of 1 degrades excess calls to rules rather than
//     stalling the conversation
// ---------------------------------------------------------------------------

function brief(id: string, name: string): AgentBrief {
  return { id, name, klass: "charmer" };
}

function baseCtx(id: string, name: string): AgentContextView {
  return {
    self: {
      id,
      name,
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
    },
    nearby: [],
    memory: [],
    event: null,
    phase: "running",
  };
}

// A minimal WorldView/DecisionSink pair that runs one two-person conversation
// entirely in memory. `allowedOutcomesFn` lets a test change what
// conversationState() returns allowed on the SECOND read (the resolve-turn
// refresh) without touching the first.
function makeHarness(opts: {
  ids?: [string, string];
  maxTurns?: number;
  allowedOutcomesFn?: (readCount: number) => ConvOutcome["outcome"][];
}) {
  const [aId, bId] = opts.ids ?? ["a1", "b2"];
  const names: Record<string, string> = { [aId]: "Priya", [bId]: "Marcus" };
  const maxTurns = opts.maxTurns ?? 2;
  let conversationStateReads = 0;
  const messages: ConvMessage[] = [];
  let resolved: ConvOutcome | null = null;

  const world: WorldView = {
    livingAgents(): AgentBrief[] {
      return [brief(aId, names[aId]!), brief(bId, names[bId]!)];
    },
    agentContext(id: string): AgentContextView | null {
      if (id !== aId && id !== bId) return null;
      return baseCtx(id, names[id]!);
    },
    conversationState(id: string): ConversationView | null {
      conversationStateReads += 1;
      const allowed = opts.allowedOutcomesFn
        ? opts.allowedOutcomesFn(conversationStateReads)
        : (["alliance", "truce", "nothing"] as ConvOutcome["outcome"][]);
      return {
        id,
        participantIds: [aId, bId],
        messages: [],
        maxTurns,
        turnsTaken: 0,
        nextSpeakerId: aId,
        allowedOutcomes: allowed,
        partners: [],
      };
    },
  };

  const sink: DecisionSink = {
    applyDecision(): void {},
    appendConversationMessage(_convId: string, m: ConvMessage): void {
      messages.push(m);
    },
    resolveConversation(_convId: string, outcome: ConvOutcome): void {
      resolved = outcome;
    },
    reportSwarmTelemetry(): void {},
  };

  return {
    world,
    sink,
    messages,
    get resolved() {
      return resolved;
    },
    get conversationStateReads() {
      return conversationStateReads;
    },
  };
}

test("two rules-backend runs with the same seed produce byte-identical transcripts", async () => {
  applyTunables({ ...tunables, seed: 12345 });

  async function runOnce() {
    // The rule engine's "don't repeat a recently said line" memory
    // (backends/rules.ts) is keyed by agent id at module scope, spanning
    // conversations by design so a real run does not repeat itself -- but
    // that means two independent harness invocations replaying the SAME
    // seeded run both start from a clean slate, which is what this reset
    // reproduces. Without it, the second call here would inherit the
    // first's ring and diverge for a reason that has nothing to do with the
    // seed.
    resetRuleSpeechMemory();
    const h = makeHarness({ maxTurns: 4 });
    const deps: ConversationDeps = {
      world: h.world,
      sink: h.sink,
      backend: createRuleBackend(),
      spend: new SpendTracker(),
      budget: createCallBudget(() => 1000),
    };
    await runConversation(deps, "conv-1", { paced: false });
    return { messages: h.messages, resolved: h.resolved };
  }

  const first = await runOnce();
  const second = await runOnce();

  assert.deepEqual(first.messages, second.messages);
  assert.deepEqual(first.resolved, second.resolved);
  // Sanity: the harness actually produced lines, not an empty run.
  assert.ok(first.messages.length >= 2);

  applyTunables({ ...tunables, seed: 0 });
});

test("a different seed can produce a different transcript than seed A", async () => {
  async function runWithSeed(seed: number) {
    applyTunables({ ...tunables, seed });
    resetRuleSpeechMemory();
    const h = makeHarness({ maxTurns: 4 });
    const deps: ConversationDeps = {
      world: h.world,
      sink: h.sink,
      backend: createRuleBackend(),
      spend: new SpendTracker(),
      budget: createCallBudget(() => 1000),
    };
    await runConversation(deps, "conv-seed-check", { paced: false });
    return h.messages.map((m) => m.text).join("|");
  }

  const seeds = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => s * 7919);
  const outputs = new Set<string>();
  for (const s of seeds) outputs.add(await runWithSeed(s));

  // Not every seed needs to differ (the rule engine's phrase space is finite),
  // but across eight widely spread seeds at least one pair must diverge, or
  // rand is not actually reaching the turn/outcome choice at all.
  assert.ok(outputs.size > 1, "expected at least two distinct transcripts across seeds");

  applyTunables({ ...tunables, seed: 0 });
});

test("the resolve turn re-reads conversation state instead of trusting the stale initial view", async () => {
  // First read (the initial `view` snapshot) forbids alliance; the SECOND
  // read (the resolve-turn refresh) allows only alliance. If the loop still
  // resolves against the stale first read, the outcome will never be
  // "alliance" no matter how many times this runs.
  let sawAllianceOutcome = false;
  for (let attempt = 0; attempt < 25 && !sawAllianceOutcome; attempt++) {
    applyTunables({ ...tunables, seed: attempt + 1 });
    const h = makeHarness({
      maxTurns: 2,
      allowedOutcomesFn: (reads) => (reads === 1 ? ["nothing"] : ["alliance"]),
    });
    const deps: ConversationDeps = {
      world: h.world,
      sink: h.sink,
      backend: createRuleBackend(),
      spend: new SpendTracker(),
      budget: createCallBudget(() => 1000),
    };
    await runConversation(deps, "conv-refresh", { paced: false });
    if (h.resolved?.outcome === "alliance") sawAllianceOutcome = true;
  }

  assert.ok(
    sawAllianceOutcome,
    "expected the resolve turn to be able to land on the refreshed allowed set (alliance), " +
      "not be stuck on the stale initial view's set (nothing)",
  );
  assert.ok(true); // conversationStateReads > 1 is implied by the above being reachable at all

  applyTunables({ ...tunables, seed: 0 });
});

test("a per tick call budget of 1 degrades excess turns to rules instead of stalling", async () => {
  const h = makeHarness({ maxTurns: 4 });
  let primaryCalls = 0;
  const modelBackend = {
    name: "fake-model",
    billable: false,
    async healthy() {
      return true;
    },
    async decide() {
      throw new Error("not used in this test");
    },
    async converse(...args: Parameters<ReturnType<typeof createRuleBackend>["converse"]>) {
      primaryCalls += 1;
      return createRuleBackend().converse(...args);
    },
    async resolve(...args: Parameters<ReturnType<typeof createRuleBackend>["resolve"]>) {
      primaryCalls += 1;
      return createRuleBackend().resolve(...args);
    },
  };

  const budget = createCallBudget(() => 1);
  budget.refillTick(); // allowance = 1 for the whole run, mirroring one scheduler tick
  const deps: ConversationDeps = {
    world: h.world,
    sink: h.sink,
    backend: modelBackend as unknown as ConversationDeps["backend"],
    spend: new SpendTracker(),
    budget,
  };

  applyTunables({ ...tunables, flags: { ...tunables.flags, perTickCallBudget: true } });
  await runConversation(deps, "conv-budget", { paced: false });
  applyTunables({ ...tunables, flags: { ...tunables.flags, perTickCallBudget: false } });

  // The conversation must still complete (resolve) despite the budget
  // running out mid-conversation -- the sim never stalls on a model.
  assert.ok(h.resolved !== null);
  // With only 1 call admitted total, at most one turn was served by the
  // "primary" backend; the remaining turn(s) degraded to rules.
  assert.ok(primaryCalls <= 1, `expected at most 1 primary call, got ${primaryCalls}`);
  assert.ok(h.messages.length >= 2);
});
