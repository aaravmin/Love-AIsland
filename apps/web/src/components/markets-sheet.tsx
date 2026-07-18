"use client";

import { useState } from "react";
import { ChevronUp, TrendingUp, X } from "lucide-react";
import { MarketsList } from "@/components/markets-list";
import { useGameStore } from "@/lib/gameStore";

// Markets live in a bottom tab that expands to a full-screen board (per the
// redesign: the right rail is the activity feed now). The trigger sits at the
// bottom center; opening it covers the island with the full market list.
export function MarketsSheet() {
  const [open, setOpen] = useState(false);
  const marketCount = useGameStore(
    (s) => Object.values(s.markets).filter((m) => !m.settled).length,
  );

  return (
    <>
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}
          className="pointer-events-auto absolute left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card/95 px-5 py-2.5 shadow-lg backdrop-blur transition-colors hover:border-primary"
        >
          <TrendingUp className="size-4 text-primary" />
          <span className="text-sm font-bold text-foreground">Markets</span>
          {marketCount > 0 ? (
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-bold text-primary tabular-nums">
              {marketCount}
            </span>
          ) : null}
          <ChevronUp className="size-4 text-muted-foreground" />
        </button>
      ) : null}

      {open ? (
        <div className="absolute inset-0 z-40 flex flex-col bg-background/95 backdrop-blur">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="size-5 text-primary" />
              <h2 className="font-heading text-lg font-extrabold text-foreground">Markets</h2>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close markets"
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto p-4">
            {/* Picking a contestant opens their panel; close the board so it shows. */}
            <MarketsList onSelect={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
