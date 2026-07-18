import type { WorldView, DecisionSink, AgentContextView, AgentDecision, AgentBrief } from "@arena/shared";
import { tunables } from "@arena/shared";
import { fallbackDecision } from "./fallback.js";
import { sharedCallBudget, type CallBudget } from "./budget.js";

// ---------------------------------------------------------------------------
// Task 4.3: the think scheduler. A 1 s scan (the server drives it) finds due,
// living agents and launches a think for each under a concurrency semaphore
// (cap 8, ARCHITECTURE.md 7.1). Each decision is applied via DecisionSink the
// instant it resolves -- no batching, so one slow LLM call never stalls the
// others. First think is staggered; subsequent ones re-jitter 15-30 s after
// completion (30-45 s while the spend soft-throttle is on).
//
// WS-M adds three things on top of that, all additive:
//   - every per-agent rand stream is now derived from the run seed
//     (tunables.seed) rather than only the agent id, so a seeded run replays
//     byte-for-byte (spec line 214).
//   - the think launch draws from WS-K's shared per-tick call budget; once a
//     tick's allowance is spent, further thinks this scan degrade to
//     ruleThinker rather than skipping or stalling (spec line 27).
//   - an optional batchThinker: when the active backend implements its own
//     decideBatch, every agent due in the same scan can be folded into one
//     call instead of one per agent. This is opt-in and unused unless a
//     caller supplies one, so the default (non-batched) path above is
//     unchanged either way.
// ---------------------------------------------------------------------------

const THINK_MIN_MS = 15_000;
const THINK_MAX_MS = 30_000;
const THROTTLE_MIN_MS = 30_000;
const THROTTLE_MAX_MS = 45_000;
const CONCURRENCY = 8;

// A think result: the decision plus the telemetry the scheduler forwards.
export type ThinkResult = {
  decision: AgentDecision;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
  fallback: boolean;
};

// A decision source: context in, decision + telemetry out. The LLM thinker
// (decisions.ts) and the rule-only default both satisfy it.
export type Thinker = (ctx: AgentContextView, rand: () => number) => Promise<ThinkResult>;

// The batched form of a Thinker: several agents' contexts in, one result per
// context out, ideally from a single call. decisions.ts's createBatchThinker
// is the production implementation (present only when the active backend
// implements decideBatch); this type lives here, beside Thinker, because
// SwarmSchedulerOptions below needs the shape regardless of who produces it.
export type BatchThinker = (
  contexts: AgentContextView[],
  rand: () => number,
) => Promise<ThinkResult[]>;

// Default thinker: the deterministic rule engine, zero cost, no latency.
export const ruleThinker: Thinker = async (ctx, rand) => ({
  decision: fallbackDecision(ctx, rand),
  latencyMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cached: false,
  fallback: true,
});

// Deterministic seed derivation: mixes a base seed (tunables.seed, the run
// seed) with any number of string/number parts via FNV-1a-style hashing, so
// two different call sites never collide by coincidence while both still
// derive from the same run seed. This agent-id use here and conversation.ts's
// (runSeed, convId, turn) use both go through this rather than each inventing
// an incompatible scheme, which is what byte-identical replay across a
// seeded run (spec line 214) actually requires.
export function combineSeed(base: number, ...parts: Array<string | number>): number {
  let h = (base ^ 2166136261) >>> 0;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    // Mixes a separator between parts so ("ab", "c") and ("a", "bc") hash
    // differently.
    h = Math.imul(h ^ 0x01, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SwarmSchedulerOptions = {
  world: WorldView;
  sink: DecisionSink;
  // Defaults to the rule engine; the LLM thinker slots in here.
  thinker?: Thinker;
  // When true, think intervals stretch (spend soft-throttle at $8).
  throttled?: () => boolean;
  // Defaults to the process-wide shared budget (budget.ts). Overridable so
  // tests can inject a small cap without touching the singleton.
  budget?: CallBudget;
  // Present only when the active backend can batch (decisions.ts's
  // createBatchThinker returns one precisely then). Absent means every think
  // launches independently, exactly as before this option existed.
  batchThinker?: BatchThinker;
};

export type SwarmScheduler = {
  tick(now: number): void;
  forget(id: string): void;
};

export function createSwarmScheduler(opts: SwarmSchedulerOptions): SwarmScheduler {
  const { world, sink } = opts;
  const thinker: Thinker = opts.thinker ?? ruleThinker;
  const throttled = opts.throttled ?? (() => false);
  const budget = opts.budget ?? sharedCallBudget;
  const batchThinker = opts.batchThinker;

  const nextThinkAt = new Map<string, number>();
  const rngState = new Map<string, number>();
  // Agents whose think is in flight -- never launch a second concurrent think
  // for the same agent, and cap total concurrency.
  const inFlight = new Set<string>();

  function ensureRegistered(id: string, now: number): void {
    if (nextThinkAt.has(id)) return;
    const seed = combineSeed(tunables.seed, id);
    rngState.set(id, seed);
    nextThinkAt.set(id, now + Math.floor(mulberry32(seed)() * THINK_MAX_MS));
  }

  function forget(id: string): void {
    nextThinkAt.delete(id);
    rngState.delete(id);
    inFlight.delete(id);
  }

  function jitter(rand: () => number): number {
    const [lo, hi] = throttled() ? [THROTTLE_MIN_MS, THROTTLE_MAX_MS] : [THINK_MIN_MS, THINK_MAX_MS];
    return lo + Math.floor(rand() * (hi - lo));
  }

  function applyResult(agentId: string, result: ThinkResult): void {
    // The agent may have died while thinking; applyDecision no-ops then.
    sink.applyDecision(agentId, result.decision);
    sink.reportSwarmTelemetry({
      kind: "decision",
      agentId,
      action: result.decision.action,
      reasoning: result.decision.reasoning,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cached: result.cached,
      fallback: result.fallback,
    });
  }

  function release(agentId: string, rand: () => number): void {
    inFlight.delete(agentId);
    nextThinkAt.set(agentId, Date.now() + jitter(rand));
  }

  function tick(now: number): void {
    // Start of scan: refill the shared per-tick budget before anything below
    // can draw from it (budget.ts's stated contract).
    budget.refillTick();

    const agents = world.livingAgents();
    const living = new Set(agents.map((a) => a.id));
    for (const id of [...nextThinkAt.keys()]) if (!living.has(id)) forget(id);

    // Collect this scan's due agents up front (same reservation the old
    // single loop did: register, respect the semaphore, push nextThinkAt out
    // immediately) so a batching backend can fold them into one call below.
    // When batchThinker is absent this list is simply walked one at a time
    // afterward, which is byte-for-byte the loop this replaced.
    const due: { agent: AgentBrief; ctx: AgentContextView }[] = [];
    for (const agent of agents) {
      ensureRegistered(agent.id, now);
      if (inFlight.size >= CONCURRENCY) break; // semaphore full this round
      if (inFlight.has(agent.id)) continue;
      if (now < nextThinkAt.get(agent.id)!) continue;

      const ctx = world.agentContext(agent.id);
      if (!ctx) continue;

      // Reserve a slot and push nextThinkAt far out so this agent isn't
      // re-launched while its think is in flight; the real re-jitter happens
      // on resolve.
      inFlight.add(agent.id);
      nextThinkAt.set(agent.id, now + THINK_MAX_MS);
      due.push({ agent, ctx });
    }

    if (due.length === 0) return;

    // The batched path: one call covers every due agent this scan. Only
    // taken when a batchThinker is wired in and there is more than one agent
    // to fold together -- a lone due agent gets no benefit from batching and
    // falls through to the plain path below. A batch call still only spends
    // one unit of the per tick budget (it genuinely is one network call), so
    // it competes fairly against the per-agent path for the same pool rather
    // than costing due.length units.
    if (batchThinker && due.length > 1 && budget.tryAcquire()) {
      const rands = due.map(({ agent }) => {
        const seed = rngState.get(agent.id)!;
        const r = mulberry32(seed);
        rngState.set(agent.id, (Math.imul(seed, 1664525) + 1013904223) >>> 0);
        return r;
      });
      // The call itself needs one generator distinct from any single agent's
      // stream; keyed by `now` so it stays reproducible for a given seed.
      const batchRand = mulberry32(combineSeed(tunables.seed, "batch", now));
      void batchThinker(
        due.map((d) => d.ctx),
        batchRand,
      )
        .then((results) => {
          results.forEach((result, i) => applyResult(due[i]!.agent.id, result));
        })
        .catch(() => {
          // createBatchThinker guarantees a per-context rule fallback
          // internally; this guard only covers a caller that did not.
        })
        .finally(() => {
          due.forEach(({ agent }, i) => release(agent.id, rands[i]!));
        });
      return;
    }

    // The default, non-batched path: launch and apply each think
    // independently so one slow call never stalls the others.
    for (const { agent, ctx } of due) {
      const seed = rngState.get(agent.id)!;
      const rand = mulberry32(seed);
      rngState.set(agent.id, (Math.imul(seed, 1664525) + 1013904223) >>> 0);

      // Budget exhausted this tick: this one call degrades to the rule
      // engine rather than skipping the agent's think or waiting for the
      // next scan (spec line 27 -- the sim must never stall on a model).
      const activeThinker = budget.tryAcquire() ? thinker : ruleThinker;

      void activeThinker(ctx, rand)
        .then((result) => applyResult(agent.id, result))
        .catch(() => {
          // Thinker guarantees a fallback internally, but guard anyway.
        })
        .finally(() => release(agent.id, rand));
    }
  }

  return { tick, forget };
}
