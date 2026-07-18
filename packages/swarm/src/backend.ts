import type { AgentContextView, AgentDecision, ConvOutcome, Tone } from "@arena/shared";
import type { Usage } from "./spend.js";

// ---------------------------------------------------------------------------
// The model seam.
//
// Everything the swarm needs from a "brain" is these three calls. Game logic
// (decisions.ts, conversation.ts, the scheduler, the server bridge) talks to a
// ModelBackend and never to a vendor SDK, so no provider name appears anywhere
// above this file. Backends live in ./backends: the hosted Anthropic path
// (unchanged, still the original client), a local Ollama path, a free tier
// OpenAI-compatible hosted path, and a rule engine that needs no model at all.
//
// The three calls mirror the three things an islander does: pick an action,
// say a line, and close out an encounter. Each returns the value plus the
// accounting the caller needs (usage for the spend cap, latency and cached for
// telemetry, backend/fallback so the demo feed can show which path served).
// ---------------------------------------------------------------------------

export type LLMResult<T> = {
  value: T;
  usage: Usage;
  latencyMs: number;
  cached: boolean;
  // Which backend produced this, and whether it came from the no-model path.
  // Optional so the pre-seam shape stays assignable.
  backend?: string;
  fallback?: boolean;
};

export type ConvTurn = { text: string; tone: Tone; wantsToEnd: boolean };

export type ConvFinal = { text: string; tone: Tone; outcome: ConvOutcome["outcome"] };

// `tone` is optional so every existing caller that only ever pushed
// {speaker, text} keeps compiling unchanged. It carries the speaker's tone for
// the turn that produced the line, so a later reader (the rule engine's
// reaction layer, an overhearing agent) can react to what a line *sounded*
// like without re-deriving it from the text.
export type TranscriptLine = { speaker: string; text: string; tone?: Tone };

// `rand` is the scheduler's per-agent seeded generator. Model backends ignore
// it; the rule backend uses it so a rules-only game stays deterministic for the
// balance harness.
export interface ModelBackend {
  // Stable identifier, surfaced in telemetry and operator logs.
  readonly name: string;
  // Whether calls to this backend cost real money. The spend cap only tracks
  // billable backends, so a local, hosted, or rule-driven game never burns
  // budget.
  readonly billable: boolean;
  // Optional non-queuing concurrency ceiling for the primary. Local model
  // servers commonly process one generation at a time; admitting a whole
  // scheduler wave only makes every request wait behind the first and hit its
  // timeout. A resilient wrapper serves overflow immediately from rules while
  // preserving the primary for the calls it can actually run.
  readonly maxConcurrency?: number;

  // Cheap reachability probe. Backends that cannot fail answer true.
  healthy(): Promise<boolean>;

  decide(ctx: AgentContextView, rand: () => number): Promise<LLMResult<AgentDecision>>;

  converse(
    ctx: AgentContextView,
    partnerName: string,
    transcript: TranscriptLine[],
    rand: () => number,
  ): Promise<LLMResult<ConvTurn>>;

  resolve(
    ctx: AgentContextView,
    partnerName: string,
    transcript: TranscriptLine[],
    allowedOutcomes: ConvOutcome["outcome"][],
    rand: () => number,
  ): Promise<LLMResult<ConvFinal>>;

  // True once this backend's circuit breaker has opened, i.e. calls are
  // presently being served by the rule engine rather than this backend.
  // Optional: only a resilient-wrapped backend has a breaker to report on. A
  // caller that wants to surface "is the game currently running on
  // templates" (spec: "surface degradation") checks this rather than
  // inferring it from telemetry after the fact.
  degraded?(): boolean;

  // Optional call-batching form of decide(): pack several agents' contexts
  // into one request. Only worth implementing where a rate limit actually
  // bites (the hosted free-tier path); anthropic, local, and rules are
  // unaffected by its absence, and decideBatchOrFanOut below is the default
  // implementation every caller gets regardless of whether the active
  // backend implements this.
  decideBatch?(
    contexts: AgentContextView[],
    rand: () => number,
  ): Promise<LLMResult<AgentDecision>[]>;
}

// The default implementation of decideBatch for a backend that does not
// implement its own: one decide() call per context, run concurrently. Callers
// that want batching when it is available, and plain fan-out otherwise,
// should go through this rather than calling backend.decideBatch directly.
export function decideBatchOrFanOut(
  backend: ModelBackend,
): (contexts: AgentContextView[], rand: () => number) => Promise<LLMResult<AgentDecision>[]> {
  if (backend.decideBatch) return backend.decideBatch.bind(backend);
  return (contexts, rand) => Promise.all(contexts.map((ctx) => backend.decide(ctx, rand)));
}

// Tidy a spoken line before it reaches the transcript.
//
// Two things smaller local models get wrong that the hosted one does not, even
// though the prompt covers both. First, they reach for em and en dashes
// despite being told not to. The house rule for islander speech is not "use a
// plain dash instead" - it is no dash of any kind, anywhere - so a dash found
// here is dropped and the clause is rejoined rather than rewritten into
// another dash. A clause-separator dash ("well - no, wait - yes") reads like a
// pause, so it becomes a comma; a dash inside a compound word ("well-known")
// has no natural non-dash stand-in, so the halves are simply run together with
// a space. Second, they overrun "at most 20 words", and a hard character slice
// then cuts mid-word, which reads as a rendering bug in the chat UI. Prefer
// the last sentence end, then the last word boundary, and only ever fall back
// to a hard cut.
export function clampLine(raw: string, limit = 160): string {
  const text = raw
    .trim()
    // A dash set off by spaces on both sides is standing in for a pause or an
    // aside; a comma keeps that rhythm without leaving a dash behind.
    .replace(/\s+[—–-]\s+/g, ", ")
    // A dash with no surrounding space is gluing two words into a compound;
    // running them together with a plain space reads better than a comma.
    .replace(/(\w)[—–-](\w)/g, "$1 $2")
    .replace(/,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);

  // A sentence end far enough in that we are not throwing the line away.
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentence >= limit * 0.5) return head.slice(0, sentence + 1);

  const space = head.lastIndexOf(" ");
  return space >= limit * 0.5 ? `${head.slice(0, space).replace(/[,;:]$/, "")}...` : head;
}

// Collapse a JSON-Schema union type ("string" | "null") to a single concrete
// type. Grammar-constrained decoding on smaller or less complete
// implementations - Ollama's `format`, and plenty of OpenAI-compatible
// free-tier endpoints - does not handle a `type` array the way Anthropic's
// forced tool use does, so both the local and hosted backends normalize
// through this before handing a schema to the provider. The prompt already
// tells the model to use an empty string / null literal when there is no
// value, so dropping the union costs nothing at the value level.
export function simplifyJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(simplifyJsonSchema);
  if (schema == null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "type" && Array.isArray(value)) {
      out.type = value.find((t) => t !== "null") ?? "string";
      continue;
    }
    out[key] = simplifyJsonSchema(value);
  }
  return out;
}

// Close a JSON document that ran out of output budget mid-write.
//
// Grammar-constrained decoding guarantees the shape is valid JSON as far as it
// got, but not that it finished: a chatty model can spend the whole budget
// inside a string field and stop mid-sentence, which JSON.parse rejects
// outright. Since the fields callers care about are already present by then,
// closing the open string and any open containers salvages the call instead of
// throwing the turn away. Values read out of it are length-clamped afterwards
// regardless. Shared by the local and hosted backends, the two paths that
// stream provider JSON through a token budget rather than getting it back as a
// single forced tool call.
export function closeTruncatedJson(raw: string): string[] {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const ch of raw) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
  }

  // A trailing backslash would escape the quote we are about to add.
  let base = escaped ? raw.slice(0, -1) : raw;
  if (inString) base += '"';
  // A cut right after a separator leaves a trailing comma, which is invalid.
  else base = base.replace(/[,\s]+$/, "");

  const closers = [...stack].reverse().join("");
  // Two shapes to try: the document closed as-is, and the same with a null
  // supplied for a key whose value never got written ({"a":1,"b" or {"a":1,"b":).
  return [`${base}${closers}`, `${base.replace(/:\s*$/, "")}:null${closers}`];
}

export function parseModelJson(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    for (const candidate of closeTruncatedJson(content)) {
      try {
        return JSON.parse(candidate) as Record<string, unknown>;
      } catch {
        /* try the next repair */
      }
    }
    throw new Error("model returned unparseable JSON");
  }
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
