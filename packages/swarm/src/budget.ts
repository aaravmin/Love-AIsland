import { tunables } from "@arena/shared";

// ---------------------------------------------------------------------------
// Per-tick model call budget (spec line 118, and the stated precondition for
// the hosted path at spec line 224: "this only works with the batching, the
// per tick call budget, and backoff from Task A").
//
// This is a token bucket, not a semaphore. scheduler.ts's CONCURRENCY cap
// (8) bounds how many thinks are in flight at once, but a fast think frees
// its slot immediately and the loop refills it, so CONCURRENCY alone puts no
// ceiling on how many calls a single tick issues. Conversations bypass the
// scheduler's semaphore entirely today, issuing calls of their own on top.
// This budget is the one thing both paths share: every model call, from
// either source, draws from the same pool for the tick it happens in.
//
// tryAcquire() never throws and never blocks. Over budget, it returns false
// and the caller is expected to run that one call through the rule engine
// instead - the sim's liveness never depends on the model answering, and a
// budget that stalled a caller waiting for the next tick would violate that
// exactly as badly as an unreachable API would. WS-M wires the two
// consumers: the think launch in scheduler.ts and the conversation turns in
// conversation.ts.
// ---------------------------------------------------------------------------

export type CallBudget = {
  // Attempt to spend one call this tick. Returns false, never throws, once
  // the tick's allowance is exhausted.
  tryAcquire(): boolean;
  // Start a new tick: reset the allowance to the current cap. Call once per
  // scheduler scan, before any tryAcquire() for that scan.
  refillTick(): void;
  // Calls left this tick, for telemetry.
  remaining(): number;
};

// `capPerTick` is a function rather than a captured number so a live tunables
// reload (tests, or the operator tuning surface) takes effect on the next
// refill instead of requiring a fresh budget to be constructed.
export function createCallBudget(
  capPerTick: () => number = () => tunables.swarm.callsPerTick,
): CallBudget {
  // Initialized from the cap immediately, rather than starting at zero, so a
  // call made before the first refillTick() (there is always at least one
  // agent thinking before the scheduler's own first tick completes) is still
  // admitted rather than spuriously rejected.
  let remainingCalls = Math.max(0, Math.floor(capPerTick()));

  return {
    tryAcquire(): boolean {
      // The flag gates enforcement, not existence: with it off (today's
      // behavior) every call is admitted regardless of the counter.
      if (!tunables.flags.perTickCallBudget) return true;
      if (remainingCalls <= 0) return false;
      remainingCalls -= 1;
      return true;
    },
    refillTick(): void {
      remainingCalls = Math.max(0, Math.floor(capPerTick()));
    },
    remaining(): number {
      return remainingCalls;
    },
  };
}

// The one shared budget across the whole swarm process. Every think and every
// conversation turn draws from this pool, mirroring the single shared
// CONCURRENCY semaphore in scheduler.ts - a per-caller budget would let a
// hosted free tier's rate limit get hit by conversations alone even while
// thinks stayed well under it.
export const sharedCallBudget: CallBudget = createCallBudget();
