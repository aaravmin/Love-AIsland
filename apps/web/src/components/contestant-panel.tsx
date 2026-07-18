"use client";

import { useState } from "react";
import Link from "next/link";
import { Crosshair, Star, X } from "lucide-react";
import { toast } from "sonner";
import { buyShares, STAT_KEYS, STAT_MAX, winProbabilities, type Class, type Stats } from "@arena/shared";
import { PriceChart } from "@/components/price-chart";
import { selectMyContestantId, useGameStore } from "@/lib/gameStore";
import { outcomePresentation } from "@/lib/outcomes";
import { placeBet } from "@/lib/socket";
import { cn } from "@/lib/utils";

// Detail panel for a clicked islander: who they are, what they're good at
// (stats), how they play (class behavior), their win market with Buy Yes/No,
// and their personal slice of the activity feed. Class and stats are shown as
// two independent things -- stats are capability, class is behavior.

const CLASS_INFO: Record<Class, { label: string; text: string; behavior: string }> = {
  bold: { label: "Bold", text: "text-destructive", behavior: "Seeks fights - hunts the weak" },
  timid: { label: "Timid", text: "text-chart-5", behavior: "Survivor - avoids conflict, lies low" },
  schemer: { label: "Schemer", text: "text-accent", behavior: "Allies up, then betrays" },
  charmer: { label: "Charmer", text: "text-primary", behavior: "Builds big alliances" },
  wildcard: { label: "Wildcard", text: "text-chart-4", behavior: "Unpredictable - even to themselves" },
};

const STAT_LABEL: Record<keyof Stats, string> = {
  charisma: "Charisma",
  cunning: "Cunning",
  grit: "Grit",
  strength: "Strength",
  charm: "Charm",
  instinct: "Instinct",
  resolve: "Resolve",
};

const SPENDS = [5, 10, 25];

function hpColor(frac: number): string {
  if (frac > 0.5) return "bg-emerald-500";
  if (frac > 0.25) return "bg-amber-400";
  return "bg-rose-500";
}

function StatBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] font-medium text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-chart-4"
          style={{ width: `${Math.round((value / STAT_MAX) * 100)}%` }}
        />
      </div>
      <span className="w-4 shrink-0 text-right font-mono text-[11px] font-semibold text-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}

export function ContestantPanel() {
  const id = useGameStore((s) => s.selectedContestantId);
  const contestant = useGameStore((s) => (id ? s.contestants[id] : undefined));
  const market = useGameStore((s) => (id ? s.markets[id] : undefined));
  const allMarkets = useGameStore((s) => s.markets);
  const spectator = useGameStore((s) => s.spectator);
  const phase = useGameStore((s) => s.phase);
  const feed = useGameStore((s) => s.feed);
  const allContestants = useGameStore((s) => s.contestants);
  const close = useGameStore((s) => s.setSelectedContestant);
  // Follow state (user ask 1, first half: "follow your own agent or the
  // agents you invested in"). The panel that is opened by the exact same
  // click path the camera follow reacts to (IslandScene.ts setSelectedContestant)
  // is the natural place to start/stop that follow -- closing the panel
  // already reads as "stop looking at this one".
  const followedContestantId = useGameStore((s) => s.followedContestantId);
  const setFollowed = useGameStore((s) => s.setFollowedContestantId);
  const myContestantId = useGameStore(selectMyContestantId);

  const [spend, setSpend] = useState(10);
  const [pending, setPending] = useState(false);
  // Two-step confirm: a buy button click only stages a side here; the actual
  // placeBet call happens from the confirm row below.
  // The pending confirm is bound to a contestant id, so selecting a different
  // islander automatically drops any half-made bet without a reset effect.
  const [confirm, setConfirm] = useState<{ id: string; side: "yes" | "no" } | null>(null);

  if (!id || !contestant) return null;

  const confirmSide = confirm && confirm.id === id ? confirm.side : null;
  // Identity-checked (not string-compared against a public display name) --
  // ownerName alone can't tell two same-named owners apart or tell the
  // viewer's OWN islander from someone else's, which is what this panel used
  // to rely on.
  const isMine = myContestantId !== null && myContestantId === id;
  const isFollowing = followedContestantId === id;

  const info = CLASS_INFO[contestant.klass];
  const hpFrac = contestant.maxHp > 0 ? Math.max(0, contestant.hp) / contestant.maxHp : 0;
  const position = spectator?.positions.find((p) => p.contestantId === id);
  const canBet =
    !!spectator && !!market && !market.settled && contestant.alive && phase !== "settled";
  // Normalized "chance to win the whole game" for THIS islander: their raw
  // priceYes divided by the sum across all living, unsettled markets, so the
  // headline and payout multiplier are coherent with the rest of the board and
  // re-derive on every price change. The lose ("No") side is 1 - winProb.
  const winProb =
    market && contestant.alive && !market.settled
      ? (winProbabilities(
          Object.values(allMarkets)
            .filter((m) => !m.settled && allContestants[m.contestantId]?.alive)
            .map((m) => ({ id: m.contestantId, priceYes: m.priceYes })),
        ).get(id) ?? market.priceYes)
      : market
        ? market.priceYes
        : 0;
  // Headline only: the normalized "chance to win the whole game" as a percent.
  const yesCents = market ? Math.round(winProb * 100) : 0;
  // Real tradeable payout for the current stake, straight from the raw LMSR:
  // buyShares returns the exact shares you receive, and each share pays out 1
  // token if that side wins. So the TOTAL you get back is the share count, and
  // the multiplier is simply payout / stake -- both come from the same number,
  // so "7.3x" and "get 73" always reconcile on the button. (The normalized
  // headline % above is a separate cross-field probability, not this payout.)
  const yesShares = market ? buyShares(market.qYes, market.qNo, "yes", spend).shares : 0;
  const noShares = market ? buyShares(market.qYes, market.qNo, "no", spend).shares : 0;
  const yesMultiplier = market && spend > 0 ? `${(yesShares / spend).toFixed(1)}x` : "-";
  const noMultiplier = market && spend > 0 ? `${(noShares / spend).toFixed(1)}x` : "-";
  // Total payout if you win = the full share count (raw LMSR, not the
  // normalized display %), since each share pays out 1 token. This is what
  // you get back in total, not just the profit -- spelling that out is the
  // whole point of this display pass.
  const yesPayout = Math.round(yesShares);
  const noPayout = Math.round(noShares);
  const confirmPayout = confirmSide === "yes" ? yesPayout : noPayout;
  // Already holding the opposite side blocks the other button -- the server
  // rejects this as "oppositeSide" anyway, but disabling it up front avoids
  // the round trip.
  const hasYesPosition = !!position && position.yesShares > 0;
  const hasNoPosition = !!position && position.noShares > 0;
  // Full per-islander history, oldest first (newest last) -- persists after
  // death since the feed itself never drops entries.
  const myFeed = feed.filter((e) => e.contestantIds.includes(id));

  async function bet(side: "yes" | "no") {
    if (!spectator) return;
    if (spectator.tokens < spend) {
      toast.error("Not enough tokens.");
      return;
    }
    setPending(true);
    try {
      const ack = await placeBet(id!, side, spend);
      if (!ack.ok) {
        const msg =
          ack.reason === "insufficient"
            ? "Not enough tokens."
            : ack.reason === "settled"
              ? "This market has settled."
              : ack.reason === "capExceeded"
                ? "Bets are capped at 25 tokens."
                : ack.reason === "oppositeSide"
                  ? "You can't bet both sides of one market."
                  : "Betting isn't open.";
        toast.error(msg);
      }
    } catch {
      toast.error("Couldn't reach the island.");
    } finally {
      setPending(false);
      setConfirm(null);
    }
  }

  function selectSide(side: "yes" | "no") {
    setConfirm({ id: id!, side });
  }

  function confirmBet() {
    if (!confirmSide) return;
    void bet(confirmSide);
  }

  return (
    <div className="absolute top-16 left-4 z-30 flex max-h-[calc(100%-5rem)] w-72 flex-col">
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="min-w-0 truncate text-base font-bold text-foreground">
                {contestant.name}
              </p>
              {isMine ? (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold text-primary"
                  title="This is your islander"
                >
                  <Star className="size-2.5 fill-current" />
                  Yours
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              <span className={cn("font-semibold", info.text)}>{info.label}</span>
              {" · owned by "}
              <span className="font-medium text-foreground">
                {isMine ? "you" : contestant.ownerName}
              </span>
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground italic">{info.behavior}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* Follow toggle: same size/position in both states so nothing
                reflows when it's pressed -- only the icon's fill and the
                button's background change. */}
            <button
              onClick={() => setFollowed(isFollowing ? null : id)}
              aria-pressed={isFollowing}
              aria-label={isFollowing ? "Stop following" : "Follow this islander"}
              title={isFollowing ? "Stop following" : "Follow this islander"}
              className={cn(
                "rounded-md p-1 transition-colors",
                isFollowing
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Crosshair className="size-4" />
            </button>
            <button
              onClick={() => close(null)}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* One-tap jump to the viewer's own islander + start following it in
            the same gesture -- the panel only knows how to show ONE
            contestant at a time, so this is the shortest path from "looking
            at someone else" to "watching mine". Hidden once it IS mine. */}
        {myContestantId && !isMine ? (
          <button
            onClick={() => {
              close(myContestantId);
              setFollowed(myContestantId);
            }}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 py-1.5 text-xs font-bold text-primary transition-colors hover:bg-primary/20"
          >
            <Crosshair className="size-3.5" />
            Follow my islander
          </button>
        ) : null}

        <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase">Kills</span>
          <span className="font-heading text-2xl font-extrabold tabular-nums text-foreground">
            {contestant.kills}
          </span>
        </div>

        {contestant.alive ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase">Health</span>
              <span className="font-mono text-xs font-semibold text-foreground tabular-nums">
                {Math.max(0, Math.round(contestant.hp))}/{contestant.maxHp}
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full transition-all", hpColor(hpFrac))}
                style={{ width: `${Math.round(hpFrac * 100)}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-center text-sm font-bold text-rose-400">
            Eliminated{contestant.deathIndex !== null ? ` · #${contestant.deathIndex + 1} out` : ""}
          </div>
        )}

        {/* Stats: what they're good at (independent of class/behavior). */}
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <span className="text-[11px] font-semibold text-muted-foreground uppercase">Stats</span>
          {STAT_KEYS.map((key) => (
            <StatBar key={key} label={STAT_LABEL[key]} value={contestant.stats[key]} />
          ))}
        </div>

        {/* Who this islander has allied with. */}
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <span className="text-[11px] font-semibold text-muted-foreground uppercase">Allies</span>
          {contestant.allies.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">None yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {contestant.allies.map((allyId) => (
                <span
                  key={allyId}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
                >
                  {allContestants[allyId]?.name ?? "Unknown"}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Win market + betting (Kalshi-style prices, Polymarket-style chart). */}
        {market ? (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase">
                {market.settled ? "Settled" : "Chance to win"}
              </p>
              <p
                className={cn(
                  "font-heading text-2xl font-extrabold tabular-nums",
                  market.settled
                    ? market.settledOutcome === "yes"
                      ? "text-emerald-400"
                      : "text-rose-400"
                    : "text-foreground",
                )}
              >
                {market.settled ? (market.settledOutcome === "yes" ? "WON" : "OUT") : `${yesCents}%`}
              </p>
            </div>

            <PriceChart points={market.sparkline} className="text-foreground" />

            {canBet ? (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground">Stake</span>
                  {SPENDS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setSpend(s)}
                      className={cn(
                        "flex-1 rounded-md border py-1 text-xs font-bold tabular-nums transition-colors",
                        spend === s
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                {confirmSide ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted px-3 py-2">
                    <p className="text-xs font-medium text-foreground">
                      Confirm: bet {spend} on{" "}
                      <span
                        className={cn(
                          "font-semibold",
                          confirmSide === "yes" ? "text-emerald-400" : "text-rose-400",
                        )}
                      >
                        {confirmSide === "yes" ? "Yes" : "No"}
                      </span>{" "}
                      → get <span className="font-semibold text-foreground">{confirmPayout}</span>{" "}
                      back if they {confirmSide === "yes" ? "win" : "lose"}
                    </p>
                    <div className="flex gap-2">
                      <button
                        disabled={pending}
                        onClick={confirmBet}
                        className="flex-1 rounded-lg bg-primary py-1.5 text-xs font-bold text-primary-foreground transition-colors disabled:opacity-50"
                      >
                        Confirm
                      </button>
                      <button
                        disabled={pending}
                        onClick={() => setConfirm(null)}
                        className="flex-1 rounded-lg border border-border py-1.5 text-xs font-bold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      disabled={pending || hasNoPosition}
                      onClick={() => selectSide("yes")}
                      className="flex flex-1 flex-col items-center rounded-lg bg-emerald-500/15 py-2 font-bold text-emerald-300 ring-1 ring-emerald-500/40 transition-colors hover:bg-emerald-500/25 disabled:opacity-50"
                    >
                      <span className="flex items-center gap-1.5 text-sm">
                        Yes
                        <span className="font-mono text-[11px] font-bold text-emerald-400/90 tabular-nums">
                          {yesMultiplier}
                        </span>
                      </span>
                      <span className="text-[11px] font-semibold text-emerald-400/90 tabular-nums">
                        Bet {spend} → get {yesPayout}
                      </span>
                    </button>
                    <button
                      disabled={pending || hasYesPosition}
                      onClick={() => selectSide("no")}
                      className="flex flex-1 flex-col items-center rounded-lg bg-rose-500/15 py-2 font-bold text-rose-300 ring-1 ring-rose-500/40 transition-colors hover:bg-rose-500/25 disabled:opacity-50"
                    >
                      <span className="flex items-center gap-1.5 text-sm">
                        No
                        <span className="font-mono text-[11px] font-bold text-rose-400/90 tabular-nums">
                          {noMultiplier}
                        </span>
                      </span>
                      <span className="text-[11px] font-semibold text-rose-400/90 tabular-nums">
                        Bet {spend} → get {noPayout}
                      </span>
                    </button>
                  </div>
                )}
              </>
            ) : !spectator ? (
              <Link
                href="/join"
                className="rounded-lg bg-primary py-2 text-center text-sm font-bold text-primary-foreground"
              >
                Join to bet
              </Link>
            ) : null}

            {position && (position.yesShares > 0 || position.noShares > 0) ? (
              <div className="rounded-lg bg-muted px-3 py-2 text-xs">
                <p className="font-semibold text-muted-foreground uppercase">Your position</p>
                {position.yesShares > 0 ? (
                  <p className="text-foreground">
                    {position.yesShares.toFixed(1)} Yes shares · pays{" "}
                    <span className="font-semibold text-emerald-400">{Math.round(position.yesShares)}</span> if they win · spent{" "}
                    {Math.round(position.yesSpent)}
                  </p>
                ) : null}
                {position.noShares > 0 ? (
                  <p className="text-foreground">
                    {position.noShares.toFixed(1)} No shares · pays{" "}
                    <span className="font-semibold text-rose-400">{Math.round(position.noShares)}</span> if they lose · spent{" "}
                    {Math.round(position.noSpent)}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* This islander's full interaction history -- persists after death. */}
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <span className="text-[11px] font-semibold text-muted-foreground uppercase">Feed</span>
          {myFeed.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">Nothing yet.</p>
          ) : (
            <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {myFeed.map((e) => (
                <p key={e.id} className="text-xs leading-snug text-foreground/80">
                  {e.kind === "conv" ? (
                    <>
                      <span className="font-semibold text-foreground">{e.speaker}:</span> {e.text}
                    </>
                  ) : e.kind === "outcome" ? (
                    // Same glyph the activity feed and the transcript panel use
                    // (outcomes.ts) so an outcome doesn't read three different
                    // ways across the app -- truce keeps its dove here too, it
                    // just no longer pops a NOTABLE badge on the island itself.
                    <>
                      {e.outcome ? `${outcomePresentation(e.outcome).icon} ` : ""}
                      {e.text}
                    </>
                  ) : (
                    e.text
                  )}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
