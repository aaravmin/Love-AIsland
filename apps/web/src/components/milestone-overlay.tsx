"use client";

// This overlay is a small animation state machine driven by external store
// changes (a death, hostile mode, a new feed line, the winner). Enqueuing a
// splash and stepping the in/hold/out animation from effects is the intended
// pattern here, so the set-state-in-effect rule is deliberately relaxed.
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import { useGameStore } from "@/lib/gameStore";
import { cn } from "@/lib/utils";

// Full-screen, one-shot splash animations for the game's big beats: the alive
// count crossing 10/5/2, hostile mode kicking in, a scheduled event actually
// eliminating someone, and the winner landing. Each fires at most once per
// game -- the fired flags (and the alive-count baseline used to detect a
// crossing) live in a ref and reset whenever the room drops back to "lobby",
// which is what a fresh game / room reset looks like from here.

type Splash = { id: number; title: string; sub?: string };

const ANIM_MS = 450;
const HOLD_MS = 1700;

let splashSeq = 0;

type FiredFlags = {
  c10: boolean;
  c5: boolean;
  c2: boolean;
  hostile: boolean;
  winner: boolean;
  lastFeedId: number;
};

function freshFlags(lastFeedId: number): FiredFlags {
  return { c10: false, c5: false, c2: false, hostile: false, winner: false, lastFeedId };
}

export function MilestoneOverlay() {
  const contestants = useGameStore((s) => s.contestants);
  const phase = useGameStore((s) => s.phase);
  const hostile = useGameStore((s) => s.hostile);
  const feed = useGameStore((s) => s.feed);
  const results = useGameStore((s) => s.results);

  const fired = useRef<FiredFlags>(freshFlags(0));
  const prevAliveRef = useRef<number | null>(null);

  const [queue, setQueue] = useState<Splash[]>([]);
  const [active, setActive] = useState<Splash | null>(null);
  const [entered, setEntered] = useState(false);

  const aliveCount = useMemo(
    () => Object.values(contestants).filter((c) => c.alive).length,
    [contestants],
  );

  function enqueue(title: string, sub?: string) {
    setQueue((q) => [...q, { id: ++splashSeq, title, sub }]);
  }

  // A fresh lobby is a new game: clear every fired flag and anything queued
  // from the last run.
  useEffect(() => {
    if (phase === "lobby") {
      fired.current = freshFlags(fired.current.lastFeedId);
      prevAliveRef.current = null;
      setQueue([]);
      setActive(null);
    }
  }, [phase]);

  // Alive count crossing 10, then 5, then 2. Compared against the previous
  // reading (not just the current one) so a late-joining client's first
  // snapshot doesn't retroactively fire every threshold at once, and so a
  // multi-death tick that jumps straight past a threshold still fires it.
  useEffect(() => {
    if (phase !== "running") {
      prevAliveRef.current = null;
      return;
    }
    const prev = prevAliveRef.current;
    if (prev !== null) {
      const f = fired.current;
      if (!f.c10 && prev > 10 && aliveCount <= 10) {
        f.c10 = true;
        enqueue("10 LEFT");
      }
      if (!f.c5 && prev > 5 && aliveCount <= 5) {
        f.c5 = true;
        enqueue("5 LEFT");
      }
      if (!f.c2 && prev > 2 && aliveCount <= 2) {
        f.c2 = true;
        enqueue("FINAL 2");
      }
    }
    prevAliveRef.current = aliveCount;
  }, [aliveCount, phase]);

  // Hostile mode turning on.
  useEffect(() => {
    if (hostile && !fired.current.hostile) {
      fired.current.hostile = true;
      enqueue("SUDDEN DEATH", "Healing is gone. Alliances are off.");
    }
  }, [hostile]);

  // A scheduled event actually eliminating someone (the feed line ends
  // "... eliminated." -- the "nobody met the axe" miss doesn't splash).
  useEffect(() => {
    if (feed.length === 0) return;
    const last = feed[feed.length - 1];
    if (last.id <= fired.current.lastFeedId) return;
    fired.current.lastFeedId = last.id;
    if (last.kind === "event" && /eliminated/.test(last.text)) {
      if (last.text.startsWith("The Purge")) enqueue("THE PURGE");
      else if (last.text.startsWith("The Vote")) enqueue("THE VOTE");
    }
  }, [feed]);

  // Winner.
  useEffect(() => {
    if (results && !fired.current.winner) {
      fired.current.winner = true;
      enqueue("WINNER", results.winnerName);
    }
  }, [results]);

  // Pop the next queued splash once nothing is currently showing.
  useEffect(() => {
    if (active || queue.length === 0) return;
    setActive(queue[0]);
    setQueue((q) => q.slice(1));
  }, [active, queue]);

  // Animate whichever splash is active: in, hold, out, then clear.
  useEffect(() => {
    if (!active) return;
    setEntered(false);
    const enter = requestAnimationFrame(() => setEntered(true));
    const exitTimer = setTimeout(() => setEntered(false), ANIM_MS + HOLD_MS);
    const doneTimer = setTimeout(() => setActive(null), ANIM_MS + HOLD_MS + ANIM_MS);
    return () => {
      cancelAnimationFrame(enter);
      clearTimeout(exitTimer);
      clearTimeout(doneTimer);
    };
  }, [active]);

  if (!active) return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-[#1a0714]/60 transition-opacity duration-[450ms] ease-out",
        entered ? "opacity-100" : "opacity-0",
      )}
    >
      <div
        className={cn(
          "flex flex-col items-center gap-2 rounded-3xl border-4 border-chart-4 bg-primary px-10 py-8 text-center shadow-2xl transition-all duration-[450ms] ease-out",
          entered ? "scale-100 opacity-100" : "scale-75 opacity-0",
        )}
      >
        <span className="font-heading text-5xl font-extrabold tracking-wide text-primary-foreground uppercase sm:text-7xl">
          {active.title}
        </span>
        {active.sub ? (
          <span className="max-w-xs text-base font-bold text-chart-4 sm:text-xl">
            {active.sub}
          </span>
        ) : null}
      </div>
    </div>
  );
}
