import { tunables } from "@arena/shared";
import type { AllianceView, Contestant, RelOutcome } from "@arena/shared";
import { aliveCount, state } from "./state.js";
import { pushWorldEvent, rand, relationship, social } from "./social.js";
// Value import, and safe: awareness.ts reads state and social only, so it never
// reaches back here. This is the one place the bloc layer needs a read on how an
// individual member rates its own survival, which is what the spec means by
// defection following "its own survival points elsewhere" rather than following
// a group number the member cannot feel.
import { selfOdds } from "./awareness.js";
// Rich SMS follow up: allianceBroken had a NotifyEvent variant with no producer
// anywhere in the codebase (WS-F only wired the formation side, in
// swarmBridge.ts). notify.ts imports nothing from this file, so pulling this in
// here does not create a cycle -- see this module's own header note above about
// the awareness.ts import direction for the same reasoning applied the other way.
import { notifyAboutContestant } from "./notify.js";

// ---------------------------------------------------------------------------
// Alliances as groups, and the spontaneous ouster board.
//
// The existing pairwise model is not replaced. `Contestant.allies` remains the
// authority every other system already reads: combat's ally-attack block, the
// conversation gate's allowed-outcome set, and the vote's isolation weighting
// all keep working untouched. What this adds is a GROUP object layered on top,
// with the invariant that a group's members are pairwise allies in those
// arrays. So a three-person bloc is visible to old code as three mutual pairs,
// and visible to new code as one bloc with a cohesion level.
//
// That invariant is the whole trick. It is why multi-person alliances could be
// added without touching combat.ts or the parts of events.ts that read allies.
// ---------------------------------------------------------------------------

export type Alliance = {
  id: string;
  memberIds: string[];
  // 0..1. Rises with shared good outcomes and successful joint votes, falls
  // with betrayal. Below the defection floor, members start leaving.
  cohesion: number;
  formedAt: number;
  // When ordinary warmth between two members last topped the bloc up. Kept so
  // a chatty pair cannot pin cohesion at 1 by producing an amicable outcome
  // every few seconds: warmth counts, but it counts once per scan window.
  // Optional because a bloc that has never been credited has nothing to record,
  // and because leaving it optional keeps every existing construction valid.
  lastGoodCreditAt?: number;
};

export type AllianceState = {
  byId: Map<string, Alliance>;
  // Reverse index so "which bloc is this agent in" is not a scan.
  memberOf: Map<string, string>;
  // The ouster board: target id -> supporter id -> when that support was given.
  //
  // The timestamp is the point. The comment further down has always claimed
  // support "decays when the villa moves on", but the only thing that ever
  // removed a supporter was that supporter dying, so a campaign started in the
  // opening minute still counted toward quorum an hour later. Holding the time
  // each name went on the board is what makes expiry possible at all; the set
  // semantics (one agent is one voice, no matter how often it pushes) are
  // unchanged, since a Map keyed by supporter id is still idempotent.
  ousterSupport: Map<string, Map<string, number>>;
  nextId: number;
  lastCohesionScanAt: number;
};

export function createAllianceState(): AllianceState {
  return {
    byId: new Map(),
    memberOf: new Map(),
    ousterSupport: new Map(),
    nextId: 1,
    lastCohesionScanAt: 0,
  };
}

// Lazily created on first use. This is what lets social.ts import this module
// for its type alone, which is how the runtime import cycle between the two
// stays broken.
function st(): AllianceState {
  const s = social();
  s.alliances ??= createAllianceState();
  return s.alliances;
}

export function allianceOf(agentId: string): Alliance | undefined {
  const id = st().memberOf.get(agentId);
  return id ? st().byId.get(id) : undefined;
}

export function allAlliances(): Alliance[] {
  return [...st().byId.values()];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Cohesion as something a member could feel rather than as a score it could
// read. The two boundaries are the config's own landmarks: a bloc at or above
// where cohesion STARTS is holding, a bloc under the floor where members begin
// walking is visibly coming apart, and everything between the two is strained.
// Deriving the bands from those knobs rather than from fresh constants means
// retuning the floor retunes what "fracturing" means, instead of leaving the
// word describing a state defection no longer triggers on.
export function cohesionBand(cohesion: number): AllianceView["cohesionBand"] {
  if (cohesion < tunables.social.defectionFloor) return "fracturing";
  if (cohesion < tunables.social.cohesionStart) return "strained";
  return "solid";
}

// The bloc projected for one member's agent context.
//
// This is the seam that makes a group speakable. Before it, an agent in a
// four-person bloc saw three ids in `self.allies` and nothing that named them
// as a unit or reported how the unit was holding, so "our four" and "we are
// cracking" had no representation to be built from.
//
// `memberNames` includes the agent itself, so its length always equals `size`
// and a prompt builder never has to reason about an off-by-one. Dead members
// are filtered even though removeFromAlliances should already have taken them
// out, because a view that names a corpse is worse than a view that is briefly
// one short.
export function allianceViewFor(agentId: string): AllianceView | undefined {
  if (!tunables.flags.multiAlliances) return undefined;
  const g = allianceOf(agentId);
  if (!g) return undefined;
  const living = g.memberIds.filter((m) => state.contestants[m]?.alive);
  // A bloc of one is not a bloc, and a bloc the agent is no longer a living
  // part of is not its bloc.
  if (living.length < 2 || !living.includes(agentId)) return undefined;
  return {
    id: g.id,
    size: living.length,
    memberNames: living.map((m) => state.contestants[m]?.name ?? m),
    cohesionBand: cohesionBand(g.cohesion),
  };
}

// Make every member of `a` a pairwise ally of every member of `b`, which is
// what keeps the group invariant true for all the old code.
function linkAll(memberIds: string[]): void {
  for (const x of memberIds) {
    const cx = state.contestants[x];
    if (!cx) continue;
    for (const y of memberIds) {
      if (x === y) continue;
      if (!cx.allies.includes(y)) cx.allies.push(y);
    }
  }
}

function unlink(agentId: string, fromIds: string[]): void {
  const c = state.contestants[agentId];
  for (const other of fromIds) {
    if (other === agentId) continue;
    if (c) {
      const i = c.allies.indexOf(other);
      if (i >= 0) c.allies.splice(i, 1);
    }
    const oc = state.contestants[other];
    if (oc) {
      const j = oc.allies.indexOf(agentId);
      if (j >= 0) oc.allies.splice(j, 1);
    }
  }
}

// Called when a conversation produces an alliance. With the flag off this does
// nothing and the caller's existing pairwise push is the whole behavior.
export function joinOrFormAlliance(a: Contestant, b: Contestant, now: number): Alliance | null {
  if (!tunables.flags.multiAlliances) return null;
  const s = st();
  const ga = allianceOf(a.id);
  const gb = allianceOf(b.id);
  const cap = tunables.social.maxAllianceSize;

  // Both already in the same bloc: nothing to do but reaffirm it.
  if (ga && gb && ga.id === gb.id) {
    ga.cohesion = Math.min(1, ga.cohesion + tunables.social.cohesionGainPerGoodOutcome);
    return ga;
  }

  // Both in different blocs: merge only if the combined size fits. A merge that
  // would overflow the cap is declined rather than truncated, because dropping
  // someone silently to make room reads as a betrayal nobody chose.
  if (ga && gb) {
    if (ga.memberIds.length + gb.memberIds.length > cap) return ga;
    for (const m of gb.memberIds) {
      if (!ga.memberIds.includes(m)) ga.memberIds.push(m);
      s.memberOf.set(m, ga.id);
    }
    s.byId.delete(gb.id);
    // A merge starts shakier than either half was: more people, more ways to
    // diverge.
    ga.cohesion = Math.min(ga.cohesion, gb.cohesion) * 0.9;
    linkAll(ga.memberIds);
    pushWorldEvent(
      "allianceFormed",
      ga.memberIds,
      `${ga.memberIds.length} islanders are running together now.`,
      now,
    );
    return ga;
  }

  // One in a bloc, one out: the outsider joins if there is room.
  const group = ga ?? gb;
  const joiner = ga ? b : a;
  if (group) {
    if (group.memberIds.length >= cap) return group;
    group.memberIds.push(joiner.id);
    s.memberOf.set(joiner.id, group.id);
    group.cohesion = Math.max(0, group.cohesion - 0.05); // a new face dilutes it
    linkAll(group.memberIds);
    pushWorldEvent(
      "allianceFormed",
      group.memberIds,
      `${joiner.name} is in with ${group.memberIds.length - 1} others now.`,
      now,
    );
    return group;
  }

  // Neither in a bloc: a new pair becomes the seed of one.
  const fresh: Alliance = {
    id: `al${s.nextId++}`,
    memberIds: [a.id, b.id],
    cohesion: tunables.social.cohesionStart,
    formedAt: now,
  };
  s.byId.set(fresh.id, fresh);
  s.memberOf.set(a.id, fresh.id);
  s.memberOf.set(b.id, fresh.id);
  return fresh;
}

// A member walks. Their pairwise links to the bloc are cut, which is what makes
// the departure visible to combat and the vote.
export function defect(agentId: string, now: number, reason: string): void {
  const g = allianceOf(agentId);
  if (!g) return;
  const s = st();
  const c = state.contestants[agentId];
  g.memberIds = g.memberIds.filter((m) => m !== agentId);
  s.memberOf.delete(agentId);
  unlink(agentId, [...g.memberIds, agentId]);
  g.cohesion = Math.max(0, g.cohesion - tunables.social.cohesionLossPerBetrayal);

  if (c) {
    pushWorldEvent("allianceBroken", [agentId, ...g.memberIds], `${c.name} ${reason}.`, now);
    // Rich SMS (WS-G follow up): this was the one allianceBroken producer gap
    // WS-F flagged -- a bloc breaking here (voluntary walk from maybeDefect, or
    // an involuntary ejection from creditBetrayal below) never told a single
    // spectator. Notify both directions, mirroring how swarmBridge.ts's
    // notifyPair fires once per side of a formation: the leaver's own line says
    // THEY cut ties (betrayedSubject: false), and each remaining member's line
    // says they got cut loose (betrayedSubject: true). g.memberIds has already
    // been filtered above to exclude agentId, so this only reaches the members
    // actually left behind. Wrapped defensively -- a notification failure is
    // never allowed to break alliance state, which by this point is already
    // fully committed above.
    try {
      for (const otherId of g.memberIds) {
        const other = state.contestants[otherId];
        if (!other) continue;
        notifyAboutContestant(agentId, now, {
          kind: "allianceBroken",
          subjectName: c.name,
          otherName: other.name,
          betrayedSubject: false,
        });
        notifyAboutContestant(otherId, now, {
          kind: "allianceBroken",
          subjectName: other.name,
          otherName: c.name,
          betrayedSubject: true,
        });
      }
    } catch (err) {
      console.error("[alliances] allianceBroken notification failed:", err);
    }
  }
  // A bloc of one is not a bloc.
  if (g.memberIds.length <= 1) {
    for (const m of g.memberIds) s.memberOf.delete(m);
    s.byId.delete(g.id);
  }
}

// ---------------------------------------------------------------------------
// Cohesion drivers.
//
// Cohesion used to have exactly one gain path (two members who were already in
// the same bloc formally re-allying) and one loss path (a defection). Both of
// the things the spec actually names as drivers were missing: successful joint
// votes never touched it, and a real in-fiction betrayal cost nothing. The
// three functions below are the seams for those, called from the systems that
// own the underlying events rather than reaching into them from here.
// ---------------------------------------------------------------------------

// Ordinary warmth between two members of the same bloc.
//
// The narrow re-alliance path missed the common case: two people in a bloc who
// simply get on well produce `amicable` outcomes for the whole run and the
// group they belong to never registered any of it. Returns whether the credit
// landed, so a caller can tell "not in a bloc together" from "credited".
export function creditGoodOutcome(
  aId: string,
  bId: string,
  outcome: RelOutcome,
  now: number,
): boolean {
  if (!tunables.flags.multiAlliances) return false;
  const ga = allianceOf(aId);
  if (!ga || allianceOf(bId)?.id !== ga.id) return false;

  // `alliance` is deliberately not handled here. joinOrFormAlliance already
  // credits a same-bloc re-affirmation, and crediting it twice for one outcome
  // would make formal re-allying worth double what it is meant to be worth.
  const scale = outcome === "amicable" ? 1 : outcome === "truce" ? 0.5 : 0;
  if (scale === 0) return false;

  // Once per scan window. Two members mid conversation can produce warmth every
  // few seconds, and without a window that alone would hold any bloc at full
  // cohesion forever, which would make the whole defection path unreachable by
  // a completely different route than the one this workstream is fixing.
  const last = ga.lastGoodCreditAt ?? -Infinity;
  if (now - last < tunables.alliances.cohesionScanMs) return false;
  ga.lastGoodCreditAt = now;

  ga.cohesion = clamp01(ga.cohesion + tunables.social.cohesionGainPerGoodOutcome * scale);
  return true;
}

// The spec's main positive driver: a bloc whose members converged on the same
// eliminated target just proved, in public, that it can move a vote.
//
// `memberIds` is the set of agents who voted for the target that actually went.
// Returns the ids of every bloc credited, so the vote resolution can log or
// assert that the driver fired rather than trusting that it did.
export function creditJointVote(
  memberIds: string[],
  targetEliminated: boolean,
  now: number,
): string[] {
  if (!tunables.flags.multiAlliances) return [];
  // A vote that did not remove anyone proved nothing about the bloc's reach.
  if (!targetEliminated) return [];

  const voters = new Set(memberIds);
  const credited: string[] = [];
  for (const g of allAlliances()) {
    const converged = g.memberIds.filter((m) => voters.has(m)).length;
    // One member voting with the field is that member, not the bloc. Two or
    // more moving together is the group functioning as a group.
    if (converged < 2) continue;
    // Scaled by turnout, so a two of five showing is worth less than the whole
    // group moving as one. A bloc that only half shows up learns something
    // about itself too.
    const share = converged / Math.max(1, g.memberIds.length);
    g.cohesion = clamp01(g.cohesion + tunables.social.cohesionGainPerJointVote * share);
    g.lastGoodCreditAt = now;
    credited.push(g.id);
  }
  return credited;
}

// A member attacked someone it is allied with.
//
// combat.ts has always computed this exact boolean and used it only to flag the
// emit, so the single most flagrant thing an islander can do to its own bloc
// carried no cohesion cost at all. Only an attack INSIDE a bloc counts: two
// pairwise allies who never formed a group have no group to damage.
export function creditBetrayal(attackerId: string, defenderId: string, now: number): void {
  if (!tunables.flags.multiAlliances) return;
  const g = allianceOf(attackerId);
  if (!g || allianceOf(defenderId)?.id !== g.id) return;

  g.cohesion = Math.max(0, g.cohesion - tunables.social.cohesionLossPerBetrayal);

  // Hitting someone you are running with is a decision, not a mood. If it takes
  // the bloc under the floor, the attacker does not get to stay inside it and
  // keep the protection. defect() applies its own further loss on the way out,
  // and that compounding is intended: a betrayal the group absorbs costs less
  // than one that actually breaks it.
  if (tunables.flags.allianceDefection && g.cohesion < tunables.social.defectionFloor) {
    defect(attackerId, now, "turned on the group");
  }
}

export function removeFromAlliances(agentId: string): void {
  const s = st();
  const g = allianceOf(agentId);
  if (!g) return;
  g.memberIds = g.memberIds.filter((m) => m !== agentId);
  s.memberOf.delete(agentId);
  if (g.memberIds.length <= 1) {
    for (const m of g.memberIds) s.memberOf.delete(m);
    s.byId.delete(g.id);
  }
}

// ---------------------------------------------------------------------------
// Cohesion drift and defection checks.
//
// Called on the slow path, not every tick: a bloc that re-evaluates itself
// constantly never holds together long enough to matter, and the drama comes
// from blocs that last and then crack. The scan interval lives in config
// (tunables.alliances.cohesionScanMs) rather than here.
// ---------------------------------------------------------------------------

// How hard cohesion is pulled toward the bloc's mean trust on each scan. Small
// on purpose, so one sour conversation does not dissolve a long partnership.
const COHESION_DRIFT_RATE = 0.05;

// The pre-spec flat defection roll, kept as the CENTRE of the new scaled roll
// rather than as the roll itself, so a member under no particular pressure
// still leaves about as often as it used to.
const DEFECTION_BASE_CHANCE = 0.25;
// A member who is personally comfortable barely considers walking; one whose
// own survival clearly points elsewhere considers it often. These bracket the
// base above at roughly 0.10 and 0.40.
const DEFECTION_CALM_SCALE = 0.4;
const DEFECTION_PRESSURE_SCALE = 1.2;
// Used when selfOdds is off and there is no standing signal to read. Chosen so
// the scaled roll collapses back to exactly DEFECTION_BASE_CHANCE, which keeps
// that flag combination behaving as it did before this became survival-aware.
const NEUTRAL_PRESSURE = 0.5;
// How much of the walk decision the ouster board may account for. Names on the
// board are the most concrete evidence a member has, but a bloc is also the
// thing that protects against them, so it never dominates the trust reading.
const OUSTER_EXPOSURE_WEIGHT = 0.4;
// How far a weak bond outweighs personal pressure when choosing WHICH member
// walks. Bond leads because the question here is who is least held, not who is
// most afraid; pressure decides whether anyone walks at all.
const PRESSURE_PICK_WEIGHT = 0.5;

// Erosion applied per scan when the trust signal is unavailable, expressed as a
// fraction of one good outcome so the two stay in proportion under retuning: a
// bloc that gets nothing back slides, and a single shared good outcome buys
// back several scans of it.
const BLIND_EROSION_FRACTION = 0.25;

let warnedBlindCohesion = false;

// Mean pairwise trust inside a bloc, or null when there is no trust signal to
// read.
//
// The null case is the fixed-point trap this function exists to name. With
// multiAlliances on and relationshipMemory off - two independent env reads, so
// a reachable production config and not just a test artifact - every
// relationship() lookup returns a fresh zero record. Mean trust is then exactly
// 0 for every bloc forever, and the drift below has its zero at (0 + 1) / 2 =
// 0.5, well above the 0.2 defection floor. Cohesion pinned at precisely 0.5 for
// the entire run, no bloc could ever crack, and cohesion was decorative.
function blocMeanTrust(g: Alliance, now: number): number | null {
  if (!tunables.flags.relationshipMemory) return null;
  let trustSum = 0;
  let pairs = 0;
  for (const x of g.memberIds) {
    for (const y of g.memberIds) {
      if (x === y) continue;
      trustSum += relationship(x, y, now).trust;
      pairs++;
    }
  }
  return pairs > 0 ? trustSum / pairs : 0;
}

// How much this member's own survival points away from the bloc. 0..1.
//
// Cohesion alone answers "is the group weak", which is a fact about everyone
// equally. This answers "and is staying in it still working for ME", which is
// what the spec means by defection following a member's own survival. A
// fracturing bloc of comfortable people should mostly hold; the same bloc
// containing someone the villa is circling should lose that someone.
function standingPressure(agentId: string, now: number): number {
  const c = state.contestants[agentId];
  if (!c) return NEUTRAL_PRESSURE;

  const odds = selfOdds(c, now);
  let p: number;
  if (!odds) {
    p = NEUTRAL_PRESSURE;
  } else {
    p =
      odds.band === "precarious"
        ? 1
        : odds.band === "shaky"
          ? 0.6
          : odds.band === "steady"
            ? 0.25
            : 0;
    // The band is the position; `worried` is whether this personality actually
    // feels it. A timid islander acts on a shaky read a bold one shrugs off.
    if (odds.worried) p += 0.15;
  }

  // The vote math input. Support already sitting on the board against this
  // member is the least deniable signal available to it.
  const q = ousterQuorum();
  if (q > 0) p += Math.min(1, ousterSupportCount(agentId) / q) * OUSTER_EXPOSURE_WEIGHT;

  return Math.min(1, p);
}

// Below the floor, at most one member walks per scan, and only sometimes:
// defection is meant to be the source of most drama, which means it has to be
// possible without being constant.
function maybeDefect(g: Alliance, now: number): void {
  let walker: string | null = null;
  let worstScore = -Infinity;
  for (const m of g.memberIds) {
    let bondSum = 0;
    for (const o of g.memberIds) if (o !== m) bondSum += relationship(m, o, now).trust;
    const bond = g.memberIds.length > 1 ? bondSum / (g.memberIds.length - 1) : 0;
    const score = -bond + standingPressure(m, now) * PRESSURE_PICK_WEIGHT;
    if (score > worstScore) {
      worstScore = score;
      walker = m;
    }
  }
  if (!walker) return;

  const pressure = standingPressure(walker, now);
  const chance =
    DEFECTION_BASE_CHANCE * (DEFECTION_CALM_SCALE + DEFECTION_PRESSURE_SCALE * pressure);
  if (rand() < chance) defect(walker, now, "walked away from the group");
}

export function tickAlliances(now: number): void {
  if (!tunables.flags.multiAlliances) return;
  const s = st();
  if (now - s.lastCohesionScanAt < tunables.alliances.cohesionScanMs) return;
  s.lastCohesionScanAt = now;

  expireOusterSupport(now);

  for (const g of allAlliances()) {
    const meanTrust = blocMeanTrust(g, now);
    if (meanTrust === null) {
      // No trust signal. Rather than pinning at the drift's fixed point, a bloc
      // with nothing sustaining it erodes. That keeps the one property that
      // matters in both configurations: cohesion is something a bloc has to
      // keep earning, and defection stays reachable. The credit seams above are
      // what a bloc earns it back with.
      if (!warnedBlindCohesion) {
        warnedBlindCohesion = true;
        console.warn(
          "[alliances] multiAlliances is on but relationshipMemory is off. " +
            "There is no trust signal, so bloc cohesion erodes on a timer " +
            "instead of tracking how members feel. Set ISLAND_RELATIONSHIP_MEMORY=1 " +
            "for the intended behavior.",
        );
      }
      g.cohesion = Math.max(
        0,
        g.cohesion - tunables.social.cohesionGainPerGoodOutcome * BLIND_EROSION_FRACTION,
      );
    } else {
      // Pull cohesion gently toward the bloc's mean trust rather than setting
      // it. Mean trust is -1..1 and cohesion is 0..1, hence the remap.
      g.cohesion = clamp01(g.cohesion + (meanTrust - (g.cohesion * 2 - 1)) * COHESION_DRIFT_RATE);
    }

    if (!tunables.flags.allianceDefection) continue;
    if (g.cohesion >= tunables.social.defectionFloor) continue;
    maybeDefect(g, now);
  }
}

// ---------------------------------------------------------------------------
// The spontaneous ouster board.
//
// Outside a formal voting event, nobody can be eliminated on one agent's say
// so. A target needs at least `ousterThreshold` of the LIVING field behind it.
// That threshold is the whole safety property: it is what stops one aggressive
// schemer from unilaterally removing people between scheduled events.
// ---------------------------------------------------------------------------

// How many living islanders must agree before an ouster can proceed.
export function ousterQuorum(): number {
  return Math.max(2, Math.ceil(aliveCount() * tunables.social.ousterThreshold));
}

// An agent throws its weight behind removing `targetId`. Returns true once the
// support has reached quorum, which is the caller's cue to act.
//
// `now` is optional so the two existing call sites keep compiling unchanged. It
// is what stamps the entry for expiry, so a caller that already has the sim's
// clock should always pass it: the Date.now() default is a fallback for callers
// that do not, not the intended path.
export function supportOuster(supporterId: string, targetId: string, now = Date.now()): boolean {
  if (!tunables.flags.spontaneousOuster) return false;
  if (supporterId === targetId) return false;
  const target = state.contestants[targetId];
  const supporter = state.contestants[supporterId];
  if (!target?.alive || !supporter?.alive) return false;

  const s = st();
  const board = s.ousterSupport.get(targetId) ?? new Map<string, number>();
  // Keyed by supporter, so ten pushes from one agent remain one voice and the
  // most recent push is what the expiry clock runs from.
  board.set(supporterId, now);
  s.ousterSupport.set(targetId, board);
  return board.size >= ousterQuorum();
}

// Register support, then report the state of the campaign.
//
// This exists because the ORDER is the whole bug. The production path guards
// with a winnability check BEFORE registering, and winnability is
// `count + backers >= quorum` with quorum floored at 2, so the very first
// supporter evaluates 0 + 1 >= 2, returns early, and never goes on the board.
// Support could therefore never leave zero at any flag setting, and the
// spontaneous ouster - the spec's main source of pressure between scheduled
// events - was mathematically unreachable in a real run rather than merely
// rare.
//
// Register first, then use winnability only to decide whether this agent keeps
// spending its intent on a target it cannot yet carry. That is what the "vote
// math" check was always meant to be: a reason to hold or redirect, not a
// precondition for being counted.
export function campaignForOuster(
  supporterId: string,
  targetId: string,
  now: number,
): { registered: boolean; reachedQuorum: boolean; keepCampaigning: boolean } {
  const reachedQuorum = supportOuster(supporterId, targetId, now);
  const registered = ousterSupportCount(targetId) > 0 && !!state.contestants[supporterId]?.alive;
  return {
    registered,
    reachedQuorum,
    // Worth staying on it if one more voice would carry it. Below that the
    // agent is better off looking for a target the villa is already circling.
    keepCampaigning: !reachedQuorum && ousterIsWinnable(targetId, 1),
  };
}

export function ousterSupportCount(targetId: string): number {
  return st().ousterSupport.get(targetId)?.size ?? 0;
}

// Whether an agent has the numbers to bother trying. This is the "vote math"
// check: an agent estimates whether the support exists before pushing, and
// backs off or redirects when it does not.
//
// NOTE: this is a question about whether to KEEP pushing, not a gate on being
// counted. Calling it before supportOuster deadlocks the board - see
// campaignForOuster above for why.
export function ousterIsWinnable(targetId: string, wouldBackerCount: number): boolean {
  return ousterSupportCount(targetId) + wouldBackerCount >= ousterQuorum();
}

export function clearOusterSupport(targetId: string): void {
  st().ousterSupport.delete(targetId);
}

// Support decays when the villa moves on, so a stale campaign does not sit at
// quorum forever waiting to fire.
//
// This is the time-based half, called from tickAlliances. Until it existed the
// comment above was aspirational: the only thing that ever removed a name was
// dropSupporter, and that fires only when the supporter dies, so a grudge from
// the opening minute still counted an hour later and quorum ratcheted upward
// permanently.
export function expireOusterSupport(now: number): void {
  const ttl = tunables.alliances.ousterSupportTtlMs;
  if (ttl <= 0) return;
  const s = st();
  for (const [targetId, board] of s.ousterSupport) {
    for (const [supporterId, at] of board) {
      if (now - at >= ttl) board.delete(supporterId);
    }
    if (board.size === 0) s.ousterSupport.delete(targetId);
  }
}

// The other half: a supporter who is no longer alive is no longer a voice.
export function dropSupporter(supporterId: string): void {
  for (const board of st().ousterSupport.values()) board.delete(supporterId);
}
