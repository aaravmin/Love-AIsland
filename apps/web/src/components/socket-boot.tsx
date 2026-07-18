"use client";

import { useEffect } from "react";
import { getSocket } from "@/lib/socket";
import { useGameStore } from "@/lib/gameStore";

// Opens the game socket as soon as any route mounts (layout-level), so the
// snapshot is usually hydrated before the island scene or a form needs it.
// Renders nothing; the socket itself is a module singleton.
export function SocketBoot() {
  useEffect(() => {
    getSocket();
    // QA/debug handle for phase-gate verification scripts (mirrors __arenaGame).
    (window as unknown as Record<string, unknown>).__arenaStore = useGameStore;
  }, []);
  return null;
}
