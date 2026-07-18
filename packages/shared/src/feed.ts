// ---------------------------------------------------------------------------
// The world event feed and the world state snapshot.
//
// Before this, "what is happening in the villa" was only ever expressed as
// ~18 separate socket emissions, each one fired at its call site and consumed
// by the client. There was no server-side record an agent could read, so an
// agent could not know that a purge just took three people, or that two
// islanders it has never met formed an alliance across the map.
//
// This adds one append-only feed and one derived snapshot. Agents read these
// instead of polling raw game state, which is what keeps awareness decoupled:
// combat, events, and the conversation gate all just append, and nothing that
// appends needs to know who is listening.
//
// The socket emissions are untouched. The feed is a parallel record for agents,
// not a replacement for the wire protocol.
// ---------------------------------------------------------------------------

// PRODUCER STATUS (kept current so the gap is visible rather than discovered
// by grep every time). As of this contract landing:
//   HAVE a producer today:    allianceFormed, allianceBroken, voteResult,
//                              fight, tension, amicable
//   NO producer yet:          death, purge, hostile, livingCountChanged
// The four with no producer are exactly the ones the spec names first (a
// death, a purge, the living count changing) -- appending them is WS-E's
// (vote/purge path) and WS-H's (combat death path) job, not this file's; this
// file only owns the enum and the reader-side helpers below.
export type WorldEventKind =
  | "death"
  | "purge" // a scheduled mass elimination fired
  | "voteResult"
  | "allianceFormed"
  | "allianceBroken"
  | "fight"
  | "tension"
  | "amicable"
  | "hostile" // endgame forcer engaged
  | "livingCountChanged";

export type WorldEvent = {
  id: number; // monotonic, so a reader can resume from where it left off
  t: number;
  kind: WorldEventKind;
  // Everyone involved. A reader filters on this to find events about itself.
  actorIds: string[];
  // Human line, reused for prompt injection and for debugging the feed.
  line: string;
  // How many were alive immediately after this event.
  livingAfter: number;
};

// Where the run is, in terms an agent can reason about without seeing a clock.
export type GamePhaseView =
  | "early" // before the first scheduled event
  | "mid" // between the two scheduled events
  | "late" // after the second
  | "endgame"; // hostile mode

export type EventPosture =
  | "none"
  | "imminent" // countdown is running
  | "active" // firing right now
  | "justPassed"; // fired within the recency window

// The snapshot every agent reads. Small on purpose: this is what gets narrated
// into a prompt, so anything added here costs tokens on every think.
export type WorldStateView = {
  livingCount: number;
  startingCount: number;
  // How long this run has been going. The conflict warmup ramp needs a real
  // elapsed value to measure against the configured window; inferring it from
  // the event countdown only works while a countdown is actually running, and
  // leaves the opening minutes flat. Null before the run starts.
  runElapsedMs: number | null;
  phase: GamePhaseView;
  posture: EventPosture;
  // What the imminent/active event is, when there is one.
  eventKind: "purge" | "weakestLink" | "hostile" | null;
  secondsUntilEvent: number | null;
  // Events since this agent last thought, newest last. Bounded by the reader.
  recent: WorldEvent[];
};

// How long after firing an event still reads as "just passed".
export const JUST_PASSED_MS = 30_000;

// ---------------------------------------------------------------------------
// The feed itself. Held per room alongside the rest of the room's state.
// ---------------------------------------------------------------------------

export type FeedState = {
  events: WorldEvent[];
  nextId: number;
};

// Ring cap. Long enough that an agent thinking every 15-30 s never misses an
// event, short enough that a long run does not grow without bound.
const FEED_CAP = 200;

export function createFeedState(): FeedState {
  return { events: [], nextId: 1 };
}

export function appendWorldEvent(
  feed: FeedState,
  e: Omit<WorldEvent, "id">,
): WorldEvent {
  const ev: WorldEvent = { ...e, id: feed.nextId++ };
  feed.events.push(ev);
  if (feed.events.length > FEED_CAP) {
    feed.events.splice(0, feed.events.length - FEED_CAP);
  }
  return ev;
}

// Events newer than `sinceId`, capped. `sinceId` of 0 means "everything you
// still have", which is what a freshly spawned reader wants.
export function eventsSince(feed: FeedState, sinceId: number, limit = 6): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let i = feed.events.length - 1; i >= 0; i--) {
    const e = feed.events[i];
    if (!e || e.id <= sinceId) break;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out.reverse();
}

// Events mentioning a specific agent, newest last. This is how an agent finds
// out what happened to it while it was busy.
export function eventsAbout(feed: FeedState, agentId: string, limit = 4): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let i = feed.events.length - 1; i >= 0; i--) {
    const e = feed.events[i];
    if (!e) break;
    if (e.actorIds.includes(agentId)) out.push(e);
    if (out.length >= limit) break;
  }
  return out.reverse();
}

// One short sentence summarizing the run's shape, for prompt injection. Kept
// deliberately vague about numbers an agent should not precisely know: it gets
// the living count, which is observable by looking around, but never a
// percentage or a rank.
export function describeWorldState(w: WorldStateView): string {
  const bits: string[] = [`${w.livingCount} of you are left`];
  switch (w.posture) {
    case "imminent":
      bits.push(
        w.secondsUntilEvent != null
          ? `something is coming in about ${Math.max(1, Math.round(w.secondsUntilEvent))} seconds`
          : "something is coming",
      );
      break;
    case "active":
      bits.push("it is happening right now");
      break;
    case "justPassed":
      bits.push("it just happened and the villa is still reeling");
      break;
    case "none":
      break;
  }
  if (w.phase === "endgame") bits.push("this is the endgame");
  return `${bits.join(". ")}.`;
}

// One or two sentences narrating a short list of recent events for one agent,
// with that agent's own involvement foregrounded ("you watched X go" rather
// than "X died"). Takes an already-filtered slice -- typically
// ctx.recentEvents, which the server trims to what this agent has not yet
// seen -- rather than the whole feed, so this stays a pure renderer with no
// cursor or store of its own. Returns null for an empty list so a prompt does
// not get padded with "nothing has happened".
//
// WS-I is the intended caller: it sits next to describeWorldState as the
// second half of the world block a conversation/decision prompt injects.
export function describeRecentEvents(
  events: WorldEvent[],
  selfId: string,
): string | null {
  if (events.length === 0) return null;
  const bits: string[] = [];
  for (const e of events) {
    const involved = e.actorIds.includes(selfId);
    const you = involved ? "you were involved when " : "";
    switch (e.kind) {
      case "death":
        bits.push(involved ? "you watched someone go" : "someone just died");
        break;
      case "purge":
        bits.push(`a purge just took people, ${e.livingAfter} of you are left`);
        break;
      case "voteResult":
        bits.push(involved ? "you were caught up in a vote" : "a vote just went down");
        break;
      case "allianceFormed":
        bits.push(involved ? "you formed an alliance" : "an alliance just formed nearby");
        break;
      case "allianceBroken":
        bits.push(involved ? "your alliance just broke" : "an alliance just broke nearby");
        break;
      case "fight":
        bits.push(involved ? "you were just in a fight" : "a fight just broke out nearby");
        break;
      case "tension":
        bits.push(involved ? "things just got tense for you with someone" : "there was tension nearby");
        break;
      case "amicable":
        bits.push(involved ? "you just had a good moment with someone" : "something friendly just happened nearby");
        break;
      case "hostile":
        bits.push("the villa has turned hostile, this is the endgame");
        break;
      case "livingCountChanged":
        bits.push(`${e.livingAfter} of you are left now`);
        break;
      default:
        // Unknown kind (forward compatibility): fall back to the pre-rendered
        // line rather than dropping the event silently.
        bits.push(`${you}${e.line}`.trim());
        break;
    }
  }
  if (bits.length === 0) return null;
  return `${bits.join(". ")}.`;
}
