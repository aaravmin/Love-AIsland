"use client";

import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { Tone } from "@arena/shared";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { type ClientConversation, useGameStore } from "@/lib/gameStore";
import { outcomePresentation } from "@/lib/outcomes";
import { cn } from "@/lib/utils";

// Click-only transcript panel: shows the ONE conversation a viewer clicked an
// interaction marker for (store.openConversationId), never the "most active"
// one auto-picked. It renders nothing until a marker click sets that id, and
// the X button clears it back to null -- so this panel never pops on its own.
//
// Once opened, a viewer can swipe (or use the chevrons) to page through the
// retained conversationHistory ring (spec line 198, "swipe to view past
// conversations") without re-clicking a marker for each one. This never
// changes when the panel FIRST appears -- only what it shows once it's open.

const TONE_CLASS: Record<Tone, string> = {
  friendly: "text-emerald-400",
  hostile: "text-rose-400",
  deceptive: "text-fuchsia-400",
  neutral: "text-foreground/80",
};

// Horizontal drag distance (px) that counts as a swipe rather than a tap/scroll.
const SWIPE_THRESHOLD = 48;

export function ConversationPanel() {
  const openId = useGameStore((s) => s.openConversationId);
  const conversations = useGameStore((s) => s.conversations);
  const conversationHistory = useGameStore((s) => s.conversationHistory);
  const contestants = useGameStore((s) => s.contestants);
  const setOpenConversation = useGameStore((s) => s.setOpenConversation);

  // Which conversation is on screen while browsing, independent of the store's
  // openConversationId -- swiping must not fight the live socket layer, which
  // only ever knows about the ONE conversation a marker click opened. Reset to
  // "follow the live one" whenever a fresh marker click changes openId, so
  // browsing never leaks from one clicked conversation into the next.
  const [manualId, setManualId] = useState<string | null>(null);
  // Adjust state during render rather than in an effect (React's recommended
  // pattern for "reset a piece of state when a prop changes") -- a fresh
  // marker click landing a new openId resets any in-progress swipe browsing
  // without an extra post-render effect pass.
  const [prevOpenId, setPrevOpenId] = useState(openId);
  if (openId !== prevOpenId) {
    setPrevOpenId(openId);
    setManualId(null);
  }

  // The full browsable timeline: retained history (already chronological,
  // oldest first) plus whatever is currently live and hasn't been pruned into
  // that history yet. History is capped and gated on flags.conversationHistory
  // (gameStore.ts) so with that flag off this list degrades to just the live
  // conversation, matching today's behavior exactly.
  const timeline = useMemo(() => {
    const historyIds = new Set(conversationHistory.map((c) => c.id));
    const live = Object.values(conversations).filter((c) => !historyIds.has(c.id));
    return [...conversationHistory, ...live];
  }, [conversationHistory, conversations]);

  const activeId = manualId ?? openId;
  const conv: ClientConversation | null =
    (activeId &&
      (conversations[activeId] ?? conversationHistory.find((c) => c.id === activeId))) ||
    null;

  // Gate stays on openId, never on manualId: a marker click is the only thing
  // allowed to make this panel appear on its own, exactly as before.
  if (!openId || !conv) return null;

  const idx = timeline.findIndex((c) => c.id === conv.id);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < timeline.length - 1;

  function goPrev() {
    if (idx > 0) setManualId(timeline[idx - 1]!.id);
  }
  function goNext() {
    if (idx >= 0 && idx < timeline.length - 1) setManualId(timeline[idx + 1]!.id);
  }

  const nameOf = (id: string) => contestants[id]?.name ?? "Someone";
  const [aId, bId] = conv.participantIds;
  const header = outcomePresentation(conv.outcome);

  return (
    <PointerSwipe onSwipeLeft={goNext} onSwipeRight={goPrev}>
      <div className="absolute bottom-4 left-4 z-20 w-[min(20rem,calc(100%-2rem))] md:bottom-4">
        <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card/95 shadow-lg backdrop-blur">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold",
                  header.badgeClass,
                )}
              >
                {header.icon} {header.label}
              </span>
              <span className="min-w-0 truncate text-sm font-semibold text-foreground">
                {nameOf(aId ?? "")} &amp; {nameOf(bId ?? "")}
              </span>
            </div>
            <button
              onClick={() => setOpenConversation(null)}
              aria-label="Close conversation"
              className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="flex max-h-52 flex-col gap-2 overflow-y-auto px-3 py-2.5">
            {conv.messages.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Sizing each other up...</p>
            ) : (
              conv.messages.map((m, i) => (
                <div key={i} className="flex flex-col gap-0.5">
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase">
                    {nameOf(m.speakerId)}
                  </span>
                  <span className={cn("text-sm leading-snug", TONE_CLASS[m.tone])}>
                    &ldquo;{m.text}&rdquo;
                  </span>
                </div>
              ))
            )}
          </div>
          {timeline.length > 1 ? (
            <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-1.5">
              <button
                onClick={goPrev}
                disabled={!canPrev}
                aria-label="Previous conversation"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                {idx + 1} / {timeline.length}
              </span>
              <button
                onClick={goNext}
                disabled={!canNext}
                aria-label="Next conversation"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </PointerSwipe>
  );
}

// Minimal horizontal swipe detector via pointer events -- the repo's only
// existing swipe implementation is the Base UI drawer primitive
// (components/ui/drawer.tsx), which is a modal bottom/side sheet with its own
// portal, overlay, and snap-point machinery; wrapping this small, always-
// mounted, non-modal panel in that would pull in a second surface it doesn't
// want just to borrow a drag listener. Pointer events (not touch-only) so it
// works with mouse drags in desktop dev/testing too.
function PointerSwipe({
  onSwipeLeft,
  onSwipeRight,
  children,
}: {
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  children: ReactNode;
}) {
  const start = useRef<{ x: number; y: number; active: boolean } | null>(null);

  function onPointerDown(e: ReactPointerEvent) {
    start.current = { x: e.clientX, y: e.clientY, active: true };
  }
  function onPointerUp(e: ReactPointerEvent) {
    const s = start.current;
    start.current = null;
    if (!s?.active) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    // Require the drag to be mostly horizontal so a vertical scroll through
    // the transcript body never gets misread as a page-through swipe.
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) onSwipeLeft();
    else onSwipeRight();
  }
  function onPointerCancel() {
    start.current = null;
  }

  return (
    <div onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
      {children}
    </div>
  );
}
