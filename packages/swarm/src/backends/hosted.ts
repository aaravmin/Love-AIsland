import type { AgentContextView, AgentDecision, ConvOutcome, Tone } from "@arena/shared";
import type { ConvFinal, ConvTurn, LLMResult, ModelBackend, TranscriptLine } from "../backend.js";
import { clampLine, parseModelJson, simplifyJsonSchema } from "../backend.js";
import {
  buildConversationUser,
  buildDecisionUser,
  buildPersonaBlock,
  DECIDE_TOOL,
  SHARED_RULES,
  SPEAK_TOOL,
  resolveTool,
} from "../prompts.js";

// ---------------------------------------------------------------------------
// The free tier hosted backend (spec Task A, section 5 option 2): any
// OpenAI-compatible chat-completions endpoint, reached at its own base URL
// with its own optional API key. This is deliberately not the Anthropic path -
// that one stays "anthropic" (paid, forced tool use, ../anthropic.ts
// unchanged). This one targets the chat-completions shape most free-tier
// providers speak, constraining output with response_format: json_schema the
// same way Ollama's `format` constrains decoding, so the caller gets the same
// structurally-valid JSON guarantee without needing the provider to support
// native tool calling.
//
// It reuses the prompt layer wholesale, exactly like the local backend: one
// shared rules block, one per-agent persona block, one small dynamic user
// block. There is no explicit cache_control knob on a generic
// chat-completions endpoint the way there is on Anthropic's API, so the
// caching story here is the same as the local path's: the system message is
// assembled the same way on every call so a provider that does its own prefix
// caching (several free tiers do, transparently) gets a stable prefix to key
// on.
// ---------------------------------------------------------------------------

export type HostedOptions = {
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  timeoutMs: number;
};

// Same reasoning as the local backend's budgets, but tighter: this path is the
// one the spec explicitly warns will hit rate limits (section 5, "Fifty
// agents making parallel calls will hit those limits quickly"), so headroom
// here is latency AND quota, not just latency.
const DECIDE_TOKENS = 200;
const SPEAK_TOKENS = 160;
const REASONING_LIMIT = 240;

type ChatCompletion = {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

// Resolve the model's free-text target NAME back to a nearby contestant id.
// Same contract as the local and Anthropic paths.
function resolveTargetId(ctx: AgentContextView, name: unknown): string | null {
  if (typeof name !== "string" || name.trim().length === 0) return null;
  const lower = name.trim().toLowerCase();
  return ctx.nearby.find((n) => n.name.toLowerCase() === lower)?.id ?? null;
}

function resolveVoteTargetId(ctx: AgentContextView, name: unknown): string | null {
  if (typeof name !== "string" || name.trim().length === 0) return null;
  const lower = name.trim().toLowerCase();
  return (
    ctx.nearby.find((n) => n.name.toLowerCase() === lower)?.id ??
    ctx.relationships?.find((r) => r.name.toLowerCase() === lower)?.id ??
    null
  );
}

function headersFor(apiKey: string | undefined): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  // Some free tiers (a local proxy, a provider gated by IP allowlist instead
  // of a key) need no auth at all; sending an empty bearer token is worse than
  // omitting the header.
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

export function createHostedBackend(opts: HostedOptions): ModelBackend {
  const { model, apiKey, timeoutMs } = opts;
  const base = opts.baseUrl.replace(/\/+$/, "");

  async function complete(
    system: string,
    user: string,
    schema: unknown,
    schemaName: string,
    maxTokens: number,
  ): Promise<{ parsed: Record<string, unknown>; result: Omit<LLMResult<never>, "value"> }> {
    const start = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: headersFor(apiKey),
        body: JSON.stringify({
          model,
          temperature: 0.8,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: schemaName, schema: simplifyJsonSchema(schema), strict: true },
          },
        }),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`hosted ${res.status}`);
    const body = (await res.json()) as ChatCompletion;
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("hosted backend returned no content");
    const parsed = parseModelJson(content);
    return {
      parsed,
      result: {
        usage: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        latencyMs: Date.now() - start,
        cached: false,
        backend: "hosted",
        fallback: false,
      },
    };
  }

  const systemFor = (ctx: AgentContextView) => `${SHARED_RULES}\n\n${buildPersonaBlock(ctx)}`;

  const backend: ModelBackend = {
    name: "hosted",
    // A free tier by construction; the dollar spend cap only tracks the paid
    // Anthropic path.
    billable: false,

    async healthy() {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), Math.min(timeoutMs, 2_000));
      try {
        const res = await fetch(`${base}/models`, { headers: headersFor(apiKey), signal: ctl.signal });
        return res.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },

    async decide(ctx): Promise<LLMResult<AgentDecision>> {
      const { parsed, result } = await complete(
        systemFor(ctx),
        buildDecisionUser(ctx),
        DECIDE_TOOL.input_schema,
        DECIDE_TOOL.name,
        DECIDE_TOKENS,
      );
      const value: AgentDecision = {
        action: parsed.action as AgentDecision["action"],
        target: resolveTargetId(ctx, parsed.target),
        voteTarget: resolveVoteTargetId(ctx, parsed.voteTarget),
        reasoning:
          typeof parsed.reasoning === "string" ? clampLine(parsed.reasoning, REASONING_LIMIT) : "",
      };
      return { ...result, value };
    },

    async converse(
      ctx,
      partnerName: string,
      transcript: TranscriptLine[],
    ): Promise<LLMResult<ConvTurn>> {
      const { parsed, result } = await complete(
        systemFor(ctx),
        buildConversationUser(partnerName, transcript, ctx.self.name, false, ctx.event, ctx),
        SPEAK_TOOL.input_schema,
        SPEAK_TOOL.name,
        SPEAK_TOKENS,
      );
      return {
        ...result,
        value: {
          text: clampLine(String(parsed.text ?? "")),
          tone: (parsed.tone as Tone) ?? "neutral",
          wantsToEnd: parsed.wantsToEnd === true,
        },
      };
    },

    async resolve(
      ctx,
      partnerName: string,
      transcript: TranscriptLine[],
      allowedOutcomes: ConvOutcome["outcome"][],
    ): Promise<LLMResult<ConvFinal>> {
      const tool = resolveTool(allowedOutcomes);
      const { parsed, result } = await complete(
        systemFor(ctx),
        buildConversationUser(partnerName, transcript, ctx.self.name, true, ctx.event, ctx),
        tool.input_schema,
        tool.name,
        SPEAK_TOKENS,
      );
      const outcome = allowedOutcomes.includes(parsed.outcome as ConvOutcome["outcome"])
        ? (parsed.outcome as ConvOutcome["outcome"])
        : allowedOutcomes[0]!;
      return {
        ...result,
        value: {
          text: clampLine(String(parsed.text ?? "")),
          tone: (parsed.tone as Tone) ?? "neutral",
          outcome,
        },
      };
    },

    // Call batching (spec line 118). This is the one backend where a rate
    // limit actually bites (section 5, option 2), so it is the one where
    // packing several agents' decisions into a single request earns its
    // complexity. Each context becomes one numbered entry in the prompt and
    // one array slot in the schema; answers are matched back up by array
    // position, not by name, since two islanders can share an initial but
    // never a position.
    async decideBatch(
      contexts: AgentContextView[],
      rand: () => number,
    ): Promise<LLMResult<AgentDecision>[]> {
      if (contexts.length === 0) return [];
      if (contexts.length === 1) return [await backend.decide(contexts[0]!, rand)];

      const batchSchema = {
        type: "object" as const,
        properties: {
          decisions: {
            type: "array" as const,
            items: DECIDE_TOOL.input_schema,
            minItems: contexts.length,
            maxItems: contexts.length,
          },
        },
        required: ["decisions"],
      };
      const user = contexts
        .map((ctx, i) => `Contestant ${i}: ${buildPersonaBlock(ctx)}\n${buildDecisionUser(ctx)}`)
        .join("\n\n---\n\n");
      const { parsed, result } = await complete(
        SHARED_RULES,
        `Decide for each of these ${contexts.length} contestants, in order. Return exactly ${contexts.length} decisions in the same order, one per contestant.\n\n${user}`,
        batchSchema,
        "decideBatch",
        DECIDE_TOKENS * contexts.length,
      );
      const decisions = Array.isArray(parsed.decisions)
        ? (parsed.decisions as Record<string, unknown>[])
        : [];

      return Promise.all(
        contexts.map(async (ctx, i): Promise<LLMResult<AgentDecision>> => {
          const entry = decisions[i];
          // A short or malformed batch reply is missing one slot, not the
          // whole call: recover just that contestant with a single-context
          // retry rather than throwing away every other answer in the batch.
          if (!entry) return backend.decide(ctx, rand);
          const value: AgentDecision = {
            action: entry.action as AgentDecision["action"],
            target: resolveTargetId(ctx, entry.target),
            voteTarget: resolveVoteTargetId(ctx, entry.voteTarget),
            reasoning:
              typeof entry.reasoning === "string"
                ? clampLine(entry.reasoning as string, REASONING_LIMIT)
                : "",
          };
          return { ...result, value };
        }),
      );
    },
  };

  return backend;
}
