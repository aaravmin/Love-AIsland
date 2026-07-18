// Extensionless on purpose. This is the only RUNTIME import between files in
// this package -- every other cross-file import here is `import type`, which is
// erased before a bundler ever sees it. Under moduleResolution "bundler" tsc
// happily maps a ".js" specifier onto the ".ts" file, so a ".js" suffix here
// typechecks clean while Turbopack, which does no such mapping, fails to
// resolve it and breaks the web build. Matching index.ts's extensionless style
// keeps this resolvable by both.
import { tunables } from "./tunables";

// ---------------------------------------------------------------------------
// Per-pair relationship memory.
//
// The existing stores stay exactly as they are. `Contestant.allies` remains the
// flat, symmetric, binary ally list the server already gates attacks and votes
// on, and `Contestant.memory` remains the six-item free-text ring buffer the
// prompt reads. This adds the graded, directional layer neither of those can
// express: what A specifically thinks of B, and why.
//
// Records are keyed by ORDERED pair. A's read of B is not B's read of A: A can
// walk away from a conversation feeling betrayed while B thinks it went fine,
// and the vote logic needs that asymmetry.
//
// Two stores per record, deliberately:
//
//   - trust / threat / affinity are running accumulators. Every outcome ever
//     recorded is folded in and none is dropped, so a grudge from early in the
//     run still colors the endgame. They fade with time rather than being
//     erased, which is the spec's rule.
//   - history is a bounded list of recent outcomes, kept for recall: it is what
//     gets narrated into a prompt ("you and Dana argued twice today"). It is a
//     window, not the memory itself.
//
// The three axes answer three different questions the vote logic asks:
//   trust     do I believe this person will hold to a deal?
//   threat    does this person beat me if they stay?
//   affinity  do I like them, and by extension does the villa?
// Survivor-style reasoning needs all three, because the person you like most is
// often the person most dangerous to leave in.
// ---------------------------------------------------------------------------

// The five outcomes from the spec, plus the "truce" the game already produces,
// plus "witnessedKill" -- not a conversation outcome, but the strongest threat
// signal in the game, and it belongs in the same history so a describe call
// can narrate it. Truce predates this spec and is still emitted by the
// escalation scorer, so it stays in the set rather than being renamed into one
// of the new soft outcomes.
export type RelOutcome =
  | "alliance"
  | "amicable"
  | "truce"
  | "nothing"
  | "tension"
  | "fight"
  | "witnessedKill";

export type RelEvent = {
  t: number;
  outcome: RelOutcome;
  // A short phrase naming the trigger, e.g. "argued about the vote" or
  // "backed out of the alliance". Fully plumbed end to end -- applyOutcome
  // accepts it, recordPairOutcome forwards it, apps/server/src/social.ts's
  // recordOutcome accepts it -- but every call site today omits it, so
  // history records WHAT happened and never WHY. Left for callers (WS-F) to
  // start passing; this type does not need to widen to support it.
  note?: string;
};

export type Relationship = {
  from: string;
  to: string;
  trust: number; // -1..1
  threat: number; // 0..1
  affinity: number; // -1..1
  history: RelEvent[]; // most recent last, capped
  updatedAt: number;
};

export function relKey(from: string, to: string): string {
  return `${from}>${to}`;
}

export function emptyRelationship(from: string, to: string, now: number): Relationship {
  return { from, to, trust: 0, threat: 0, affinity: 0, history: [], updatedAt: now };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// Exponential fade toward neutral. Applied lazily on every read and write, so a
// record that has not been touched in ten minutes reports faded numbers without
// anything having to sweep the map on a tick.
function faded(v: number, elapsedMs: number): number {
  const hl = tunables.relationships.halfLifeMs;
  if (hl <= 0 || elapsedMs <= 0) return v;
  return v * Math.pow(0.5, elapsedMs / hl);
}

// Decay a record to `now` in place and return it. Idempotent: calling twice
// with the same `now` is the same as calling once.
export function decayRelationship(r: Relationship, now: number): Relationship {
  const dt = now - r.updatedAt;
  if (dt <= 0) return r;
  r.trust = faded(r.trust, dt);
  r.threat = faded(r.threat, dt);
  r.affinity = faded(r.affinity, dt);
  r.updatedAt = now;
  return r;
}

// Fold one outcome into a record. All five outcome types land here, including
// tension and amicable, which are the easy ones to quietly drop: they are the
// difference between a villa that remembers a slight and one that only tracks
// alliances and fights.
export function applyOutcome(
  r: Relationship,
  outcome: RelOutcome,
  now: number,
  note?: string,
): Relationship {
  decayRelationship(r, now);
  const k = tunables.relationships;

  switch (outcome) {
    case "alliance":
      r.trust += k.trustPerAlliance;
      r.affinity += k.affinityPerAmicable;
      // An ally is a known quantity, which reads as slightly less dangerous.
      r.threat -= k.threatPerFight * 0.5;
      break;
    case "amicable":
      r.trust += k.trustPerAmicable;
      r.affinity += k.affinityPerAmicable;
      break;
    case "truce":
      // Not warmth, just an agreement not to escalate.
      r.trust += k.trustPerAmicable * 0.5;
      break;
    case "tension":
      r.trust += k.trustPerTension;
      r.affinity += k.affinityPerTension;
      r.threat += k.threatPerFight * 0.3;
      break;
    case "fight":
      r.trust += k.trustPerFight;
      r.affinity += k.affinityPerTension * 1.5;
      r.threat += k.threatPerFight;
      break;
    case "nothing":
      // Recorded so "we have spoken and nothing came of it" is distinguishable
      // from "we have never spoken", which changes how an approach reads.
      break;
    case "witnessedKill":
      // Not produced through this path. applyWitnessedKill below mutates
      // threat directly (a kill is not a conversation, so none of the
      // conversation-outcome axis logic above applies) and pushes its own
      // history entry with this outcome. This case exists only so the switch
      // stays exhaustive over RelOutcome; if applyOutcome is ever called with
      // "witnessedKill" directly it is a safe no-op rather than a silent
      // fall-through.
      break;
  }

  r.trust = clamp(r.trust, -1, 1);
  r.threat = clamp(r.threat, 0, 1);
  r.affinity = clamp(r.affinity, -1, 1);

  r.history.push({ t: now, outcome, ...(note ? { note } : {}) });
  const cap = k.historyLength;
  if (r.history.length > cap) r.history.splice(0, r.history.length - cap);
  r.updatedAt = now;
  return r;
}

// Witnessing a kill is not a conversation outcome, but it is the single
// strongest threat signal in the game, so it folds into the same record. This
// also pushes a history entry: before this, applyWitnessedKill touched only
// threat and updatedAt, so an agent that watched someone commit murder and had
// no other history with the killer got a null describeRelationship (history
// was empty), meaning the villa's most dramatic private information was
// unnarratable. Now it has one entry to recall it by.
export function applyWitnessedKill(r: Relationship, now: number): Relationship {
  decayRelationship(r, now);
  r.threat = clamp(r.threat + tunables.relationships.threatPerKillWitnessed, 0, 1);
  r.history.push({ t: now, outcome: "witnessedKill" });
  const cap = tunables.relationships.historyLength;
  if (r.history.length > cap) r.history.splice(0, r.history.length - cap);
  r.updatedAt = now;
  return r;
}

// How much weight a specific outcome still carries in `r`'s history, folding
// each matching event's age through the SAME exponential half-life the
// numeric trust/threat/affinity axes already use (see `faded` above,
// tunables.relationships.halfLifeMs). Without this, describeRelationship
// counted history RAW: a grudge whose numeric trust had decayed back to
// neutral still narrated "you fought 3 times" at full intensity, so the
// sentence and the numbers disagreed. A fresh fight counts as ~1.0; one whose
// age equals exactly one half-life counts as ~0.5; a very old one trails
// toward 0 without ever being deleted, per the spec's "old outcomes fade in
// weight but are not erased".
export function weightedOutcomeCount(
  r: Relationship,
  outcome: RelOutcome,
  now: number,
): number {
  const hl = tunables.relationships.halfLifeMs;
  let total = 0;
  for (const h of r.history) {
    if (h.outcome !== outcome) continue;
    const age = now - h.t;
    total += hl <= 0 || age <= 0 ? 1 : Math.pow(0.5, age / hl);
  }
  return total;
}

// ---------------------------------------------------------------------------
// The store. A flat map keyed by ordered pair, held per room alongside the rest
// of the room's state.
// ---------------------------------------------------------------------------

export type RelationshipStore = Map<string, Relationship>;

export function createRelationshipStore(): RelationshipStore {
  return new Map();
}

export function getRelationship(
  store: RelationshipStore,
  from: string,
  to: string,
  now: number,
): Relationship {
  const key = relKey(from, to);
  let r = store.get(key);
  if (!r) {
    r = emptyRelationship(from, to, now);
    store.set(key, r);
  }
  return decayRelationship(r, now);
}

// Record an outcome for both directions at once. Conversations are mutual
// events even though the readings of them are not, and every call site so far
// wants both sides written, so this is the ergonomic default.
export function recordPairOutcome(
  store: RelationshipStore,
  a: string,
  b: string,
  outcome: RelOutcome,
  now: number,
  note?: string,
): void {
  applyOutcome(getRelationship(store, a, b, now), outcome, now, note);
  applyOutcome(getRelationship(store, b, a, now), outcome, now, note);
}

// Everyone A has an opinion about, strongest feelings first. Used to build the
// narrated relationship block in a prompt without dumping the whole map.
export function relationshipsFor(
  store: RelationshipStore,
  from: string,
  now: number,
): Relationship[] {
  const out: Relationship[] = [];
  for (const r of store.values()) {
    if (r.from !== from) continue;
    out.push(decayRelationship(r, now));
  }
  const magnitude = (r: Relationship) =>
    Math.abs(r.trust) + Math.abs(r.affinity) + r.threat;
  return out.sort((x, y) => magnitude(y) - magnitude(x));
}

// Drop every record touching a dead islander. Keeps the map from growing across
// a long run; the dead cannot be voted for or allied with.
export function forgetAgent(store: RelationshipStore, id: string): void {
  for (const key of [...store.keys()]) {
    const r = store.get(key);
    if (r && (r.from === id || r.to === id)) store.delete(key);
  }
}

// A short human sentence describing how `from` reads `to`, for prompt injection
// and for debugging. Returns null when there is no meaningful history, so a
// prompt does not get padded with "you feel neutral about everyone".
//
// The fight/tension counts below are WEIGHTED (weightedOutcomeCount), not raw
// history lengths. Before this, a grudge whose numeric trust had already
// decayed back toward neutral still narrated "you fought 3 times" at full
// intensity -- the sentence and the numbers disagreed, because the numeric
// axes decay (via `faded`) but a raw `.filter().length` does not. Now both
// halves of the record fade on the same clock, so the narrated intensity
// tracks the numbers rather than diverging from them.
export function describeRelationship(
  r: Relationship,
  toName: string,
  now: number = r.updatedAt,
): string | null {
  if (r.history.length === 0) return null;
  const bits: string[] = [];
  if (r.trust > 0.3) bits.push("you trust them");
  else if (r.trust < -0.3) bits.push("you do not trust them");
  if (r.affinity > 0.3) bits.push("you like them");
  else if (r.affinity < -0.3) bits.push("you dislike them");
  if (r.threat > 0.45) bits.push("they are dangerous to you");
  const fights = weightedOutcomeCount(r, "fight", now);
  const tensions = weightedOutcomeCount(r, "tension", now);
  const witnessedKills = weightedOutcomeCount(r, "witnessedKill", now);
  // Round for narration: a fight that has faded to a third of its weight
  // still reads as "you fought once", not as a fraction nobody would say.
  const foughtN = Math.round(fights);
  if (foughtN > 0) bits.push(foughtN === 1 ? "you fought once" : `you fought ${foughtN} times`);
  else if (tensions > 1) bits.push("things have been tense");
  if (witnessedKills >= 0.5) bits.push("you saw them kill someone");
  if (bits.length === 0) return null;
  return `${toName}: ${bits.join(", ")}.`;
}
