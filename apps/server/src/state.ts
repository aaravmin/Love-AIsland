import { tunables } from "@arena/shared";
import { runSeed } from "./social.js";
import type {
  Contestant,
  GameState,
  Market,
  MarketPublic,
  PrivateSpectator,
  PublicContestant,
  Snapshot,
  Spectator,
} from "@arena/shared";

// The single in-memory game (locked decision 12: exactly one concurrent
// session). Everything mutates this object between ticks; reset swaps it
// for a pristine one.
export function createGameState(): GameState {
  return {
    phase: "lobby",
    startedAt: null,
    autoStartAt: null,
    timeline: null,
    contestants: {},
    conversations: {},
    markets: {},
    positions: [],
    trades: [],
    spectators: {},
    events: [],
    deathOrder: [],
    hostile: { active: false, startedAt: null, fullDecayAt: null },
    spend: {
      estimatedUsd: 0,
      capUsd: 10,
      softThrottleUsd: 8,
      fallbackActive: false,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    },
    winnerContestantId: null,
    winnerPortfolioId: null,
  };
}

export let state: GameState = createGameState();

export function replaceState(next: GameState): void {
  state = next;
}

export function aliveCount(): number {
  let n = 0;
  for (const c of Object.values(state.contestants)) if (c.alive) n++;
  return n;
}

export function spectatorByClientId(clientId: string): Spectator | undefined {
  return Object.values(state.spectators).find((s) => s.clientId === clientId);
}

// A contestant this client owns in the current room, if any (used to hide the
// join CTA once they're at the room's per-person limit).
export function ownedContestantId(clientId: string): string | null {
  if (!clientId) return null;
  const owned = Object.values(state.contestants).find((c) => c.ownerClientId === clientId);
  return owned ? owned.id : null;
}

// How many islanders this client owns in the current room (enforced against the
// room's agentsPerPerson in the create handler).
export function ownedContestantCount(clientId: string): number {
  if (!clientId) return 0;
  let n = 0;
  for (const c of Object.values(state.contestants)) if (c.ownerClientId === clientId) n++;
  return n;
}

// The ONLY contestant shape that crosses the socket (DATA_MODELS.md).
export function toPublicContestant(c: Contestant): PublicContestant {
  const { ownerPhone, ownerClientId, memory, nextThinkAt, ...pub } = c;
  void ownerPhone;
  void ownerClientId;
  void memory;
  void nextThinkAt;
  return pub;
}

export function priceYes(m: Market): number {
  return 1 / (1 + Math.exp((m.qNo - m.qYes) / m.b));
}

const SPARKLINE_POINTS = 60;

export function toMarketPublic(m: Market): MarketPublic {
  // Downsample priceHistory to ~60 evenly spaced points (snapshot only;
  // live updates ride the tick diff).
  const h = m.priceHistory;
  const stride = Math.max(1, Math.ceil(h.length / SPARKLINE_POINTS));
  const sparkline: [number, number][] = [];
  for (let i = 0; i < h.length; i += stride) {
    const p = h[i]!;
    sparkline.push([p.t, p.price]);
  }
  const last = h[h.length - 1];
  if (last && sparkline[sparkline.length - 1]?.[0] !== last.t) {
    sparkline.push([last.t, last.price]);
  }
  return {
    contestantId: m.contestantId,
    qYes: m.qYes,
    qNo: m.qNo,
    b: m.b,
    priceYes: priceYes(m),
    settled: m.settled,
    settledOutcome: m.settledOutcome,
    sparkline,
  };
}

export function toPrivateSpectator(s: Spectator, agentsPerPerson = 1): PrivateSpectator {
  const owned = ownedContestantCount(s.clientId);
  return {
    id: s.id,
    name: s.name,
    tokens: s.tokens,
    positions: state.positions.filter((p) => p.spectatorId === s.id),
    ownedContestantId: ownedContestantId(s.clientId),
    // How many more islanders this person may create in this room; the client
    // hides the join CTA at 0.
    agentsRemaining: Math.max(0, agentsPerPerson - owned),
    // Whether they've opted in to SMS portfolio alerts (drives the toggle).
    notify: s.notify,
  };
}

// Full public state plus, when the caller is a known spectator, their private
// balance and positions (tokens 0 / positions [] otherwise; the client keys
// off `spectator` in the hello ack, not these fields).
export function assembleSnapshot(spectator: Spectator | null, room: Snapshot["room"]): Snapshot {
  return {
    phase: state.phase,
    room,
    startedAt: state.startedAt,
    autoStartAt: state.autoStartAt,
    timeline: state.timeline,
    contestants: Object.values(state.contestants).map(toPublicContestant),
    markets: Object.values(state.markets).map(toMarketPublic),
    activeConversations: Object.values(state.conversations)
      .filter((c) => c.endedAt === null)
      .map((c) => ({
        id: c.id,
        participantIds: c.participants,
        startedAt: c.startedAt,
      })),
    events: state.events,
    hostile: state.hostile,
    spend: state.spend,
    deathOrder: state.deathOrder,
    winnerContestantId: state.winnerContestantId,
    tokens: spectator?.tokens ?? 0,
    positions: spectator
      ? state.positions.filter((p) => p.spectatorId === spectator.id)
      : [],
    // Publish the resolved flags so the client renders the behavior the server
    // is actually running, rather than guessing from its own build-time env.
    flags: tunables.flags,
    // The run's seed, per spec line 214. Every new behavior draws from the
    // seeded RNG in social.ts rather than Math.random, so publishing the seed
    // is what makes a run reproducible for debugging and makes the betting
    // auditable: a spectator can show that the run they bet on replays to the
    // same outcome. Read live rather than captured, because the active room's
    // social state is swapped on reset and a captured value would report a
    // finished run's seed for the run that replaced it.
    seed: runSeed(),
  };
}
