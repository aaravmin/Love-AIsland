import Anthropic from "@anthropic-ai/sdk";
import type { AgentContextView, AgentDecision, ConvOutcome, Tone } from "@arena/shared";
import {
  buildConversationUser,
  buildDecisionUser,
  buildPersonaBlock,
  DECIDE_TOOL,
  resolveTool,
  SHARED_RULES,
  SPEAK_TOOL,
} from "./prompts.js";
import type { ConvFinal, ConvTurn, LLMResult } from "./backend.js";
import type { Usage } from "./spend.js";

// The result shapes now live in backend.ts so every backend speaks them.
// Re-exported here so existing importers of this module keep working.
export type { ConvFinal, ConvTurn, LLMResult };

// ---------------------------------------------------------------------------
// Task 4.2: the Haiku client. Forced tool use (structurally valid JSON, no
// parsing heuristics), 2-block prompt caching (shared rules + persona), a 10 s
// per-call timeout, and no SDK retries (a hung call must fall back fast, not
// stack retries under the timeout). Usage is returned so the caller can
// account it against the spend cap.
// ---------------------------------------------------------------------------

// claude-haiku-4-5 (ARCHITECTURE.md decision 5). Override via env for pinning.
const MODEL = process.env.SWARM_MODEL ?? "claude-haiku-4-5";
const CALL_TIMEOUT_MS = 10_000;

export function createAnthropic(apiKey: string): Anthropic {
  // maxRetries 0: the scheduler's timeout + rule fallback is the retry policy;
  // SDK retries would blow past the 10 s budget.
  return new Anthropic({ apiKey, maxRetries: 0 });
}

// Both system blocks carry cache_control so static tokens bill at cache-read
// rate after each agent's first call (block 0 fleet-wide, block 1 per agent).
function systemBlocks(persona: string): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: SHARED_RULES, cache_control: { type: "ephemeral" } },
    { type: "text", text: persona, cache_control: { type: "ephemeral" } },
  ];
}

function usageOf(u: Anthropic.Usage): Usage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function toolInput(msg: Anthropic.Message, name: string): Record<string, unknown> | null {
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === name) {
      return block.input as Record<string, unknown>;
    }
  }
  return null;
}

// Resolve the model's free-text target NAME back to a nearby contestant id.
function resolveTargetId(ctx: AgentContextView, name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0) return null;
  const lower = name.trim().toLowerCase();
  const hit = ctx.nearby.find((n) => n.name.toLowerCase() === lower);
  return hit ? hit.id : null;
}

// One decision call. Throws on timeout/error/malformed output so the caller
// falls back to the rule engine for this agent this round.
export async function llmDecision(
  client: Anthropic,
  ctx: AgentContextView,
): Promise<LLMResult<AgentDecision>> {
  const start = Date.now();
  const msg = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 120,
      system: systemBlocks(buildPersonaBlock(ctx)),
      messages: [{ role: "user", content: buildDecisionUser(ctx) }],
      tools: [DECIDE_TOOL as unknown as Anthropic.Tool],
      tool_choice: { type: "tool", name: "decide" },
    },
    { timeout: CALL_TIMEOUT_MS },
  );
  const input = toolInput(msg, "decide");
  if (!input) throw new Error("decide tool not called");
  const action = input.action as AgentDecision["action"];
  const decision: AgentDecision = {
    action,
    target: resolveTargetId(ctx, input.target),
    reasoning: typeof input.reasoning === "string" ? input.reasoning : "",
  };
  const usage = usageOf(msg.usage);
  return {
    value: decision,
    usage,
    latencyMs: Date.now() - start,
    cached: usage.cacheReadTokens > 0,
  };
}

// One conversation turn (non-final). Throws on error so the caller uses a
// canned line.
export async function llmConversationTurn(
  client: Anthropic,
  ctx: AgentContextView,
  partnerName: string,
  transcript: { speaker: string; text: string }[],
): Promise<LLMResult<ConvTurn>> {
  const start = Date.now();
  const msg = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 100,
      system: systemBlocks(buildPersonaBlock(ctx)),
      messages: [
        {
          role: "user",
          content: buildConversationUser(
            partnerName,
            transcript,
            ctx.self.name,
            false,
            ctx.event,
            ctx,
          ),
        },
      ],
      tools: [SPEAK_TOOL as unknown as Anthropic.Tool],
      tool_choice: { type: "tool", name: "speak" },
    },
    { timeout: CALL_TIMEOUT_MS },
  );
  const input = toolInput(msg, "speak");
  if (!input) throw new Error("speak tool not called");
  const usage = usageOf(msg.usage);
  return {
    value: {
      text: String(input.text ?? "").slice(0, 160),
      tone: (input.tone as Tone) ?? "neutral",
      wantsToEnd: input.wantsToEnd === true,
    },
    usage,
    latencyMs: Date.now() - start,
    cached: usage.cacheReadTokens > 0,
  };
}

// The final turn: say a last line and pick an outcome from the allowed set.
export async function llmConversationResolve(
  client: Anthropic,
  ctx: AgentContextView,
  partnerName: string,
  transcript: { speaker: string; text: string }[],
  allowedOutcomes: ConvOutcome["outcome"][],
): Promise<LLMResult<ConvFinal>> {
  const start = Date.now();
  const tool = resolveTool(allowedOutcomes);
  const msg = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 100,
      system: systemBlocks(buildPersonaBlock(ctx)),
      messages: [
        {
          role: "user",
          content: buildConversationUser(
            partnerName,
            transcript,
            ctx.self.name,
            true,
            ctx.event,
            ctx,
          ),
        },
      ],
      tools: [tool as unknown as Anthropic.Tool],
      tool_choice: { type: "tool", name: "resolve" },
    },
    { timeout: CALL_TIMEOUT_MS },
  );
  const input = toolInput(msg, "resolve");
  if (!input) throw new Error("resolve tool not called");
  const outcome = allowedOutcomes.includes(input.outcome as ConvOutcome["outcome"])
    ? (input.outcome as ConvOutcome["outcome"])
    : allowedOutcomes[0]!;
  const usage = usageOf(msg.usage);
  return {
    value: {
      text: String(input.text ?? "").slice(0, 160),
      tone: (input.tone as Tone) ?? "neutral",
      outcome,
    },
    usage,
    latencyMs: Date.now() - start,
    cached: usage.cacheReadTokens > 0,
  };
}
