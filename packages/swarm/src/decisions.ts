import type Anthropic from "@anthropic-ai/sdk";
import type { ModelBackend } from "./backend.js";
import { toBackend } from "./backends/index.js";
import { fallbackDecision, stripSpeechDashes } from "./fallback.js";
import type { SpendTracker } from "./spend.js";
import type { BatchThinker, Thinker, ThinkResult } from "./scheduler.js";

// ---------------------------------------------------------------------------
// The production thinker: a decision from whichever backend is active, with the
// deterministic rule engine as the fallback for the spend cap, a timeout, or
// any error. This is the single place the two paths meet, so the scheduler
// stays agnostic to whether a decision came from a model or the rules -- and
// now also to which model, since it only ever sees a ModelBackend.
// ---------------------------------------------------------------------------

// Accepts a backend, or a pre-seam client (wrapped transparently), or null for
// rules only. The signature is unchanged for existing callers.
export function createThinker(
  source: Anthropic | ModelBackend | null,
  spend: SpendTracker,
): Thinker {
  const backend = toBackend(source);

  return async (ctx, rand): Promise<ThinkResult> => {
    const fallback = (latencyMs: number): ThinkResult => ({
      decision: fallbackDecision(ctx, rand),
      latencyMs,
      inputTokens: 0,
      outputTokens: 0,
      cached: false,
      fallback: true,
    });

    // No backend configured, or a paid backend has hit the hard cap: rules
    // only. A free backend (local or rules) is never gated by spend.
    if (!backend) return fallback(0);
    if (backend.billable && spend.fallbackActive) return fallback(0);

    try {
      const r = await backend.decide(ctx, rand);
      if (backend.billable) spend.record(r.usage);
      return {
        // The private thought is rendered to the audience, so it is held to the
        // same no-dash rule as speech. The rule engine sanitizes its own inside
        // fallbackDecision; this is the model path's equivalent chokepoint.
        decision: { ...r.value, reasoning: stripSpeechDashes(r.value.reasoning) },
        latencyMs: r.latencyMs,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        cached: r.cached,
        // A resilient backend reports when it served from the rule engine, so
        // the telemetry feed shows the real path rather than just "not rules".
        fallback: r.fallback ?? false,
      };
    } catch {
      // Timeout / API error / malformed output -> rule fallback for this round.
      return fallback(0);
    }
  };
}

// The batching counterpart to createThinker: present only when the active
// backend implements its own decideBatch (today, the hosted free-tier path --
// the one rate limited enough for batching to matter, spec line 224).
// Returns null for every other backend so the scheduler keeps its default
// per-agent launch, where a slow call never blocks a fast one
// (scheduler.ts's module doc). Wrapping mirrors createThinker's per-item
// accounting: dash-stripped reasoning, spend recorded only for a billable
// backend, and a rule fallback per agent if the whole batch call throws --
// one bad batch must not leave every agent in it without a decision this
// scan.
export function createBatchThinker(
  source: Anthropic | ModelBackend | null,
  spend: SpendTracker,
): BatchThinker | null {
  const backend = toBackend(source);
  if (!backend || !backend.decideBatch) return null;

  return async (contexts, rand): Promise<ThinkResult[]> => {
    try {
      const results = await backend.decideBatch!(contexts, rand);
      if (backend.billable) for (const r of results) spend.record(r.usage);
      return results.map((r) => ({
        decision: { ...r.value, reasoning: stripSpeechDashes(r.value.reasoning) },
        latencyMs: r.latencyMs,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        cached: r.cached,
        fallback: r.fallback ?? false,
      }));
    } catch {
      return contexts.map((ctx) => ({
        decision: fallbackDecision(ctx, rand),
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cached: false,
        fallback: true,
      }));
    }
  };
}
