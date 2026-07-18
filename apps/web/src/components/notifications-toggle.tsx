"use client";

import { useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { useGameStore } from "@/lib/gameStore";
import { setNotifPref } from "@/lib/socket";
import { cn } from "@/lib/utils";

// Small on/off pill for SMS portfolio updates, default off. Only renders once
// this browser has actually joined as a spectator -- there's nothing to
// toggle before that. Reflects the server-authoritative spectator.notify;
// setNotifPref updates the store itself once the ack lands.
export function NotificationsToggle() {
  const spectator = useGameStore((s) => s.spectator);
  const [busy, setBusy] = useState(false);

  if (!spectator) return null;

  const on = spectator.notify;

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      await setNotifPref(!on);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      aria-pressed={on}
      title="Text me portfolio updates"
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-60",
        on
          ? "border-primary/40 bg-primary/15 text-primary"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {on ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
      <span className="hidden sm:inline">Text me portfolio updates</span>
    </button>
  );
}
