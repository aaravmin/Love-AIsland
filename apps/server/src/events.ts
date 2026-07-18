import { randomUUID } from "node:crypto";
import { tunables } from "@arena/shared";
import type { Contestant, EventModifier, GameEvent } from "@arena/shared";
import {
  allianceOf,
  creditJointVote,
  ousterQuorum,
  ousterSupportCount,
} from "./alliances.js";
import { processDeath } from "./combat.js";
import { applyMarketDrift } from "./market.js";
import { closeDigest, openDigest } from "./notify.js";
import {
  breakTie,
  pushHostileEvent,
  pushPurgeEvent,
  pushWorldEvent,
  rand,
  relationship,
} from "./social.js";
import { aliveCount, state } from "./state.js";
import type { ArenaServer } from "./io.js";

// ---------------------------------------------------------------------------
// Phase 7: the two scheduled mass-eliminations (the Purge, the Weakest Link)
// and the hostile-mode endgame forcer (ARCHITECTURE.md 6.5-6.6).
//
// Events thin the field on the run timeline but can NEVER end the game -- the
// winner always comes from combat, guaranteed to resolve by hostile mode.
// Every elimination still flows through the one processDeath pipeline
// (serialized, strict deathIndex, settle-No-before-next), so events reuse the
// exact settlement/redemption path combat uses.
// ---------------------------------------------------------------------------

// On-screen + agent-context warning window before an event fires.
const EVENT_COUNTDOWN_MS = 60_000;
// Regen decays 1 -> 0 across this window once hostile mode starts, then stays 0
// forever: no healing means every fight is permanent attrition and the field
// grinds down to one.
const HOSTILE_FULL_DECAY_MS = 3 * 60_000;

// Floor that makes each event incapable of ending the game (a scheduled cull
// must never crown the winner -- that is combat's job). The Purge and The Vote
// both remove the same purge-equivalent count and share this floor.
const PURGE_MIN_SURVIVORS = 4;

const EVENT_DESCRIPTION: Record<GameEvent["kind"], string> = {
  purge: "The Purge - the weakest islanders are culled.",
  weakestLink: "The Vote - the islanders vote off the players they want gone.",
};

function living(): Contestant[] {
  return Object.values(state.contestants).filter((c) => c.alive);
}

// Higher = safer from the Purge. Proven lethality (kills) dominates, then raw
// fighting stats and current health -- the Purge culls the physically weak.
function combatStrength(c: Contestant): number {
  return c.kills * 100 + c.stats.strength * 4 + c.stats.grit * 3 + (c.hp / c.maxHp) * 20;
}

// The number both scheduled events remove: the bottom third of the living
// field, floored so the game can never drop below PURGE_MIN_SURVIVORS (only
// combat may crown the winner). The Purge and The Vote both use this count.
function purgeEquivalentCount(): number {
  const alive = living();
  const removable = Math.max(0, alive.length - PURGE_MIN_SURVIVORS);
  return Math.min(Math.floor(alive.length / 3), removable);
}

// How many THE VOTE sends home.
//
// The spec phrases the vote in the singular ("the most votes is eliminated",
// line 150) but the shipped build has always removed a purge-equivalent slice,
// and quietly dropping to one would change the shape of every run. So the
// deviation is deliberate and it is now a knob rather than a hardcode:
// social.voteEliminationCount is 0 by default, meaning "keep the shipped
// slice", and setting it to 1 gives the spec's literal wording. Whatever the
// number, PURGE_MIN_SURVIVORS still holds, because a scheduled cull may never
// crown the winner.
function voteEliminationCount(): number {
  const configured = tunables.social.voteEliminationCount;
  if (configured <= 0) return purgeEquivalentCount();
  const removable = Math.max(0, living().length - PURGE_MIN_SURVIVORS);
  return Math.min(configured, removable);
}

// The Purge removes the bottom third by combat strength, never dropping the
// field below PURGE_MIN_SURVIVORS. Returned weakest-first so deathIndex runs
// in ascending strength.
//
// The secondary comparator is THE tie rule (social.ts breakTie), and it is
// applied unconditionally rather than behind a flag. combatStrength is
// kills*100 + strength*4 + grit*3 + hpFrac*20 over small integer stats, so
// exact ties between two contestants are routine, not exotic; before this the
// winner of such a tie was decided by Object.values insertion order, which is
// neither stated anywhere nor stable under a reseeded run. That is not a
// behavior the flags-off build is entitled to keep: the spec's "state this
// rule once and use it everywhere" (line 150) is a cross-cutting correctness
// rule, and breakTie only ever decides between contestants the primary
// comparator already called equal, so it can never change who the Purge culls
// on merit.
export function purgeTargets(): string[] {
  const count = purgeEquivalentCount();
  if (count <= 0) return [];
  return living()
    .slice()
    .sort((a, b) => {
      const ds = combatStrength(a) - combatStrength(b);
      if (ds !== 0) return ds;
      return breakTie(a, b);
    })
    .slice(0, count)
    .map((c) => c.id);
}

// Higher = more likely to be voted out. The villa piles onto the biggest
// threats (notoriety) and the friendless loners (few allies), with light noise
// so the tally shifts run to run.
//
// The noise draws from the seeded rand(), not Math.random. A run seed exists so
// a run can be replayed for debugging and so betting outcomes are auditable
// (spec line 214); an unseeded draw inside the path that decides who dies means
// the legacy vote is the one thing in the sim that cannot be reproduced.
function voteWeight(c: Contestant): number {
  const isolation = (10 - Math.min(10, c.allies.length)) * 4;
  return c.notoriety + isolation + rand() * 20;
}

// Survivor-style vote weighting: how badly `voter` wants `target` gone. Unlike
// the original weight, this is per-voter rather than global, because the whole
// point is that different islanders want different people out.
//
// Three inputs, matching how a real player reasons:
//   threat      does this person beat me if they stay
//   likability  can I actually get others to follow me onto them
//   history     what has passed between us
// Raw dislike alone is deliberately the weakest term. An agent that votes purely
// on feeling is the thing this replaces.
function survivorVoteWeight(voter: Contestant, target: Contestant, now: number): number {
  const rel = tunables.flags.relationshipMemory ? relationship(voter.id, target.id, now) : null;

  // Threat: proven lethality and standing, plus how dangerous this specific
  // person has felt to this specific voter.
  const threat = target.kills * 18 + target.notoriety * 0.6 + (rel ? rel.threat * 30 : 0);

  // Likability works BOTH ways and that is the interesting part. A well liked
  // target is harder to remove because the votes will not follow, so being
  // popular is protection; but a well liked target is also a bigger long-term
  // problem, so it adds threat too. The net is that the villa hesitates over
  // its favorites until they become the obvious remaining danger.
  const allyCount = target.allies.length;
  const protection = allyCount * 7;
  const longGameRisk = allyCount * 3;

  // History: the accumulated feeling, which matters but does not dominate.
  const history = rel ? -rel.affinity * 12 - rel.trust * 8 : 0;

  // Isolation: the friendless are the easy vote, which is the villa's oldest
  // habit and the one the original weighting already captured.
  const isolation = (10 - Math.min(10, allyCount)) * 3;

  return threat + longGameRisk - protection + history + isolation + rand() * 10;
}

// How many votes this voter can realistically expect to land on `target`.
//
// This used to discard the voter entirely and count "everyone who is not the
// target and not one of the target's allies", which with ten alive and a target
// holding two allies is seven against a threshold of four: true for every voter
// against every target, forever. It was a no-op wearing the name of a check.
//
// The real question is per voter, because the whole point is that different
// islanders command different numbers. An islander cannot see the villa's
// intentions, but it CAN count three things it genuinely observes:
//
//   its own vote          always one
//   the people with it    its bloc and its pairwise allies, minus the target
//                         and anyone allied to the target, because a shared
//                         friend does not follow you onto them
//   who is already circling  names already on the ouster board for this target,
//                         plus (when relationship memory is on) living
//                         islanders carrying visible bad blood with the target
//
// Deliberately optimistic on the last term and deliberately capped by who is
// actually alive: an agent overestimating its reach a little is exactly how a
// real player misreads a vote.
function expectedVotesFor(voter: Contestant, target: Contestant, now: number): number {
  const counted = new Set<string>([voter.id]);

  const add = (id: string): void => {
    if (id === voter.id || id === target.id) return;
    const c = state.contestants[id];
    if (!c?.alive) return;
    // Someone close to the target is not a vote against the target.
    if (target.allies.includes(id)) return;
    counted.add(id);
  };

  const bloc = tunables.flags.multiAlliances ? allianceOf(voter.id) : undefined;
  if (bloc) for (const id of bloc.memberIds) add(id);
  for (const id of voter.allies) add(id);

  for (const c of living()) {
    if (counted.has(c.id) || c.id === voter.id || c.id === target.id) continue;
    // Already publicly campaigning against this target: the board is the one
    // piece of other people's intent an islander can actually read.
    if (ousterSupportCount(target.id) > 0 && c.allies.includes(voter.id)) {
      add(c.id);
      continue;
    }
    if (!tunables.flags.relationshipMemory) continue;
    const rel = relationship(c.id, target.id, now);
    if (rel.affinity < -0.2 || rel.threat > 0.4) add(c.id);
  }

  return counted.size;
}

// Can this voter actually pull the votes together? An agent that pushes a
// target it has no numbers for wastes its vote, so it checks first and
// redirects when the math is not there.
//
// The bar is the same quorum the spontaneous ouster uses (alliances.ts
// ousterQuorum, social.ousterThreshold of the living field, floored at two), so
// "do I have the numbers" means one thing in this codebase rather than two.
function voteMathSupports(voter: Contestant, target: Contestant, now: number): boolean {
  return expectedVotesFor(voter, target, now) >= ousterQuorum();
}

// THE VOTE (the "weakestLink" event, presented as "The Vote"): the villa votes
// off the same number the Purge would cull. Each living islander casts one vote
// for a living NON-ally, weighted toward the biggest threats and least-liked
// loners; an islander hemmed in only by allies may abstain, or throw a protest
// vote at the highest-notoriety islander overall. The top `count` vote-getters
// go home (ties: THE tie rule, lower health then the seed). Returned
// most-voted-first so deathIndex runs from the villa's clearest target down.
export function voteTargets(now = Date.now()): string[] {
  const count = voteEliminationCount();
  if (count <= 0) return [];
  const alive = living();
  const tally = new Map<string, number>();
  // Who voted for whom, kept alongside the counts so the bloc that converged on
  // an eliminated target can be credited afterwards. The tally alone is a
  // number and forgets the names, which is why joint-vote cohesion never had a
  // producer before.
  const ballots = new Map<string, string[]>();
  for (const c of alive) {
    tally.set(c.id, 0);
    ballots.set(c.id, []);
  }
  const castVote = (voterId: string, targetId: string): void => {
    tally.set(targetId, (tally.get(targetId) ?? 0) + 1);
    ballots.get(targetId)?.push(voterId);
  };

  // Survivor-style resolution: every living islander votes, the most votes go
  // home, and ties break by the one stated rule (lower health, then the seed).
  if (tunables.flags.voteResolution) {
    const topThreatSurvivor =
      alive.slice().sort((a, b) => b.notoriety - a.notoriety)[0] ?? null;

    for (const voter of alive) {
      const candidates = alive.filter(
        (c) => c.id !== voter.id && !voter.allies.includes(c.id),
      );
      let choiceId: string | null = null;

      if (candidates.length === 0) {
        // Hemmed in by allies only. Abstaining is a real choice here, so it
        // stays possible rather than forcing a vote nobody wanted to cast.
        if (topThreatSurvivor && topThreatSurvivor.id !== voter.id && rand() < 0.5) {
          choiceId = topThreatSurvivor.id;
        }
      } else {
        // Score every candidate, then prefer the best one the voter can
        // actually get others onto.
        const scored = candidates
          .map((c) => ({ c, w: survivorVoteWeight(voter, c, now) }))
          .sort((x, y) => y.w - x.w);
        const winnable = scored.find((s) => voteMathSupports(voter, s.c, now));

        if (winnable) {
          choiceId = winnable.c.id;
        } else {
          // The math is not there for ANY of them. Voting the top pick anyway
          // is what the old code did, and it is why the check never showed:
          // failing produced a mild reordering and nothing else. An islander
          // that cannot carry its own plan does one of the two things a real
          // player does.
          //
          // Redirect: fall in behind whoever the villa is already circling,
          // which is the only public read on where the votes are going. This
          // is what makes a vote converge rather than scatter.
          const bandwagon = scored
            .filter((s) => ousterSupportCount(s.c.id) > 0)
            .sort((x, y) => ousterSupportCount(y.c.id) - ousterSupportCount(x.c.id))[0];
          if (bandwagon) {
            choiceId = bandwagon.c.id;
          } else {
            // Hold. Nobody is circling anybody, so throwing a vote at a target
            // it cannot remove only paints this voter as the one who moved
            // first. Hesitation is the visible behavior the spec is asking for.
            choiceId = null;
          }
        }
      }
      if (choiceId) castVote(voter.id, choiceId);
    }

    const ordered = alive.slice().sort((a, b) => {
      const dv = (tally.get(b.id) ?? 0) - (tally.get(a.id) ?? 0);
      if (dv !== 0) return dv;
      // THE tie rule, the same one used everywhere.
      return breakTie(a, b);
    });

    const eliminated = ordered.slice(0, count);
    for (const c of eliminated) {
      pushWorldEvent(
        "voteResult",
        [c.id],
        `${c.name} was voted out with ${tally.get(c.id) ?? 0} votes.`,
        now,
      );
      // A bloc whose members converged on someone who ACTUALLY went home just
      // proved to itself that it can move the villa, which is the spec's main
      // positive cohesion driver (line 148) and had no call site anywhere.
      // Credited per eliminated target with the real ballot, so a bloc that
      // half showed up is scaled down by turnout inside creditJointVote rather
      // than here. Every caller of voteTargets eliminates exactly what it
      // returns, so passing `true` for targetEliminated is honest.
      creditJointVote(ballots.get(c.id) ?? [], true, now);
    }
    return eliminated.map((c) => c.id);
  }
  // Fallback target for a voter surrounded only by allies: the loudest name in
  // the villa (highest notoriety overall, never themselves).
  const topThreat = alive.slice().sort((a, b) => b.notoriety - a.notoriety)[0] ?? null;
  for (const voter of alive) {
    const candidates = alive.filter((c) => c.id !== voter.id && !voter.allies.includes(c.id));
    let choiceId: string | null = null;
    if (candidates.length === 0) {
      // Only allies in reach: abstain half the time, else protest-vote the
      // biggest threat in the villa.
      if (topThreat && topThreat.id !== voter.id && rand() < 0.5) choiceId = topThreat.id;
    } else {
      let best = -Infinity;
      for (const c of candidates) {
        const w = voteWeight(c);
        if (w > best) {
          best = w;
          choiceId = c.id;
        }
      }
    }
    if (choiceId) castVote(voter.id, choiceId);
  }
  return alive
    .slice()
    .sort((a, b) => {
      const dv = (tally.get(b.id) ?? 0) - (tally.get(a.id) ?? 0);
      if (dv !== 0) return dv;
      // THE tie rule, the same one the flag-on path above uses.
      //
      // This branch used to break a vote-count tie on fewest allies and then
      // lowest live market price, which is a third undocumented rule for the
      // same question, and it is the ACTIVE one whenever voteResolution is off.
      // Worse, pricing made who dies a function of who bet, so a spectator
      // could move an elimination with tokens. breakTie is total (lower health,
      // then the seeded hash, then id order), so nothing downstream of the
      // count is left undecided and the legacy vote replays under its seed.
      return breakTie(a, b);
    })
    .slice(0, count)
    .map((c) => c.id);
}

function fireEvent(io: ArenaServer, event: GameEvent, now: number): void {
  const targets = event.kind === "purge" ? purgeTargets() : voteTargets(now);
  const cause = event.kind === "purge" ? "purge" : "voteOff";
  // One text for one mass elimination. Without the digest, processDeath fires a
  // per-victim alert inside this loop and the per-spectator cooldown swallows
  // all but the first, so someone holding positions on three culled islanders
  // got exactly one text about whichever victim happened to be processed first.
  // That is a correctness bug, not a rate limit. Opened BEFORE the loop and
  // closed after it so the digest scan reads the settled post-purge state in
  // one pass: who died, who survived, and whose price moved.
  const digest = tunables.flags.richNotifications;
  if (digest) openDigest(now);
  try {
    // Serialized: each processDeath completes (settlement + redemption) before
    // the next, so No positions redeem in strict order and deathIndex is dense.
    for (const id of targets) processDeath(io, id, cause, null, now);
  } finally {
    // A throw mid-cull must not leave the digest latched open, which would
    // suppress every later notification for the rest of the run.
    if (digest) closeDigest(now);
  }
  event.firedAt = now;
  event.eliminatedIds = targets;
  event.resolved = true;

  // Surviving a cull is observable and it is real information: the field just
  // shrank and this islander is still standing. Applied to survivors only, and
  // deliberately small, so it reads as a nudge rather than a re-pricing.
  for (const c of living()) applyMarketDrift(c.id, tunables.market.driftOnPurgeSurvival, now);

  // The feed entry agents actually react to. Routed through social.ts's typed
  // producer for the purge kind rather than the untyped pushWorldEvent, so the
  // "purge" WorldEventKind has one named producer that a reader can find by
  // grep. The line is broadcast-ready: world narration and the rich SMS both
  // read it verbatim, so it names the count and reads as a sentence.
  if (event.kind === "purge") {
    pushPurgeEvent(
      targets,
      targets.length === 1
        ? "The Purge took one islander."
        : `The Purge took ${targets.length} islanders.`,
      now,
    );
  } else {
    pushWorldEvent(
      "voteResult",
      targets,
      targets.length === 1
        ? "The Vote sent one islander home."
        : `The Vote sent ${targets.length} home.`,
      now,
    );
  }

  io.emit("event:fired", {
    kind: event.kind,
    eliminatedIds: targets,
    survivorsCount: aliveCount(),
  });
}

function startHostile(io: ArenaServer, now: number): void {
  state.hostile.active = true;
  state.hostile.startedAt = now;
  state.hostile.fullDecayAt = now + HOSTILE_FULL_DECAY_MS;
  // Hostile mode is the largest single change to everyone's situation in the
  // run and until now it existed only as a socket emit and a prompt modifier,
  // so nothing an agent reads ever recorded that it happened. Pushing it to the
  // feed is what lets an islander react to the endgame rather than merely be
  // told about it in its next prompt.
  pushHostileEvent(
    "Sudden death has begun. Healing is gone and only one islander leaves the villa.",
    now,
  );
  io.emit("game:hostile", { startedAt: now, fullDecayAt: state.hostile.fullDecayAt });
}

// Step of the running-phase tick: raise 60 s countdowns, fire due events, and
// flip on hostile mode when the timeline reaches it.
export function tickEvents(io: ArenaServer, now: number): void {
  if (state.phase !== "running") return;
  for (const event of state.events) {
    if (event.resolved) continue;
    if (event.countdownStartedAt === null && now >= event.scheduledAt - EVENT_COUNTDOWN_MS) {
      event.countdownStartedAt = now;
      io.emit("event:countdown", {
        kind: event.kind,
        firesAt: event.scheduledAt,
        description: EVENT_DESCRIPTION[event.kind],
      });
    }
    if (event.firedAt === null && now >= event.scheduledAt) fireEvent(io, event, now);
  }
  if (!state.hostile.active && state.timeline && now >= state.timeline.hostileAt) {
    startHostile(io, now);
  }
}

// regenFactor for tickRegen: 1 normally, lerping to 0 across the hostile decay
// window, then pinned at 0 (no healing -> guaranteed convergence).
export function currentRegenFactor(now: number): number {
  const h = state.hostile;
  if (!h.active || h.startedAt === null || h.fullDecayAt === null) return 1;
  if (now >= h.fullDecayAt) return 0;
  const span = h.fullDecayAt - h.startedAt;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - (now - h.startedAt) / span));
}

// The agent-context modifier (populates WorldView.agentContext().event): drives
// both the LLM prompt line and the rule-engine aggression pressure. Hostile
// mode outranks a pending countdown.
export function currentEventModifier(now: number): EventModifier | null {
  if (state.hostile.active) {
    return {
      kind: "hostile",
      secondsUntil: null,
      line: "SUDDEN DEATH: healing is gone and there are no more allies. Only one islander leaves. Hunt.",
    };
  }
  let soonest: GameEvent | null = null;
  for (const e of state.events) {
    if (e.resolved || e.countdownStartedAt === null || e.firedAt !== null) continue;
    if (!soonest || e.scheduledAt < soonest.scheduledAt) soonest = e;
  }
  if (!soonest) return null;
  const secondsUntil = Math.max(0, Math.round((soonest.scheduledAt - now) / 1000));
  const line =
    soonest.kind === "purge"
      ? `The Purge hits in ${secondsUntil}s and culls the physically weakest islanders. If you are weak, ally up or lie low until it passes; if you are strong, pick off the vulnerable now before the Purge takes them for you.`
      : `The Vote hits in ${secondsUntil}s and the whole villa votes several islanders off - the biggest threats and the friendless loners go home. Make yourself liked and notable and lock in allies now, and campaign against your rivals; if you are unpopular or isolated, the villa will vote you out.`;
  return { kind: soonest.kind, secondsUntil, line };
}

// Operator overrides (admin.ts). forceEvent fires the next unresolved event
// immediately; forceEndgame flips hostile mode on now.
export function forceNextEvent(io: ArenaServer, now: number): boolean {
  const next = state.events.find((e) => !e.resolved && e.firedAt === null);
  if (!next) return false;
  fireEvent(io, next, now);
  return true;
}

export function forceHostile(io: ArenaServer, now: number): boolean {
  if (state.hostile.active) return false;
  startHostile(io, now);
  return true;
}

// Operator override (admin.ts "forceVote"): run THE VOTE right now, voting off
// the purge-equivalent count via cause "voteOff", without waiting for the
// scheduled event. Emits the same event:fired the scheduled vote would so the
// client feed + "THE VOTE" splash still fire. Only meaningful in a running game.
export function forceVoteNow(io: ArenaServer, now: number): boolean {
  if (state.phase !== "running") return false;
  const targets = voteTargets(now);
  // Same batching as the scheduled path: an operator-forced vote is still a
  // mass elimination, so spectators get one digest rather than a burst.
  const digest = tunables.flags.richNotifications;
  if (digest) openDigest(now);
  try {
    for (const id of targets) processDeath(io, id, "voteOff", null, now);
  } finally {
    if (digest) closeDigest(now);
  }
  io.emit("event:fired", {
    kind: "weakestLink",
    eliminatedIds: targets,
    survivorsCount: aliveCount(),
  });
  return true;
}

// Operator arm (admin.ts "armEvent"): schedule an event to fire in `seconds`.
// Reuses (or creates) the room's event of that kind, starts its countdown now,
// and emits the same event:countdown the tick loop would -- tickEvents then
// fires it when the timer expires. Only meaningful in a running game.
export function armEvent(
  io: ArenaServer,
  kind: GameEvent["kind"],
  seconds: number,
  now: number,
): boolean {
  if (state.phase !== "running") return false;
  let event = state.events.find((e) => e.kind === kind);
  if (!event) {
    event = {
      id: randomUUID(),
      kind,
      scheduledAt: now,
      countdownStartedAt: null,
      firedAt: null,
      eliminatedIds: [],
      resolved: false,
    };
    state.events.push(event);
  }
  const firesAt = now + seconds * 1000;
  event.scheduledAt = firesAt;
  event.countdownStartedAt = now;
  // Re-arm cleanly so tickEvents will fire it even if this kind already ran.
  event.firedAt = null;
  event.resolved = false;
  event.eliminatedIds = [];
  io.emit("event:countdown", {
    kind,
    firesAt,
    description: EVENT_DESCRIPTION[kind],
  });
  return true;
}
