"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, ChevronRight, Heart, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";

const INTRO_SEEN_KEY = "arena.introSeen.pixelV1";
const EXIT_MS = 850;

const STEPS = [
  {
    icon: Bot,
    number: "01",
    title: "Build an islander",
    copy: "Pick their personality and strategy.",
  },
  {
    icon: Heart,
    number: "02",
    title: "Watch the drama",
    copy: "Islanders flirt, scheme, and fight live.",
  },
  {
    icon: Trophy,
    number: "03",
    title: "Back a survivor",
    copy: "Bet tokens on who outlasts the island.",
  },
] as const;

export default function IntroScreen() {
  const [visible] = useState(
    () => {
      if (new URLSearchParams(window.location.search).get("intro") === "0") return false;
      try {
        return window.sessionStorage.getItem(INTRO_SEEN_KEY) !== "1";
      } catch {
        return true;
      }
    },
  );
  const [leaving, setLeaving] = useState(false);
  const router = useRouter();

  function enterIsland() {
    if (leaving) return;
    setLeaving(true);
    try {
      window.sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    } catch {
      // Storage may be unavailable in a privacy-restricted browser; the
      // animation should still complete normally for this visit.
    }
    // Everyone signs in first. The join page then routes to character creation
    // (if the game hasn't started) or straight to the island (if it has). The
    // room, if this is a QR/room link, rides along so sign-in targets it.
    const room = new URLSearchParams(window.location.search).get("room")?.trim();
    window.setTimeout(
      () => router.push(`/join${room ? `?room=${encodeURIComponent(room.toUpperCase())}` : ""}`),
      EXIT_MS,
    );
  }

  if (!visible) return null;

  return (
    <section
      className="intro-screen fixed inset-0 z-[100] cursor-pointer overflow-x-hidden overflow-y-auto bg-[#170f22] text-white"
      data-leaving={leaving}
      role="dialog"
      aria-modal="true"
      aria-labelledby="intro-title"
      onClick={enterIsland}
    >
      <div className="intro-pink-plane absolute inset-x-0 top-0 h-[46%] bg-[#ff2d78]" />
      <div className="intro-pixel-corner absolute top-0 right-0 size-40 bg-[#ffd84d] sm:size-56" />
      <div className="intro-pixel-sun absolute -right-8 top-8 size-24 bg-[#ff2d78] sm:size-32" />
      <div className="intro-coral-block absolute -bottom-20 -left-16 h-64 w-72 bg-[#ff6b35] sm:h-80 sm:w-96" />
      <div aria-hidden="true" className="intro-pixel-heart absolute top-[12%] left-[6%]" />
      <div aria-hidden="true" className="intro-pixel-spark absolute right-[8%] bottom-[14%]" />
      <div aria-hidden="true" className="absolute top-[66%] left-[8%] size-3 bg-[#ffd84d] shadow-[20px_20px_0_#ff2d78,44px_-12px_0_#32b8e8]" />

      <div className="intro-stage relative z-10 flex min-h-full items-center justify-center p-4 sm:p-8" data-leaving={leaving}>
        <div className="intro-pixel-frame w-full max-w-5xl overflow-hidden border-4 border-[#0e0916] bg-[#21152f]">
          <div className="grid lg:grid-cols-[1.08fr_0.92fr]">
            <div className="relative flex flex-col justify-center overflow-hidden border-b-4 border-[#0e0916] bg-[#ff2d78] px-6 py-8 sm:px-10 sm:py-12 lg:min-h-[570px] lg:border-r-4 lg:border-b-0 lg:px-14">
              <div className="mb-5 flex w-fit items-center gap-2 border-2 border-[#21152f] bg-[#ffd84d] px-3 py-1.5 font-mono text-[10px] font-black tracking-[0.2em] text-[#21152f] uppercase">
                <span className="size-2 bg-[#21152f]" />
                Live from the villa.exe
              </div>
              <p className="font-mono text-sm font-black tracking-[0.16em] text-white uppercase sm:text-base">Welcome to</p>
              <h1 id="intro-title" className="intro-pixel-title mt-2 font-heading text-6xl leading-[0.85] font-extrabold tracking-[-0.055em] sm:text-8xl lg:text-9xl">
                Love
                <span className="block text-[#ffd84d]">AI<span className="text-white">sland</span></span>
              </h1>
              <p className="mt-7 max-w-md border-l-4 border-[#ffd84d] bg-[#d91d63] px-4 py-3 text-sm leading-relaxed font-semibold text-white sm:text-base">
                Every islander is AI. You decide who to trust.
              </p>
              <div className="mt-6 flex items-end justify-between gap-4">
                <div className="inline-flex w-fit items-center gap-2 border-2 border-white bg-[#21152f] px-3 py-2 font-mono text-[10px] font-black tracking-wider uppercase">
                  <span className="size-2 animate-pulse bg-[#65e899]" />
                  Island status: live
                </div>
                <div className="intro-islander-wrap hidden sm:block" aria-hidden="true">
                  <div className="islander-idle-sprite" />
                </div>
              </div>
            </div>

            <div className="flex flex-col justify-between gap-6 bg-[#21152f] px-6 py-7 sm:px-10 sm:py-10 lg:px-12">
              <div>
                <p className="font-mono text-[10px] font-bold tracking-[0.2em] text-[#ff2d78] uppercase">How to play</p>
                <p className="mt-2 font-heading text-2xl font-bold">Tonight on the island_</p>
                <p className="mt-1 text-sm text-[#b7a9cc]">Create a character. Watch their story. Pick the winner.</p>
              </div>

              <div className="flex flex-col gap-3">
                {STEPS.map(({ icon: Icon, number, title, copy }) => (
                  <div key={number} className="intro-pixel-step grid grid-cols-[2.75rem_1fr] gap-3 border-2 border-[#49385e] bg-[#2a2038] p-3.5">
                    <div className="flex size-11 items-center justify-center border-2 border-[#ff77a8] bg-[#ff2d78] text-white">
                      <Icon className="size-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="bg-[#ffd84d] px-1 font-mono text-[10px] font-black text-[#21152f]">{number}</span>
                        <h2 className="font-heading text-base font-bold">{title}</h2>
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-[#b7a9cc] sm:text-sm">{copy}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <Button
                  type="button"
                  size="lg"
                  onClick={(event) => {
                    event.stopPropagation();
                    enterIsland();
                  }}
                  className="intro-pixel-button h-12 w-full rounded-none border-2 border-[#fff3a6] bg-[#ffd84d] font-mono text-sm font-black tracking-wide text-[#21152f] uppercase hover:bg-[#ffe477]"
                >
                  Enter the island <ChevronRight className="size-5 stroke-[3]" />
                </Button>
                <p className="mt-3 text-center text-[11px] font-medium tracking-wider text-[#7f7194] uppercase">
                  Click anywhere to enter
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
