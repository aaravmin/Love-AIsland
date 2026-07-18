import type { SpendState } from "@arena/shared";

// ---------------------------------------------------------------------------
// Task 4.2 (spend half): usage accounting against the $10 hard cap and $8 soft
// throttle (ARCHITECTURE.md 7.6). The swarm owns this tracker and consults it
// before every LLM call; the server keeps a mirror `SpendState` for the UI,
// accumulated from the same per-call usage carried on SwarmTelemetry, so the
// two never diverge.
//
// Haiku 4.5 pricing (per 1M tokens): input $1, output $5, cache read $0.10,
// cache write $1.25.
// ---------------------------------------------------------------------------

const USD_PER_TOKEN = {
  input: 1 / 1_000_000,
  output: 5 / 1_000_000,
  cacheRead: 0.1 / 1_000_000,
  cacheWrite: 1.25 / 1_000_000,
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export function usageCostUsd(u: Usage): number {
  return (
    u.inputTokens * USD_PER_TOKEN.input +
    u.outputTokens * USD_PER_TOKEN.output +
    u.cacheReadTokens * USD_PER_TOKEN.cacheRead +
    u.cacheWriteTokens * USD_PER_TOKEN.cacheWrite
  );
}

export class SpendTracker {
  private estimatedUsd = 0;
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  // Operator override: force the rule-engine fallback on without spending to
  // the cap, so the graceful-degradation path can be demonstrated on demand
  // (task 8.6). Cleared on reset.
  private forced = false;

  constructor(
    readonly capUsd = 10,
    readonly softThrottleUsd = 8,
  ) {}

  record(u: Usage): void {
    this.estimatedUsd += usageCostUsd(u);
    this.calls += 1;
    this.inputTokens += u.inputTokens;
    this.outputTokens += u.outputTokens;
    this.cacheReadTokens += u.cacheReadTokens;
  }

  // Zeroed on operator game reset (ARCHITECTURE.md 6.8) so each fresh game
  // starts with the full budget. Reset is operator-only, so this can't be used
  // to bypass the cap.
  reset(): void {
    this.estimatedUsd = 0;
    this.calls = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.forced = false;
  }

  // Operator toggle to prove the cap path on demand (task 8.6).
  forceFallback(): void {
    this.forced = true;
  }

  // At/over $10 (or when forced): zero new LLM calls, rule engine only.
  get fallbackActive(): boolean {
    return this.forced || this.estimatedUsd >= this.capUsd;
  }

  // At/over $8: stretch think intervals, tighten conversation gating, cap turns.
  get throttled(): boolean {
    return this.estimatedUsd >= this.softThrottleUsd;
  }

  snapshot(): SpendState {
    return {
      estimatedUsd: this.estimatedUsd,
      capUsd: this.capUsd,
      softThrottleUsd: this.softThrottleUsd,
      fallbackActive: this.fallbackActive,
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
    };
  }
}
