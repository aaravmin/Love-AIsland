import { randomUUID } from "node:crypto";
import type { Contestant, GameResultsPayload } from "@arena/shared";
import { settleMarketYes } from "./market.js";
import { notifyPayout } from "./notify.js";
import type { Room } from "./rooms.js";
import { aliveCount, priceYes, state } from "./state.js";
import type { ArenaServer } from "./io.js";

// Lobby -> running -> settled (ARCHITECTURE.md 6.8). Reset is a transition
// back to a fresh lobby, implemented in admin.ts.

export const AUTO_START_CONTESTANTS = 10;
export const AUTO_START_DELAY_MS = 90_000;
export const MAX_CONTESTANTS = 50;
// Bounds in-memory spectator growth: a client cycling clientIds could
// otherwise mint unbounded Spectator objects (memory-exhaustion DoS). Far
// above any real audience for one game session.
export const MAX_SPECTATORS = 2000;

// Late contestant joins close at purgeAt - 60s: a fresh contestant walking
// into the Purge with 0 kills would be dead on arrival. If a room has no purge
// (eventCount 0) joins stay open until hostile mode.
const LATE_JOIN_CUTOFF_BEFORE_PURGE_MS = 60_000;

// A room's timeline is derived from its configured length: the Purge and
// Weakest Link land at ~1/3 and ~2/3, hostile mode at ~5/6 of the run. The MAIN
// room (20 min, 2 events) matches the original ~6/12/16.7 schedule.
function timelineFor(now: number, lengthMinutes: number): { purgeAt: number; weakestLinkAt: number; hostileAt: number } {
  const run = lengthMinutes * 60_000;
  return {
    purgeAt: now + Math.round(run / 3),
    weakestLinkAt: now + Math.round((run * 2) / 3),
    hostileAt: now + Math.round((run * 5) / 6),
  };
}

export function joinsOpen(now: number): boolean {
  if (state.phase === "lobby") return true;
  if (state.phase !== "running" || !state.timeline) return false;
  return now < state.timeline.purgeAt - LATE_JOIN_CUTOFF_BEFORE_PURGE_MS;
}

function broadcastPhase(io: ArenaServer): void {
  io.emit("game:phase", {
    phase: state.phase,
    startedAt: state.startedAt,
    autoStartAt: state.autoStartAt,
    ...(state.timeline ? { timeline: state.timeline } : {}),
  });
}

// Called after every contestant creation. Only the MAIN (hackathon) room
// auto-starts; friend rooms are started by their host.
export function maybeScheduleAutoStart(io: ArenaServer, now: number, room: Room): void {
  if (!room.isMain) return;
  if (state.phase !== "lobby") return;
  if (state.autoStartAt !== null) return;
  if (Object.keys(state.contestants).length < AUTO_START_CONTESTANTS) return;
  state.autoStartAt = now + AUTO_START_DELAY_MS;
  broadcastPhase(io);
}

export function startGame(io: ArenaServer, now: number, room: Room): boolean {
  if (state.phase !== "lobby") return false;
  state.phase = "running";
  state.startedAt = now;
  state.autoStartAt = null;
  const timeline = timelineFor(now, room.config.lengthMinutes);
  state.timeline = timeline;
  // The room's eventCount decides which of the two scheduled events run (Purge
  // first, then Weakest Link). 0 = none (just the hostile forcer).
  const events = [];
  if (room.config.eventCount >= 1) {
    events.push({
      id: randomUUID(),
      kind: "purge" as const,
      scheduledAt: timeline.purgeAt,
      countdownStartedAt: null,
      firedAt: null,
      eliminatedIds: [],
      resolved: false,
    });
  }
  if (room.config.eventCount >= 2) {
    events.push({
      id: randomUUID(),
      kind: "weakestLink" as const,
      scheduledAt: timeline.weakestLinkAt,
      countdownStartedAt: null,
      firedAt: null,
      eliminatedIds: [],
      resolved: false,
    });
  }
  state.events = events;
  broadcastPhase(io);
  return true;
}

// Step 1 of every tick: auto-start countdown and endgame detection. Called per
// room (the caller has activated it).
export function tickLifecycle(io: ArenaServer, now: number, room: Room): void {
  if (state.phase === "lobby" && state.autoStartAt !== null && now >= state.autoStartAt) {
    startGame(io, now, room);
    return;
  }
  if (
    state.phase === "running" &&
    Object.keys(state.contestants).length > 1 &&
    aliveCount() === 1
  ) {
    // Endgame (task 8.1): freeze the sim, settle the winner's market Yes (which
    // redeems every winning Yes position), then broadcast the results payload.
    // The phase flip is the input freeze -- movement/combat/events are all
    // gated on `running`, and bet:place rejects once settled.
    state.phase = "settled";
    const winner = Object.values(state.contestants).find((c) => c.alive) ?? null;
    state.winnerContestantId = winner?.id ?? null;
    if (winner) {
      settleMarketYes(io, winner.id);
      const results = buildResults(winner);
      state.winnerPortfolioId = results.winnerPortfolio.spectatorId || null;
      io.emit("game:results", results);
      // Rich SMS (WS-G/WS-H): the moment a user most wants a text and, before
      // this, the only outcome the whole game produced with no SMS at all.
      // Uses the exact spent/net figures buildResults just computed and
      // broadcast, so the text can never disagree with what the results
      // screen shows.
      notifyPayoutsForResults(now, winner);
    }
    broadcastPhase(io);
  }
}

// Fires the end-of-game payout SMS to every opted-in spectator (task 2 of the
// user's ask: rich SMS about the game's outcome for their money). Recomputes
// spent/net per spectator the same way buildResults does rather than trusting
// GameResultsPayload's payouts array, which carries only a display name (not
// unique, and not keyed by spectator id) -- recomputing from
// state.positions/state.spectators directly is what guarantees the number in
// the text always matches the number buildResults just broadcast.
function notifyPayoutsForResults(now: number, winner: Contestant): void {
  for (const spec of Object.values(state.spectators)) {
    if (!spec.notify || !spec.phone) continue;
    const spent = state.positions
      .filter((p) => p.spectatorId === spec.id)
      .reduce((sum, p) => sum + p.yesSpent + p.noSpent, 0);
    const net = Math.round(spec.tokens) - 50;
    const isOwner = winner.ownerClientId === spec.clientId;
    notifyPayout(spec.phone, now, { winnerName: winner.name, isOwner, spent, net }, spec);
  }
}

// A short, in-character one-liner about the winner for the winner screen. Draws
// from templates keyed to their journey -- a ruthless killer, a scheming manip-
// ulator, a lucky timid survivor -- then picks one at random so replays vary.
function winnerQuip(winner: Contestant): string {
  const name = winner.name;
  const kills = winner.kills;
  const templates: string[] = [];
  if (kills >= 3) {
    templates.push(`${name} carved through the island and left ${kills} bodies in the sand.`);
    templates.push(`${name} turned the whole season into a highlight reel of ${kills} eliminations.`);
  }
  if (winner.klass === "bold") {
    templates.push(`${name} never backed down from a fight and swung their way to the crown.`);
  }
  if (winner.klass === "schemer") {
    templates.push(`${name} smiled, allied, and betrayed every last one of them to win.`);
  }
  if (winner.klass === "charmer") {
    templates.push(`${name} charmed the entire island and walked out without a scratch.`);
  }
  if (winner.klass === "timid" || kills === 0) {
    templates.push(`${name} kept their head down and outlasted everyone who tried to play hero.`);
    templates.push(`${name} barely threw a punch and somehow that was the winning move.`);
  }
  // Always-available fallbacks so every class and stat line has options.
  templates.push(`${name} is the last one standing on the island.`);
  templates.push(`Against all the odds, ${name} took the whole thing.`);
  return templates[Math.floor(Math.random() * templates.length)]!;
}

// Assembles the end-of-game results (task 8.1): the surviving islander and its
// owner, a quip, the spectator whose betting portfolio finished richest, the
// token leaderboard, per-bettor payouts, and a few recap stats. Runs once, after
// the winner's market has settled Yes so final balances are already credited.
function buildResults(winner: Contestant): GameResultsPayload {
  const specs = Object.values(state.spectators).sort((a, b) => b.tokens - a.tokens);
  const top = specs[0];
  const leaderboard = specs.slice(0, 10).map((s) => ({ name: s.name, tokens: Math.round(s.tokens) }));

  // Every bettor's final payout: total staked across their positions, and net
  // vs the 50 tokens they started with. Sorted best net first.
  const payouts = Object.values(state.spectators)
    .map((s) => {
      const spent = state.positions
        .filter((p) => p.spectatorId === s.id)
        .reduce((sum, p) => sum + p.yesSpent + p.noSpent, 0);
      return { name: s.name, spent, net: Math.round(s.tokens) - 50 };
    })
    .sort((a, b) => b.net - a.net);

  // "Biggest upset": how far down the winner traded before coming back. The
  // lower their market ever dipped, the bigger the comeback.
  const wm = state.markets[winner.id];
  const prices = wm ? wm.priceHistory.map((p) => p.price) : [];
  const lowest = prices.length > 0 ? Math.min(...prices, wm ? priceYes(wm) : 1) : 1;
  const biggestUpset =
    prices.length > 0
      ? `${winner.name} won after trading as low as ${Math.round(lowest * 100)}%`
      : `${winner.name} took the crown`;

  return {
    winnerContestantId: winner.id,
    winnerName: winner.name,
    winnerOwnerName: winner.ownerName,
    quip: winnerQuip(winner),
    winnerPortfolio: top
      ? { spectatorId: top.id, name: top.name, tokens: Math.round(top.tokens) }
      : { spectatorId: "", name: "-", tokens: 0 },
    leaderboard,
    payouts,
    recap: {
      totalDeaths: state.deathOrder.length,
      totalBets: state.trades.length,
      biggestUpset,
    },
  };
}
