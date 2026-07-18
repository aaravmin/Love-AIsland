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
// The local backend: an Ollama server on the machine (or the LAN).
//
// It reuses the prompt layer wholesale. prompts.ts was already written in
// provider-neutral terms (a shared rules block, a persona block, a small
// dynamic block, and a JSON schema per response), so the only work here is
// transport: system + user go over /api/chat, and the tool schema becomes
// Ollama's `format`, which constrains decoding to that exact shape. That gives
// the same structurally-valid JSON guarantee the hosted path gets from forced
// tool use, without needing the local model to support tool calling.
//
// Every call is timeout-bounded and throws on any failure, so an unreachable or
// slow Ollama drops cleanly to the rule engine (see resilient.ts) instead of
// stalling the sim.
// ---------------------------------------------------------------------------

// `model` is optional: an operator who set SWARM_LOCAL_MODEL always gets
// exactly that model, but with it unset the backend auto-detects rather than
// silently targeting a name that may never have been pulled on this machine.
type OllamaOptions = { host: string; model?: string; timeoutMs: number };

// Output budgets. The hosted path runs tight caps (120/100) because every token
// is billed; local inference is free, so the only cost of headroom is latency.
// Small local models are markedly more verbose, and a budget that truncates the
// response mid-JSON throws away the whole call, so these run generous.
// A budget that truncates mid-JSON is recoverable (see closeTruncatedJson in
// backend.ts), so these are tuned for latency rather than set high enough to
// never overrun.
const DECIDE_TOKENS = 220;
const SPEAK_TOKENS = 180;

// The private-thought line rendered in the telemetry feed. The prompt asks for
// one sentence; a small local model given the headroom above will happily write
// a paragraph, and occasionally spill schema fragments into the string, so it
// is bounded here rather than trusted. Roomier than a spoken line because it is
// display-only and never part of a transcript.
const REASONING_LIMIT = 240;

// Historic default, kept only as the last resort when auto-detection itself
// cannot reach the server: the exact behavior this backend had before
// auto-detect existed, for a machine that also happens to have no Ollama
// running at all (in which case healthy() already reports false and the
// resilient wrapper never gets this far).
const DEFAULT_MODEL = "llama3.2";

type ChatResponse = {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
};

type TagsResponse = { models?: { name: string }[] };

// Resolve the model's free-text target NAME back to a nearby contestant id.
// Same contract as the hosted path: an unknown name resolves to null, and the
// server clamps a null-target action to wander.
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

export function createOllamaBackend(opts: OllamaOptions): ModelBackend {
  const { host, timeoutMs } = opts;
  const configuredModel = opts.model?.trim() || undefined;

  // Auto-detected model name, resolved at most once and cached for the
  // backend's lifetime. Querying /api/tags exists so a machine that only has,
  // say, gemma3:4b pulled is not silently talking to a llama3.2 that was never
  // there - which is exactly why 100% of local dialogue was reaching the rule
  // engine's templates before this existed. A configured model always wins and
  // skips this entirely.
  let detected: Promise<string> | null = null;

  async function resolveModel(): Promise<string> {
    if (configuredModel) return configuredModel;
    detected ??= (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), Math.min(timeoutMs, 3_000));
      try {
        const res = await fetch(`${host}/api/tags`, { signal: ctl.signal });
        if (!res.ok) throw new Error(`ollama ${res.status}`);
        const body = (await res.json()) as TagsResponse;
        const first = body.models?.[0]?.name;
        if (!first) throw new Error("ollama has no models installed");
        return first;
      } catch {
        // Nothing reachable, or nothing installed: fall back to the historic
        // default so behavior degrades to exactly what it was before
        // auto-detect existed, rather than to a hard failure.
        return DEFAULT_MODEL;
      } finally {
        clearTimeout(timer);
      }
    })();
    return detected;
  }

  async function chat(
    system: string,
    user: string,
    schema: unknown,
    maxTokens: number,
  ): Promise<{ parsed: Record<string, unknown>; result: Omit<LLMResult<never>, "value"> }> {
    const start = Date.now();
    const model = await resolveModel();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: simplifyJsonSchema(schema),
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          options: { temperature: 0.8, num_predict: maxTokens },
        }),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const body = (await res.json()) as ChatResponse;
    const content = body.message?.content;
    if (!content) throw new Error("ollama returned no content");
    const parsed = parseModelJson(content);
    return {
      parsed,
      result: {
        // Real token counts for the telemetry feed. Local inference is free, so
        // the backend is not billable and none of this reaches the spend cap.
        usage: {
          inputTokens: body.prompt_eval_count ?? 0,
          outputTokens: body.eval_count ?? 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        latencyMs: Date.now() - start,
        cached: false,
        backend: "local",
        fallback: false,
      },
    };
  }

  // Both system blocks are concatenated: Ollama keeps its own prefix cache
  // keyed on the prompt prefix, so putting the fleet-wide rules first still
  // gets the shared prefix reused across every agent. This is the local path's
  // answer to prompt caching - there is no explicit cache_control knob to set,
  // so a byte-identical prefix across calls is what lets the server's own
  // cache do the work instead.
  const systemFor = (ctx: AgentContextView) => `${SHARED_RULES}\n\n${buildPersonaBlock(ctx)}`;

  return {
    name: "local",
    billable: false,
    // Ollama may be configured for more parallelism externally, but one is the
    // safe portable default. Overflow is handled immediately by the resilient
    // rule backend instead of sitting in Ollama's queue for up to 20 seconds.
    maxConcurrency: 1,

    async healthy() {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), Math.min(timeoutMs, 2_000));
      try {
        const res = await fetch(`${host}/api/tags`, { signal: ctl.signal });
        return res.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },

    async decide(ctx): Promise<LLMResult<AgentDecision>> {
      const { parsed, result } = await chat(
        systemFor(ctx),
        buildDecisionUser(ctx),
        DECIDE_TOOL.input_schema,
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
      const { parsed, result } = await chat(
        systemFor(ctx),
        buildConversationUser(partnerName, transcript, ctx.self.name, false, ctx.event, ctx),
        SPEAK_TOOL.input_schema,
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
      const { parsed, result } = await chat(
        systemFor(ctx),
        buildConversationUser(partnerName, transcript, ctx.self.name, true, ctx.event, ctx),
        resolveTool(allowedOutcomes).input_schema,
        SPEAK_TOKENS,
      );
      // The server validates the outcome too, but clamp here so an off-schema
      // local model can never widen what the escalation scorer allowed.
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
  };
}
