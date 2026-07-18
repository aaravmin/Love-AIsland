"use client";

import { useEffect, useState } from "react";
import { useGameStore } from "@/lib/gameStore";

// Phase 7 top-center banner: a live countdown to the next scheduled event
// (the Purge / the Weakest Link), then the persistent SUDDEN DEATH banner once
// hostile mode is on. Ticks once a second off a local clock so the numbers
// move without spamming the store.

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// The server's description is prefixed with the event's own name ("The Purge -
// the weakest islanders are culled."), which would just repeat the banner's
// title. Strip that prefix so the line under the title reads as a plain
// explanation instead.
function explain(description: string): string {
  const dash = description.indexOf(" - ");
  const rest = dash === -1 ? description : description.slice(dash + 3);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export function EventBanner() {
  const countdown = useGameStore((s) => s.eventCountdown);
  const hostile = useGameStore((s) => s.hostile);
  const phase = useGameStore((s) => s.phase);
  const autoStartAt = useGameStore((s) => s.autoStartAt);
  const startingSoon = phase === "lobby" && autoStartAt !== null;
  const now = useNow(!!countdown || !!hostile || startingSoon);

  // Pre-game start countdown, shown on the island while a lobby is armed.
  if (startingSoon && autoStartAt !== null) {
    const remaining = autoStartAt - now;
    return (
      <div className="pointer-events-none absolute top-4 left-1/2 z-30 -translate-x-1/2">
        <div className="rounded-full border border-primary/40 bg-primary/90 px-5 py-2 text-center shadow-lg backdrop-blur">
          <span className="text-sm font-extrabold tracking-wide text-primary-foreground uppercase">
            🏝 Game starts in {fmt(remaining)}
          </span>
        </div>
      </div>
    );
  }

  if (hostile) {
    return (
      <div className="pointer-events-none absolute top-4 left-1/2 z-30 -translate-x-1/2">
        <div className="animate-pulse rounded-full border border-rose-400/40 bg-rose-600/90 px-5 py-2 text-center shadow-lg backdrop-blur">
          <span className="text-sm font-extrabold tracking-wide text-white uppercase">
            🔥 Sudden Death · last islander standing
          </span>
        </div>
      </div>
    );
  }

  if (countdown) {
    const label = countdown.kind === "purge" ? "The Purge" : "The Vote";
    const remaining = countdown.firesAt - now;
    return (
      <div className="pointer-events-none absolute top-4 left-1/2 z-30 -translate-x-1/2">
        <div className="flex flex-col items-center gap-0.5 rounded-2xl border border-amber-300/40 bg-amber-500/90 px-5 py-2 text-center shadow-lg backdrop-blur">
          <span className="text-sm font-extrabold tracking-wide text-[#3a2600] uppercase">
            ⚠ {label} in {fmt(remaining)}
          </span>
          <span className="text-xs font-medium text-[#3a2600]/80">
            {explain(countdown.description)}
          </span>
        </div>
      </div>
    );
  }

  return null;
}
