"use client";

import { useState } from "react";
import { Crown, X } from "lucide-react";
import { useGameStore } from "@/lib/gameStore";
import { cn } from "@/lib/utils";

// Phase 8 results screen: the end-of-game payoff. Shows the surviving islander
// and its owner, the spectator whose betting portfolio finished richest, the
// token leaderboard, and a few recap stats. Driven by the game:results event;
// falls back to a minimal "X wins" card if a client connected after settlement
// (only the winner id survives in the snapshot).
export function ResultsScreen() {
  const phase = useGameStore((s) => s.phase);
  const results = useGameStore((s) => s.results);
  const winnerId = useGameStore((s) => s.winnerContestantId);
  const winnerName = useGameStore((s) =>
    (results?.winnerContestantId ?? s.winnerContestantId)
      ? s.contestants[results?.winnerContestantId ?? s.winnerContestantId!]?.name
      : undefined,
  );
  const [dismissed, setDismissed] = useState(false);

  if (phase !== "settled") return null;
  if (!results && !winnerId) return null;
  if (dismissed) {
    return (
      <button
        onClick={() => setDismissed(false)}
        className="absolute top-4 left-1/2 z-40 -translate-x-1/2 rounded-full bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground shadow-lg"
      >
        👑 Show results
      </button>
    );
  }

  const winner = winnerName ?? "The last islander";

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center overflow-y-auto bg-[#1a0714]/95 p-4 backdrop-blur">
      <div className="relative my-auto w-full max-w-md rounded-2xl border border-primary/30 bg-card p-6 shadow-2xl">
        <button
          onClick={() => setDismissed(true)}
          className="absolute top-3 right-3 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Dismiss results"
        >
          <X className="size-5" />
        </button>

        <div className="flex flex-col items-center gap-1 text-center">
          <Crown className="size-10 text-primary" />
          <p className="text-xs font-bold tracking-widest text-primary uppercase">Winner</p>
          <h1 className="font-heading text-3xl font-extrabold text-foreground">{winner}</h1>
          {results ? (
            <p className="text-sm text-muted-foreground">
              owned by <span className="font-semibold text-foreground">{results.winnerOwnerName}</span>
            </p>
          ) : null}
          {results?.quip ? (
            <p className="mt-1 max-w-xs text-sm font-semibold text-foreground italic">
              &ldquo;{results.quip}&rdquo;
            </p>
          ) : null}
        </div>

        {results ? (
          <>
            <div className="mt-5 flex items-center justify-between rounded-xl bg-primary/10 px-4 py-3">
              <div>
                <p className="text-[11px] font-semibold tracking-wide text-primary uppercase">
                  Top portfolio
                </p>
                <p className="font-bold text-foreground">{results.winnerPortfolio.name}</p>
              </div>
              <p className="font-heading text-2xl font-extrabold tabular-nums text-primary">
                {results.winnerPortfolio.tokens.toLocaleString()}
              </p>
            </div>

            {results.leaderboard.length > 0 ? (
              <div className="mt-4">
                <p className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Leaderboard
                </p>
                <ol className="flex flex-col gap-1">
                  {results.leaderboard.map((row, i) => (
                    <li
                      key={`${row.name}-${i}`}
                      className="flex items-center justify-between rounded-lg bg-muted px-3 py-1.5 text-sm"
                    >
                      <span className="flex items-center gap-2 truncate">
                        <span className="w-4 text-right font-mono text-xs text-muted-foreground tabular-nums">
                          {i + 1}
                        </span>
                        <span className="truncate font-medium text-foreground">{row.name}</span>
                      </span>
                      <span className="font-semibold tabular-nums text-foreground">
                        {row.tokens.toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            {results.payouts.length > 0 ? (
              <div className="mt-4">
                <p className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Payouts
                </p>
                <ol className="flex flex-col gap-1">
                  {results.payouts.map((row, i) => (
                    <li
                      key={`${row.name}-${i}`}
                      className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-1.5 text-sm"
                    >
                      <span className="flex min-w-0 items-center gap-2 truncate">
                        <span className="w-4 text-right font-mono text-xs text-muted-foreground tabular-nums">
                          {i + 1}
                        </span>
                        <span className="truncate font-medium text-foreground">{row.name}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-muted-foreground tabular-nums">
                          spent {row.spent.toLocaleString()}
                        </span>
                        <span
                          className={cn(
                            "font-semibold tabular-nums",
                            row.net >= 0 ? "text-emerald-400" : "text-rose-400",
                          )}
                        >
                          {row.net >= 0 ? "+" : ""}
                          {row.net.toLocaleString()}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            <div className="mt-4 grid grid-cols-2 gap-2 text-center">
              <div className="rounded-lg bg-muted px-2 py-2">
                <p className="text-[11px] text-muted-foreground uppercase">Eliminations</p>
                <p className="font-heading text-xl font-extrabold text-foreground tabular-nums">
                  {results.recap.totalDeaths}
                </p>
              </div>
              <div className="rounded-lg bg-muted px-2 py-2">
                <p className="text-[11px] text-muted-foreground uppercase">Bets placed</p>
                <p className="font-heading text-xl font-extrabold text-foreground tabular-nums">
                  {results.recap.totalBets}
                </p>
              </div>
            </div>
            <p className="mt-3 text-center text-xs text-muted-foreground italic">
              {results.recap.biggestUpset}
            </p>
          </>
        ) : (
          <p className="mt-5 text-center text-sm text-muted-foreground">
            The game has ended. Final standings weren&rsquo;t captured on this device.
          </p>
        )}
      </div>
    </div>
  );
}
