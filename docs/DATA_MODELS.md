# Love AIsland - Data Models

Status: Phase 0 deliverable, awaiting Aarav's approval.
These are the final shapes for `packages/shared/src/types.ts`.
Every field added or changed relative to the brief in MVP_BUILD_PLAN.md is flagged with a comment and justified.

```ts
export type Class = "bold" | "timid" | "schemer" | "charmer" | "wildcard";

export type Stats = {
  charisma: number;
  cunning: number;
  grit: number;
  strength: number;
  charm: number;
  instinct: number;
};
// Budget: 30 points total, each stat 1..8.
// Enforced by shared/balance.ts on both client (UX) and server (authority), not by the type.

export type Intent =
  | { kind: "wander" }
  | { kind: "approach"; target: string }
  | { kind: "attack"; target: string }
  | { kind: "flee"; from?: string }
  | { kind: "layLow" }
  | { kind: "converse"; convId: string };
// CHANGED: added "converse" — pins agents in place during a conversation so the
// fast loop doesn't walk them apart mid-transcript.

export type MemoryItem = { t: number; text: string };

// Server-internal, full shape. Never serialized to clients as-is.
export type Contestant = {
  id: string;
  name: string;
  ownerEmail: string;      // PRIVATE: prize contact only, never leaves the server
  ownerName: string;       // ADDED (owner visibility decision): public attribution on the panel
  ownerClientId: string;   // ADDED: links the contestant to its creator's session
  klass: Class;
  stats: Stats;
  persona: string;
  hp: number;
  maxHp: number;           // derived: 60 + 8*grit (formula lives in shared/balance.ts)
  alive: boolean;
  kills: number;
  notoriety: number;
  x: number;
  y: number;
  intent: Intent;
  allies: string[];
  memory: MemoryItem[];    // ring buffer, max 6 items
  deathIndex: number | null;  // ADDED (no-simultaneous-deaths decision): position in the strict global death order
  diedAt: number | null;
  killedBy: string | null;
  causeOfDeath: "combat" | "purge" | "weakestLink" | null;  // ADDED (two-event decision)
  lastCombatAt: number | null;   // ADDED: gates regen (no regen within 5 s of combat)
  activeFightId: string | null;  // ADDED: one fight at a time; the serialization anchor
  nextThinkAt: number;           // ADDED: swarm scheduler bookkeeping
};

// ADDED: the explicit public projection — the ONLY contestant shape that crosses the socket.
export type PublicContestant = Omit<
  Contestant,
  "ownerEmail" | "ownerClientId" | "memory" | "nextThinkAt"
>;

export type Conversation = {
  id: string;
  participants: string[];
  messages: { speaker: string; text: string; tone: Tone }[];
  outcome: "alliance" | "truce" | "fight" | "nothing" | "ongoing";
  fightInitiator: string | null;
  startedAt: number;
  endedAt: number | null;
  maxTurns: number;  // ADDED: 2..4, drawn at creation; hard bound on LLM calls per conversation
};

export type Tone = "friendly" | "hostile" | "neutral" | "deceptive";

export type Market = {
  contestantId: string;
  qYes: number;  // CHANGED semantics: initialized non-zero by 1/N seeding, never both 0
  qNo: number;
  b: number;     // 70 (derivation in ARCHITECTURE.md 6.4)
  seedPrice: number;                    // ADDED: the 1/N price at creation, for UI and debugging
  settled: boolean;                     // ADDED (settle-on-death decision): frozen the instant its contestant dies
  settledOutcome: "yes" | "no" | null;  // ADDED
  createdAt: number;
  priceHistory: { t: number; price: number }[];  // recorded on trade + 5 s heartbeat; downsampled to ~60 pts in snapshots
};

export type Position = {
  spectatorId: string;
  contestantId: string;
  yesShares: number;
  noShares: number;
  yesSpent: number;  // ADDED (no-selling decision): with no exits, cumulative cost basis
  noSpent: number;   //   is fixed — needed for the panel's "your position / potential payout" P&L
};

// ADDED: append-only audit log. Powers recap stats (biggest upset), dispute-proofing,
// and the demo view's trade feed.
export type Trade = {
  id: string;
  spectatorId: string;
  contestantId: string;
  side: "yes" | "no";
  spend: number;
  shares: number;
  priceAfter: number;
  t: number;
};

export type Spectator = {
  id: string;
  clientId: string;  // ADDED: localStorage reconnect key
  name: string;
  email: string;     // PRIVATE: never serialized to clients
  tokens: number;    // starts at 50
};

// CHANGED wholesale (two-event decision): was ceremony/cull/twist, now exactly two
// stat-based mass eliminations, neither of which can end the game.
export type GameEvent = {
  id: string;
  kind: "purge" | "weakestLink";
  scheduledAt: number;                 // ~1/3 and ~2/3 of the run timeline
  countdownStartedAt: number | null;   // ADDED: 60 s on-screen warning + agent context injection
  firedAt: number | null;
  eliminatedIds: string[];             // ADDED: in strict death order
  resolved: boolean;
};

// ADDED (spend-cap decision).
export type SpendState = {
  estimatedUsd: number;
  capUsd: number;          // 10
  softThrottleUsd: number; // 8 — stretch think intervals, tighten conversation gating
  fallbackActive: boolean; // true => zero further LLM calls, rule engine only
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

// ADDED (endgame-forcer decision).
export type HostileState = {
  active: boolean;
  startedAt: number | null;
  fullDecayAt: number | null;  // regenFactor lerps 1 -> 0 over ~3 min, then stays 0
};

export type GameState = {
  phase: "lobby" | "running" | "settled";
  // reset is a transition back to a fresh lobby, not a phase
  startedAt: number | null;
  autoStartAt: number | null;  // ADDED: countdown once >= 10 contestants
  timeline: {                  // ADDED: computed at start for the ~18 min running phase
    purgeAt: number;
    weakestLinkAt: number;
    hostileAt: number;
  } | null;
  contestants: Record<string, Contestant>;
  conversations: Record<string, Conversation>;
  markets: Record<string, Market>;  // created at contestant creation — betting open from lobby
  positions: Position[];
  trades: Trade[];                  // ADDED (see Trade)
  spectators: Record<string, Spectator>;
  events: GameEvent[];
  deathOrder: string[];             // ADDED: the strict serialized death order, authoritative
  hostile: HostileState;            // ADDED
  spend: SpendState;                // ADDED
  winnerContestantId: string | null;
  winnerPortfolioId: string | null;
};
```

## Deliberate non-fields

Public favor is not stored anywhere.
Per the locked decision it IS the live `priceYes`, read from the market wherever favor is needed.
Charm's notoriety-softening combines the charm stat with the live price at the point of use.

Nothing from the brief's models was deleted; every change above is additive or a documented semantic change.
