"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { setRoom } from "@/lib/onboarding";
import { joinRoom } from "@/lib/socket";
import { IslandChoice } from "./island-choice";

// The intro screen reads sessionStorage (and window.location) during its very
// first render to decide whether this tab has already entered the island.
// Keeping it client-only prevents a server/client first render mismatch
// while still giving the Phaser scene time to boot behind it.
const IntroScreen = dynamic(() => import("./intro-screen"), {
  ssr: false,
  loading: () => <div className="fixed inset-0 z-[100] bg-[#170f22]" />,
});

// Whether this tab has already picked or joined an island this session --
// tracked separately from intro-screen's own "seen the intro" flag so a
// refresh mid-flow resumes at the right step instead of looping back to the
// island landing.
const CHOSEN_KEY = "arena.islandChosen.v1";

function markChosen(): void {
  try {
    window.sessionStorage.setItem(CHOSEN_KEY, "1");
  } catch {
    // Storage may be unavailable in a privacy-restricted browser; the flow
    // still proceeds for this visit, it just re-prompts on refresh.
  }
}

type Phase = "loading" | "choice" | "intro";

// A small stepped flow ahead of the intro screen: a QR/room link skips the
// landing entirely and joins straight in (the QR path), otherwise the
// islander picks Join or Create on <IslandChoice/> first, then sees the
// "enter the island" screen.
export function IntroGate() {
  const [phase, setPhase] = useState<Phase>("loading");

  useEffect(() => {
    const roomParam = new URLSearchParams(window.location.search).get("room")?.trim();

    if (roomParam) {
      const code = roomParam.toUpperCase();
      // Persist immediately so the sign-in + create steps resolve this room
      // even before the join round-trip resolves.
      setRoom(code);
      void joinRoom(code)
        .then((res) => {
          if (!res.ok) toast.error(res.error ?? "Couldn't find that island.");
        })
        .finally(() => {
          markChosen();
          setPhase("intro");
        });
      return;
    }

    let chosen = false;
    try {
      chosen = window.sessionStorage.getItem(CHOSEN_KEY) === "1";
    } catch {
      chosen = false;
    }
    // Deciding the first step from sessionStorage/URL must happen after mount to
    // stay SSR-safe (both server and client first-render the "loading" screen),
    // so this initial setState in the effect is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase(chosen ? "intro" : "choice");
  }, []);

  if (phase === "choice") {
    return (
      <IslandChoice
        onChosen={() => {
          markChosen();
          setPhase("intro");
        }}
      />
    );
  }

  if (phase === "loading") {
    return <div className="fixed inset-0 z-[100] bg-[#170f22]" />;
  }

  return <IntroScreen />;
}
