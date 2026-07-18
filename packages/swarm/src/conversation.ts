import type Anthropic from "@anthropic-ai/sdk";
import type { ConvOutcome, DecisionSink, WorldView } from "@arena/shared";
import { tunables } from "@arena/shared";
import type { ConvFinal, ConvTurn, LLMResult, ModelBackend, TranscriptLine } from "./backend.js";
import { createRuleBackend, toBackend } from "./backends/index.js";
import { stripSpeechDashes } from "./fallback.js";
import type { SpendTracker } from "./spend.js";
import { sharedCallBudget, type CallBudget } from "./budget.js";
import { combineSeed, mulberry32 } from "./scheduler.js";

// ---------------------------------------------------------------------------
// Task 4.6: the conversation turn loop. The server's gate (task 4.5) creates a
// Conversation and calls runConversation, which alternates speakers, streams
// each line to clients via DecisionSink.appendConversationMessage, and on the
// final turn resolves into an outcome the server turns into an alliance/truce/
// fight.
//
// Every line comes from the active ModelBackend, so this file names no
// provider. Whatever the backend, a failed or empty turn falls through to the
// rule engine (backends/rules.ts), which is where the per-class and
// state-driven templated speech now lives. The transcript is therefore always
// populated and a conversation always resolves.
// ---------------------------------------------------------------------------

const TURN_PACING_MS = 1200; // lets the transcript animate on clients

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The no-model speaker: the last-resort path for any turn, and the whole
// conversation when nothing else is configured or a paid backend hit the cap.
const ruleBackend = createRuleBackend();

export type ConversationDeps = {
  world: WorldView;
  sink: DecisionSink;
  // The active backend. `client` is the pre-seam field, still accepted and
  // wrapped transparently, so existing callers compile and behave unchanged.
  backend?: ModelBackend;
  client?: Anthropic | null;
  spend: SpendTracker;
  // Defaults to the process-wide shared budget (budget.ts). Overridable so
  // tests can inject a small cap without touching the singleton.
  budget?: CallBudget;
};

// The single point every spoken line passes through on its way to the
// transcript and the clients, whichever backend produced it. The house rule
// that islander speech carries no dashes is enforced here rather than in each
// backend precisely because there is more than one backend and they all get it
// wrong sometimes; the prompts still ask, but nothing downstream trusts it.
// With the flag off this is the identity function.
function sayable(raw: string): string {
  return stripSpeechDashes(raw);
}

// Run one call against the active backend, falling through to the rule engine
// on any throw or on an empty line. Never rejects.
async function withRules<T extends { text: string }>(
  primary: () => Promise<LLMResult<T>>,
  rules: () => Promise<LLMResult<T>>,
): Promise<LLMResult<T>> {
  try {
    const r = await primary();
    if (r.value.text) return r;
  } catch {
    /* fall through */
  }
  return rules();
}

// Runs one conversation to completion. Self-paced and async; the server fires
// it and does not await it (the tick keeps running). The headless balance
// harness (task 5.4) passes { paced: false } to drop the inter-line delays so
// a full game fast-forwards with no wall-clock waits.
export async function runConversation(
  deps: ConversationDeps,
  convId: string,
  opts?: { paced?: boolean },
): Promise<void> {
  const paced = opts?.paced ?? true;
  const { world, sink, spend } = deps;
  const budget = deps.budget ?? sharedCallBudget;
  const view = world.conversationState(convId);
  if (!view || view.participantIds.length < 2) return;

  const configured = deps.backend ?? toBackend(deps.client) ?? ruleBackend;
  // A paid backend past the hard cap stops being used at all; free backends
  // (local, rules) are never gated by spend.
  const speaker = configured.billable && spend.fallbackActive ? ruleBackend : configured;

  const [aId, bId] = view.participantIds;
  const maxTurns = Math.max(2, Math.min(4, view.maxTurns));
  const transcript: TranscriptLine[] = [];

  // A cheap name lookup instead of building a full AgentContextView (with all
  // its awareness computation) just to read a display string. Snapshotted
  // once: a partner dying mid-conversation already ends the loop via the
  // ctx-null break below, so this does not need to be re-fetched per turn.
  const briefs = world.livingAgents();
  const nameOf = (id: string): string => briefs.find((a) => a.id === id)?.name ?? "someone";

  for (let turn = 0; turn < maxTurns; turn++) {
    const speakerId = turn % 2 === 0 ? aId! : bId!;
    const partnerId = speakerId === aId ? bId! : aId!;
    const ctx = world.agentContext(speakerId);
    if (!ctx) break; // speaker died mid-conversation
    const partnerName = nameOf(partnerId);
    const isFinal = turn === maxTurns - 1;
    // Seeded per (runSeed, convId, turn) rather than Math.random, so a rules
    // run with the same ISLAND_RUN_SEED replays byte-for-byte (spec line 214).
    // backend.ts already documented `rand` as "the scheduler's seeded
    // generator" -- this is the conversation path finally honoring that.
    const rand = mulberry32(combineSeed(tunables.seed, convId, turn));

    // A model-backed speaker still competes for the shared per-tick call
    // budget (spec line 118); the rule engine never does, so only a real
    // model call is gated here. Exhausting the budget degrades just this
    // turn to rules rather than skipping or stalling the conversation (spec
    // line 27 -- the sim must never stop).
    const turnBackend = speaker !== ruleBackend && budget.tryAcquire() ? speaker : ruleBackend;

    if (!isFinal) {
      const r: LLMResult<ConvTurn> = await withRules(
        () => turnBackend.converse(ctx, partnerName, transcript, rand),
        () => ruleBackend.converse(ctx, partnerName, transcript, rand),
      );
      // Rule-served turns carry zero usage, so this is a no-op for them.
      if (turnBackend.billable) spend.record(r.usage);
      const { tone } = r.value;
      const text = sayable(r.value.text);
      transcript.push({ speaker: ctx.self.name, text, tone });
      sink.appendConversationMessage(convId, { speaker: speakerId, text, tone });
    } else {
      // Re-read conversation state rather than trusting the initial snapshot:
      // up to (maxTurns - 1) paced turns, ~4s at TURN_PACING_MS, can pass
      // before this point, during which allies, HP, and hostile mode can all
      // change -- and those are exactly what computeAllowedOutcomes reads
      // server-side. sink.resolveConversation applies whatever outcome comes
      // back without re-validating it, so this refresh is the only guard
      // against resolving against a stale allowed set. Falls back to the
      // initial snapshot if the conversation has since vanished server-side.
      const freshView = world.conversationState(convId) ?? view;
      const allowed = freshView.allowedOutcomes.length
        ? freshView.allowedOutcomes
        : (["nothing"] as ConvOutcome["outcome"][]);

      const r: LLMResult<ConvFinal> = await withRules(
        () => turnBackend.resolve(ctx, partnerName, transcript, allowed, rand),
        () => ruleBackend.resolve(ctx, partnerName, transcript, allowed, rand),
      );
      if (turnBackend.billable) spend.record(r.usage);
      const { tone } = r.value;
      const text = sayable(r.value.text);
      let outcome = r.value.outcome;
      transcript.push({ speaker: ctx.self.name, text, tone });
      sink.appendConversationMessage(convId, { speaker: speakerId, text, tone });
      // An alliance requires the final tone to be non-hostile, else it
      // downgrades to truce (ARCHITECTURE.md 7.3).
      if (outcome === "alliance" && tone === "hostile") outcome = "truce";
      const fightInitiator = outcome === "fight" ? speakerId : null;
      sink.resolveConversation(convId, { outcome, fightInitiator });
      return;
    }
    if (paced) await sleep(TURN_PACING_MS);
  }

  // Ran out of speakers (a participant died): end as nothing.
  sink.resolveConversation(convId, { outcome: "nothing", fightInitiator: null });
}
