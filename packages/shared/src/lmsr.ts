// ---------------------------------------------------------------------------
// Task 6.1: the LMSR (logarithmic market scoring rule) math. PURE and shared
// by BOTH the server (authoritative) and the client (optimistic bet preview),
// so a bet's predicted price and its settled price come from identical code
// (ARCHITECTURE.md 6.4). No I/O, no state.
// ---------------------------------------------------------------------------

// Liquidity parameter: at p=0.5, spending 10 tokens moves the price ~6.7 pts;
// a per-trade cap of 25 keeps a single whale off the tails (6.4 derivation).
export const LMSR_B = 70;

// Prices clamp to [2%, 98%] at seed so no market starts at a dead 0/100.
const P_MIN = 0.02;
const P_MAX = 0.98;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// C(qY,qN) = b·ln(e^{qY/b} + e^{qN/b}), via the log-sum-exp trick (factor out
// the max) so it never overflows.
export function cost(qYes: number, qNo: number, b: number = LMSR_B): number {
  const m = Math.max(qYes, qNo) / b;
  return b * (m + Math.log(Math.exp(qYes / b - m) + Math.exp(qNo / b - m)));
}

// priceYes = 1 / (1 + e^{(qN-qY)/b}). priceNo = 1 - priceYes.
export function priceYes(qYes: number, qNo: number, b: number = LMSR_B): number {
  return 1 / (1 + Math.exp((qNo - qYes) / b));
}

// 1/N seeding at market creation: target p0 = clamp(1/N, 0.02, 0.98) with
// qYes = 0, qNo = b·ln((1-p0)/p0). A late joiner uses the same formula at the
// living count when it joins.
export function seedShares(
  livingCount: number,
  b: number = LMSR_B,
): { qYes: number; qNo: number; seedPrice: number } {
  // A lone islander is essentially certain to win, so seed them at ~100%
  // (rounds to 100 in the UI) rather than the [2,98]% clamp used when there are
  // rivals to spread probability across.
  const p0 = livingCount <= 1 ? 0.995 : clamp(1 / livingCount, P_MIN, P_MAX);
  return { qYes: 0, qNo: b * Math.log((1 - p0) / p0), seedPrice: p0 };
}

// Normalized win probability for DISPLAY only. The per-contestant markets are
// independent LMSRs, so their raw priceYes values do NOT sum to 1 -- shown
// verbatim they read as incoherent odds (two islanders at 100% and 50%). To
// present a coherent "chance to win the whole game" we divide each market's
// raw priceYes by the sum across all provided (living, unsettled) markets, so
// the displayed odds sum to ~100%, are equal (1/N) before any bet moves a
// price, and rank winner < loser for N>2. This is a pure derivation: the
// betting math (buyShares/cost) and settlement still run on the raw prices.
// Guards a non-positive sum by falling back to an equal 1/N split.
export function winProbabilities(entries: { id: string; priceYes: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const n = entries.length;
  if (n === 0) return out;
  const sum = entries.reduce((acc, e) => acc + e.priceYes, 0);
  if (sum <= 0) {
    for (const e of entries) out.set(e.id, 1 / n);
    return out;
  }
  for (const e of entries) out.set(e.id, e.priceYes / sum);
  return out;
}

// The share spread that produces a given price. Inverting
// priceYes = 1/(1+e^{(qN-qY)/b}) gives qY-qN = b·ln(p/(1-p)), so any target
// price maps to exactly one spread. This is the whole basis of event drift:
// callers think in price points ("this fight is worth -2 pts") and never in
// shares, which are an LMSR implementation detail.
export function spreadForPrice(p: number, b: number = LMSR_B): number {
  // Nudge off the open interval's ends: ln(0) and ln(∞) would hand back
  // ±Infinity and poison qYes/qNo for the rest of the run. The guard is an
  // epsilon rather than [P_MIN, P_MAX] because callers own their own band --
  // seedShares deliberately seeds a lone islander at 0.995, outside that clamp.
  const eps = 1e-9;
  const safe = clamp(p, eps, 1 - eps);
  return b * Math.log(safe / (1 - safe));
}

export type DriftResult = {
  qYes: number;
  qNo: number;
  priceAfter: number;
  applied: number; // the price move actually realized, after clamping
};

// Move a market's price by `delta` points WITHOUT anyone buying anything.
// Used for event-driven odds drift (an alliance forms, a fight breaks out): the
// world moved, so the price should move, but no tokens changed hands.
//
// The requested move is clamped two ways: |delta| never exceeds `maxDelta`, and
// the resulting price is held inside [floor, ceil] so drift can never walk a
// market onto a tail where the LMSR stops behaving.
//
// The spread change is split evenly between the two sides (qYes up half, qNo
// down half) rather than loaded onto qYes alone. Both produce the same price;
// splitting keeps the two q's from drifting apart in absolute magnitude over a
// long run of one-sided events, which would slowly distort the cost curve that
// later real bets price against.
export function driftPrice(
  qYes: number,
  qNo: number,
  delta: number,
  maxDelta: number,
  floor: number,
  ceil: number,
  b: number = LMSR_B,
): DriftResult {
  const before = priceYes(qYes, qNo, b);
  const capped = clamp(delta, -Math.abs(maxDelta), Math.abs(maxDelta));
  if (capped === 0 || !Number.isFinite(capped)) {
    return { qYes, qNo, priceAfter: before, applied: 0 };
  }
  // Clamp only in the direction of travel. A market already outside the band
  // (seedShares puts a lone islander at 0.995, above the ceiling) must not be
  // yanked back into it as a side effect of an unrelated event -- drift may
  // decline to move such a price, but it may never reverse it.
  const lo = Math.min(floor, ceil);
  const hi = Math.max(floor, ceil);
  const raw = before + capped;
  const target = capped > 0 ? Math.min(raw, Math.max(hi, before)) : Math.max(raw, Math.min(lo, before));
  const shift = (spreadForPrice(target, b) - (qYes - qNo)) / 2;
  const nqY = qYes + shift;
  const nqN = qNo - shift;
  const after = priceYes(nqY, nqN, b);
  return { qYes: nqY, qNo: nqN, priceAfter: after, applied: after - before };
}

export type BuyResult = {
  shares: number; // shares acquired (== the increase in that side's q)
  qYes: number; // new qYes
  qNo: number; // new qNo
  priceAfter: number; // new priceYes
  cost: number; // tokens spent (exactly the input spend)
};

// Buy by spend (closed form, no numeric solver). Spending `spend` tokens on
// `side` adds d shares of that side, where (for Yes)
//   d = b·ln( e^{c/b}·(e^{qY/b}+e^{qN/b}) − e^{qN/b} ) − qY
// (symmetric for No). The realized cost is exactly `spend`, which is what makes
// the optimistic UX honest: "spend 10" always costs 10 regardless of races.
export function buyShares(
  qYes: number,
  qNo: number,
  side: "yes" | "no",
  spend: number,
  b: number = LMSR_B,
): BuyResult {
  const eY = Math.exp(qYes / b);
  const eN = Math.exp(qNo / b);
  const ec = Math.exp(spend / b);
  if (side === "yes") {
    const d = b * Math.log(ec * (eY + eN) - eN) - qYes;
    const nqY = qYes + d;
    return { shares: d, qYes: nqY, qNo, priceAfter: priceYes(nqY, qNo, b), cost: spend };
  }
  const d = b * Math.log(ec * (eY + eN) - eY) - qNo;
  const nqN = qNo + d;
  return { shares: d, qYes, qNo: nqN, priceAfter: priceYes(qYes, nqN, b), cost: spend };
}
