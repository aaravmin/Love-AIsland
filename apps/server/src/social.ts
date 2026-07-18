import {
  appendWorldEvent,
  createFeedState,
  createRelationshipStore,
  eventsSince,
  forgetAgent,
  getRelationship,
  recordPairOutcome,
  relationshipsFor,
  tunables,
  type FeedState,
  type RelOutcome,
  type Relationship,
  type OverheardFragment,
  type RelationshipStore,
  type WorldEvent,
  type WorldEventKind,
  type WorldStateView,
} from "@arena/shared";
// Type-only, deliberately. alliances.ts reads this module at call time, so a
// value import here would close a runtime import cycle. A type import is erased
// at compile time, which breaks the cycle outright rather than relying on
// function hoisting to paper over it. The store is created lazily by
// alliances.ts on first use.
import type { AllianceState } from "./alliances.js";
import { aliveCount, state } from "./state.js";

// ---------------------------------------------------------------------------
// Per-room social state: the world event feed, the per-pair relationship store,
// and the run's seeded RNG.
//
// Follows the same shape as movement.ts / combat.ts / market.ts: a state object
// the room owns, a module-level `cur` pointer, and a `useSocial` that rooms.ts
// calls from activate(). The synchronous engine is single-threaded and every
// entry point activates before touching state, so this is safe.
//
// Everything here is inert until a flag turns it on. Appending to the feed is
// unconditional and cheap (it is just a bounded array), because a feed that
// only records while someone is listening is a feed with holes in it; what the
// flags gate is whether anyone READS it.
// ---------------------------------------------------------------------------

// mulberry32: small, fast, and the same generator the scheduler and harness
// already use, so seeded behavior is consistent across the codebase.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SocialState = {
  feed: FeedState;
  rel: RelationshipStore;
  // The run seed. One seed per room makes a run reproducible for debugging and
  // makes betting outcomes auditable after the fact.
  seed: number;
  rand: () => number;
  // Where each agent's feed cursor sits, so a think only sees what is new to it.
  feedCursor: Map<string, number>;
  // Conversation fragments each agent has picked up, keyed by listener.
  overheard: Map<string, OverheardFragment[]>;
  // Multi-person alliance groups and the spontaneous ouster board. Created on
  // first use by alliances.ts (see the type-only import above).
  alliances: AllianceState | null;
};

// A zero seed in config means "pick one and report it". A fixed seed replays.
function pickSeed(): number {
  if (tunables.seed > 0) return Math.floor(tunables.seed);
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}

export function createSocialState(seed = pickSeed()): SocialState {
  // Surfaced per the spec's "one run seed so a run can be reproduced for
  // debugging and so betting outcomes are auditable" rule (spec line 214).
  // createSocialState runs exactly once per room at room start (rooms.ts) and
  // once per admin-triggered reset (admin.ts), which is "room start" in every
  // sense that matters for auditability, so this is the log line rather than
  // a one-off print buried in a route handler. Not gated behind a flag: a
  // seed with nobody to read it defeats the point, and printing it is free.
  console.log(`[social] run seed ${seed}`);
  return {
    feed: createFeedState(),
    rel: createRelationshipStore(),
    seed,
    rand: mulberry32(seed),
    feedCursor: new Map(),
    overheard: new Map(),
    alliances: null,
  };
}

let cur: SocialState = createSocialState();
export function useSocial(s: SocialState): void {
  cur = s;
}
export function social(): SocialState {
  return cur;
}

// The run's seeded random. Every new behavior added by the spec draws from
// this rather than Math.random, so a seeded run replays.
export function rand(): number {
  return cur.rand();
}

// Exported so a caller outside this module can put the seed somewhere a
// human or the admin console can read it. WS-D does not own state.ts, so the
// one-line addition that would put this in Snapshot (`seed: runSeed()` next
// to the other top-level fields in assembleSnapshot, apps/server/src/state.ts)
// is left for state.ts's owner (WS-F touches the same server context path) to
// wire in; the getter is ready the moment someone does.
export function runSeed(): number {
  return cur.seed;
}

// ---------------------------------------------------------------------------
// THE tie rule. Stated once here and used everywhere a tie can happen, which is
// the spec's requirement and also the only way a tie stays reproducible.
//
//   1. Lower current health goes first.
//   2. If health ties too, a deterministic function of the run seed and the two
//      ids decides. It is stable across replays of the same seed and cannot
//      deadlock, which is the property that matters: an unbroken tie would hang
//      the sim.
// ---------------------------------------------------------------------------

function hashWithSeed(seed: number, id: string): number {
  // FNV-1a over the id, mixed with the seed. Same generator family as the
  // scheduler's, so seeded behavior is consistent across the codebase.
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Negative when `a` should be eliminated first. Sortable directly.
export function breakTie(
  a: { id: string; hp: number },
  b: { id: string; hp: number },
): number {
  if (a.hp !== b.hp) return a.hp - b.hp;
  const ha = hashWithSeed(cur.seed, a.id);
  const hb = hashWithSeed(cur.seed, b.id);
  if (ha !== hb) return ha - hb;
  // Astronomically unlikely, but a total order must be total.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

export function pushWorldEvent(
  kind: WorldEventKind,
  actorIds: string[],
  line: string,
  now: number,
): WorldEvent {
  return appendWorldEvent(cur.feed, {
    t: now,
    kind,
    actorIds,
    line,
    livingAfter: aliveCount(),
  });
}

// ---------------------------------------------------------------------------
// Typed producer helpers for the four WorldEventKind values feed.ts declares
// but this codebase has no call site for yet (see feed.ts's PRODUCER STATUS
// comment). These are thin wrappers over pushWorldEvent -- they add nothing
// but a typed signature and a documented owner per kind -- so the call sites
// that eventually append these kinds do not each have to know the
// WorldEventKind string or re-derive livingAfter by hand.
//
// PRODUCER OWNERSHIP. Listed so the gap stays visible rather than rediscovered
// by grep:
//   pushDeathEvent               apps/server/src/combat.ts, on a kill
//                                 resolving (processDeath's combat path) --
//                                 WS-H.
//   pushPurgeEvent                apps/server/src/events.ts, when a scheduled
//                                 mass-elimination event actually fires --
//                                 WS-E.
//   pushHostileEvent              apps/server/src/events.ts, when endgame
//                                 hostile mode engages -- WS-E.
//   pushLivingCountChangedEvent   wherever aliveCount() changes and the
//                                 change is not already implied by a death or
//                                 purge event's own livingAfter field -- call
//                                 once per CHANGE, not once per contestant, so
//                                 a purge that removes three people is one
//                                 feed entry here, not three.
//
// None of these are called from this file. They exist so the workstreams that
// own combat.ts and events.ts have a stable, typed target to call into rather
// than reaching for the untyped pushWorldEvent(kind: string, ...) directly.
// ---------------------------------------------------------------------------

export function pushDeathEvent(agentId: string, line: string, now: number): WorldEvent {
  return pushWorldEvent("death", [agentId], line, now);
}

export function pushPurgeEvent(agentIds: string[], line: string, now: number): WorldEvent {
  return pushWorldEvent("purge", agentIds, line, now);
}

export function pushHostileEvent(line: string, now: number): WorldEvent {
  return pushWorldEvent("hostile", [], line, now);
}

export function pushLivingCountChangedEvent(line: string, now: number): WorldEvent {
  return pushWorldEvent("livingCountChanged", [], line, now);
}

// What this agent has not yet seen, WITHOUT advancing its cursor. Safe to call
// any number of times for any reason -- narrating a display name, building an
// awareness block that gets read more than once per think, whatever -- and
// every call returns the same events until something else drains the cursor.
//
// This is the fix for the bug drainEventsFor's own comment used to claim
// away: agentContext (swarmBridge.ts) is not "called once per think". A
// single 4-turn conversation calls world.agentContext(speakerId) once per
// turn plus world.agentContext(partnerId) once per turn just to read a
// display name (packages/swarm/src/conversation.ts:88,93), so a draining read
// there was burning both participants' unread events up to 4 extra times per
// conversation, and a real consumer built on top of agentContext would often
// find the cursor already advanced past what it meant to react to.
// agentContext must be side-effect free; peekEventsFor is what makes that
// possible.
export function peekEventsFor(agentId: string, limit = 4): WorldEvent[] {
  const since = cur.feedCursor.get(agentId) ?? 0;
  return eventsSince(cur.feed, since, limit);
}

// What this agent has not yet seen, then advance its cursor. Reserved for the
// one explicit "this agent is thinking right now and is about to act on what
// it sees" call site (the swarm scheduler's think loop). Every other reader --
// including agentContext, which conversation turns call multiple times per
// conversation purely to read a display name -- must use peekEventsFor
// instead, or it will silently starve the real think call of events it has
// not actually reacted to yet.
export function drainEventsFor(agentId: string, limit = 4): WorldEvent[] {
  const since = cur.feedCursor.get(agentId) ?? 0;
  const events = eventsSince(cur.feed, since, limit);
  const newest = cur.feed.events[cur.feed.events.length - 1];
  if (newest) cur.feedCursor.set(agentId, newest.id);
  return events;
}

// ---------------------------------------------------------------------------
// World state snapshot
// ---------------------------------------------------------------------------

export function worldStateView(now: number): WorldStateView {
  const living = aliveCount();
  const starting = Object.keys(state.contestants).length;

  // Phase is derived from which scheduled events have resolved rather than from
  // the clock, so it stays right when an operator fires an event early.
  const resolved = state.events.filter((e) => e.resolved).length;
  const phase = state.hostile.active
    ? "endgame"
    : resolved === 0
      ? "early"
      : resolved === 1
        ? "mid"
        : "late";

  // Posture: is something coming, happening, or freshly over?
  let posture: WorldStateView["posture"] = "none";
  let eventKind: WorldStateView["eventKind"] = null;
  let secondsUntilEvent: number | null = null;

  const pending = state.events.find((e) => !e.resolved && e.countdownStartedAt !== null);
  const firing = state.events.find((e) => e.firedAt !== null && now - e.firedAt < 1_000);
  const recent = state.events
    .filter((e) => e.firedAt !== null && now - e.firedAt < JUST_PASSED_WINDOW)
    .sort((a, b) => (b.firedAt ?? 0) - (a.firedAt ?? 0))[0];

  if (firing) {
    posture = "active";
    eventKind = firing.kind;
  } else if (pending) {
    posture = "imminent";
    eventKind = pending.kind;
    secondsUntilEvent = Math.max(0, (pending.scheduledAt - now) / 1000);
  } else if (recent) {
    posture = "justPassed";
    eventKind = recent.kind;
  } else if (state.hostile.active) {
    posture = "active";
    eventKind = "hostile";
  }

  return {
    livingCount: living,
    startingCount: starting,
    runElapsedMs: state.startedAt === null ? null : Math.max(0, now - state.startedAt),
    phase,
    posture,
    eventKind,
    secondsUntilEvent,
    // The snapshot's own narration surface. Before this it was hardcoded to
    // an empty array even though this function already computes a `recent`
    // scheduled-event lookup above (for posture/eventKind) -- this is a
    // different `recent`, the world FEED's tail, which is what lets
    // describeWorldState (feed.ts) and eventually a conversation/decision
    // prompt say something like "four of us left" or reference a purge that
    // just took three people rather than only knowing an unlabeled countdown
    // fired. `eventsSince(cur.feed, 0, N)` deliberately ignores any one
    // agent's read cursor: this is a snapshot of the world, not a per-agent
    // unread queue (that is what peekEventsFor/drainEventsFor are for), so
    // every caller of worldStateView sees the same tail regardless of who
    // asks.
    recent: eventsSince(cur.feed, 0, WORLD_SNAPSHOT_RECENT_COUNT),
  };
}

// How many of the feed's most recent events ride along in worldStateView's
// own `recent` field. Local to this file rather than a tunables.ts entry: WS-D
// does not own tunables.ts (packages/shared/src/tunables.ts), and every other
// magnitude this file reads already lives there, so this constant is a
// placeholder for a proper `awareness.worldSnapshotRecentCount` tunable --
// see this workstream's cross-file request to add one. Small on purpose: this
// rides along in every worldStateView() call, which feeds directly into a
// prompt (describeWorldState/describeRecentEvents), so it costs tokens on
// every think that has worldAwareness on.
const WORLD_SNAPSHOT_RECENT_COUNT = 4;

const JUST_PASSED_WINDOW = 30_000;

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

export function recordOutcome(
  a: string,
  b: string,
  outcome: RelOutcome,
  now: number,
  note?: string,
): void {
  recordPairOutcome(cur.rel, a, b, outcome, now, note);
}

export function relationship(from: string, to: string, now: number): Relationship {
  return getRelationship(cur.rel, from, to, now);
}

export function relationshipsOf(from: string, now: number): Relationship[] {
  return relationshipsFor(cur.rel, from, now);
}

export function forgetRelationships(agentId: string): void {
  forgetAgent(cur.rel, agentId);
  cur.feedCursor.delete(agentId);
  cur.overheard.delete(agentId);
}

export function resetSocial(): void {
  cur.feed = createFeedState();
  cur.rel = createRelationshipStore();
  cur.feedCursor.clear();
  cur.overheard.clear();
  cur.alliances = null;
  cur.seed = pickSeed();
  cur.rand = mulberry32(cur.seed);
}
