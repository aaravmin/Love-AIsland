import { randomUUID } from "node:crypto";
import { buyShares, driftPrice, seedShares, tunables } from "@arena/shared";
import type { Market, Position, Trade } from "@arena/shared";
import { notifyAboutContestant } from "./notify.js";
import { priceYes, state } from "./state.js";
import type { ArenaServer } from "./io.js";

// ---------------------------------------------------------------------------
// Task 6.2: server market lifecycle and betting. All pricing goes through the
// shared LMSR module so the server (authoritative) and the client (optimistic
// preview) compute identical numbers.
// ---------------------------------------------------------------------------

// Betting mechanics that predate the spec, now sourced from tunables.market
// per the "nothing is hardcoded" rule rather than local module constants.
const PER_TRADE_CAP = tunables.market.perTradeCap; // tokens per bet (ARCH 6.4: keeps a whale off the tails)
const PRICE_HEARTBEAT_MS = tunables.market.priceHeartbeatMs;
// An odds "surge"/"drop" worth an SMS: priceYes moved this many points from its
// tracked recent extreme (low for a surge, high for a drop). Checked on the
// ~5 s heartbeat (cheap) and rate-limited per spectator via the priority
// category buckets, so neither ever spams. Symmetric per WS-G's contract --
// the drop side did not exist at all before this.
const SURGE_DELTA = tunables.notify.surgeDelta;
const DROP_DELTA = tunables.notify.dropDelta;

// 1/N seeding at creation (or at a late-join's living count).
export function seedMarket(contestantId: string, livingCount: number, now: number): Market {
  const { qYes, qNo, seedPrice } = seedShares(livingCount);
  return {
    contestantId,
    qYes,
    qNo,
    b: 70,
    seedPrice,
    settled: false,
    settledOutcome: null,
    createdAt: now,
    priceHistory: [{ t: now, price: seedPrice }],
  };
}

// Per-room market bookkeeping (Phase 9): the dirty set (markets whose price
// moved since the last tick, drained into the diff's `prices`) and the price
// heartbeat clock. `cur` is pointed at the active room by useMarket().
// surgeLow tracks each market's recent priceYes low; when the live price rises
// SURGE_DELTA above it we fire a surge alert and re-baseline (the low follows
// price down otherwise). surgeHigh is the symmetric drop-side tracker: when the
// live price falls DROP_DELTA below it we fire a drop alert and re-baseline
// (the high follows price up otherwise). Before surgeHigh existed, a holder
// whose position collapsed got nothing at all -- market.ts silently
// re-baselined downward with no notification. Per room, both drive SMS only.
export type MarketState = {
  dirtyMarkets: Set<string>;
  lastHeartbeatAt: number;
  surgeLow: Map<string, number>;
  surgeHigh: Map<string, number>;
};
export function createMarketState(): MarketState {
  return { dirtyMarkets: new Set(), lastHeartbeatAt: 0, surgeLow: new Map(), surgeHigh: new Map() };
}
let cur: MarketState = createMarketState();
export function useMarket(s: MarketState): void {
  cur = s;
}

export function markMarketDirty(id: string): void {
  cur.dirtyMarkets.add(id);
}
export function drainDirtyPrices(): [id: string, priceYes: number][] {
  const out: [string, number][] = [];
  for (const id of cur.dirtyMarkets) {
    const m = state.markets[id];
    if (m) out.push([id, priceYes(m)]);
  }
  cur.dirtyMarkets.clear();
  return out;
}

export function resetMarket(): void {
  cur.dirtyMarkets.clear();
  cur.lastHeartbeatAt = 0;
  cur.surgeLow.clear();
  cur.surgeHigh.clear();
}

// Step 7 of the tick: append a priceHistory point to every unsettled market
// every ~5 s so sparklines fill in even when a market isn't traded. Piggybacks
// the odds-surge SMS scan on the same cadence (cheap; rate-limited downstream).
export function tickPriceHeartbeat(now: number): void {
  if (now - cur.lastHeartbeatAt < PRICE_HEARTBEAT_MS) return;
  cur.lastHeartbeatAt = now;
  for (const m of Object.values(state.markets)) {
    if (m.settled) continue;
    const price = priceYes(m);
    m.priceHistory.push({ t: now, price });
    // Broadcast every unsettled market on the heartbeat, not just traded ones,
    // so clients receive a periodic price point and their sparklines keep
    // growing (a flat line still advances in time) instead of freezing.
    markMarketDirty(m.contestantId);

    // Surge alert: fire when priceYes has climbed SURGE_DELTA above its tracked
    // recent low, then re-baseline to the current price; otherwise let the low
    // trail the price down so a later rebound still registers.
    const low = cur.surgeLow.get(m.contestantId);
    if (low === undefined) {
      cur.surgeLow.set(m.contestantId, price);
    } else if (price - low >= SURGE_DELTA) {
      cur.surgeLow.set(m.contestantId, price);
      const c = state.contestants[m.contestantId];
      if (c && c.alive) {
        const pct = Math.round(price * 100);
        notifyAboutContestant(m.contestantId, now, { kind: "surge", subjectName: c.name, pctNow: pct });
      }
    } else if (price < low) {
      cur.surgeLow.set(m.contestantId, price);
    }

    // Drop alert: the symmetric case. Fires when priceYes has fallen DROP_DELTA
    // below its tracked recent high, then re-baselines to the current price;
    // otherwise the high trails the price up so a later fall still registers.
    const high = cur.surgeHigh.get(m.contestantId);
    if (high === undefined) {
      cur.surgeHigh.set(m.contestantId, price);
    } else if (high - price >= DROP_DELTA) {
      cur.surgeHigh.set(m.contestantId, price);
      const c = state.contestants[m.contestantId];
      if (c && c.alive) {
        const pct = Math.round(price * 100);
        notifyAboutContestant(m.contestantId, now, { kind: "drop", subjectName: c.name, pctNow: pct });
      }
    } else if (price > high) {
      cur.surgeHigh.set(m.contestantId, price);
    }
  }
}

// Endgame settlement: the winner's market settles "yes" and every Yes position
// on it redeems 1 token per share (ARCHITECTURE.md 6.4). Called once, when the
// game reaches a single survivor.
export function settleMarketYes(io: ArenaServer, contestantId: string): void {
  const m = state.markets[contestantId];
  if (!m || m.settled) return;
  m.settled = true;
  m.settledOutcome = "yes";
  markMarketDirty(contestantId);
  for (const pos of state.positions) {
    if (pos.contestantId !== contestantId || pos.yesShares <= 0) continue;
    const spec = state.spectators[pos.spectatorId];
    if (!spec) continue;
    const credit = pos.yesShares;
    spec.tokens += credit;
    io.to(`spec:${pos.spectatorId}`).emit("balance:update", {
      tokens: spec.tokens,
      delta: credit,
      reason: "winnerRedemption",
      contestantId,
    });
  }
  io.emit("market:settled", { contestantId, outcome: "yes" });
}

function findPosition(spectatorId: string, contestantId: string): Position | undefined {
  return state.positions.find(
    (p) => p.spectatorId === spectatorId && p.contestantId === contestantId,
  );
}

export type BetReason = "insufficient" | "settled" | "capExceeded" | "phase" | "oppositeSide";
export type BetOk = {
  shares: number;
  cost: number;
  newBalance: number;
  qYes: number;
  qNo: number;
  priceYes: number;
};

// Execute a validated bet: move the market via the shared LMSR, deduct exactly
// `spend`, update the position, log a Trade, and mark the price dirty. The
// caller (protocol) has already checked phase and spectator identity.
export function executeBet(
  spectatorId: string,
  contestantId: string,
  side: "yes" | "no",
  spend: number,
  now: number,
): BetOk | { error: BetReason } {
  const m = state.markets[contestantId];
  const spec = state.spectators[spectatorId];
  if (!m || !spec) return { error: "settled" }; // unknown market -> treat as unavailable
  if (m.settled) return { error: "settled" };
  if (!Number.isInteger(spend) || spend < 1 || spend > PER_TRADE_CAP) return { error: "capExceeded" };
  if (spec.tokens < spend) return { error: "insufficient" };
  // You can't hold both sides of the same market: block a bet on the side
  // opposite to an existing position.
  const existing = findPosition(spectatorId, contestantId);
  if (existing) {
    if (side === "yes" && existing.noShares > 0) return { error: "oppositeSide" };
    if (side === "no" && existing.yesShares > 0) return { error: "oppositeSide" };
  }

  const r = buyShares(m.qYes, m.qNo, side, spend);
  m.qYes = r.qYes;
  m.qNo = r.qNo;
  m.priceHistory.push({ t: now, price: r.priceAfter });
  spec.tokens -= spend;

  let pos = findPosition(spectatorId, contestantId);
  if (!pos) {
    pos = { spectatorId, contestantId, yesShares: 0, noShares: 0, yesSpent: 0, noSpent: 0 };
    state.positions.push(pos);
  }
  if (side === "yes") {
    pos.yesShares += r.shares;
    pos.yesSpent += spend;
  } else {
    pos.noShares += r.shares;
    pos.noSpent += spend;
  }

  state.trades.push({
    id: randomUUID(),
    spectatorId,
    contestantId,
    side,
    spend,
    shares: r.shares,
    priceAfter: r.priceAfter,
    t: now,
  } satisfies Trade);

  markMarketDirty(contestantId);
  return {
    shares: r.shares,
    cost: spend,
    newBalance: spec.tokens,
    qYes: m.qYes,
    qNo: m.qNo,
    priceYes: r.priceAfter,
  };
}

// ---------------------------------------------------------------------------
// Event-driven odds drift (spec Task E). The world moved, so the price moves,
// even though nobody bet. Callers (combat, the event feed, the conversation
// bridge) say "move this islander by tunables.market.driftOnFight" and never
// touch shares -- the price-to-spread inversion lives in @arena/shared/lmsr.
//
// Death is deliberately NOT on this path. The head pills and market list show a
// NORMALIZED chance to win (winProbabilities divides each price by the sum over
// living, unsettled markets), so settling a dead islander's market drops it out
// of that denominator and every survivor's displayed percentage rises by
// itself. A raw nudge on death as well would count the same effect twice, which
// is exactly how death stops being the dominant signal.
//
// `delta` is a TARGET PRICE move in probability points, signed. Returns the
// move actually realized (0 when the call was a no-op), so a caller can log or
// test the outcome without re-reading the market.
export function applyMarketDrift(contestantId: string, delta: number, now: number): number {
  if (!tunables.flags.marketEventDrift) return 0;
  const m = state.markets[contestantId];
  // An unknown or settled market is a normal outcome here, not an error: events
  // fire about islanders who just died, and the drift simply has nowhere to go.
  if (!m || m.settled) return 0;

  const { maxDriftPerEvent, priceFloor, priceCeil } = tunables.market;
  const r = driftPrice(m.qYes, m.qNo, delta, maxDriftPerEvent, priceFloor, priceCeil, m.b);
  if (r.applied === 0) return 0;
  m.qYes = r.qYes;
  m.qNo = r.qNo;

  // Same two steps executeBet takes after it moves a market: record the point
  // so sparklines show the jump, and mark the market dirty so the price rides
  // out on the next tick diff.
  m.priceHistory.push({ t: now, price: r.priceAfter });
  markMarketDirty(contestantId);

  // No Trade record on purpose. state.trades is the audit log of spectator
  // activity -- who spent what, at what price. A drift moved the price without
  // anyone spending a token, so writing it there would invent a trade that
  // never happened and corrupt every downstream read of the history.
  //
  // Existing positions are likewise untouched: share counts and token balances
  // live on state.positions / state.spectators, and this function writes only
  // to the market's q values. A drift changes the price later bets execute at;
  // it cannot change what an earlier bet already bought.
  return r.applied;
}
