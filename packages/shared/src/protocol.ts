import type {
  Class,
  Conversation,
  Stats,
  PublicContestant,
  Position,
  GameEvent,
  HostileState,
  SpendState,
  Tone,
} from "./types.js";
import type { Tunables } from "./tunables.js";

// Client-to-server event payloads and acks

export type HelloPayload = {
  clientId: string;
};

export type HelloAck = {
  ok: boolean;
  spectator: PrivateSpectator | null;
  snapshot: Snapshot;
};

export type SpectatorJoinPayload = {
  clientId: string;
  name: string;
  phone: string;
};

export type SpectatorJoinAck = {
  ok: boolean;
  spectator: PrivateSpectator;
  snapshot: Snapshot;
};

export type ContestantCreatePayload = {
  clientId: string;
  name: string;
  klass: Class;
  stats: Stats;
  persona: string;
};

export type ContestantCreateAck =
  | { ok: true; contestant: PublicContestant }
  | { ok: false; error: string };

export type BetPlacePayload = {
  betId: string;
  contestantId: string;
  side: "yes" | "no";
  spend: number;
};

export type BetPlaceAckSuccess = {
  ok: true;
  betId: string;
  shares: number;
  cost: number;
  newBalance: number;
  market: { qYes: number; qNo: number; priceYes: number };
};

export type BetPlaceAckFailure = {
  ok: false;
  betId: string;
  reason: "insufficient" | "settled" | "capExceeded" | "phase" | "oppositeSide";
};

export type BetPlaceAck = BetPlaceAckSuccess | BetPlaceAckFailure;

export type AdminCmdPayload = {
  key: string;
  cmd:
    | "start"
    | "reset"
    | "forceEvent"
    | "forceEndgame"
    | "forceConversation"
    | "forceFallback"
    | "seed"
    | "countdown"
    | "armEvent"
    | "setLength"
    | "forceVote";
  // Which room the command targets; defaults to the MAIN room when omitted.
  room?: string;
  // `seed`: how many house islanders to add. `countdown`: seconds until the
  // game auto-starts. `armEvent`: which event to arm + seconds until it fires.
  // `setLength`: the game length in minutes (uses `minutes`).
  count?: number;
  seconds?: number;
  minutes?: number;
  eventKind?: "purge" | "weakestLink";
  arg?: unknown;
};

export type AdminCmdAck = {
  ok: boolean;
};

// Server-to-client tick diff

// Fast-clock cadence (ARCHITECTURE.md section 4). Shared because the client's
// interpolation buffer renders ~2 ticks behind real time.
export const TICK_MS = 150;

export type TickDiff = {
  t: number;
  seq: number;
  moves?: [id: string, x: number, y: number][];
  hp?: [id: string, hp: number][];
  prices?: [contestantId: string, priceYes: number][];
  regenFactor?: number;
};

// Supporting types for snapshot

export type MarketPublic = {
  contestantId: string;
  qYes: number;
  qNo: number;
  b: number;
  priceYes: number;
  settled: boolean;
  settledOutcome: "yes" | "no" | null;
  sparkline: [t: number, price: number][];
};

export type PrivateSpectator = {
  id: string;
  name: string;
  tokens: number;
  positions: Position[];
  // An islander this person owns in the current room, or null.
  ownedContestantId: string | null;
  // How many more islanders they may create in this room (room agentsPerPerson
  // minus what they own); the client hides the join CTA at 0.
  agentsRemaining: number;
  // Whether they've opted in to SMS portfolio updates (drives the toggle).
  notify: boolean;
};

// ---- Multi-room (Phase 9) --------------------------------------------------

export type RoomConfig = {
  agentsPerPerson: number;
  lengthMinutes: number;
  eventCount: number;
};

export type RoomMeta = {
  code: string;
  name: string;
  isMain: boolean;
  config: RoomConfig;
};

export type RoomInfo = RoomMeta & {
  phase: "lobby" | "running" | "settled";
  islanders: number;
  spectators: number;
  // When an auto-start countdown is armed (lobby only), the epoch ms it fires;
  // null otherwise. Lets the operator console show a room's armed countdown.
  autoStartAt: number | null;
};

export type RoomCreatePayload = { clientId: string; name: string; config: RoomConfig };
export type RoomJoinPayload = { clientId: string; code: string };
export type RoomStartPayload = { clientId: string };
// Toggle SMS portfolio updates for this person (default off).
export type NotifPrefPayload = { clientId: string; on: boolean };

export type RoomEnterAck =
  | { ok: true; snapshot: Snapshot; spectator: PrivateSpectator | null }
  | { ok: false; error: string };
export type RoomListAck = { rooms: RoomInfo[] };

export type Snapshot = {
  phase: "lobby" | "running" | "settled";
  // The room this snapshot describes (Phase 9).
  room: RoomMeta;
  startedAt: number | null;
  autoStartAt: number | null;
  timeline: {
    purgeAt: number;
    weakestLinkAt: number;
    hostileAt: number;
  } | null;
  contestants: PublicContestant[];
  markets: MarketPublic[];
  activeConversations: {
    id: string;
    participantIds: string[];
    startedAt: number;
  }[];
  events: GameEvent[];
  hostile: HostileState;
  spend: SpendState;
  deathOrder: string[];
  winnerContestantId: string | null;
  tokens: number;
  positions: Position[];
  // The server's RESOLVED behavior flags.
  //
  // The client cannot read the ISLAND_* environment: Next only exposes
  // NEXT_PUBLIC_ variables to the browser, and only when referenced statically,
  // so a dynamic lookup would silently report every flag as off. Publishing the
  // already-resolved values here means the server is the single source of truth
  // and the two halves of the app can never disagree about which behavior is
  // switched on.
  flags: Tunables["flags"];
  // The run's seed, published so the run is auditable from the client and the
  // admin console (spec line 214). Zero means "one was picked at start and
  // reported", matching Tunables.seed and runSeed()'s own convention, rather
  // than meaning the field is absent.
  seed: number;
};

// Server-to-client event payloads

export type GamePhasePayload = {
  phase: "lobby" | "running" | "settled";
  startedAt: number | null;
  autoStartAt?: number | null;
  timeline?: {
    purgeAt: number;
    weakestLinkAt: number;
    hostileAt: number;
  };
};

export type ContestantJoinedPayload = {
  contestant: PublicContestant;
  market: MarketPublic;
};

export type ConvStartedPayload = {
  id: string;
  participantIds: string[];
  x: number;
  y: number;
};

export type ConvMessagePayload = {
  convId: string;
  speakerId: string;
  text: string;
  tone: Tone;
};

export type ConvEndedPayload = {
  convId: string;
  // Mirrors Conversation["outcome"]. Widened with the two soft outcomes so the
  // client can show an outcome icon for them; older clients simply fall through
  // to their default glyph for an unrecognized value.
  outcome: Conversation["outcome"];
  fightInitiatorId: string | null;
};

export type FightStartedPayload = {
  fightId: string;
  attackerId: string;
  defenderId: string;
  betrayal: boolean;
};

export type ContestantDiedPayload = {
  contestantId: string;
  deathIndex: number;
  killerId: string | null;
  cause: "combat" | "purge" | "weakestLink" | "voteOff";
  // A short, specific description of HOW they died (e.g. "Rico crushed Nova
  // with a rock"), for the feed and the tombstone card.
  causeText: string;
  settlement: { priceAtDeath: number };
};

// A new alliance between two islanders (drives the feed line).
export type AllianceFormedPayload = {
  aId: string;
  bId: string;
  aName: string;
  bName: string;
};

// A private thought a viewer can see but the other islanders cannot -- e.g. an
// islander planning to betray an ally. Shown in the island feed and the
// islander's own character feed.
export type AgentThoughtPayload = {
  agentId: string;
  agentName: string;
  text: string;
  kind: "scheme" | "plan" | "observe";
};

export type MarketSettledPayload = {
  contestantId: string;
  outcome: "yes" | "no";
};

export type BalanceUpdatePayload = {
  tokens: number;
  delta: number;
  reason: "bet" | "deathRedemption" | "winnerRedemption";
  contestantId?: string;
};

export type EventCountdownPayload = {
  kind: "purge" | "weakestLink";
  firesAt: number;
  description: string;
};

export type EventFiredPayload = {
  kind: "purge" | "weakestLink";
  eliminatedIds: string[];
  survivorsCount: number;
};

export type GameHostilePayload = {
  startedAt: number;
  fullDecayAt: number;
};

export type GameResultsPayload = {
  winnerContestantId: string;
  winnerName: string;
  winnerOwnerName: string;
  // A short, in-character one-liner about the winner for the winner screen.
  quip: string;
  winnerPortfolio: {
    spectatorId: string;
    name: string;
    tokens: number;
  };
  leaderboard: {
    name: string;
    tokens: number;
  }[];
  // Per-bettor final payout breakdown (net = tokens now - the 50 they started
  // with; drives the payouts screen). Sorted best-first.
  payouts: {
    name: string;
    spent: number;
    net: number;
  }[];
  recap: {
    totalDeaths: number;
    totalBets: number;
    biggestUpset: string;
  };
};

export type SwarmTelemetryPayload = {
  kind: "decision" | "convTurn";
  agentId: string;
  action?: string;
  reasoning?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
  fallback: boolean;
};

export type SpendUpdatePayload = {
  estimatedUsd: number;
  capUsd: number;
  throttled: boolean;
  fallbackActive: boolean;
};

// Event-map types for Socket.IO typing (without importing socket.io)

export type ClientToServerEvents = {
  hello: (payload: HelloPayload, ack: (a: HelloAck) => void) => void;
  "spectator:join": (
    payload: SpectatorJoinPayload,
    ack: (a: SpectatorJoinAck) => void
  ) => void;
  "contestant:create": (
    payload: ContestantCreatePayload,
    ack: (a: ContestantCreateAck) => void
  ) => void;
  "bet:place": (
    payload: BetPlacePayload,
    ack: (a: BetPlaceAck) => void
  ) => void;
  "admin:cmd": (
    payload: AdminCmdPayload,
    ack: (a: AdminCmdAck) => void
  ) => void;
  "room:create": (payload: RoomCreatePayload, ack: (a: RoomEnterAck) => void) => void;
  "room:join": (payload: RoomJoinPayload, ack: (a: RoomEnterAck) => void) => void;
  "room:start": (payload: RoomStartPayload, ack: (a: { ok: boolean }) => void) => void;
  "room:list": (ack: (a: RoomListAck) => void) => void;
  "notif:setPref": (payload: NotifPrefPayload, ack: (a: { ok: boolean; notify: boolean }) => void) => void;
};

export type ServerToClientEvents = {
  tick: (diff: TickDiff) => void;
  "game:phase": (payload: GamePhasePayload) => void;
  "contestant:joined": (payload: ContestantJoinedPayload) => void;
  "conv:started": (payload: ConvStartedPayload) => void;
  "conv:message": (payload: ConvMessagePayload) => void;
  "conv:ended": (payload: ConvEndedPayload) => void;
  "fight:started": (payload: FightStartedPayload) => void;
  "contestant:died": (payload: ContestantDiedPayload) => void;
  "alliance:formed": (payload: AllianceFormedPayload) => void;
  "agent:thought": (payload: AgentThoughtPayload) => void;
  "market:settled": (payload: MarketSettledPayload) => void;
  "balance:update": (payload: BalanceUpdatePayload) => void;
  "event:countdown": (payload: EventCountdownPayload) => void;
  "event:fired": (payload: EventFiredPayload) => void;
  "game:hostile": (payload: GameHostilePayload) => void;
  "game:results": (payload: GameResultsPayload) => void;
  "swarm:telemetry": (payload: SwarmTelemetryPayload) => void;
  "spend:update": (payload: SpendUpdatePayload) => void;
};
