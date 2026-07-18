"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Tone } from "@arena/shared";
import { Bot } from "lucide-react";
import { useGameStore, type FeedEntry } from "@/lib/gameStore";
import { outcomePresentation } from "@/lib/outcomes";
import { cn } from "@/lib/utils";

// The live "broadcast chat": a translucent, high-contrast feed overlaid on the
// right of the island (replacing the old markets rail -- markets moved to the
// bottom sheet). Everything that happens on the island streams here as chat:
// conversation lines, fights, eliminations, and the Phase 7 events. Built for
// legibility over the map: dark scrim, light text, color only for meaning.

const TONE_TEXT: Record<Tone, string> = {
  friendly: "text-emerald-300",
  hostile: "text-rose-300",
  deceptive: "text-fuchsia-300",
  neutral: "text-zinc-200",
};

// A gap this long between two "conv" lines reads as a new moment rather than
// a continuation of the same back-and-forth, even if by coincidence the same
// two names are still talking -- keeps a slow, sparse feed from gluing
// unrelated exchanges into one giant card.
const GROUP_GAP_MS = 45_000;

// Consecutive "conv" entries get folded into one exchange card instead of
// scrolling past as identical-looking flat lines -- the shape most amplified
// the "everyone repeats the same line" complaint, since a repeated phrase
// used to read as N separate rail entries with nothing visually tying them
// to the moment they came from. FeedEntry (gameStore.ts, owned by WS-P) does
// not carry a conversation id, only the speaking contestant, so grouping is
// a heuristic: keep folding while consecutive conv lines involve at most two
// distinct speakers and arrive within GROUP_GAP_MS of each other. A third
// speaker or a long gap starts a new group -- conservative enough that it
// only ever merges lines a viewer would already read as one exchange.
type FeedGroup = { kind: "exchange"; entries: FeedEntry[] } | { kind: "single"; entry: FeedEntry };

function groupFeed(feed: FeedEntry[]): FeedGroup[] {
  const groups: FeedGroup[] = [];
  for (const entry of feed) {
    if (entry.kind === "conv") {
      const last = groups[groups.length - 1];
      if (last?.kind === "exchange") {
        const lastEntry = last.entries[last.entries.length - 1]!;
        // Cheap defense-in-depth against an exact repeat slipping through
        // WS-P's socket-layer throttle -- collapse it into the prior line
        // rather than showing the same sentence twice in a row.
        const isExactRepeat = lastEntry.speaker === entry.speaker && lastEntry.text === entry.text;
        const speakers = new Set(last.entries.map((e) => e.speaker));
        speakers.add(entry.speaker);
        const withinGap = entry.t - lastEntry.t <= GROUP_GAP_MS;
        if (withinGap && speakers.size <= 2) {
          if (!isExactRepeat) last.entries.push(entry);
          continue;
        }
      }
      groups.push({ kind: "exchange", entries: [entry] });
      continue;
    }
    groups.push({ kind: "single", entry });
  }
  return groups;
}

function Row({ entry }: { entry: FeedEntry }) {
  switch (entry.kind) {
    case "conv":
      return (
        <p className="leading-snug">
          <span className={cn("font-semibold", entry.tone ? TONE_TEXT[entry.tone] : "text-zinc-100")}>
            {entry.speaker}:
          </span>{" "}
          <span className="text-zinc-200">{entry.text}</span>
        </p>
      );
    case "outcome":
      return (
        <p className="text-[13px] leading-snug text-sky-300 italic">
          {entry.outcome ? `${outcomePresentation(entry.outcome).icon} ` : ""}
          {entry.text}
        </p>
      );
    case "fight":
      return <p className="leading-snug font-medium text-rose-300">⚔ {entry.text}</p>;
    case "death":
      return <p className="leading-snug font-semibold text-rose-400">☠ {entry.text}</p>;
    case "join":
      return <p className="leading-snug text-zinc-400">＋ {entry.text}</p>;
    case "alliance":
      return <p className="leading-snug font-semibold text-emerald-300">🤝 {entry.text}</p>;
    case "thought":
      return (
        <p className="leading-snug text-zinc-400 italic">
          💭 <span className="text-zinc-500">{entry.text}</span>
        </p>
      );
    case "event":
      return (
        <p className="rounded-md bg-amber-400/15 px-2 py-1 leading-snug font-semibold text-amber-300">
          ⚠ {entry.text}
        </p>
      );
    case "hostile":
      return (
        <p className="rounded-md bg-rose-600/25 px-2 py-1 leading-snug font-bold text-rose-200">
          🔥 {entry.text}
        </p>
      );
    default:
      return <p className="leading-snug text-zinc-300">{entry.text}</p>;
  }
}

// Minimum sample size before the degradation indicator will judge the run at
// all -- at 0-4 decisions the ratio is noise (a single early rule-fallback
// pick would otherwise flip the badge on for a game that's actually fine).
const DEGRADED_MIN_SAMPLE = 5;
// Share of recent decisions that must be rule-fallback before the sim reads
// as "on templates" to a spectator, not merely "occasionally falling back".
const DEGRADED_RATIO = 0.8;

export function ActivityFeed() {
  const feed = useGameStore((s) => s.feed);
  // Model degradation signal (task: "robotic dialogue" and "no model
  // reachable" must stop looking identical to a spectator). No dedicated
  // modelDegraded field crosses the wire yet, so this reads the two swarm
  // telemetry signals that already do: spend.fallbackActive (the spend
  // tracker forcing rule-engine-only, protocol.ts) and the live fallback
  // share of swarm:telemetry decisions (swarmStats, gameStore.ts). Either
  // one degrades gracefully to "not shown" if telemetry hasn't arrived yet.
  const spend = useGameStore((s) => s.spend);
  const swarmStats = useGameStore((s) => s.swarmStats);
  const templatesActive =
    spend?.fallbackActive === true ||
    (swarmStats.calls >= DEGRADED_MIN_SAMPLE &&
      swarmStats.fallback / swarmStats.calls >= DEGRADED_RATIO);

  const groups = useMemo(() => groupFeed(feed), [feed]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Auto-follow the newest line, but only while the viewer is already scrolled
  // to the bottom -- if they've scrolled up to read history, don't yank them.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [feed.length]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  return (
    <div className="pointer-events-auto flex h-full flex-col overflow-hidden rounded-xl border border-white/10 bg-[#12121a]/85 shadow-lg backdrop-blur-sm">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="size-2 animate-pulse rounded-full bg-rose-500" />
        <span className="text-xs font-bold tracking-wide text-zinc-200 uppercase">Island feed</span>
        {templatesActive ? (
          <span
            className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-zinc-700/50 px-2 py-0.5 text-[10px] font-medium text-zinc-300"
            title="No model is currently reachable, so dialogue is running on rule-based templates."
          >
            <Bot className="size-3" />
            Templates
          </span>
        ) : null}
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2 text-sm">
        {feed.length === 0 ? (
          <p className="py-6 text-center text-xs text-zinc-500">
            Quiet on the island... for now.
          </p>
        ) : (
          groups.map((group) =>
            group.kind === "single" ? (
              <Row key={group.entry.id} entry={group.entry} />
            ) : group.entries.length === 1 ? (
              <Row key={group.entries[0]!.id} entry={group.entries[0]!} />
            ) : (
              // An exchange: multiple lines from the same back-and-forth,
              // visually tied together with a rail instead of scrolling by
              // as indistinguishable flat rows.
              <div
                key={group.entries[0]!.id}
                className="flex flex-col gap-1 border-l-2 border-white/10 py-0.5 pl-2"
              >
                {group.entries.map((entry) => (
                  <Row key={entry.id} entry={entry} />
                ))}
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}
