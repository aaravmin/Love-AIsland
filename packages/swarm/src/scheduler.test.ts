import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBrief, AgentContextView, AgentDecision, DecisionSink, WorldView } from "@arena/shared";
import { applyTunables, tunables } from "@arena/shared";
import {
  combineSeed,
  createSwarmScheduler,
  mulberry32,
  ruleThinker,
  type ThinkResult,
} from "./scheduler.js";
import { createCallBudget } from "./budget.js";

function ctx(id: string): AgentContextView {
  return {
    self: {
      id,
      name: id,
      klass: "charmer",
      stats: { charisma: 5, cunning: 5, grit: 5, strength: 5, charm: 5, instinct: 5, resolve: 5 },
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

function makeWorld(ids: string[]): WorldView {
  return {
    livingAgents(): AgentBrief[] {
      return ids.map((id) => ({ id, name: id, klass: "charmer" }));
    },
    agentContext(id: string): AgentContextView | null {
      return ids.includes(id) ? ctx(id) : null;
    },
    conversationState() {
      return null;
    },
  };
}

function makeSink() {
  const applied: { agentId: string; decision: AgentDecision }[] = [];
  const sink: DecisionSink = {
    applyDecision(agentId, d) {
      applied.push({ agentId, decision: d });
    },
    appendConversationMessage() {},
    resolveConversation() {},
    reportSwarmTelemetry() {},
  };
  return { sink, applied };
}

test("combineSeed derives a different stream per part and mulberry32 is deterministic", () => {
  const a = combineSeed(7, "agent-1");
  const b = combineSeed(7, "agent-2");
  const c = combineSeed(9, "agent-1");
  assert.notEqual(a, b);
  assert.notEqual(a, c);

  const r1 = mulberry32(a);
  const r2 = mulberry32(a);
  const seq1 = [r1(), r1(), r1()];
  const seq2 = [r2(), r2(), r2()];
  assert.deepEqual(seq1, seq2);
});

test("think launch consumes the shared per-tick budget and degrades to ruleThinker when exhausted", async () => {
  const world = makeWorld(["a", "b", "c"]);
  const { sink, applied } = makeSink();
  let modelCalls = 0;
  const modelThinker = async (c: AgentContextView, rand: () => number): Promise<ThinkResult> => {
    modelCalls += 1;
    return ruleThinker(c, rand);
  };

  const budget = createCallBudget(() => 1);
  applyTunables({ ...tunables, flags: { ...tunables.flags, perTickCallBudget: true } });

  const scheduler = createSwarmScheduler({ world, sink, thinker: modelThinker, budget });
  const t0 = Date.now();
  // First tick only registers each agent with a staggered first-think offset;
  // nothing is due yet. A second tick, far enough past THINK_MAX_MS, is what
  // actually launches the thinks.
  scheduler.tick(t0);
  scheduler.tick(t0 + 60_000);
  // Give the in-flight promises (they resolve synchronously here, but stay
  // async via .then chains) a tick to settle.
  await new Promise((r) => setTimeout(r, 10));

  applyTunables({ ...tunables, flags: { ...tunables.flags, perTickCallBudget: false } });

  // All three agents still got a decision applied -- nothing stalled.
  assert.equal(applied.length, 3);
  // But with a budget of 1, at most one of the three think launches was
  // actually allowed to use the "model" thinker; the rest degraded to rules.
  assert.ok(modelCalls <= 1, `expected at most 1 model call, got ${modelCalls}`);
});

test("phase pacing thinks more slowly early and more quickly late", async () => {
  const before = {
    flags: { ...tunables.flags },
    swarm: { ...tunables.swarm },
    seed: tunables.seed,
  };
  applyTunables({
    flags: { ...tunables.flags, phasePacing: true },
    swarm: {
      ...tunables.swarm,
      thinkEarlyScale: 2,
      thinkLateScale: 0.5,
    },
    seed: 123,
  });

  const phasedWorld = (phase: "early" | "late"): WorldView => ({
    livingAgents: () => [{ id: "paced", name: "paced", klass: "charmer" }],
    agentContext: () => ({
      ...ctx("paced"),
      world: {
        livingCount: 4,
        startingCount: 4,
        runElapsedMs: phase === "early" ? 1_000 : 600_000,
        phase,
        posture: "none",
        eventKind: null,
        secondsUntilEvent: null,
        recent: [],
      },
    }),
    conversationState: () => null,
  });

  const early = makeSink();
  const late = makeSink();
  const earlyScheduler = createSwarmScheduler({ world: phasedWorld("early"), sink: early.sink });
  const lateScheduler = createSwarmScheduler({ world: phasedWorld("late"), sink: late.sink });
  const t0 = Date.now();
  earlyScheduler.tick(t0);
  lateScheduler.tick(t0);

  const firstDraw = mulberry32(combineSeed(123, "paced"))();
  const baseThinkMaxMs = 30_000; // scheduler's documented base upper bound
  const lateDue = Math.floor(firstDraw * baseThinkMaxMs * 0.5) + 1;
  earlyScheduler.tick(t0 + lateDue);
  lateScheduler.tick(t0 + lateDue);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(early.applied.length, 0, "the opening cadence should still be waiting");
  assert.equal(late.applied.length, 1, "the late cadence should already have acted");

  applyTunables(before);
});
