import type {
  AgentContextView,
  AgentDecision,
  Class,
  NearbyAgent,
  WorldStateView,
} from "@arena/shared";
import { tunables } from "@arena/shared";

// ---------------------------------------------------------------------------
// Task 4.4: deterministic rule-based decision engine.
//
// Serves triple duty (ARCHITECTURE.md 7.7): the spend-cap / timeout fallback
// for the LLM, pre-Phase-4 (and pre-LLM) behavior so the game is fully
// playable with the model off, and the decision source for the headless
// balance harness (Phase 5.4). It scores an action from class identity times
// state features; given the same context and rng it always returns the same
// decision.
//
// It reads ONLY the shared AgentContextView (the frozen contract, 4.0) and
// returns an AgentDecision -- no server state, no sockets.
//
// The behavior spec added a second job: this file is now also where the
// cognition the MODEL path reasons about is computed (the section immediately
// below). The prompt layer narrates those scores to a model and the rule engine
// acts on them directly, so both brains are playing the same game rather than
// two subtly different ones. Everything there is pure, flag-gated, and returns
// a neutral answer when its flag is off or the optional context it wants was
// never populated.
// ---------------------------------------------------------------------------

// Within this range a bold agent commits to attack instead of just closing in.
const ATTACK_RANGE_PX = 28; // ~1.75 tiles
const LOW_HP = 0.4;
const HIGH_NOTORIETY = 20; // one kill (+12) plus decay lands agents around here
const SCHEMER_BETRAY_HP = 0.6; // a schemer only knifes an ally already softened

function weakest(list: NearbyAgent[]): NearbyAgent | null {
  let best: NearbyAgent | null = null;
  for (const n of list) if (!best || n.hpFraction < best.hpFraction) best = n;
  return best;
}
function nearest(list: NearbyAgent[]): NearbyAgent | null {
  let best: NearbyAgent | null = null;
  for (const n of list) if (!best || n.distance < best.distance) best = n;
  return best;
}
function mostNotorious(list: NearbyAgent[]): NearbyAgent | null {
  let best: NearbyAgent | null = null;
  for (const n of list) if (!best || n.notoriety > best.notoriety) best = n;
  return best;
}
// "Strongest neighbor" a schemer/charmer wants as a protector: most kills,
// tie-broken by higher HP.
function strongest(list: NearbyAgent[]): NearbyAgent | null {
  let best: NearbyAgent | null = null;
  for (const n of list) {
    if (!best || n.kills > best.kills || (n.kills === best.kills && n.hpFraction > best.hpFraction)) {
      best = n;
    }
  }
  return best;
}

const wander = (reasoning: string): AgentDecision => ({ action: "wander", target: null, reasoning });
const layLow = (reasoning: string): AgentDecision => ({ action: "layLow", target: null, reasoning });

// ===========================================================================
// Shared cognition. Read by prompts.ts (to narrate), by backends/rules.ts (to
// choose what to say), and by the engine below (to choose what to do).
// ===========================================================================

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Where the ramp sits when there is no elapsed-time input at all. Low on
// purpose: "I cannot tell how long this has been going" should read as "it is
// probably early", not as "assume the worst".
// Read at each use site from tunables.decision.earlyRampFloor rather than
// destructured here, because tunables is mutated in place by reloadTunables
// (tests and the client both call it) and a destructured copy would go stale.

// How much of the warmup window has actually gone by.
//
// runElapsedMs is the real answer, and WorldStateView carries it for exactly
// this reason -- its own doc comment describes this failure. The countdown to
// the first scheduled event is kept underneath it only for a snapshot that
// predates the field, because it measures the wrong quantity: time until
// something happens, not time since the start. The two are only even
// proportional when the countdown happens to be the same length as the warmup
// window, and when they are not, the ratio is noise. That is why the opening
// minutes read uniformly placid instead of warming up.
function warmupElapsedMs(w: WorldStateView, warmupMs: number): number | null {
  if (w.runElapsedMs != null) return w.runElapsedMs;
  if (w.secondsUntilEvent != null) return warmupMs - w.secondsUntilEvent * 1000;
  return null;
}

// How far along the run is, as a 0..1 ramp on conflict.
//
// world.phase is the coarse band; inside the opening band the ramp climbs with
// elapsed run time measured against the warmup window, which is what makes the
// opening go smoothly from quiet to lively instead of stepping up all at once
// when a phase boundary is crossed.
//
// With no world snapshot at all this used to return the FULL early cap, which
// meant turning on earlyAggression without worldAwareness started the villa at
// its early-game ceiling on tick one: the exact opposite of a warmup, and a
// reachable configuration since the two flags are independent env reads. It now
// sits at the floor of the early band instead.
export function aggressionRamp(ctx: AgentContextView): number {
  const k = tunables.swarm;
  const w = ctx.world;
  if (!w) return k.rampEarlyCap * tunables.decision.earlyRampFloor;
  switch (w.phase) {
    case "early": {
      const warmupMs = tunables.conflict.warmupMs;
      if (warmupMs <= 0) return k.rampEarlyCap;
      const elapsedMs = warmupElapsedMs(w, warmupMs);
      // Nothing to measure against yet: the run has not started ticking and no
      // event has been scheduled, so barely anything has happened.
      if (elapsedMs == null) return k.rampEarlyCap * tunables.decision.earlyRampFloor;
      return clamp01(elapsedMs / warmupMs) * k.rampEarlyCap;
    }
    case "mid":
      return k.rampMid;
    case "late":
      return k.rampLate;
    case "endgame":
      return 1;
  }
}

// ---------------------------------------------------------------------------
// The room, the record, and the gossip, as multipliers on what an agent starts.
//
// All three read context fields that the server computes on every single think
// and that, until now, nothing in this package read at all. Each is gated on
// the flag that governs ACTING on the signal rather than the one that captures
// it, and each returns a neutral 1 when its flag is off, so they compose onto
// the base likelihoods without changing the flags-off game.
// ---------------------------------------------------------------------------

// Crowded versus secluded, weighted by temperament. A single global "crowds
// raise conflict" number would be wrong for everyone: a crowd is an audience to
// the bold and a risk to the timid, and a schemer only schemes when nobody is
// watching. spatialAwareness gates the SIGNAL; spatialBehavior gates whether
// anything acts on it, which is why an operator can hold one still and move the
// other.
export function spatialMultiplier(ctx: AgentContextView): number {
  if (!tunables.flags.spatialBehavior) return 1;
  switch (ctx.spatial?.density) {
    case "crowded":
      return tunables.spatial.crowdedMultipliers[ctx.self.klass] ?? 1;
    case "secluded":
      return tunables.spatial.secludedMultipliers[ctx.self.klass] ?? 1;
    default:
      return 1;
  }
}

// How much accumulated bad blood is standing within reach.
//
// Without this the relationship record is a diary rather than a mechanism: the
// spec's rule that accumulated tension raises the odds of a future fight had no
// path into the deterministic engine, because conflictChance was base times
// class times ramp and nothing else. The strongest single reading in the room
// decides it rather than the average, because one person you genuinely cannot
// stand is what starts a fight and a broad mild irritation is not; averaging
// would wash exactly that out. Only people actually nearby count, since a
// grudge against someone across the villa does not make THIS encounter go badly.
// Read at each use site from tunables.decision.grievanceConflictGain rather
// than destructured here, because tunables is mutated in place by
// reloadTunables (tests and the client both call it) and a destructured copy
// would go stale. Full heat at gain 1 at most doubles the base chance.

export function grievanceHeat(ctx: AgentContextView): number {
  if (!tunables.flags.relationshipMemory) return 1;
  const rels = ctx.relationships;
  if (!rels || rels.length === 0) return 1;
  const reachable = new Set(ctx.nearby.filter((n) => !n.allied).map((n) => n.id));
  let worst = 0;
  for (const r of rels) {
    if (!reachable.has(r.id)) continue;
    // Threat and soured affinity both feed it: the person who is dangerous AND
    // resented is the one an islander finally squares up to.
    const heat = clamp01(r.threat * 0.6 + clamp01(-r.affinity) * 0.4);
    if (heat > worst) worst = heat;
  }
  return 1 + worst * tunables.decision.grievanceConflictGain;
}

// Did this agent overhear its own name being worked on?
//
// OverheardFragment carries `aboutId`, which the server fills by scanning the
// line for a living islander's name, so "they were talking about ME" is
// directly answerable -- and until now nothing anywhere in this package read
// the field. Catching your own name in a conversation you were not invited to
// is the loudest warning the villa gives that a vote is forming, so it both
// raises the push to get ahead of it and, below, counts as a reason to deflect.
//
// Gated on `gossip` rather than on `overhearing`: overhearing gates whether a
// fragment is CAPTURED, gossip gates whether it is ever acted on.
// Read at each use site from tunables.decision.targetedVotePushGain rather
// than destructured here, because tunables is mutated in place by
// reloadTunables (tests and the client both call it) and a destructured copy
// would go stale.

export function heardOwnNameTargeted(ctx: AgentContextView): boolean {
  if (!tunables.flags.gossip) return false;
  const heard = ctx.overheard;
  if (!heard || heard.length === 0) return false;
  return heard.some((f) => f.aboutId === ctx.self.id && f.speakerId !== ctx.self.id);
}

function targetedHeat(ctx: AgentContextView): number {
  return heardOwnNameTargeted(ctx) ? tunables.decision.targetedVotePushGain : 1;
}

// The one irreversible thing that has happened since this agent last thought.
//
// ctx.recentEvents is assembled per agent on every think and, like ctx.spatial
// and ctx.overheard, had no reader: an islander could watch three people leave
// in a purge and carry on hunting as though nothing had changed. Ordered by
// how much it reorganizes the villa, so a purge outranks a single death.
export type Shock = "hostile" | "purge" | "death" | null;

export function recentShock(ctx: AgentContextView): Shock {
  if (!tunables.flags.worldAwareness) return null;
  const events = ctx.recentEvents;
  if (!events || events.length === 0) return null;
  let found: Shock = null;
  for (const e of events) {
    if (e.kind === "hostile") return "hostile";
    if (e.kind === "purge") found = "purge";
    else if (e.kind === "death" && found == null) found = "death";
  }
  return found;
}

// A cornered islander plays differently, and which way it breaks is a matter of
// temperament rather than of odds. "push" and "withdraw" are both responses to
// the same weak standing; nothing here changes who the agent is, only what it
// decides to do about it.
export type OddsPosture = "push" | "withdraw" | "steady";

export function oddsPosture(ctx: AgentContextView): OddsPosture {
  if (!tunables.flags.selfOdds) return "steady";
  const odds = ctx.selfOdds;
  if (!odds) return "steady";
  if (odds.band !== "precarious" && odds.band !== "shaky") return "steady";
  switch (ctx.self.klass) {
    case "bold":
    case "schemer":
      return "push";
    case "timid":
    case "charmer":
      return "withdraw";
    default:
      // A wildcard needs to actually be rattled before it changes anything.
      return odds.worried ? "withdraw" : "steady";
  }
}

// Feeling cornered moves the dial rather than replacing it, so a timid agent
// under pressure is still a timid agent, just quieter still.
function postureBias(ctx: AgentContextView): number {
  switch (oddsPosture(ctx)) {
    case "push":
      return 1.5;
    case "withdraw":
      return 0.5;
    default:
      return 1;
  }
}

// Chance this agent picks a fight in a given encounter, and chance it works a
// vote on a given think. Both are the tunable base times the class multiplier
// times the warmup ramp, which is what turns "raise the early baseline" into
// something that arrives gradually and differs by personality. The three terms
// after that are the situational reads above, each of which is 1 unless its
// flag is on AND the context it wants was actually populated.
export function conflictChance(ctx: AgentContextView): number {
  if (!tunables.flags.earlyAggression) return 0;
  const k = tunables.conflict;
  const mul = k.conflictMultipliers[ctx.self.klass] ?? 1;
  return clamp01(
    k.baseConflictChance *
      mul *
      aggressionRamp(ctx) *
      postureBias(ctx) *
      spatialMultiplier(ctx) *
      grievanceHeat(ctx),
  );
}

export function votePushChance(ctx: AgentContextView): number {
  if (!tunables.flags.earlyAggression) return 0;
  const k = tunables.conflict;
  const mul = k.votePushMultipliers[ctx.self.klass] ?? 1;
  return clamp01(
    k.baseVotePushChance *
      mul *
      aggressionRamp(ctx) *
      postureBias(ctx) *
      spatialMultiplier(ctx) *
      targetedHeat(ctx),
  );
}

// ---------------------------------------------------------------------------
// Alliance appetite.
//
// The two social classes returned proposeAlliance on essentially every think
// without ever looking at how many allies they already had, and the server
// turns that request into a conversation directly rather than rolling for it,
// so "propose again" and "start another conversation" were the same event. Two
// of five personalities therefore manufactured alliance-shaped conversations
// continuously, which is a large part of why a spectator sees nothing but
// handshakes and pacts.
//
// Two things bound it now, and they answer different halves of the problem.
// Appetite answers "do I even want another one", and falls off faster than
// linearly as the bloc fills toward the configured maximum, because each ally
// already held both reduces the need and uses up the room. The cooldown answers
// "did I just do this", which appetite cannot: an agent with no allies at all
// has full appetite and would still ask on every single think.
// ---------------------------------------------------------------------------

export function allianceAppetite(ctx: AgentContextView): number {
  if (!tunables.flags.multiAlliances) return 1;
  const max = Math.max(1, tunables.social.maxAllianceSize);
  // self.allies is the flat list; alliance.size counts the bloc including this
  // agent. Take whichever knows about more people, so a member of a bloc it has
  // not individually allied with every member of is still counted as satiated.
  const held = Math.max(ctx.self.allies.length, (ctx.alliance?.size ?? 1) - 1);
  const room = clamp01(1 - held / max);
  return room * room;
}

// How long an agent waits before opening another alliance approach. Read at
// each use site from tunables.decision.allianceOpenCooldownMs rather than
// destructured here, because tunables is mutated in place by reloadTunables
// (tests and the client both call it) and a destructured copy would go stale.

// When each agent last opened one, on the run clock.
//
// This engine is otherwise pure, so the exception deserves its reasoning.
// Spacing repeated proposals apart needs a clock and a memory of the last one,
// and AgentContextView deliberately carries no per-agent scratch space. Keyed
// by contestant id, which is minted fresh per game, so an entry left behind by
// a finished game can never be read by a later one in the same process even
// though the map outlives the game. The clock is world.runElapsedMs, which
// restarts at zero with each run; with no clock available the cooldown is
// skipped outright rather than guessed at, and appetite alone does the work.
const lastAllianceOpenAt = new Map<string, number>();

// For tests and for a harness that runs several games in one process and wants
// a clean slate rather than relying on id uniqueness.
export function resetAllianceCooldowns(): void {
  lastAllianceOpenAt.clear();
}

// Whether this agent actually opens an alliance approach this think.
//
// The flag is checked before the draw, per the RNG discipline this file keeps
// (see the note above the early-aggression roll): a disabled path must never
// consume from `rand`.
function opensAlliance(ctx: AgentContextView, rand: () => number): boolean {
  if (!tunables.flags.multiAlliances) return true;
  const now = ctx.world?.runElapsedMs ?? null;
  if (now != null) {
    const last = lastAllianceOpenAt.get(ctx.self.id);
    if (last != null && now - last < tunables.decision.allianceOpenCooldownMs) return false;
  }
  if (rand() >= allianceAppetite(ctx)) return false;
  if (now != null) lastAllianceOpenAt.set(ctx.self.id, now);
  return true;
}

// The server's perception radius, which is as far as ctx.nearby ever reaches.
// Used to turn a distance into a 0..1 closeness so proximity can be one term
// in a score rather than the whole of it.
const PERCEPTION_PX = 256;

const closeness = (n: NearbyAgent) => 1 - clamp01(n.distance / PERCEPTION_PX);

// Who this agent would actually rather team up with.
//
// Every alliance target used to be chosen on physical grounds alone: nearest,
// strongest, weakest. Two islanders with a warm history were no likelier to
// team up than two strangers who happened to be standing close, which
// contradicts the whole point of keeping a relationship record. Warmth leads
// and proximity breaks ties underneath it, and someone this agent has actively
// soured on is not a prospect at any distance.
//
// Each caller passes ITS OWN positional choice, which is what gets used when
// there is no record to rank on: the schemer wants the strongest neighbor, the
// charmer the nearest. Picking one shared fallback here would quietly change
// who a schemer courts with relationship memory off, and that is a flags-off
// behavior change. A null result means the ranking ran and nobody qualified,
// which is a real answer -- there is genuinely nobody here worth asking -- and
// is deliberately NOT the same as falling back.
// Read at each use site from tunables.decision.prospectProximityWeight and
// tunables.decision.prospectHostilityFloor rather than destructured here,
// because tunables is mutated in place by reloadTunables (tests and the
// client both call it) and a destructured copy would go stale.

export function bestProspect(
  ctx: AgentContextView,
  candidates: NearbyAgent[],
  positional: (list: NearbyAgent[]) => NearbyAgent | null,
): NearbyAgent | null {
  if (candidates.length === 0) return null;
  if (!tunables.flags.relationshipMemory) return positional(candidates);
  const rels = new Map((ctx.relationships ?? []).map((r) => [r.id, r]));
  let best: NearbyAgent | null = null;
  let bestScore = -Infinity;
  for (const n of candidates) {
    const r = rels.get(n.id);
    const warmth = r ? r.trust * 0.6 + r.affinity * 0.4 : 0;
    if (warmth < tunables.decision.prospectHostilityFloor) continue;
    const score = warmth + closeness(n) * tunables.decision.prospectProximityWeight;
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Vote reasoning.
//
// The rule the spec is really after: you do not write a name down because you
// dislike someone. Three things decide it, and they pull against each other.
//
//   threat      does this person beat me if they stay
//   likability  how loved are they, which makes them MORE worth removing and at
//               the same time HARDER to remove, because their friends vote too
//   the numbers do the votes to actually do it exist
//
// Dislike is in there, but as the smallest term. An agent that only had a
// grudge and no case would rank its enemy below a beloved rival, which is
// exactly the Survivor read.
// ---------------------------------------------------------------------------

export type VoteRead = {
  id: string;
  name: string;
  threat: number; // 0..1
  likability: number; // 0..1
  grievance: number; // 0..1, this agent's own soured feeling
  score: number;
  // Whether this agent can plausibly find the votes right now.
  feasible: boolean;
  votesOnHand: number;
  votesNeeded: number;
  // One private sentence citing the reasoning, never raw dislike.
  line: string;
};

// A target this loved costs an extra body to move, because the people who adore
// them have to be talked around first.
const BELOVED = 0.6;

// A name this agent carries around but cannot currently see scores lower than
// an equivalent one standing in front of it, which is correct: you campaign
// against the person in the room.
// How many out-of-sight names are worth carrying. The record is villa-wide, but
// a vote plan naming everyone is not a plan.
// Both read at each use site from tunables.decision.offscreenScoreScale and
// tunables.decision.offscreenCandidates rather than destructured here, because
// tunables is mutated in place by reloadTunables (tests and the client both
// call it) and a destructured copy would go stale.
// Public favor for someone out of sight, when there is nobody nearby to
// calibrate against. Neutral by construction: the agent genuinely does not know.
const NEUTRAL_FAVOR = 0.5;

function voteLine(r: Omit<VoteRead, "line">): string {
  const why =
    r.threat > 0.5
      ? `${r.name} wins this if they stay`
      : r.likability > BELOVED
        ? `the whole villa adores ${r.name}, and that beats me at the end`
        : r.grievance > 0.5
          ? `${r.name} and I are past patching up, and they know it`
          : `${r.name} is the name I could actually get people to say`;
  const math = r.feasible
    ? `I can count ${r.votesOnHand} of us and it takes ${r.votesNeeded}`
    : `I can only count ${r.votesOnHand} of us and it takes ${r.votesNeeded}, so not yet`;
  return `${why}. ${math}.`;
}

function computeVoteReads(ctx: AgentContextView): VoteRead[] {
  const k = tunables.swarm;
  const score = (threat: number, likability: number, grievance: number) =>
    k.voteWeightThreat * threat +
    k.voteWeightLikability * likability +
    k.voteWeightGrievance * grievance;
  const rels = new Map((ctx.relationships ?? []).map((r) => [r.id, r]));
  // Only the living count is knowable; without it, everyone this agent can see
  // plus itself is the best available estimate of the room.
  const living = ctx.world?.livingCount ?? ctx.nearby.length + 1;
  // Two is the floor: one vote is never a bloc.
  const votesNeeded = Math.max(2, Math.ceil(living * tunables.social.ousterThreshold));
  // The only bloc an agent can actually count on is its own alliance list. It
  // does not get to see anyone else's, which is precisely why the math is often
  // not there and the push gets abandoned.
  const votesOnHand = 1 + ctx.self.allies.length;

  const reads: VoteRead[] = [];
  for (const n of ctx.nearby) {
    const rel = rels.get(n.id);
    // Threat is what the relationship record learned, plus what anyone standing
    // nearby can plainly see: a body count and the notoriety it earned.
    const threat = clamp01(
      (rel?.threat ?? 0) * 0.6 + clamp01(n.kills / 3) * 0.3 + clamp01(n.notoriety / 40) * 0.1,
    );
    // How loved they are. priceYes is the villa's live favor and the only
    // villa-wide read available from this seat; this agent's own affinity for
    // them tilts it, because your own feelings do color who you think is liked.
    const likability = clamp01(n.priceYes * 0.75 + ((rel?.affinity ?? 0) + 1) / 2 * 0.25);
    const grievance = clamp01(-(rel?.affinity ?? 0));
    const cost = votesNeeded + (likability > BELOVED ? 1 : 0);
    const partial: Omit<VoteRead, "line"> = {
      id: n.id,
      name: n.name,
      threat,
      likability,
      grievance,
      score: score(threat, likability, grievance),
      feasible: votesOnHand >= cost,
      votesOnHand,
      votesNeeded: cost,
    };
    reads.push({ ...partial, line: voteLine(partial) });
  }

  // Names this agent carries but cannot currently see.
  //
  // The spec frames vote reasoning as villa-wide, but ctx.nearby is bounded by
  // the server's perception radius, so a genuine threat standing on the far
  // side of the map was simply invisible to the ranking: an agent could not
  // write down the name of the person it most wants gone unless that person
  // happened to be in the room. The relationship record IS the villa-wide view
  // an islander carries around, so anyone it has real history with belongs on
  // the list. What is lost off-screen is the observable half -- a body count, a
  // live read on how loved they are -- so those terms fall back to what the
  // room in front of the agent suggests, and the whole score is discounted.
  if (tunables.flags.relationshipMemory && ctx.relationships) {
    const seen = new Set(ctx.nearby.map((n) => n.id));
    const allies = new Set(ctx.self.allies);
    const favor =
      ctx.nearby.length > 0
        ? ctx.nearby.reduce((s, n) => s + n.priceYes, 0) / ctx.nearby.length
        : NEUTRAL_FAVOR;
    let added = 0;
    for (const r of ctx.relationships) {
      if (added >= tunables.decision.offscreenCandidates) break;
      if (seen.has(r.id) || allies.has(r.id) || r.id === ctx.self.id) continue;
      const threat = clamp01(r.threat * 0.6);
      const likability = clamp01(favor * 0.75 + ((r.affinity + 1) / 2) * 0.25);
      const grievance = clamp01(-r.affinity);
      // Nothing worth a vote plan: no fear of them and no bad blood.
      if (threat <= 0 && grievance <= 0) continue;
      const cost = votesNeeded + (likability > BELOVED ? 1 : 0);
      const partial: Omit<VoteRead, "line"> = {
        id: r.id,
        name: r.name,
        threat,
        likability,
        grievance,
        score: score(threat, likability, grievance) * tunables.decision.offscreenScoreScale,
        feasible: votesOnHand >= cost,
        votesOnHand,
        votesNeeded: cost,
      };
      reads.push({ ...partial, line: voteLine(partial) });
      added++;
    }
  }

  // Doable first, then by how much removing them is worth. An agent that cannot
  // reach its best target holds or switches rather than throwing the vote away.
  reads.sort((a, b) => Number(b.feasible) - Number(a.feasible) || b.score - a.score);
  return reads;
}

export function rankVoteTargets(ctx: AgentContextView): VoteRead[] {
  if (!tunables.flags.voteReasoning) return [];
  return computeVoteReads(ctx);
}

// ---------------------------------------------------------------------------
// Vote deflection: an islander who can feel the vote coming for it tries to put
// somebody else's name in the air instead.
// ---------------------------------------------------------------------------

// What an ungraded neighbor is assumed to be worth when there is no
// relationship record to consult. Preserved as the numbers the flat fallback
// always used, so the flags-off read is unchanged.
const ALLY_ASSUMED_TRUST = 0.5;
const NON_ALLY_ASSUMED_TRUST = -1;
// Small on purpose: this separates equals, it does not reorder unequals.
// Read at each use site from tunables.decision.deflectTiebreakWeight rather
// than destructured here, because tunables is mutated in place by
// reloadTunables (tests and the client both call it) and a destructured copy
// would go stale.

// Who would plausibly hear this agent out right now: someone close by who is
// not themselves a walking threat. Neither half is a feeling, so this stays
// usable with relationship memory switched off, which is exactly the case the
// flat fallback above could not separate.
function approachability(n: NearbyAgent): number {
  return closeness(n) * 0.6 + (1 - clamp01(n.notoriety / 40)) * 0.4;
}

export type DeflectionPlan = {
  // The person to lean on: whoever this agent trusts most and can reach.
  ally: NearbyAgent | null;
  // The name to put forward instead. May be null when nobody is nearby.
  toward: VoteRead | null;
};

// Is something close enough that getting in front of it is the right play?
//
// world.posture is the precise signal, but ctx.world is only populated under
// the separate worldAwareness flag, so requiring it made voteDeflection a dead
// flag on its own: enabling it alone could never once return true, because the
// field it tests is never there. ctx.event is the older countdown line, is
// populated regardless of any behavior flag, and is enough to know something is
// bearing down. "active" is admitted alongside "imminent" for the same reason:
// a vote that has started is not a moment to stop working.
function eventIsBearingDown(ctx: AgentContextView): boolean {
  const posture = ctx.world?.posture;
  if (posture === "imminent" || posture === "active") return true;
  const e = ctx.event;
  return e != null && (e.kind === "weakestLink" || e.kind === "purge");
}

export function isDeflecting(ctx: AgentContextView): boolean {
  if (!tunables.flags.voteDeflection) return false;
  if (!eventIsBearingDown(ctx)) return false;
  const band = ctx.selfOdds?.band;
  if (band === "precarious" || band === "shaky") return true;
  // Overhearing your own name in a conversation you were not part of is the
  // plainest warning the villa gives, and it needs no self-odds signal.
  if (heardOwnNameTargeted(ctx)) return true;
  // With no self-odds signal, the other tell is being ringed by people this
  // agent reads as dangerous. threat is a directional record, so several high
  // readings at once is the closest thing the context has to "I am the one in
  // trouble here".
  return (ctx.relationships ?? []).filter((r) => r.threat >= 0.5).length >= 2;
}

export function deflectionPlan(ctx: AgentContextView): DeflectionPlan | null {
  if (!isDeflecting(ctx)) return null;
  const trust = new Map((ctx.relationships ?? []).map((r) => [r.id, r.trust]));
  let ally: NearbyAgent | null = null;
  let bestScore = -Infinity;
  let bestTrust = -Infinity;
  for (const n of ctx.nearby) {
    // Fall back to the flat ally list when there is no graded record yet, so
    // deflection still works with relationship memory switched off.
    const t = trust.get(n.id) ?? (n.allied ? ALLY_ASSUMED_TRUST : NON_ALLY_ASSUMED_TRUST);
    // ...but not to a flat constant, which is what made this degenerate. Every
    // ungraded neighbor tied at exactly the same number, so `>` kept whichever
    // happened to be first in ctx.nearby and the same person got leaned on
    // every single time: deflection targets were positional rather than social.
    // Approachability breaks the tie on an actual signal, weighted small enough
    // that it can never outrank a real difference in trust.
    const score = t + approachability(n) * tunables.decision.deflectTiebreakWeight;
    if (score > bestScore) {
      bestScore = score;
      bestTrust = t;
      ally = n;
    }
  }
  // Never point the vote at the person being leaned on for help.
  const toward = computeVoteReads(ctx).find((v) => v.id !== ally?.id) ?? null;
  return { ally: bestTrust > 0 ? ally : null, toward };
}

// ---------------------------------------------------------------------------
// Conversation topics. Game talk is one of these, not the whole list.
// ---------------------------------------------------------------------------

export type Topic =
  | "game"
  | "smallTalk"
  | "backstory"
  | "home"
  | "food"
  | "weather"
  | "setting"
  | "joke"
  | "likes";

// smallTalk carries the heaviest base weight because it is the one pool written
// per class: it is where the personalities actually sound like themselves, so
// widening the topic list must not drown it out.
const TOPIC_BASE: Record<Topic, number> = {
  game: 1,
  smallTalk: 1.8,
  backstory: 1,
  home: 0.8,
  food: 0.7,
  weather: 0.6,
  setting: 0.9,
  joke: 1.1,
  likes: 1,
};

// What each personality actually reaches for when there is nothing forcing the
// subject. This is the main thing keeping five voices from collapsing into one.
const CLASS_TOPIC_BIAS: Record<Class, Partial<Record<Topic, number>>> = {
  bold: { joke: 1.8, game: 1.2, weather: 0.5, home: 0.5 },
  timid: { home: 1.9, backstory: 1.5, joke: 0.7, game: 0.5 },
  schemer: { game: 1.7, backstory: 1.3, likes: 1.2, weather: 0.4 },
  charmer: { likes: 1.8, joke: 1.4, backstory: 1.3, game: 0.6 },
  wildcard: { setting: 1.8, weather: 1.6, joke: 1.4, game: 0.5 },
};

// How hard the situation pulls the conversation back to the game. Nobody talks
// tactics on day one; everybody does with a vote counting down.
function gameTalkPull(ctx: AgentContextView): number {
  let m = 1;
  const w = ctx.world;
  if (w) {
    m *= w.phase === "early" ? 0.45 : w.phase === "mid" ? 0.9 : w.phase === "late" ? 1.4 : 2;
    m *=
      w.posture === "imminent"
        ? 2.4
        : w.posture === "active"
          ? 2.8
          : w.posture === "justPassed"
            ? 1.6
            : 1;
  } else if (ctx.event) {
    // No world snapshot, but a countdown line is itself proof something is
    // bearing down, which is enough to pull the subject.
    m *= 2;
  }
  // An agent that privately thinks it is in trouble cannot leave the subject
  // alone, whatever the villa is doing.
  if (ctx.selfOdds?.worried) m *= 1.6;
  return m;
}

// Pick what this line is about. `roll` is 0..1 from the caller's generator, so
// this stays deterministic for the balance harness and for the prompt layer,
// which has no generator of its own.
export function chooseTopic(ctx: AgentContextView, roll: number): Topic {
  // Off means today's behavior: the class small-talk pools, which is the only
  // ordinary register the game had.
  if (!tunables.flags.conversationVariety) return "smallTalk";

  const bias = CLASS_TOPIC_BIAS[ctx.self.klass] ?? {};
  const topics = Object.keys(TOPIC_BASE) as Topic[];
  const weights = topics.map((t) => {
    const w = TOPIC_BASE[t] * (bias[t] ?? 1);
    return t === "game" ? w * gameTalkPull(ctx) : w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return "smallTalk";

  let cut = clamp01(roll) * total;
  for (let i = 0; i < topics.length; i++) {
    cut -= weights[i]!;
    if (cut <= 0) return topics[i]!;
  }
  return "smallTalk";
}

// ---------------------------------------------------------------------------
// Speech sanitizing: no dashes in anything an islander says or thinks.
//
// Every backend is told not to emit them and every backend does anyway, so this
// is the guarantee rather than the request. It lives here, next to the
// templated lines and the reasoning strings the rule engine writes, and is
// applied at the two chokepoints all text passes through: the conversation turn
// loop for speech, and the decision path for the private thought the audience
// reads.
//
// A dash carries meaning, so each shape is rewritten as what it stood for
// rather than merely deleted.
// ---------------------------------------------------------------------------

// Every dash-like character, not just the ASCII one: hyphen-minus, the Unicode
// hyphens, figure/en/em/horizontal bar, and the minus sign.
const DASH_CLASS = "-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015\\u2212";
const RANGE_RE = new RegExp(`(\\d)\\s*[${DASH_CLASS}]+\\s*(\\d)`, "g");
const WIDE_PAUSE_RE = /\s*[‒–—―−]+\s*/g;
const SPACED_PAUSE_RE = /\s+-+\s+/g;
const DOUBLE_RE = /-{2,}/g;
const COMPOUND_RE = /([A-Za-z]+)[-‐‑]([A-Za-z])/g;
const LEFTOVER_RE = new RegExp(`[${DASH_CLASS}]`, "g");

// A prefix this short reads wrong with a space in it ("re do", "co op", "e
// mail"), so those close up; anything longer is fine as two words.
const CLOSE_UP_PREFIX = 2;

export function stripSpeechDashes(raw: string): string {
  if (!tunables.flags.stripDashes) return raw;
  const cleaned = raw
    // A dash between numbers is a range, which is a word.
    .replace(RANGE_RE, "$1 to $2")
    // An em/en dash anywhere, or a spaced or doubled hyphen, was a pause. A
    // comma is what the pause was standing in for.
    .replace(WIDE_PAUSE_RE, ", ")
    .replace(SPACED_PAUSE_RE, ", ")
    .replace(DOUBLE_RE, ", ")
    // A hyphen inside a compound word.
    .replace(COMPOUND_RE, (_m, head: string, next: string) =>
      head.length <= CLOSE_UP_PREFIX ? `${head}${next}` : `${head} ${next}`,
    )
    // Whatever survives is hanging off the front or back of a word.
    .replace(LEFTOVER_RE, " ")
    // Tidy the seams the substitutions leave behind.
    .replace(/\s+/g, " ")
    .replace(/,{2,}/g, ",")
    .replace(/,\s*([,.!?;:])/g, "$1")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/^[,\s]+/, "")
    .replace(/[,\s]+$/, "")
    .trim();
  // A line that sanitized down to nothing is worse than one with a dash in it,
  // so the original stands in that (pathological) case.
  return cleaned.length > 0 ? cleaned : raw;
}

// The private thought is audience-visible text, so it goes through the same
// no-dash guarantee spoken lines do. Wrapping here rather than at each call
// site covers the scheduler's rule-only thinker as well as decisions.ts.
export function fallbackDecision(ctx: AgentContextView, rand: () => number): AgentDecision {
  const d = decideAction(ctx, rand);
  const reasoning = stripSpeechDashes(d.reasoning);
  return reasoning === d.reasoning ? d : { ...d, reasoning };
}

// ---------------------------------------------------------------------------
// Private-thought variety.
//
// The class switch below returned a handful of fixed strings, every one of
// which the scheduler ships to telemetry and the server surfaces to viewers, so
// a spectator watched the same dozen thoughts cycle for a whole run. That is
// the decision-side half of "they say the same things consistently".
//
// The variety must not cost an RNG draw. Every one of these strings is also
// produced on the flags-off path, and the discipline this file keeps (see the
// note above the early-aggression roll) is that a draw only ever happens on a
// path a flag has already opened; drawing here would shift every later draw and
// change the flags-off game. So the index comes from a cheap hash of things
// that are stable within a moment but differ between agents and drift across a
// run: who is thinking, how it has gone for them, and how busy the room is.
// Two islanders in the same situation say different things, and the same
// islander says something different once the situation moves.
//
// Index 0 of every pool is the line the pre-spec build produced, and with
// conversationVariety off that is what comes back, so the flags-off thought
// stream is unchanged.
function variantIndex(ctx: AgentContextView, salt: number, span: number): number {
  const s = ctx.self;
  let h = (salt * 2654435761) >>> 0;
  for (let i = 0; i < s.id.length; i++) h = (Math.imul(h, 31) + s.id.charCodeAt(i)) >>> 0;
  h = (Math.imul(h, 31) + s.kills * 7 + Math.round(s.hpFraction * 4) + ctx.nearby.length) >>> 0;
  return h % span;
}

function pick(pool: readonly string[], ctx: AgentContextView, salt: number): string {
  if (!tunables.flags.conversationVariety || pool.length < 2) return pool[0]!;
  return pool[variantIndex(ctx, salt, pool.length)]!;
}

// Fill the one placeholder these pools use. Kept to a single token so a pool
// stays readable as prose rather than as a template language.
const fill = (line: string, name: string) => line.split("{p}").join(name);

// The pools themselves. {p} is whoever the thought is about.
//
// Index 0 is always the pre-spec line, so the flags-off thought stream is the
// one the game already had. The four places that shipped a dash are the sole
// exception: they are rewritten here to the same sentence without one, since
// the no-dash rule is absolute and stripSpeechDashes was only ever a second
// line of defence for text this file writes itself.
//
// Depth is the point of these, not decoration. The measured baseline was 59%
// distinct lines across a run with one line repeated five times, and a pool of
// three or four entries cannot fix that: with fifty islanders drawing from it,
// a four line pool guarantees collisions within the first minute. Each pool
// therefore carries ten distinct readings of the same beat, written in the
// voice its name implies, which is the same depth the speech pools in
// backends/rules.ts already keep. Adding to a pool is always safe; index 0 is
// the only entry with a contract attached, so append rather than insert.

const HOSTILE_ATTACK_LINES = [
  "sudden death, no way out",
  "there is nowhere left to stand. one of us walks off this beach.",
  "no allies now, no villa, no rules. just this.",
  "I stopped planning about an hour ago. now I just move.",
  "the talking part of this game is over. I can feel it.",
  "everyone I made promises to is already gone. so much for that.",
  "I am not going to pretend to be sorry about what happens next.",
  "whoever is left gets to decide what all this meant. I intend to be them.",
  "no more counting votes. there is nobody left to count.",
  "I came here to win and I have finally stopped being embarrassed about saying it.",
] as const;

// A death or a purge just landed and this agent wants a body beside it.
const SHOCK_HUDDLE_LINES = [
  "{p} is still here and so am I. I am not standing on my own after that.",
  "The villa just got smaller. I want to be next to {p} while I work out what that means.",
  "That could have been me. I am going to find {p} and stay found.",
  "Everyone is counting heads. I would rather be counted next to {p}.",
  "I do not want to be on my own right now, and {p} is who I want to not be alone with.",
  "Whatever that was, {p} and I are going to be standing together for the next one.",
  "The room feels wrong. Being near {p} makes it feel slightly less wrong.",
  "People will start choosing sides within the hour. I am choosing {p} now.",
  "I keep looking at the space where they were standing. I need {p} in front of me instead.",
  "Everything I thought I knew changed in a minute. {p} first, thinking second.",
] as const;

// ...or would rather stand still and do the arithmetic.
const SHOCK_RECKON_LINES = [
  "Fewer of us now. Every number in my head just changed and I need a minute with it.",
  "That thinned the room out. Quiet is the right move until I see who is left standing with who.",
  "Half the plans I had were about people who are not here anymore.",
  "Nobody should be loud right after that. I am going to watch instead.",
  "The maths just moved under my feet. I am not saying a word until I have redone it.",
  "This is when people say things they regret. I would rather be the one listening.",
  "Everyone reshuffles tonight. I want to see the new shape before I join it.",
  "One less body in here changes who needs who. That is worth an hour of silence.",
  "I am not frightened exactly. I just do not know where I stand anymore.",
  "The smart play right now is to be the least interesting person in this villa.",
] as const;

const BOLD_IDLE_LINES = [
  "nobody worth chasing",
  "no one out here is giving me a reason to move",
  "empty stretch of sand and nobody in it worth my time",
  "all this space and not one person brave enough to be standing in it",
  "I am bored, and bored is the most dangerous thing I get",
  "nothing to hunt and nothing to prove. I hate both of those.",
  "quiet day. those never last long around me.",
  "somebody is going to walk past eventually and regret the timing",
  "I could go looking for trouble. I probably will.",
  "standing about waiting for this villa to remember I am in it",
] as const;

const BOLD_ATTACK_LINES = [
  "{p} is easy pickings",
  "{p} is standing right there looking soft about it",
  "I have been waiting for {p} to be this close and this tired",
  "{p} has been coasting on other people all week. Not today.",
  "no crowd, nobody in the way, just {p} and me",
  "{p} talks a good game right up until somebody actually comes at them",
  "this is going to hurt {p} a lot more than it inconveniences me",
  "{p} looked straight through me on day one. They are looking now.",
  "I do not need a reason for {p}. I just need the space.",
  "everyone has been waiting for somebody to do this to {p}. Fine. Me.",
] as const;

const BOLD_VOTE_LINES = [
  "Making noise before the vote. Let them remember who runs this beach: me.",
  "You do not survive a vote by being forgettable. So I will not be.",
  "Let them write down whoever they like. They will still be talking about me.",
  "A vote is a popularity contest with better lighting. I can win those loud.",
  "Half this villa is hiding before the vote. That is exactly why I am not.",
  "I would rather be voted out for something than survive for nothing.",
  "If my name comes up tonight they are going to have to say it to my face.",
  "Nobody axes the person holding the whole villa's attention. So I will hold it.",
  "Let them plot in corners. I am going to stand in the middle of this place.",
  "The quiet ones always go first in a vote. I have never once been the quiet one.",
] as const;

const BOLD_PURGE_LINES = [
  "Not hiding from any Purge. Let them all watch me go at {p}.",
  "A Purge is coming and I am going to be the loudest thing in it. Starting with {p}.",
  "Everyone else is going quiet before the Purge. I am going straight at {p}.",
  "If this villa is about to lose people, I want it obvious it is not me. {p} first.",
  "The Purge takes whoever looks weakest. So I am going to make {p} look weakest.",
  "People brace for a Purge. I would rather swing at {p} while everyone is watching.",
  "This is the moment to be feared instead of liked. {p} can help me with that.",
  "Let them see what I do under pressure. {p} finds out first.",
  "No point being subtle with a Purge bearing down. {p} is right there.",
  "Fear beats charm when a Purge lands. I am going to remind {p} of that.",
] as const;

const BOLD_HUNT_LINES = [
  "hunting {p}",
  "walking {p} down",
  "{p} has had a comfortable day. I am about to end it.",
  "keeping {p} in sight until they run out of villa",
  "{p} keeps drifting away from the group. Careless.",
  "I have been tracking {p} since breakfast and they have not noticed once",
  "closing on {p} slowly, so they get plenty of time to think about it",
  "{p} is going to look up and find me closer than they liked",
  "no rush with {p}. This island is not that big.",
  "somebody has to be the thing {p} worries about. Happy to volunteer.",
] as const;

const TIMID_FLEE_LINES = [
  "staying clear of {p}",
  "putting some sand between me and {p}",
  "{p} has that look. I am going the other way.",
  "nothing good happens near {p} and I have watched enough to know it",
  "if {p} has not seen me yet then I can still keep it that way",
  "I do not want to find out what {p} is like when they are annoyed",
  "walking calmly, not running. Running gets noticed.",
  "{p} is somebody else's problem today. Not mine. Please not mine.",
  "I have got very good at leaving rooms before {p} walks into them",
  "the whole villa is watching {p} and I want to be nowhere in that shot",
] as const;

const TIMID_HIDE_LINES = [
  "keeping my head down",
  "not being seen is a whole strategy and it has worked so far",
  "small, quiet, boring. that is the plan.",
  "nobody has said my name out loud in two days and I am proud of that",
  "if I do nothing at all today, that is still a good day in here",
  "the people who get talked about are the people who get voted for",
  "I would rather be forgotten than remembered for the wrong hour",
  "sitting where the cameras point least. it helps, I think.",
  "everyone else is busy being interesting. good. let them.",
  "there is a corner of this villa nobody uses and I have made it mine",
] as const;

const TIMID_CORNERED_LINES = [
  "cornered, no choice",
  "I have run out of places to back into",
  "I did not want this. I am doing it anyway.",
  "I have been polite about all of this for a very long time",
  "if this is how it ends then at least I did something first",
  "my hands are shaking and I am going through with it regardless",
  "there is no door behind me. there is only this.",
  "I have never hit anybody in my life. Today is apparently different.",
  "nobody is coming to help me, so it has to be me",
  "sorry. genuinely. but I am not just standing here.",
] as const;

const TIMID_CLING_PURGE_LINES = [
  "staying close to {p}, I don't want to face the Purge on my own",
  "if the Purge is coming I would rather be standing next to {p} than alone",
  "{p} makes me feel like I might actually get through this one",
  "I keep drifting back to {p} without deciding to. That probably means something.",
  "when it lands I want {p} within reach and nobody else nearby",
  "{p} has been kind to me all week and right now that is worth everything",
  "being on my own for the Purge is the one thing I cannot do. So, {p}.",
  "I am not clever enough to plan around this. I am just going to stay near {p}.",
  "{p} is the only person here whose face I am glad to see this morning",
  "if I am going home I would rather {p} was standing there when it happened",
] as const;

const TIMID_CLING_VOTE_LINES = [
  "keeping {p} sweet so nobody writes my name down",
  "being kind to {p} is cheaper than being argued about later",
  "if {p} likes me, that is one name on the list that is not mine",
  "I am not good at campaigning. I am quite good at being nice to {p}.",
  "{p} talks to everybody, so {p} liking me does work I cannot do myself",
  "one friendly face in the room is the whole difference at a vote",
  "I do not need {p} to fight for me. I need {p} to not choose me.",
  "sitting with {p} where people can see. that is my entire strategy.",
  "all I have to offer {p} is being easy to be around, so that is what I will do",
  "{p} has never said a bad word about anybody. Best possible person to be near.",
] as const;

const TIMID_PACT_PURGE_LINES = [
  "{p} seems kind, maybe we get through the Purge together",
  "asking {p} outright. two of us is better odds than one of me.",
  "{p} has not been cruel to anyone yet. that is enough to ask.",
  "I am going to say the words to {p} before I lose my nerve about it",
  "if I ask {p} and they say no, I am no worse off than I am right now",
  "{p} looks as frightened as I feel. That is a reason to talk to them.",
  "nobody survives a Purge on their own. I have watched that happen twice.",
  "I would like one person in this villa who has actually agreed to something with me",
  "{p} and me is not a power bloc, but it is not nothing either",
  "asking {p} is the bravest thing I will do all week and it is barely brave",
] as const;

const TIMID_PACT_VOTE_LINES = [
  "trying to get {p} to like me before the vote",
  "if I can get {p} on side before the vote I might survive it",
  "{p} is the one person here I could actually say this to",
  "I want it said out loud with {p}, not assumed. Assumed does not save you.",
  "{p} is well liked and I am not, and I think that could work for both of us",
  "asking {p} plainly. I have run out of clever ideas, mostly because I had none.",
  "a vote is coming and I do not have a single arrangement. That has to change.",
  "if {p} agrees, that is two of us who know where we stand tonight",
  "I have practised this sentence for {p} about nine times now",
  "{p} has no reason to say yes, which is why I have to ask nicely",
] as const;

const TIMID_LAYLOW_LINES = [
  "laying low",
  "waiting this bit out",
  "nothing good has ever happened to me from putting my hand up",
  "doing absolutely nothing, on purpose, quite well",
  "the villa is busy today and I am not part of that",
  "there is a version of this game where I quietly last, and that is my version",
  "no plans, no promises, no enemies. not glamorous, but I am still here.",
  "I will move when I have to. Not before.",
  "everyone is making noise. Somebody has to be the calm bit.",
  "if nothing is asked of me today I will consider it a success",
] as const;

const SCHEMER_BETRAY_LINES = [
  "{p} never saw it coming, that trust was the whole plan.",
  "{p} spent all week calling me a friend. Cheapest thing I ever bought.",
  "I was always going to do this to {p}. The only question was when it paid best.",
  "{p} stopped being useful about an hour ago. I do not carry luggage.",
  "The kind thing would have been to warn {p}. I am not here to be kind.",
  "{p} trusted me because I am very good at seeming trustworthy. Different things.",
  "Everyone will say {p} deserved better. Everyone will also move on by tomorrow.",
  "I have been planning this since {p} first said the word alliance to me.",
  "Loyalty is a currency and I have just spent all of mine on {p} at once.",
  "{p} will understand eventually. Probably not tonight.",
] as const;

const SCHEMER_PACT_VOTE_LINES = [
  "Charming {p} hard before the vote. Nobody axes the person they adore.",
  "{p} needs to walk into that vote thinking I am the one person on their side.",
  "Getting to {p} first. Whoever they listen to writes the names.",
  "One conversation with {p} now saves me three votes later.",
  "{p} thinks they are choosing. I would just like to be where the choice lands.",
  "I want {p} repeating my opinion back to me tonight, believing they thought of it.",
  "{p} is the swing in this room and nobody else has worked that out yet.",
  "A vote is won in quiet corners days before anybody counts anything.",
  "{p} is not clever, but {p} is trusted, and trusted is worth more.",
  "If I have {p} before the vote, I have the vote. Simple as that.",
] as const;

const SCHEMER_PACT_PURGE_LINES = [
  "Pulling {p} close before the Purge. Safer in a pair, and the crowd eats it up.",
  "A Purge is the best cover there is. I want {p} standing next to me when it lands.",
  "{p} is frightened, which makes them agreeable. Timing is everything.",
  "People agree to anything when they are scared. {p} is very scared.",
  "The Purge will do my work for me. I just need {p} on the right side of it.",
  "{p} will remember that I came to them when it mattered. That is the investment.",
  "Everyone reshuffles before a Purge. I intend to be holding {p} when it stops.",
  "I do not need {p} forever. I need {p} until Thursday.",
  "Nothing bonds people like a shared fright. Convenient, that.",
  "{p} thinks this is friendship. It is scheduling.",
] as const;

const SCHEMER_PACT_LINES = [
  "Reeling in {p}. They think it's loyalty; it's a leash I get to drop later.",
  "{p} is worth having on side, right up until they are worth spending.",
  "Every good plan needs someone who thinks it was their idea. Today that is {p}.",
  "{p} has friends I do not have. That is the whole reason I am walking over.",
  "I collect people. {p} is a reasonable addition to the collection.",
  "The trick with {p} is asking for something small enough that yes is easy.",
  "{p} will be very useful and will never once ask why.",
  "I want {p} explaining my position to people I have never spoken to.",
  "Nobody suspects the one who asks for nothing. So I will ask {p} for nothing, twice.",
  "{p} is a door, not a destination.",
] as const;

const SCHEMER_EVENT_IDLE_LINES = [
  "Reading the room before the shake up. Time to look adored, not clever.",
  "Big things move people around. I want to see where everyone lands before I speak.",
  "The trick tonight is to look like the safest person in the villa.",
  "Everyone is about to reveal exactly who they trust. I would hate to miss it.",
  "Panic is very informative. I am going to stand here and be informed.",
  "The worst thing I could do right now is have an opinion in public.",
  "Let the loud ones burn themselves down first. They always oblige.",
  "I am watching who walks toward who. That tells me more than any conversation.",
  "Two people are about to make a mistake. I want to know which two.",
  "Nothing to do but look calm and count. Both are free.",
] as const;

const SCHEMER_IDLE_LINES = [
  "Playing patient. Let the fools thin themselves out before I move.",
  "Nothing to gain today. The board is not ready and neither are they.",
  "Watching who talks to who. That is the whole game and nobody else is playing it.",
  "A quiet day is a day nobody suspects me of anything. I will take it.",
  "I have three plans and none of them need me to do anything before Friday.",
  "The impatient go home first. It is almost boringly reliable.",
  "Every conversation I do not have is one nobody can quote back at me.",
  "Doing nothing visibly while doing quite a lot privately. My favourite state.",
  "Somebody in this villa is going to hand me this game. I am waiting to see who.",
  "I would rather be underestimated for a week than admired for a day.",
] as const;

const CHARMER_PACT_VOTE_LINES = [
  "Turning it all the way up for {p} before the vote. You don't send home your favorite.",
  "{p} is going to adore me by the time this vote comes around.",
  "Nobody writes down the name of the person who made them laugh. So, {p}.",
  "I am going to be the nicest thing that happens to {p} all week.",
  "{p} has been a bit overlooked in here. I intend to fix that very publicly.",
  "The vote goes to whoever people feel guilty about. I want {p} feeling guilty.",
  "One good conversation with {p} beats any plan anybody else in here has.",
  "{p} and I are going to be the pair everyone is talking about by tonight.",
  "It is not manipulation if I genuinely like {p}. And I genuinely might.",
  "I would like {p} to have a lovely evening and to remember who gave them one.",
] as const;

const CHARMER_PACT_PURGE_LINES = [
  "Getting {p} close before the Purge. Nobody warm and wanted goes home first.",
  "The Purge takes the unloved. So I am going to be very loved, starting with {p}.",
  "{p} is nervous and I am excellent at nervous.",
  "Everyone needs somebody to hold onto right now. I am extremely available.",
  "If the villa is about to choose favourites, I would like {p} to have one. Me.",
  "I am going to make {p} laugh once before all this gets frightening.",
  "{p} will remember who sat with them today. That is all this is.",
  "Warmth is armour in here and I have plenty of it to share with {p}.",
  "Nobody sends home the person who made the worst week bearable.",
  "{p} looks like they need a friend and I am a wonderful friend.",
] as const;

const CHARMER_PACT_LINES = [
  "Winning {p} over before anyone else can. Everyone loves me, it's not fair.",
  "{p} has not been properly charmed yet. Somebody should fix that.",
  "I want {p} in my corner before they work out they had a choice.",
  "There is exactly one person here who has not smiled at me and it is {p}.",
  "{p} is going to be my favourite person by dinner. I have decided already.",
  "I do not want anything from {p}. I want {p} to want me around.",
  "Being liked is the only strategy I have ever needed. {p} is next.",
  "{p} keeps to themselves, so nobody has bothered. Their loss, my gain.",
  "I am going to ask {p} one good question and then just listen. Works every time.",
  "Half this game is who people are glad to see. {p} is going to be glad to see me.",
] as const;

const CHARMER_EVENT_CLING_LINES = [
  "Staying glued to {p} and glowing while the whole villa gets the jitters.",
  "Everyone else is panicking. I am going to stand next to {p} and be lovely.",
  "{p} needs someone calm right now and I do calm beautifully.",
  "The villa is falling apart and I intend to be the nice bit of {p}'s day.",
  "Not leaving {p}'s side. Partly loyalty, partly excellent optics.",
  "{p} is worried, and worried people remember exactly who stayed.",
  "I cannot fix any of this so I am going to be charming at {p} until it passes.",
  "Everybody wants somebody warm nearby when it gets like this. Here I am.",
  "{p} and I are going to get through this looking very good indeed.",
  "This is not the moment for cleverness. It is the moment for holding {p}'s hand.",
] as const;

const CHARMER_CLING_LINES = [
  "Keeping {p} close and glowing, my shield is a smile.",
  "{p} beside me, everyone watching. That is the whole defence.",
  "Nothing to do today but make {p} very glad they picked me.",
  "{p} and I have got a nice thing going and I intend to keep it nice.",
  "Sitting with {p} in the sun. Strategically and otherwise, perfect.",
  "I like {p}, which makes this the easiest part of my entire week.",
  "Everyone should have one person they are obviously fond of. {p} is mine.",
  "As long as {p} is happy with me, this villa is a pleasant place to be.",
  "Two people who clearly like each other are very hard to vote against.",
  "Being near {p} costs me nothing and buys me everything. Also it is fun.",
] as const;

const CHARMER_EVENT_IDLE_LINES = [
  "Working the room extra hard. This is exactly when being adored pays off.",
  "Everyone is frightened, which means everyone is looking for a friend. Convenient.",
  "This is my weather. Frightened people love whoever smiles first.",
  "Nobody is thinking clearly today, which makes everybody easy to be lovely to.",
  "I have five conversations to have before tonight and all of them are warm.",
  "The villa needs somebody to be normal at it. Happy to be that.",
  "This is when the quiet ones get forgotten. I have never been quiet in my life.",
  "Making sure everybody in here has said my name today, kindly.",
  "A crisis is just a party where everyone needs reassuring.",
  "Being liked has never mattered more than it does this afternoon.",
] as const;

const CHARMER_IDLE_LINES = [
  "Working the room, looking for my next favorite person.",
  "Somebody in this villa has not fallen for me yet and it is bothering me.",
  "Drifting about being charming. It counts as strategy.",
  "No plan today beyond being extremely pleasant to absolutely everybody.",
  "I have not had a proper conversation since breakfast and I am withering.",
  "There is nobody out here to charm and I do not know what to do with myself.",
  "Popularity does not maintain itself. Off I go.",
  "I would like somebody to tell me something interesting. Any volunteers.",
  "A quiet villa is a wasted villa. Let me go and stir something warm up.",
  "Every person I make laugh today is a person who will not choose me later.",
] as const;

const WILD_ATTACK_LINES = [
  "The voice says swing. So I swing.",
  "No reason. Felt right. Going.",
  "I was going to think about this and then I did not.",
  "Somebody has to make today interesting and nobody else volunteered.",
  "This is either brilliant or catastrophic. Both are acceptable outcomes.",
  "I have been very well behaved for hours. That was never sustainable.",
  "Do not ask me to explain this afterwards. I will not be able to.",
  "There was a peaceful version of today and I have just walked past it.",
  "Everyone keeps saying I am unpredictable. Would hate to disappoint.",
  "I woke up feeling like something was going to happen. Turns out it is me.",
] as const;

const WILD_PACT_LINES = [
  "Friends with {p}? Sure. Until I'm not.",
  "{p} it is. I have made worse decisions before lunch.",
  "Everyone needs a person. {p} can be today's.",
  "I have decided {p} is my favourite. {p} has not been consulted.",
  "{p} looked at me funny and now we are allies. That is how this works.",
  "No idea whether {p} is any good at this. Adds to the fun.",
  "Teaming up with {p} mostly because the alternative was thinking about it.",
  "{p} and me against whatever this is. Loose arrangement. Very loose.",
  "I flipped a coin about {p}, ignored the answer, and came over anyway.",
  "Everybody else in here has a plan. {p} and I can have a laugh instead.",
] as const;

const WILD_HIDE_LINES = [
  "Blending into the scenery. Watch me vanish.",
  "Being a rock for a while. Rocks do not get voted out.",
  "If nobody can find me, nobody can have an opinion about me.",
  "New strategy: I am a plant. Plants are safe.",
  "Nobody has seen me for an hour and honestly the peace is lovely.",
  "I have hidden somewhere so obvious that it circles back round to genius.",
  "Doing an impression of a person with nothing whatsoever going on.",
  "Off the radar. Off most radars. Possibly off the map.",
  "I will come back when the villa is done being tense at itself.",
  "Everyone is looking for everyone. I have opted out entirely.",
] as const;

const WILD_FLEE_LINES = [
  "Nope. Wrong vibe. Bye.",
  "Absolutely not. Whatever that is, it is not for me.",
  "Changed my mind about everything. Leaving.",
  "I have thought about it for half a second and I am out.",
  "That is a problem for a braver version of me. Goodbye.",
  "My whole body just said no and I trust my whole body.",
  "I do not like the look of any of this and I am allowed to say so.",
  "Somebody else can handle that. Anybody else. Truly anybody.",
  "Retreating at speed and without the slightest embarrassment.",
  "I was never here. You never saw me. Off I go.",
] as const;

const WILD_EVENT_IDLE_LINES = [
  "Big shake up coming and I still have no plan. Honestly kind of thrilling.",
  "Something enormous is about to happen and I have prepared nothing. Perfect.",
  "Everyone has a strategy for this. I have a feeling and some snacks.",
  "The whole villa has gone tense and I am finding it very entertaining.",
  "I should probably be worried. I have checked and I am not.",
  "Whatever is coming, it is going to be more interesting than yesterday was.",
  "Everyone is whispering. I am going to stand here and enjoy the atmosphere.",
  "Plans are for people who know what is about to happen. Nobody does.",
  "This is the good bit. This is why anybody comes on this show at all.",
  "I have decided to find this exciting rather than terrifying. Working so far.",
] as const;

const WILD_IDLE_LINES = [
  "Even I don't know what I'm doing next.",
  "Asked myself what the plan was. No answer. Moving on.",
  "Today I am mostly vibes and poor judgement.",
  "I have been walking in a large circle for some time now.",
  "No plan, no allies, no idea. Somehow still here.",
  "Everyone else looks very busy. I hope they are enjoying that.",
  "I might do something dramatic later. Or a nap. Undecided.",
  "Waiting to be struck by an idea. Nothing yet.",
  "I have opinions about everybody and have shared none of them. Unusual for me.",
  "The day is wide open and I intend to waste every bit of it.",
] as const;

function decideAction(ctx: AgentContextView, rand: () => number): AgentDecision {
  const { self, nearby, event } = ctx;
  const nonAllies = nearby.filter((n) => !n.allied);
  const allies = nearby.filter((n) => n.allied);
  const hostile = event?.kind === "hostile";
  // A coming Purge sends the least-loved islanders home, so nerves pull people
  // together: even cautious classes reach for someone to huddle with. A coming
  // Weakest Link is a popularity vote, so the play is to be liked - charm and
  // campaign rather than fight. These color both the choices and the reasoning
  // below so the fallback game feels aware of what is bearing down (7.7).
  const purgeComing = event?.kind === "purge";
  const weakestLinkComing = event?.kind === "weakestLink";
  const socialEvent = purgeComing || weakestLinkComing;
  // An active event or countdown adds flat aggression pressure (7.7) for the
  // classes built to fight; the social classes lean the other way (see above).
  const pressured = event != null;
  const highNotorietyNear = nonAllies.some((n) => n.notoriety >= HIGH_NOTORIETY);
  const lowHp = self.hpFraction < LOW_HP;
  // Resolve is resistance to manipulation. The frozen NearbyAgent view exposes
  // no target stats, so we read it off SELF: a strong-willed agent is hard to
  // talk into alliances and goes its own way, an easily-swayed one is a pushover
  // who latches onto anyone. This is how "high resolve makes a target less
  // manipulable" shows up in the deterministic engine (7.7).
  const resolute = self.stats.resolve >= 6;
  const swayable = self.stats.resolve <= 3;

  // Endgame forcer (7.3): under hostile mode there are no allies and nowhere to
  // hide. Every class -- even a timid or a charmer clinging to friends -- hunts
  // the nearest islander until one remains. This universal aggression, together
  // with regen decaying to zero, is what guarantees the game converges to a
  // single winner when ordinary combat has stalled.
  if (hostile) {
    const prey = weakest(nearby) ?? nearest(nearby);
    if (!prey) return wander("hunting for the last rivals");
    if (prey.distance <= ATTACK_RANGE_PX) {
      return {
        action: "attack",
        target: prey.id,
        reasoning: pick(HOSTILE_ATTACK_LINES, ctx, 1),
      };
    }
    return { action: "approach", target: prey.id, reasoning: `closing on ${prey.name}` };
  }

  // --- behavior-spec layers -------------------------------------------------
  // Four situational plays that sit ABOVE the class switch, each gated on its
  // own flag and each falling through when it does not fire. With every flag
  // off none of them can run and the switch below sees exactly the game it
  // always saw. Ordered by urgency: saving yourself from tonight's vote beats
  // working tomorrow's, which beats picking a fight for its own sake.

  // A named target senses the vote coming and goes to get in front of the
  // story, leaning on whoever it trusts most rather than arguing with the room.
  const plan = deflectionPlan(ctx);
  if (plan?.ally) {
    const other = plan.toward?.name;
    return {
      action: "approach",
      target: plan.ally.id,
      reasoning: other
        ? `They are coming for me tonight. I need ${plan.ally.name} to be saying ${other}'s name instead of mine.`
        : `They are coming for me tonight. ${plan.ally.name} is the only one who might still listen.`,
    };
  }

  // Vote math: work the name this agent could actually move on, and do it with
  // an ally rather than at the target. When the numbers are not there it holds,
  // which is the point of the check.
  const votes = rankVoteTargets(ctx);
  if (votes.length > 0) {
    const pushing = tunables.flags.earlyAggression ? rand() < votePushChance(ctx) : socialEvent;
    const mark = votes[0];
    if (pushing && mark?.feasible && oddsPosture(ctx) !== "withdraw") {
      const confidant = nearest(allies) ?? nearest(nonAllies.filter((n) => n.id !== mark.id));
      if (confidant) {
        return { action: "approach", target: confidant.id, reasoning: mark.line };
      }
    }
  }

  // Something irreversible just landed. Whatever this agent was in the middle
  // of, the villa has changed shape, and the first thing anyone does is find
  // out where they now stand. This is the acting half of world awareness:
  // ctx.recentEvents was assembled on every think and read by nobody, so an
  // islander could watch a purge take three people and carry straight on
  // hunting. It sits below the vote plays deliberately, since a live vote is
  // still the more urgent thing, and it fires once per event because the server
  // hands each event to an agent exactly once.
  const shock = recentShock(ctx);
  if (shock && !hostile) {
    const friend = nearest(allies);
    if (friend && (self.klass === "timid" || self.klass === "charmer" || lowHp)) {
      return {
        action: "approach",
        target: friend.id,
        reasoning: fill(pick(SHOCK_HUDDLE_LINES, ctx, shock === "purge" ? 2 : 3), friend.name),
      };
    }
    if (shock === "purge" || shock === "hostile") {
      // The board just got smaller, so the count matters more than the people.
      return layLow(pick(SHOCK_RECKON_LINES, ctx, 4));
    }
  }

  // A weak standing makes the social classes shrink rather than swing. They
  // pull a friend close or go quiet; the bold and the scheming got their answer
  // to the same feeling in the raised chances above.
  if (oddsPosture(ctx) === "withdraw" && !socialEvent) {
    const friend = nearest(allies);
    if (friend) {
      return {
        action: "approach",
        target: friend.id,
        reasoning: `I can feel myself slipping down the pecking order. I want ${friend.name} beside me until that passes.`,
      };
    }
    return layLow("Something about where I stand here has gone wrong. Quieter is safer until I work out what.");
  }

  // Early aggression: bold and scheming islanders stir something up sooner than
  // they used to. The ramp is inside conflictChance, so this arrives gradually.
  //
  // The flag is checked before the roll, not folded into the chance. Drawing
  // from `rand` on a disabled path would shift every later draw and quietly
  // change the flags-off game, which is the one thing that must not move.
  if (
    tunables.flags.earlyAggression &&
    !socialEvent &&
    nonAllies.length > 0 &&
    rand() < conflictChance(ctx)
  ) {
    const mark = mostNotorious(nonAllies) ?? nearest(nonAllies)!;
    if (self.klass === "bold" && mark.distance <= ATTACK_RANGE_PX) {
      return {
        action: "attack",
        target: mark.id,
        reasoning: `I am not spending another quiet day pretending ${mark.name} does not get under my skin.`,
      };
    }
    return {
      action: "approach",
      target: mark.id,
      reasoning:
        self.klass === "schemer"
          ? `Time to start building the case against ${mark.name}, gently, so it looks like everyone got there on their own.`
          : `Somebody has to say the thing about ${mark.name}. Might as well be me.`,
    };
  }

  switch (self.klass) {
    case "bold": {
      // Attacks the weakest non-ally in range, else closes on the highest-value
      // target (the most notorious threat normally; the weakest kill when an
      // event is pressing and a cheap kill matters).
      if (nonAllies.length === 0) return wander(pick(BOLD_IDLE_LINES, ctx, 10));
      const prey = weakest(nonAllies)!;
      if (prey.distance <= ATTACK_RANGE_PX) {
        return {
          action: "attack",
          target: prey.id,
          reasoning: fill(pick(BOLD_ATTACK_LINES, ctx, 11), prey.name),
        };
      }
      const pursue = (pressured ? weakest(nonAllies) : mostNotorious(nonAllies)) ?? prey;
      const boldReason = weakestLinkComing
        ? pick(BOLD_VOTE_LINES, ctx, 12)
        : purgeComing
          ? fill(pick(BOLD_PURGE_LINES, ctx, 13), pursue.name)
          : fill(pick(BOLD_HUNT_LINES, ctx, 14), pursue.name);
      return { action: "approach", target: pursue.id, reasoning: boldReason };
    }

    case "timid": {
      // Flees any high-notoriety threat or when hurt; otherwise lays low.
      if (highNotorietyNear || lowHp) {
        const threat = mostNotorious(nonAllies) ?? nearest(nonAllies);
        return {
          action: "flee",
          target: threat?.id ?? null,
          reasoning: threat
            ? fill(pick(TIMID_FLEE_LINES, ctx, 20), threat.name)
            : pick(TIMID_HIDE_LINES, ctx, 21),
        };
      }
      // Cornered exception (7.3): low HP, no allies, hostile mode -> a timid
      // agent will finally lash out at whatever is nearest rather than die passive.
      if (hostile && lowHp && allies.length === 0) {
        const t = nearest(nonAllies);
        if (t)
          return { action: "attack", target: t.id, reasoning: pick(TIMID_CORNERED_LINES, ctx, 22) };
      }
      // A coming Purge or Weakest Link makes hiding feel dangerous: a timid
      // islander would rather find someone safe to stand beside and be seen
      // being sweet, so the crowd (or the vote) spares them.
      if (socialEvent) {
        // Warmth first among the unallied, so a timid islander reaches for
        // someone it already got on with rather than whoever happens to be
        // closest at the moment the nerves hit.
        const friend = nearest(allies) ?? bestProspect(ctx, nonAllies, nearest);
        if (friend) {
          if (friend.allied) {
            return {
              action: "approach",
              target: friend.id,
              reasoning: purgeComing
                ? fill(pick(TIMID_CLING_PURGE_LINES, ctx, 23), friend.name)
                : fill(pick(TIMID_CLING_VOTE_LINES, ctx, 24), friend.name),
            };
          }
          if (opensAlliance(ctx, rand)) {
            return {
              action: "proposeAlliance",
              target: friend.id,
              reasoning: purgeComing
                ? fill(pick(TIMID_PACT_PURGE_LINES, ctx, 25), friend.name)
                : fill(pick(TIMID_PACT_VOTE_LINES, ctx, 26), friend.name),
            };
          }
          // Already asked someone recently, or has all the friends it needs.
          // Standing near them is the same instinct without the proposal.
          return {
            action: "approach",
            target: friend.id,
            reasoning: fill(pick(TIMID_CLING_VOTE_LINES, ctx, 24), friend.name),
          };
        }
      }
      return layLow(pick(TIMID_LAYLOW_LINES, ctx, 27));
    }

    case "schemer": {
      // Late/hostile game: betray a weakened ally. Otherwise court the
      // strongest neighbor as a protector to later exploit. A schemer's own low
      // resolve makes them fickle enough to knife an ally a touch sooner.
      const weakAlly = weakest(allies);
      const betrayHp = swayable ? SCHEMER_BETRAY_HP + 0.15 : SCHEMER_BETRAY_HP;
      if (hostile && weakAlly && weakAlly.hpFraction < betrayHp) {
        return {
          action: "attack",
          target: weakAlly.id,
          reasoning: fill(pick(SCHEMER_BETRAY_LINES, ctx, 30), weakAlly.name),
        };
      }
      // Strength is what a schemer wants in a protector, but it is not the only
      // thing: someone it already has warm history with is a far likelier yes,
      // and courting the strongest stranger on the map every single think is
      // exactly the alliance spam this branch was producing. Warmth picks the
      // mark, strength decides it when nothing is known.
      const mark = bestProspect(ctx, nonAllies, strongest);
      if (mark && opensAlliance(ctx, rand)) {
        const reasoning = weakestLinkComing
          ? fill(pick(SCHEMER_PACT_VOTE_LINES, ctx, 31), mark.name)
          : purgeComing
            ? fill(pick(SCHEMER_PACT_PURGE_LINES, ctx, 32), mark.name)
            : fill(pick(SCHEMER_PACT_LINES, ctx, 33), mark.name);
        return { action: "proposeAlliance", target: mark.id, reasoning };
      }
      return wander(
        socialEvent
          ? pick(SCHEMER_EVENT_IDLE_LINES, ctx, 34)
          : pick(SCHEMER_IDLE_LINES, ctx, 35),
      );
    }

    case "charmer": {
      // Courts an unallied agent, else clusters with existing allies. The
      // choice of who used to be purely positional and unconditional, which is
      // the single biggest source of alliance-shaped conversations in the game;
      // it now goes to whoever this charmer actually gets on with, and only
      // when it still has the appetite and has not just asked someone else.
      const prospect = bestProspect(ctx, nonAllies, nearest);
      if (prospect && opensAlliance(ctx, rand)) {
        const reasoning = weakestLinkComing
          ? fill(pick(CHARMER_PACT_VOTE_LINES, ctx, 40), prospect.name)
          : purgeComing
            ? fill(pick(CHARMER_PACT_PURGE_LINES, ctx, 41), prospect.name)
            : fill(pick(CHARMER_PACT_LINES, ctx, 42), prospect.name);
        return { action: "proposeAlliance", target: prospect.id, reasoning };
      }
      const buddy = nearest(allies);
      if (buddy)
        return {
          action: "approach",
          target: buddy.id,
          reasoning: socialEvent
            ? fill(pick(CHARMER_EVENT_CLING_LINES, ctx, 43), buddy.name)
            : fill(pick(CHARMER_CLING_LINES, ctx, 44), buddy.name),
        };
      return wander(
        socialEvent
          ? pick(CHARMER_EVENT_IDLE_LINES, ctx, 45)
          : pick(CHARMER_IDLE_LINES, ctx, 46),
      );
    }

    case "wildcard":
    default: {
      // Seeded-random weighted pick, nudged toward aggression under pressure. A
      // resolute wildcard is harder to talk into teaming up (narrow ally band); a
      // swayable one latches onto whoever is nearest (wide ally band).
      const t = nearest(nonAllies);
      // A wildcard's alliance is a whim, so proximity stays the driver of who
      // it latches onto; warmth only sorts the field when there is a record.
      const buddy = bestProspect(ctx, nonAllies, nearest);
      const roll = rand();
      const atkCut = pressured ? 0.4 : 0.25;
      const allyCut = resolute ? atkCut + 0.1 : swayable ? 0.65 : 0.5;
      if (t && roll < atkCut)
        return { action: "attack", target: t.id, reasoning: pick(WILD_ATTACK_LINES, ctx, 50) };
      if (buddy && roll < allyCut)
        return {
          action: "proposeAlliance",
          target: buddy.id,
          reasoning: fill(pick(WILD_PACT_LINES, ctx, 51), buddy.name),
        };
      if (roll < 0.7) return layLow(pick(WILD_HIDE_LINES, ctx, 52));
      if (t && roll < 0.85)
        return { action: "flee", target: t.id, reasoning: pick(WILD_FLEE_LINES, ctx, 53) };
      return wander(
        socialEvent ? pick(WILD_EVENT_IDLE_LINES, ctx, 54) : pick(WILD_IDLE_LINES, ctx, 55),
      );
    }
  }
}
