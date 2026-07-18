import type Anthropic from "@anthropic-ai/sdk";
import type { ModelBackend } from "../backend.js";
import {
  createAnthropic,
  llmConversationResolve,
  llmConversationTurn,
  llmDecision,
} from "../anthropic.js";

// ---------------------------------------------------------------------------
// The hosted backend: a thin adapter over the original client in
// ../anthropic.ts, which is unchanged. Forced tool use, prompt caching, the
// 10 s per-call timeout and no SDK retries all still apply exactly as before.
// This path stays available and is selected with SWARM_BACKEND=anthropic.
// ---------------------------------------------------------------------------

export function createAnthropicBackend(apiKey: string): ModelBackend {
  return wrapAnthropicClient(createAnthropic(apiKey));
}

// Adapt an already-constructed client. Callers that built their own client
// before the seam existed keep working through this.
export function wrapAnthropicClient(client: Anthropic): ModelBackend {
  const tag = <T extends { backend?: string; fallback?: boolean }>(r: T): T => {
    r.backend = "anthropic";
    r.fallback = false;
    return r;
  };

  return {
    name: "anthropic",
    // The only backend that spends real money, so the only one the cap tracks.
    billable: true,
    async healthy() {
      // Reachability is proven by the first real call; any failure drops to the
      // rule engine via the resilient wrapper.
      return true;
    },
    async decide(ctx) {
      return tag(await llmDecision(client, ctx));
    },
    async converse(ctx, partnerName, transcript) {
      return tag(await llmConversationTurn(client, ctx, partnerName, transcript));
    },
    async resolve(ctx, partnerName, transcript, allowedOutcomes) {
      return tag(
        await llmConversationResolve(client, ctx, partnerName, transcript, allowedOutcomes),
      );
    },
  };
}
