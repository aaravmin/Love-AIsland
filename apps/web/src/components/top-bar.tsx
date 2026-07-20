"use client";

import Link from "next/link";
import { Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { GamesMenu } from "@/components/games-menu";
import { useGameStore } from "@/lib/gameStore";

// Minimal top chrome shared by every route: the wordmark on the left and,
// once this browser has joined as a spectator, its live token balance on
// the right. Flat colors only, no elevation.
export function TopBar() {
  const tokens = useGameStore((s) => s.spectator?.tokens ?? null);

  return (
    <header
      className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4"
      // Pad the bar out of the notch on devices with a top safe-area inset.
      style={{
        paddingTop: "env(safe-area-inset-top)",
        height: "calc(3.5rem + env(safe-area-inset-top))",
        paddingLeft: "max(1rem, env(safe-area-inset-left))",
        paddingRight: "max(1rem, env(safe-area-inset-right))",
      }}
    >
      <span className="font-heading text-xl font-bold tracking-wide text-primary">
        Love <span className="text-chart-4">AI</span>sland
      </span>
      <div className="flex items-center gap-2">
        {tokens !== null ? (
          <Badge className="rounded-full bg-primary px-3 py-1 text-sm font-bold text-primary-foreground">
            {tokens.toLocaleString()} tokens
          </Badge>
        ) : null}
        <GamesMenu />
        <Link
          href="/admin"
          className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          title="Operator console"
        >
          <Settings2 className="size-4" />
          Admin
        </Link>
      </div>
    </header>
  );
}
