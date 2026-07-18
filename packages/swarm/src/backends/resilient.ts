import type { ConvOutcome } from "@arena/shared";
import { tunables } from "@arena/shared";
import type { LLMResult, ModelBackend } from "../backend.js";

// ---------------------------------------------------------------------------
// The guarantee that the sim never stops.
//
// Wraps a primary backend and drops to the rule engine whenever the primary is
// unreachable, times out, errors, or returns something unusable. Every call is
// covered, so a model that dies mid-game degrades the writing but never the
// game loop.
//
// A breaker sits in front so a down model does not cost every agent a full
// timeout on every think: after a few consecutive failures the primary is
// skipped outright for a cooldown, then one probe call decides whether to close
// the breaker again. That is what keeps tick latency flat when Ollama is simply
// not running.
//
// The failure count and cooldown are read from tunables.swarm on every check
// rather than captured once, so a config reload (tests, or the operator
// tuning surface) takes effect on the next call instead of needing a fresh
// backend to be constructed.
// ---------------------------------------------------------------------------

export type ResilientOptions = {
  primary: ModelBackend;
  rules: ModelBackend;
  // Called on each transition so the operator log can show the path flipping.
  onStateChange?: (state: "primary" | "fallback", reason: string) => void;
};

export function createResilientBackend(opts: ResilientOptions): ModelBackend {
  const { primary, rules, onStateChange } = opts;

  let consecutiveFailures = 0;
  let openedAt = 0;
  let usingFallback = false;
  let primaryInFlight = 0;
  const maxPrimaryConcurrency = Math.max(1, primary.maxConcurrency ?? Number.POSITIVE_INFINITY);

  const announce = (state: "primary" | "fallback", reason: string) => {
    if (usingFallback === (state === "fallback")) return;
    usingFallback = state === "fallback";
    onStateChange?.(state, reason);
  };

  // Closed, or open but past the cooldown (a half-open probe).
  function mayTryPrimary(): boolean {
    if (consecutiveFailures < tunables.swarm.breakerFailuresToOpen) return true;
    return Date.now() - openedAt >= tunables.swarm.breakerCooldownMs;
  }

  function recordSuccess(): void {
    consecutiveFailures = 0;
    announce("primary", `${primary.name} responding`);
  }

  function recordFailure(err: unknown): void {
    consecutiveFailures += 1;
    if (consecutiveFailures >= tunables.swarm.breakerFailuresToOpen) {
      openedAt = Date.now();
      const reason = err instanceof Error ? err.message : String(err);
      announce("fallback", `${primary.name} unavailable (${reason})`);
    }
  }

  // Run the primary, and hand off to the rule engine on any failure. The
  // fallback call is never wrapped in a try: the rule engine cannot fail, which
  // is what makes this total.
  async function attempt<T>(
    viaPrimary: () => Promise<LLMResult<T>>,
    viaRules: () => Promise<LLMResult<T>>,
  ): Promise<LLMResult<T>> {
    // Do not queue behind a saturated local model. The rule path is a complete
    // answer, so overflow can resolve immediately and interactions keep moving
    // while the one admitted model call finishes. Saturation is not a health
    // failure and therefore must not trip the circuit breaker.
    if (mayTryPrimary() && primaryInFlight < maxPrimaryConcurrency) {
      primaryInFlight += 1;
      try {
        const r = await viaPrimary();
        recordSuccess();
        return r;
      } catch (err) {
        recordFailure(err);
      } finally {
        primaryInFlight -= 1;
      }
    }
    return viaRules();
  }

  const backend: ModelBackend = {
    name: `${primary.name}+rules`,
    // Spend accounting follows the primary: a free primary means nothing the
    // wrapper produces is ever billed.
    billable: primary.billable,

    async healthy() {
      return true; // the rule engine underneath is always there
    },

    // Surfaces whether calls are presently landing on the rule engine rather
    // than the primary, so a caller can tell "robotic dialogue" apart from
    // "unreachable model" instead of both looking identical from outside.
    degraded() {
      return usingFallback;
    },

    async decide(ctx, rand) {
      return attempt(
        () => primary.decide(ctx, rand),
        () => rules.decide(ctx, rand),
      );
    },

    async converse(ctx, partnerName, transcript, rand) {
      return attempt(
        () => primary.converse(ctx, partnerName, transcript, rand),
        () => rules.converse(ctx, partnerName, transcript, rand),
      );
    },

    async resolve(ctx, partnerName, transcript, allowed: ConvOutcome["outcome"][], rand) {
      return attempt(
        () => primary.resolve(ctx, partnerName, transcript, allowed, rand),
        () => rules.resolve(ctx, partnerName, transcript, allowed, rand),
      );
    },
  };

  // Only advertise batching when the wrapped primary actually implements it -
  // the interface is optional precisely so a wrapper around anthropic/local/
  // rules (none of which implement it) does not have to fake one.
  if (primary.decideBatch) {
    backend.decideBatch = async (contexts, rand) => {
      if (mayTryPrimary()) {
        try {
          const r = await primary.decideBatch!(contexts, rand);
          recordSuccess();
          return r;
        } catch (err) {
          recordFailure(err);
        }
      }
      return Promise.all(contexts.map((ctx) => rules.decide(ctx, rand)));
    };
  }

  return backend;
}
