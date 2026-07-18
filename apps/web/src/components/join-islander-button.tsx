"use client";

import Link from "next/link";
import { useGameStore } from "@/lib/gameStore";

// The spectate-view entry control: a single "Sign in" button. It is only
// shown while this browser has no spectator yet -- once signed in, betting
// happens by tapping an islander directly on the island, and islander
// creation (if still open) lives behind the top bar's Games menu / create
// flow, so there is nothing left for this button to do.
export function JoinIslanderButton() {
  const spectator = useGameStore((s) => s.spectator);

  if (spectator) return null;

  return (
    <div className="absolute top-4 left-4 z-20 flex flex-col items-start gap-2">
      <Link
        href="/join"
        className="rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground shadow"
      >
        Sign in
      </Link>
    </div>
  );
}
