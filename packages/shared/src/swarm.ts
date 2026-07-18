import type { Class, Stats, Tone, MemoryItem } from "./types.js";
import type { RelOutcome } from "./relationships.js";
import type { WorldEvent, WorldStateView } from "./feed.js";

// ---------------------------------------------------------------------------
// Task 4.0: the frozen server<->swarm contract (ARCHITECTURE.md section 2).
//
// This is the ONLY seam between apps/server (authoritative state, the tick,
// combat, markets) and packages/swarm (when/how agents think, prompts, LLM
// calls, spend cap, fallback). The swarm reads the world exclusively through
// WorldView and writes exclusively through DecisionSink; it never imports the
// server's GameState or touches a socket. Freezing these shapes here lets the
// server and swarm lanes move independently -- every cross-lane change is a
// visible diff in this file.
//
// All types are plain data (no server internals leak across): ids, numbers,
// and the already-public enums from types.ts. The swarm may hold none of the
// server's mutable objects.
// ---------------------------------------------------------------------------

// The six actions a decision can request (ARCHITECTURE.md 7.2). proposeAlliance
// is the swarm's intent to befriend; the server converts it to approach + a
// conversation-request flag (the gate honors it). attack sets attack intent;
// whether a fight actually spawns is the server's call (validation + Phase 5
// combat).
export type AgentAction =
  | "wander"
  | "approach"
  | "attack"
  | "flee"
  | "layLow"
  | "proposeAlliance";

// The decide-tool result. target is the person this physical action is aimed
// at (or null for wander/layLow). A vote campaign is different: an islander
// approaches a confidant while trying to turn the villa against somebody
// else, so voteTarget carries that second, social target explicitly. The
// server validates both ids independently before acting on either one.
export type AgentDecision = {
  action: AgentAction;
  target: string | null;
  voteTarget?: string | null;
  reasoning: string;
};

// Minimal identity used by the scheduler to enumerate who is due to think.
export type AgentBrief = {
  id: string;
  name: string;
  klass: Class;
};

// One entry in an agent's "nearby" list: everything the decision needs to
// weigh a neighbor, already projected to public/relative terms. distance is in
// world pixels. hpFraction and priceYes stand in for "weak/healthy" and
// "public favor" so the prompt never needs raw server fields.
export type NearbyAgent = {
  id: string;
  name: string;
  klass: Class;
  hpFraction: number; // 0..1
  kills: number;
  notoriety: number;
  priceYes: number; // live market price = public favor
  allied: boolean;
  distance: number; // world px
  // How many allies this neighbor has. Observable by watching who they move
  // and talk with, and it is what makes the vote's likability term work: a
  // well-connected target is both harder to remove and more dangerous to
  // leave, and neither half of that is expressible from priceYes alone.
  allyCount: number;
};

// A context line injected during an event countdown or hostile mode
// (ARCHITECTURE.md 6.5 / 6.6). secondsUntil is the countdown; null once the
// condition is already active (hostile mode has no countdown).
export type EventModifier = {
  kind: "purge" | "weakestLink" | "hostile";
  secondsUntil: number | null;
  line: string;
};

// The full per-agent decision context the server assembles (WorldView.
// agentContext). Own state + nearby + memory + event modifier + phase -- the
// exact inputs the decision prompt (task 4.1) and the rule fallback (4.4) both
// read. Nothing here is a live server object; it is a snapshot for one think.
export type AgentContextView = {
  self: {
    id: string;
    name: string;
    klass: Class;
    stats: Stats;
    persona: string;
    hp: number;
    maxHp: number;
    hpFraction: number;
    kills: number;
    notoriety: number;
    priceYes: number;
    allies: string[];
    x: number;
    y: number;
  };
  nearby: NearbyAgent[]; // sorted by the server's target-weight ordering (6.7)
  memory: MemoryItem[]; // ring buffer, oldest-first
  event: EventModifier | null;
  phase: "lobby" | "running" | "settled";

  // ---- Added by the behavior spec. Every field is optional and every one is
  // populated only when its feature flag is on, so with all flags off this type
  // is byte-for-byte the context the prompts already received. Consumers must
  // treat every field here as possibly absent.

  // What the agent knows about the run: living count, phase, whether an event
  // is imminent/active/just passed. Flag: worldAwareness.
  world?: WorldStateView;
  // Events since this agent last thought, already filtered and narrated.
  recentEvents?: WorldEvent[];

  // How this agent reads the people it knows, strongest feelings first. Only
  // includes pairs with actual history. Flag: relationshipMemory.
  relationships?: RelationshipSummary[];

  // Whether the agent is standing in a crowd or off on its own, and how many
  // living islanders are within the density radius. Flag: spatialAwareness.
  spatial?: { density: "crowded" | "normal" | "secluded"; neighborCount: number };

  // Fragments of nearby conversations this agent was close enough to catch.
  // These are things it heard, not things it was told, so they may be partial.
  // Flag: overhearing.
  overheard?: OverheardFragment[];

  // The agent's own rough read on how it is doing. Deliberately a coarse band
  // and a private worry line, never a number: an islander can feel it is on the
  // outside without ever seeing a percentage. Flag: selfOdds.
  selfOdds?: SelfOddsView;

  // The multi-member bloc this agent belongs to, if any. Without this, an
  // agent in a four-person alliance sees exactly what it saw before this
  // field existed -- three ids in `self.allies` -- so "our four" or "we are
  // cracking" is structurally unspeakable: nothing on the context names the
  // group as a group or reports how it is holding together. Populated by
  // apps/server/src/alliances.ts's allianceViewFor. Flag: multiAlliances.
  alliance?: AllianceView;
};

// A multi-member alliance projected for one member's context. Deliberately a
// band, never a raw cohesion number, matching the selfOdds precedent above: an
// islander can feel a bloc fracturing without ever seeing its score.
export type AllianceView = {
  id: string;
  size: number;
  memberNames: string[];
  cohesionBand: "solid" | "strained" | "fracturing";
};

// A relationship projected for one agent's context. Mirrors the Relationship
// record but carries the partner's display name so a prompt can be built
// without a second lookup.
export type RelationshipSummary = {
  id: string;
  name: string;
  trust: number; // -1..1
  threat: number; // 0..1
  affinity: number; // -1..1
  // Recent outcomes with this person, oldest first.
  recent: RelOutcome[];
  // Pre-rendered sentence, or null when there is nothing worth saying.
  line: string | null;
};

export type OverheardFragment = {
  t: number;
  // When THIS listener caught it, as distinct from `t` (kept for backward
  // compatibility with existing readers of the general event time). The two
  // are the same instant for a directly overheard line, but keeping a
  // purpose-named field means a future producer (e.g. gossip relayed a second
  // time) can stamp when this listener heard it without overloading `t`'s
  // meaning. WS-D's recordOverheard is the producer; it should set both.
  heardAt: number;
  // Who was talking. An overhearing agent knows who it saw, so this is known.
  speakerId: string;
  speakerName: string;
  aboutId: string | null; // who they were talking about, when identifiable
  text: string;
  // `fresh` means "not yet passed on in speech" -- NOT "not yet seen" and NOT
  // "conversation still ongoing". Only the speech path may clear it, by
  // calling the explicit markOverheardSpoken(listenerId, fragmentId) once a
  // fragment actually reaches a line the listener speaks. Today
  // markOverheardShared (apps/server/src/awareness.ts) is called the instant
  // a conversation STARTS (apps/server/src/swarmBridge.ts, near the gate
  // firing), which retires every fragment before a single word has been said
  // about it -- that is a bug this field's contract exists to fix, not
  // behavior to preserve. WS-D implements markOverheardSpoken and keeps
  // markOverheardShared exported as a deprecated no-op wrapper. WS-J/WS-I are
  // the callers that should invoke it from the speech path.
  fresh: boolean;
};

// The coarse self-standing signal. `band` is the whole public surface of it:
// nothing downstream may convert this back into a number, and no prompt may
// state one.
export type SelfOddsView = {
  band: "precarious" | "shaky" | "steady" | "strong";
  // The observable inputs it was built from, so behavior can key off the
  // reason rather than only the verdict.
  allianceCount: number;
  fallenOutCount: number;
  // Roughly how much this agent has done relative to the villa. 0..1.
  activity: number;
  // Set when the agent is worried enough for it to change what it does.
  worried: boolean;
};

// One spoken line in a conversation (streamed to clients as conv:message).
export type ConvMessage = {
  speaker: string; // contestant id
  text: string;
  tone: Tone;
};

// A conversation's terminal result. fightInitiator is set only when
// outcome === "fight" (the attacker; the server spawns the fight from it).
export type ConvOutcome = {
  // The spec's five outcomes are none/alliance/fight/tension/amicable. "truce"
  // is the game's own sixth, kept because the escalation scorer already emits
  // it and the golden rule is to add beside the old rather than rename it.
  // Only "alliance" and "fight" have mechanical consequences in the server;
  // "tension" and "amicable" are pure relationship signal, which is why they
  // can be added without touching combat or alliance handling.
  outcome: "alliance" | "truce" | "fight" | "nothing" | "tension" | "amicable";
  fightInitiator: string | null;
};

// What the swarm's conversation turn loop reads each turn (WorldView.
// conversationState). allowedOutcomes is precomputed by the server from class,
// stats, and state (the escalation scorer, 7.3) -- the LLM/fallback may only
// choose an outcome from this set, so the class system bounds the physics and
// Haiku can never produce a fight the rules forbid.
export type ConversationView = {
  id: string;
  participantIds: string[];
  messages: ConvMessage[];
  maxTurns: number;
  turnsTaken: number;
  nextSpeakerId: string;
  allowedOutcomes: ConvOutcome["outcome"][];
  // Public info about the partner(s), so a turn can be built without a second
  // WorldView lookup.
  partners: NearbyAgent[];
};

// Emitted by the swarm for the React Flow demo view + spend meter (forwarded
// by the server as the swarm:telemetry socket event). Structurally the wire
// SwarmTelemetryPayload; defined here because the swarm produces it.
export type SwarmTelemetry = {
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

// The swarm reads the world ONLY through this (the server implements it).
export interface WorldView {
  livingAgents(): AgentBrief[];
  agentContext(id: string): AgentContextView | null;
  conversationState(id: string): ConversationView | null;
}

// The swarm writes ONLY through this (the server implements it). Every write
// is validated server-side: applyDecision clamps illegal targets/actions to
// wander (7.2), and resolveConversation's outcome must be in the view's
// allowedOutcomes set.
export interface DecisionSink {
  applyDecision(agentId: string, d: AgentDecision): void;
  appendConversationMessage(convId: string, m: ConvMessage): void;
  resolveConversation(convId: string, outcome: ConvOutcome): void;
  reportSwarmTelemetry(e: SwarmTelemetry): void;
}
