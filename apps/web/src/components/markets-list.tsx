"use client";

import { ArrowDown, ArrowUp, Crosshair } from "lucide-react";
import { winProbabilities, type MarketPublic, type Position } from "@arena/shared";

import { useGameStore } from "@/lib/gameStore";
import { cn } from "@/lib/utils";

// Flat list of market rows shared by the desktop side panel and the mobile
// drawer, fed by the live snapshot. Per the UI style directive this stays
// functional rather than brand-themed: a bold sportsbook board (heavy
// weights, big numbers, strong trend colors), not pink. Betting
// interactions, positions, and the full market view land in Phase 6.

// Mark-to-market value of one position: for a settled market the payout is
// already fixed (winning shares pay 1 token each, the losing side is worth
// nothing); for a live market each side is valued at the SAME normalized win
// probability the board's cents and the contestant panel's headline % use
// (winProb, falling back to raw priceYes only if the id fell out of the
// living/unsettled normalization -- e.g. it was just settled this tick), so
// this reconciles with contestant-panel.tsx's per-islander math rather than
// inventing a second pricing model.
function positionValue(
  position: Position,
  market: MarketPublic | undefined,
  winProb: number | undefined,
): { cost: number; value: number; pnl: number; prob: number } {
  const cost = position.yesSpent + position.noSpent;
  if (!market) return { cost, value: 0, pnl: -cost, prob: 0 };
  if (market.settled) {
    const value = market.settledOutcome === "yes" ? position.yesShares : position.noShares;
    return { cost, value, pnl: value - cost, prob: market.settledOutcome === "yes" ? 1 : 0 };
  }
  const p = winProb ?? market.priceYes;
  const value = position.yesShares * p + position.noShares * (1 - p);
  return { cost, value, pnl: value - cost, prob: p };
}

export function MarketsList({ onSelect }: { onSelect?: () => void } = {}) {
  const contestants = useGameStore((s) => s.contestants);
  const markets = useGameStore((s) => s.markets);
  const spectator = useGameStore((s) => s.spectator);
  const select = useGameStore((s) => s.setSelectedContestant);
  const setFollowed = useGameStore((s) => s.setFollowedContestantId);
  const followedContestantId = useGameStore((s) => s.followedContestantId);

  // Normalized win odds across the living, unsettled markets, so the board's
  // cents sum to ~100% and re-derive on every price change (no stale memo -- a
  // bet on ANY market shifts every row).
  const living = Object.values(markets).filter(
    (m) => !m.settled && contestants[m.contestantId]?.alive,
  );
  const winProbs = winProbabilities(
    living.map((m) => ({ id: m.contestantId, priceYes: m.priceYes })),
  );
  // Every id the spectator currently holds shares in -- drives the "held" ring
  // on a market row so a bettor can see their exposure at a glance rather than
  // having to click each islander (contestant-panel.tsx was, until this
  // change, the ONLY place a position was visible at all).
  const heldIds = new Set(
    (spectator?.positions ?? [])
      .filter((p) => p.yesShares > 0 || p.noShares > 0)
      .map((p) => p.contestantId),
  );
  const rows = living
    .map((m) => {
      const winProb = winProbs.get(m.contestantId) ?? m.priceYes;
      return {
        id: m.contestantId,
        name: contestants[m.contestantId]!.name,
        yesCents: Math.round(winProb * 100),
        // Trend vs the seeded first sparkline point (also a normalized win
        // prob); flat markets read as "up". The epsilon absorbs float noise.
        up: winProb >= (m.sparkline[0]?.[1] ?? winProb) - 1e-9,
        held: heldIds.has(m.contestantId),
      };
    })
    .sort((a, b) => b.yesCents - a.yesCents);

  // Portfolio: every islander the spectator has ever bet on, oldest bet
  // first, with cost basis and mark-to-market P&L computed from the SAME
  // normalized winProbs map the board above already derived (positionValue).
  const positions = (spectator?.positions ?? []).filter(
    (p) => p.yesShares > 0 || p.noShares > 0,
  );
  const portfolio = positions
    .map((p) => {
      const market = markets[p.contestantId];
      const { cost, value, pnl, prob } = positionValue(p, market, winProbs.get(p.contestantId));
      return {
        position: p,
        name: contestants[p.contestantId]?.name ?? "Unknown",
        alive: contestants[p.contestantId]?.alive ?? false,
        cost,
        value,
        pnl,
        probPct: Math.round(prob * 100),
      };
    })
    // Biggest stake first -- the positions a spectator most cares about lead.
    .sort((a, b) => b.cost - a.cost);
  const portfolioCost = portfolio.reduce((sum, p) => sum + p.cost, 0);
  const portfolioValue = portfolio.reduce((sum, p) => sum + p.value, 0);
  const portfolioPnl = portfolioValue - portfolioCost;

  // "Follow my investments" (user ask 1, second half): jump the camera to the
  // single biggest position right now. The scene (IslandScene.ts, WS-O) is
  // the one that owns cutting between held islanders as the game develops;
  // this button's job is just to start that follow on the position the
  // spectator has the most riding on, using the store's one follow seam.
  const topHeld = portfolio[0]?.position.contestantId ?? null;
  const followingInvestments = topHeld !== null && followedContestantId === topHeld;

  return (
    <div className="flex flex-col gap-2">
      {spectator ? (
        <div className="flex items-center justify-between rounded-lg bg-primary/10 px-3 py-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase">Your balance</span>
          <span className="font-heading text-lg font-extrabold tabular-nums text-primary">
            {Math.round(spectator.tokens).toLocaleString()}
          </span>
        </div>
      ) : null}

      {portfolio.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg bg-muted/60 p-3 ring-1 ring-border">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase">
              Your positions
            </span>
            <span
              className={cn(
                "font-mono text-xs font-bold tabular-nums",
                portfolioPnl > 0
                  ? "text-emerald-400"
                  : portfolioPnl < 0
                    ? "text-rose-400"
                    : "text-muted-foreground",
              )}
            >
              {portfolioPnl >= 0 ? "+" : ""}
              {Math.round(portfolioPnl)}
            </span>
          </div>

          <ul className="flex flex-col gap-1">
            {portfolio.map((p) => (
              <li key={p.position.contestantId}>
                <button
                  onClick={() => {
                    select(p.position.contestantId);
                    onSelect?.();
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted"
                >
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                    {p.name}
                    {!p.alive ? <span className="ml-1 text-muted-foreground">· out</span> : null}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                    {p.probPct}%
                  </span>
                  <span
                    className={cn(
                      "shrink-0 w-14 text-right font-mono text-[11px] font-bold tabular-nums",
                      p.pnl > 0 ? "text-emerald-400" : p.pnl < 0 ? "text-rose-400" : "text-muted-foreground",
                    )}
                  >
                    {p.pnl >= 0 ? "+" : ""}
                    {Math.round(p.pnl)}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {topHeld ? (
            <button
              onClick={() => setFollowed(followingInvestments ? null : topHeld)}
              aria-pressed={followingInvestments}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md border py-1.5 text-xs font-bold transition-colors",
                followingInvestments
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <Crosshair className="size-3.5" />
              {followingInvestments ? "Following your investments" : "Follow my investments"}
            </button>
          ) : null}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="px-1 py-6 text-center text-sm text-muted-foreground">
          No islanders yet. Markets open the moment the first one steps on the sand.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((market) => (
            <li key={market.id}>
              <button
                onClick={() => {
                  select(market.id);
                  onSelect?.();
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-lg bg-muted px-3 py-3.5 text-left ring-1 transition-colors hover:ring-primary",
                  // Held marker: a spectator's own exposure gets a visibly
                  // distinct ring/tab instead of requiring a click into each
                  // islander's panel to remember what they hold.
                  market.held ? "ring-primary/60" : "ring-border",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {market.held ? (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-primary"
                      aria-label="You hold a position here"
                      title="You hold a position here"
                    />
                  ) : null}
                  <span className="min-w-0 truncate text-sm font-semibold text-foreground">
                    {market.name}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {/* Chance-to-win board: the normalized Yes/No odds in cents.
                      The real, stake-specific payout lives on the buy buttons in
                      the contestant panel, so this row stays a clean odds view. */}
                  <span className="flex flex-col items-end leading-tight">
                    <span className="text-lg font-extrabold tabular-nums text-emerald-400">
                      {market.yesCents}¢
                    </span>
                    <span className="text-[11px] font-semibold tabular-nums text-rose-400">
                      No {100 - market.yesCents}¢
                    </span>
                  </span>
                  {market.up ? (
                    <ArrowUp className="size-5 text-emerald-400" aria-label="trending up" />
                  ) : (
                    <ArrowDown className="size-5 text-rose-500" aria-label="trending down" />
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
