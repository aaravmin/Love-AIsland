import { randomUUID } from "node:crypto";
import type {
  AgentBrief,
  AgentContextView,
  AgentDecision,
  ConversationView,
  ConvMessage,
  ConvOutcome,
  DecisionSink,
  MemoryItem,
  NearbyAgent,
  SwarmTelemetry,
  WorldView,
} from "@arena/shared";
import type { Contestant } from "@arena/shared";
import {
  createAnthropic,
  createBackend,
  createSwarmScheduler,
  createThinker,
  runConversation,
  SpendTracker,
  swarmConfig,
  toBackend,
} from "@arena/swarm";
import { tunables } from "@arena/shared";
import {
  allianceViewFor,
  campaignForOuster,
  clearOusterSupport,
  creditGoodOutcome,
  joinOrFormAlliance,
} from "./alliances.js";
import { pairFoughtRecently, processDeath } from "./combat.js";
import {
  markOverheardSpoken,
  overheardFor,
  recordOverheard,
  relationshipSummaries,
  selfOdds,
  spatialAwareness,
} from "./awareness.js";
import { currentEventModifier } from "./events.js";
import { TILE_SIZE } from "./map.js";
import { applyMarketDrift } from "./market.js";
import { notifyAboutContestant } from "./notify.js";
import {
  drainEventsFor,
  peekEventsFor,
  pushWorldEvent,
  rand,
  recordOutcome,
  relationship,
  worldStateView,
} from "./social.js";
// Deep source imports into packages/swarm. The package's export map exposes
// only "." (packages/swarm/package.json), and its barrel does not re-export
// any of these three yet, so the barrel path does not resolve. WS-G has
// already asked for stripSpeechDashes to be re-exported and WS-M for
// createBatchThinker; once either lands, collapse the matching line here into
// the "@arena/swarm" import above. The deep path is deliberately narrow and
// commented rather than silently duplicated logic: there must stay exactly one
// dash stripper in the repo.
import { stripSpeechDashes } from "../../../packages/swarm/src/fallback.js";
import { setOverheardUsedHook } from "../../../packages/swarm/src/prompts.js";
import { createBatchThinker } from "../../../packages/swarm/src/decisions.js";
import {
  activate,
  roomOfAgent,
  roomOfConversation,
  runningRooms,
  type GateState,
  type Room,
} from "./rooms.js";
import { priceYes, state } from "./state.js";
import type { ArenaServer } from "./io.js";

// ---------------------------------------------------------------------------
// Server side of the 4.0 contract plus the swarm loop, conversation gate
// (4.5), outcome resolution (4.6), and alliance/memory/notoriety writers
// (4.7). This is the ONLY file that lets swarm decisions touch state.
// ---------------------------------------------------------------------------

const PERCEPTION_PX = 16 * TILE_SIZE;
const NOTORIETY_PER_KILL = 12;
const MEMORY_MAX = 6;

// Conversation gate constants (ARCHITECTURE.md 7.3).
const CONV_RADIUS_PX = 2.2 * TILE_SIZE;
const CONV_SCAN_MS = 1000; // one "tick-window"
const PAIR_COOLDOWN_MS = 90_000;
const MAX_CONCURRENT_CONV = 6;
const BASE_CONV_PROB = 0.15;
const ESCALATION_THRESHOLD = 0.6;
// A target at or above this resolve resists manipulation: a charmer/schemer
// working them cannot frame an alliance, and a schemer's betrayal of them is
// seen coming (no fight - they slip away instead of dying).
const RESOLVE_RESIST = 6;

function hpFraction(c: Contestant): number {
  return c.maxHp > 0 ? c.hp / c.maxHp : 0;
}
function marketPrice(id: string): number {
  const m = state.markets[id];
  return m ? priceYes(m) : 0;
}
function dist(a: Contestant, b: Contestant): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function targetWeight(from: Contestant, t: Contestant): number {
  const proximity = 1 / (1 + dist(from, t) / TILE_SIZE);
  return t.notoriety * (1 - 0.06 * t.stats.charm) * proximity * (t.klass === "timid" ? 0.65 : 1);
}
function toNearby(from: Contestant, o: Contestant): NearbyAgent {
  return {
    id: o.id,
    name: o.name,
    klass: o.klass,
    hpFraction: hpFraction(o),
    kills: o.kills,
    notoriety: o.notoriety,
    priceYes: marketPrice(o.id),
    allied: from.allies.includes(o.id),
    distance: dist(from, o),
    allyCount: o.allies.length,
  };
}

function pushMemory(c: Contestant, text: string, now: number): void {
  c.memory.push({ t: now, text } satisfies MemoryItem);
  if (c.memory.length > MEMORY_MAX) c.memory.shift();
}

// What an islander remembers about how a conversation went.
//
// These used to be one fixed template per outcome, so an agent's whole
// remembered history read as a list of identical clauses, and because truce
// dominated the outcome set it was largely a list of truces. That memory is
// then printed straight back into the next prompt, which taught the model that
// truces are what happens here. Varying the phrasing is not decoration: it is
// what stops the memory block feeding its own bias back into the model.
const MEMORY_LINES: Record<ConvOutcome["outcome"], ((name: string) => string)[]> = {
  alliance: [
    (n) => `allied with ${n}`,
    (n) => `shook on it with ${n}`,
    (n) => `${n} and I are working together now`,
  ],
  truce: [
    (n) => `made a truce with ${n}`,
    (n) => `agreed to leave ${n} alone for now`,
    (n) => `${n} and I called it even`,
  ],
  tension: [
    (n) => `things got tense with ${n}`,
    (n) => `${n} rubbed me the wrong way`,
    (n) => `that talk with ${n} went cold`,
  ],
  amicable: [
    (n) => `had a good chat with ${n}`,
    (n) => `warmed to ${n}`,
    (n) => `${n} is easy to be around`,
  ],
  nothing: [
    (n) => `spoke to ${n}, nothing came of it`,
    (n) => `small talk with ${n}`,
    (n) => `${n} and I talked about nothing much`,
  ],
  fight: [(n) => `it came to blows with ${n}`, (n) => `${n} and I went at it`],
};
function memoryLine(outcome: ConvOutcome["outcome"], otherName: string): string {
  const pool = MEMORY_LINES[outcome];
  return pool[Math.floor(rand() * pool.length) % pool.length]!(otherName);
}

// The short phrase naming WHY an outcome landed, stored on the relationship
// record. Every recordOutcome call site omitted it, so history recorded what
// happened and never what it was about.
function outcomeNote(outcome: ConvOutcome["outcome"], hostile: boolean): string {
  if (hostile) return "said during hostile mode";
  switch (outcome) {
    case "alliance":
      return "agreed to work together";
    case "truce":
      return "agreed to stand down";
    case "tension":
      return "a conversation that soured";
    case "amicable":
      return "a conversation that went well";
    case "fight":
      return "a conversation that turned physical";
    default:
      return "a conversation that went nowhere";
  }
}

// Whether a decision's reasoning already reads like a scheme, so we can surface
// it verbatim as a private "scheme" thought instead of a canned fallback line.
function readsSchemy(text: string): boolean {
  return /betray|backstab|manipulat|scheme|leverage|expendable|see it coming|business|get close|getting close|use (them|him|her)|throw .* under|trust/i.test(
    text,
  );
}

// Escalation scorer (ARCHITECTURE.md 7.3): how likely this agent is to turn a
// social encounter into a fight.
//
// `other` was added because the scorer structurally could not see history: it
// took only the actor, so two islanders who have fought three times scored
// exactly the same as two who had never met. The spec is explicit (line 90)
// that accumulated tension raises the odds of a future fight, and this is the
// only mechanical path that can carry it. `other` stays optional so the
// scorer keeps working for any caller that has no counterpart in hand.
function escalationScore(
  c: Contestant,
  other: Contestant | null,
  hostile: boolean,
  now: number,
): number {
  let s = 0.15;
  if (c.klass === "bold") s += 0.5;
  s += 0.04 * (c.stats.strength - 4);
  if (c.klass === "timid") s -= 0.15 + 0.02 * c.stats.charisma;
  s += 0.01 * c.notoriety;
  if (hostile) s += 0.3;

  // The pair term. Gated on relationshipMemory because that flag is what
  // populates the store at all: with it off every record is a fresh zero and
  // reading one would only add an empty map entry per conversation.
  //
  // The three pair weights (how much accumulated bad blood with one specific
  // person adds to the urge to swing at them, and how much accumulated
  // goodwill takes it away) used to be local module constants here. They now
  // live in tunables.decision, and are read BY PROPERTY PATH on every call
  // rather than destructured once: reloadTunables mutates the tunables object
  // in place, so a destructured copy taken at module load would pin the
  // process to the startup values and silently ignore every later reload.
  if (other && tunables.flags.relationshipMemory) {
    const r = relationship(c.id, other.id, now);
    s += tunables.decision.grievanceThreatGain * Math.max(0, r.threat);
    if (r.trust < 0) s += tunables.decision.grievanceDistrustGain * -r.trust;
    else s -= tunables.decision.goodwillDamping * r.trust;
  }
  return s;
}

// Whether "we agree to leave each other alone" is a thing these two could
// plausibly say to each other right now.
//
// Truce used to be in the allowed set unconditionally, which is the mechanical
// half of the user's "they almost exclusively go around making truces": an
// outcome that is always on the table gets picked constantly, and two
// islanders who have never exchanged a cross word were forever declaring
// peace with each other. A truce is a DE-ESCALATION, so it needs something to
// de-escalate FROM: a fight or tension already on the record, a swing the two
// of them traded recently, or the villa itself turning hostile.
function deEscalationWarranted(a: Contestant, b: Contestant, hostile: boolean, now: number): boolean {
  if (hostile) return true;
  if (pairFoughtRecently(a.id, b.id, now, tunables.conflict.pairCooldownMs)) return true;
  if (!tunables.flags.relationshipMemory) return false;
  const ab = relationship(a.id, b.id, now);
  const ba = relationship(b.id, a.id, now);
  const soured = (r: { trust: number; threat: number }) => r.trust < -0.1 || r.threat > 0.15;
  return soured(ab) || soured(ba);
}

// The allowed-outcome set the LLM/canned resolver must choose from. Fight
// enters only if an escalation score clears the threshold (and only against a
// non-ally, unless a schemer is present for a betrayal).
function computeAllowedOutcomes(
  a: Contestant,
  b: Contestant,
  hostile: boolean,
): ConvOutcome["outcome"][] {
  const areAllies = a.allies.includes(b.id);
  // Resolve resists manipulation: a charmer/schemer cannot frame an alliance
  // with a high-resolve target, so alliance drops off the table when either
  // party is the resistant mark of a manipulator.
  const resistsFraming = (worker: Contestant, mark: Contestant) =>
    (worker.klass === "charmer" || worker.klass === "schemer") &&
    mark.stats.resolve >= RESOLVE_RESIST;
  const allianceResisted = resistsFraming(a, b) || resistsFraming(b, a);
  const now = Date.now();

  // The spec's five-outcome set (section 2), seeded in the order the resolver
  // reads it. "nothing" is FIRST and unconditional because the spec says at
  // line 80 that most conversations end there; tension and amicable are
  // unconditional beside it because they are two of the five, not optional
  // extras. They used to be appended last and only behind relationshipMemory,
  // while "truce" - which the spec does not list at all - sat in the
  // unconditional seed ahead of everything. That inversion is the mechanical
  // cause of the villa spending its whole run making pacts.
  //
  // Truce is kept, not deleted: it is a real thing two islanders do. It is
  // simply no longer privileged, and now has to be earned by there being
  // something to de-escalate. It goes LAST so a first-match resolver reaches
  // every spec outcome before it.
  const outs: ConvOutcome["outcome"][] = ["nothing", "tension", "amicable"];
  if (!areAllies && !allianceResisted) outs.push("alliance");
  const canFight = !areAllies || a.klass === "schemer" || b.klass === "schemer";
  const escalates =
    Math.max(escalationScore(a, b, hostile, now), escalationScore(b, a, hostile, now)) >=
    ESCALATION_THRESHOLD;
  // Timid negotiates out unless cornered (low HP, no allies, hostile).
  const cornered = (c: Contestant) => hpFraction(c) < 0.4 && c.allies.length === 0 && hostile;
  const timidBlocks =
    (a.klass === "timid" && !cornered(a)) || (b.klass === "timid" && !cornered(b));
  // A high-resolve ally sees a schemer's betrayal coming: the surprise fight is
  // off, so they slip away rather than die. Only relevant when this is a
  // betrayal (the pair are already allies with a schemer among them).
  const betrayalSeenComing =
    areAllies &&
    ((a.klass === "schemer" && b.stats.resolve >= RESOLVE_RESIST) ||
      (b.klass === "schemer" && a.stats.resolve >= RESOLVE_RESIST));
  // A pair that just fought does not immediately find a new reason to swing.
  // The combat engine's own cooldown only stops a fight resuming; this is the
  // longer, configurable window that keeps two islanders from cycling through
  // fight, truce, fight all game.
  const justFought =
    tunables.flags.earlyAggression &&
    pairFoughtRecently(a.id, b.id, now, tunables.conflict.pairCooldownMs);

  if (canFight && escalates && !timidBlocks && !betrayalSeenComing && !justFought) {
    outs.push("fight");
  }

  // Last, and only when there is genuinely something to settle.
  if (deEscalationWarranted(a, b, hostile, now)) outs.push("truce");
  return outs;
}

// How far the board moves on each conversation outcome. A fight and an alliance
// are the two a spectator reads as real information; the soft outcomes barely
// register, which is why their sizes are so much smaller. "truce" and "nothing"
// move nothing: agreeing not to escalate is not news.
function marketDriftFor(outcome: ConvOutcome["outcome"]): number {
  switch (outcome) {
    case "alliance":
      return tunables.market.driftOnAlliance;
    case "fight":
      return tunables.market.driftOnFight;
    case "tension":
      return tunables.market.driftOnTension;
    case "amicable":
      return tunables.market.driftOnAmicable;
    default:
      return 0;
  }
}

// The ONE place a private thought reaches a socket.
//
// Every thought is routed through the canonical dash stripper on the way out.
// apps/server had no import of it at all, so the cross-cutting rule (spec line
// 211, "no dashes in any islander speech, anywhere") was enforced on the
// conversation path and silently violated on the thought path - including by
// this file's own hardcoded betrayal line. Centralizing the emit is what makes
// the guarantee structural: a future emit site inherits it instead of having
// to remember it.
function emitAgentThought(
  room: Room,
  agent: Contestant,
  text: string,
  kind: "scheme" | "plan" | "observe",
): void {
  room.io.emit("agent:thought", {
    agentId: agent.id,
    agentName: agent.name,
    text: stripSpeechDashes(text),
    kind,
  });
}

// What a schemer thinks while turning on someone who trusted them. A pool
// rather than one string: the identical sentence fired from two call sites for
// every betrayal in every run, which is the same "they say the same things
// consistently" complaint in miniature. Written without dashes of any kind at
// the source, so the stripper is a safety net here and not a dependency.
const BETRAYAL_LINES: ((name: string) => string)[] = [
  (n) => `Sorry ${n}. It is just business.`,
  (n) => `Nothing personal, ${n}. Somebody had to go first.`,
  (n) => `${n} would have done the same to me eventually.`,
  (n) => `I liked ${n}. That is exactly why it had to be now.`,
  (n) => `Do not take it badly, ${n}. The numbers said today.`,
];
function betrayalLine(name: string): string {
  const pool = BETRAYAL_LINES;
  return pool[Math.floor(rand() * pool.length) % pool.length]!(name);
}

// Alert the owner and the holders of both islanders in a resolved
// conversation.
//
// The soft outcomes are suppressed when the board did not actually move.
// tension and amicable are frequent by design (they are the wide middle
// ground the outcome-set fix opens up), and texting a spectator about every
// one of them would be the notification-layer version of the same spam
// problem this build exists to fix. A realized drift of zero means the market
// judged it not worth reporting, so neither do we. Alliances and fights always
// send: those are the two a spectator reads as real information.
//
// The realized move is no longer only a gate on whether to send. It rides
// along on the event as driftPoints, which is what lets the text say what this
// outcome did to the reader's position instead of only that it happened. Each
// message is built about ONE subject, so it must carry that subject's OWN
// drift: send(a, b) quotes driftA and send(b, a) quotes driftB. Crossing them
// would tell a holder of A that their position moved by the amount B's market
// moved, which on an asymmetric fight is a different number and can even be
// the opposite sign.
function notifyPair(
  a: Contestant,
  b: Contestant,
  outcome: ConvOutcome,
  driftA: number,
  driftB: number,
  now: number,
): void {
  const moved = driftA !== 0 || driftB !== 0;
  // applyMarketDrift returns the signed change in the subject's own Yes price
  // as a PROBABILITY FRACTION (lmsr.ts driftPrice: `applied = after - before`),
  // while NotifyEvent.driftPoints is specified in probability POINTS, so 0.015
  // becomes 1.5. The sign passes straight through and must NOT be flipped:
  // both conventions already agree that positive means the subject firmed up.
  // notifyContent is the layer that knows a No holder gains when a price
  // falls, and realizedMoveClause performs that inversion itself; doing it
  // here as well would invert it twice and tell a short they lost on a move
  // they actually made money on.
  const points = (drift: number) => drift * 100;
  const send = (subject: Contestant, other: Contestant, drift: number) => {
    switch (outcome.outcome) {
      case "alliance":
        notifyAboutContestant(subject.id, now, {
          kind: "allianceFormed",
          subjectName: subject.name,
          otherName: other.name,
          driftPoints: points(drift),
        });
        break;
      case "fight":
        notifyAboutContestant(subject.id, now, {
          kind: "fight",
          subjectName: subject.name,
          otherName: other.name,
          betrayal: subject.allies.includes(other.id),
          // The swing has not been thrown yet: resolveConversation only sets
          // the attack intent and combat.ts decides how it goes. Nobody has
          // won anything at this point, and claiming otherwise in a text a
          // spectator reads before the fight resolves would be a lie.
          subjectWon: null,
          driftPoints: points(drift),
        });
        break;
      case "tension":
        if (moved) {
          notifyAboutContestant(subject.id, now, {
            kind: "tension",
            subjectName: subject.name,
            otherName: other.name,
            driftPoints: points(drift),
          });
        }
        break;
      case "amicable":
        if (moved) {
          notifyAboutContestant(subject.id, now, {
            kind: "amicable",
            subjectName: subject.name,
            otherName: other.name,
            driftPoints: points(drift),
          });
        }
        break;
      default:
        // "nothing" and "truce" are not news. This is the modal case.
        break;
    }
  };
  send(a, b, driftA);
  send(b, a, driftB);
}

// An agent throws its weight behind removing someone. Returns quietly unless
// the support has reached quorum, at which point the villa acts as one.
//
// Registration comes FIRST and the vote math is read afterward. The old order
// asked "could this ever win" before putting the agent on the board, and
// winnability is `support + 1 >= quorum` with quorum floored at two, so the
// first supporter always evaluated 0 + 1 >= 2 and returned before being
// counted. Support could therefore never leave zero at any flag setting and a
// spontaneous ouster was unreachable in a real run. campaignForOuster
// (alliances.ts) is WS-C's drop-in for exactly this: it registers, then
// reports both whether quorum fell and whether staying on this target is worth
// the agent's next intent.
function pushOuster(room: Room, supporter: Contestant, target: Contestant, now: number): void {
  if (!tunables.flags.spontaneousOuster) return;

  const campaign = campaignForOuster(supporter.id, target.id, now);

  if (!campaign.reachedQuorum) {
    // Not there yet. The vote math now decides whether the agent keeps working
    // this target or looks for one the villa is already circling, which is
    // what the winnability check was always meant to be: a reason to hold or
    // redirect, never a precondition for being counted.
    if (campaign.registered && campaign.keepCampaigning) {
      emitAgentThought(room, supporter, `One more voice and ${target.name} is gone.`, "scheme");
    }
    return;
  }

  clearOusterSupport(target.id);
  pushWorldEvent(
    "voteResult",
    [target.id],
    `The villa turned on ${target.name}.`,
    now,
  );
  emitAgentThought(
    room,
    supporter,
    `Enough of us want ${target.name} gone. It is happening.`,
    "scheme",
  );
  processDeath(room.io, target.id, "voteOff", null, now);
}

// The awareness block bolted onto an agent's context. Split out because it is
// needed by both the decision context and the conversation context, and because
// keeping the "undefined when the flag is off" contract in one place is what
// guarantees the all-flags-off path is untouched.
//
// THIS FUNCTION MUST STAY SIDE-EFFECT FREE. agentContext is one WorldView
// method serving two very different readers: the scheduler's genuine per-think
// call, and the conversation runner, which calls it several times a turn just
// to look up a partner's display name. Draining the event cursor here meant a
// four turn conversation silently threw away both participants' unread world
// events before either had reacted to one, which is a direct cause of "they
// dont respond to events". Reading is a peek; the cursor advances at exactly
// one place, drainEventsForThink below.
function awarenessFields(c: Contestant, now: number): Partial<AgentContextView> {
  const out: Partial<AgentContextView> = {};

  if (tunables.flags.worldAwareness) {
    out.world = worldStateView(now);
    const events = peekEventsFor(c.id);
    if (events.length > 0) out.recentEvents = events;
  }
  const rel = relationshipSummaries(c, now);
  if (rel) out.relationships = rel;
  const spatial = spatialAwareness(c);
  if (spatial) out.spatial = spatial;
  const heard = overheardFor(c.id);
  if (heard) out.overheard = heard;
  const odds = selfOdds(c, now);
  if (odds) out.selfOdds = odds;
  // The bloc as a group rather than as three ids in self.allies, so an agent
  // can reason about "our four" and about it cracking. Returns undefined when
  // multiAlliances is off, which keeps the all-flags-off key set identical.
  const al = allianceViewFor(c.id);
  if (al) out.alliance = al;

  return out;
}

// The single cursor-advancing read, deliberately separated from context
// building above. It runs when an agent has actually thought and is about to
// act, which is the one moment "this agent has now reacted to these events" is
// true. applyDecision is that moment: the scheduler calls it exactly once per
// think, after the decision comes back, for both the batched and the
// per-agent path. Doing it here rather than inside agentContext also avoids
// widening the frozen WorldView contract with a decide-only accessor.
function drainEventsForThink(agentId: string): void {
  if (!tunables.flags.worldAwareness) return;
  drainEventsFor(agentId);
}

// ---------------------------------------------------------------------------
// WorldView
// ---------------------------------------------------------------------------
export function createWorldView(): WorldView {
  return {
    livingAgents(): AgentBrief[] {
      // Across every running room -- one scheduler drives all rooms (shared
      // LLM budget). Agent ids are globally unique.
      const out: AgentBrief[] = [];
      for (const room of runningRooms()) {
        for (const c of Object.values(room.state.contestants)) {
          if (c.alive) out.push({ id: c.id, name: c.name, klass: c.klass });
        }
      }
      return out;
    },

    agentContext(id: string): AgentContextView | null {
      // Resolve the agent's room and point the global engine state at it before
      // reading -- the scheduler may ask about any room's agent.
      const room = roomOfAgent(id);
      if (!room || room.state.phase !== "running") return null;
      activate(room);
      const c = state.contestants[id];
      if (!c || !c.alive) return null;
      const others = Object.values(state.contestants).filter(
        (o) => o.id !== id && o.alive && dist(c, o) <= PERCEPTION_PX,
      );
      others.sort((a, b) => targetWeight(c, b) - targetWeight(c, a));
      return {
        self: {
          id: c.id,
          name: c.name,
          klass: c.klass,
          stats: c.stats,
          persona: c.persona,
          hp: c.hp,
          maxHp: c.maxHp,
          hpFraction: hpFraction(c),
          kills: c.kills,
          notoriety: c.notoriety,
          priceYes: marketPrice(c.id),
          allies: c.allies,
          x: c.x,
          y: c.y,
        },
        nearby: others.map((o) => toNearby(c, o)),
        memory: c.memory,
        // Phase 7: a pending event countdown or active hostile mode becomes an
        // aggression cue for both the LLM prompt and the rule engine.
        event: currentEventModifier(Date.now()),
        phase: state.phase,
        // Awareness. Every one of these is undefined when its flag is off, so
        // with all flags off this object is exactly what it was before.
        ...awarenessFields(c, Date.now()),
      };
    },

    conversationState(id: string): ConversationView | null {
      const room = roomOfConversation(id);
      if (!room) return null;
      activate(room);
      const conv = state.conversations[id];
      if (!conv || conv.endedAt !== null) return null;
      const parts = conv.participants
        .map((pid) => state.contestants[pid])
        .filter(Boolean) as Contestant[];
      if (parts.length < 2) return null;
      const [a, b] = parts;
      return {
        id: conv.id,
        participantIds: conv.participants,
        messages: conv.messages,
        maxTurns: conv.maxTurns,
        turnsTaken: conv.messages.length,
        nextSpeakerId: conv.participants[conv.messages.length % conv.participants.length]!,
        allowedOutcomes: computeAllowedOutcomes(a!, b!, state.hostile.active),
        partners: parts.map((p) => toNearby(a!, p)),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// DecisionSink
// ---------------------------------------------------------------------------
export function createDecisionSink(io: ArenaServer): DecisionSink {
  return {
    applyDecision(agentId: string, d: AgentDecision): void {
      const room = roomOfAgent(agentId);
      if (!room) return;
      activate(room);
      useGate(room.gate);
      const c = state.contestants[agentId];
      if (!c || !c.alive) return;
      // The agent has thought and is acting on what it saw, so this is where
      // its event cursor advances - once per think, and nowhere else. It is
      // deliberately ahead of the mid-conversation return below: an agent that
      // thought while pinned still saw those events.
      drainEventsForThink(c.id);
      if (c.intent.kind === "converse") return; // pinned mid-conversation
      const target = d.target ? state.contestants[d.target] : null;
      const targetOk = !!target && target.alive && dist(c, target) <= PERCEPTION_PX;

      // Private thoughts (viewers see them in the feed; in-game islanders do
      // not). At most one per decision, emitted via the agent's own room.
      let thought = false;
      const emitThought = (text: string, kind: "scheme" | "plan" | "observe") => {
        if (thought) return;
        thought = true;
        emitAgentThought(room, c, text, kind);
      };

      switch (d.action) {
        case "attack": {
          // Allies are normally off-limits (only a schemer betrays), but under
          // hostile mode the alliances dissolve -- anyone may be attacked.
          const allyBlocked =
            c.allies.includes(target!.id) && c.klass !== "schemer" && !state.hostile.active;
          if (!targetOk || allyBlocked) {
            c.intent = { kind: "wander" };
          } else {
            c.intent = { kind: "attack", target: target!.id };
            // A schemer turning on a current ally: surface the betrayal.
            if (c.klass === "schemer" && c.allies.includes(target!.id)) {
              emitThought(betrayalLine(target!.name), "scheme");
            }
            // Wanting someone gone is also a vote, of sorts. Register it on the
            // ouster board: nothing happens on one agent's say so, but once a
            // third of the living field wants the same person out, the villa
            // moves on them together. The threshold is the safety property -
            // it is what stops one aggressive islander removing people at will
            // between scheduled events.
            pushOuster(room, c, target!, Date.now());
          }
          break;
        }
        case "approach":
          c.intent = targetOk ? { kind: "approach", target: target!.id } : { kind: "wander" };
          break;
        case "flee":
          c.intent = { kind: "flee", from: targetOk ? target!.id : undefined };
          break;
        case "layLow":
          c.intent = { kind: "layLow" };
          break;
        case "proposeAlliance":
          // Approach the target and flag a conversation request the gate honors.
          if (targetOk) {
            c.intent = { kind: "approach", target: target!.id };
            curGate.convRequests.set(c.id, target!.id);
            // A schemer's "alliance" is a setup: leak the ulterior motive.
            if (c.klass === "schemer") {
              const text = readsSchemy(d.reasoning)
                ? d.reasoning
                : `Getting close to ${target!.name}... they will not see it coming.`;
              emitThought(text, "scheme");
            }
          } else {
            c.intent = { kind: "wander" };
          }
          break;
        default:
          c.intent = { kind: "wander" };
      }

      // Occasionally let a plain decision speak so the feed feels alive -- kept
      // sparse (~15%) and never on top of a scheme thought.
      if (!thought && d.reasoning.trim() !== "" && Math.random() < 0.15) {
        const kind =
          d.action === "attack" || d.action === "approach" || d.action === "proposeAlliance"
            ? "plan"
            : "observe";
        emitThought(d.reasoning, kind);
      }
    },

    appendConversationMessage(convId: string, m: ConvMessage): void {
      const room = roomOfConversation(convId);
      if (!room) return;
      activate(room);
      const conv = state.conversations[convId];
      if (!conv || conv.endedAt !== null) return;
      conv.messages.push({ speaker: m.speaker, text: m.text, tone: m.tone });
      // Anyone standing close enough who is not in this conversation catches
      // the line. This is the one place every spoken line passes through, so it
      // is the only correct hook for it: gossip should spread from what was
      // actually said, not from the outcome after the fact.
      const speaker = state.contestants[m.speaker];
      if (speaker) recordOverheard(conv.participants, speaker, m.text, Date.now());
      room.io.emit("conv:message", { convId, speakerId: m.speaker, text: m.text, tone: m.tone });
    },

    resolveConversation(convId: string, outcome: ConvOutcome): void {
      const room = roomOfConversation(convId);
      if (!room) return;
      activate(room);
      const conv = state.conversations[convId];
      if (!conv || conv.endedAt !== null) return;
      const now = Date.now();
      conv.outcome = outcome.outcome;
      conv.fightInitiator = outcome.fightInitiator;
      conv.endedAt = now;

      const [aId, bId] = conv.participants;
      const a = aId ? state.contestants[aId] : undefined;
      const b = bId ? state.contestants[bId] : undefined;

      // Unpin both participants (back to wandering) unless a fight takes over.
      const unpin = (c?: Contestant) => {
        if (c && c.alive && c.intent.kind === "converse") c.intent = { kind: "wander" };
      };

      if (outcome.outcome === "alliance" && a && b) {
        // Alliance state + memory writers (4.7).
        if (!a.allies.includes(b.id)) a.allies.push(b.id);
        if (!b.allies.includes(a.id)) b.allies.push(a.id);
        // Layer the group model on top of the pair. This may grow an existing
        // bloc to three or more, or merge two blocs; the pairwise arrays above
        // stay the authority, and joinOrFormAlliance keeps them consistent with
        // whatever group results, so nothing downstream needs to change.
        joinOrFormAlliance(a, b, now);
        room.io.emit("alliance:formed", { aId: a.id, bId: b.id, aName: a.name, bName: b.name });
      }

      // One memory writer for every outcome that is worth remembering,
      // replacing the four separate fixed-template blocks that used to live
      // here.
      //
      // "nothing" is deliberately NOT written. Contestant.memory is a six slot
      // ring that feeds straight into the prompt, and now that the outcome set
      // is fixed and "nothing" is the modal result (spec line 80), writing it
      // would fill every agent's entire remembered history with "small talk
      // with X" inside a few minutes and push out the alliance, the fight and
      // the grudge - the exact crowding-out the old truce-heavy history
      // suffered, just with a different filler. The pair record below is the
      // right store for it: it keeps all five outcomes with decay, unbounded
      // by six slots, which is what the spec asks for.
      if (a && b && outcome.outcome !== "nothing") {
        pushMemory(a, memoryLine(outcome.outcome, b.name), now);
        pushMemory(b, memoryLine(outcome.outcome, a.name), now);
      }

      // Persist the outcome into both directions of the pair record. All five
      // outcomes land here, including "nothing", because "we have spoken and it
      // went nowhere" reads differently from "we have never spoken". The note
      // is the short phrase naming the trigger, per the RelEvent.note contract
      // in packages/shared/src/relationships.ts; every call site used to omit
      // it, so history recorded what happened and never why.
      if (a && b && tunables.flags.relationshipMemory) {
        const note = outcomeNote(outcome.outcome, state.hostile.active);
        recordOutcome(a.id, b.id, outcome.outcome, now, note);
        // Ordinary warmth between two members of the same bloc must reach the
        // group. Before this, the only cohesion gain path was a formal
        // re-alliance between two people already allied, so two islanders who
        // simply got on well all run strengthened nothing. A no-op unless both
        // are in the same bloc, so it is safe to call for every outcome.
        creditGoodOutcome(a.id, b.id, outcome.outcome, now);
      }

      // Odds drift on observable events. A spectator watched these two form an
      // alliance or fall out, so the board moves a little. Deliberately much
      // smaller than the effect of a death, which the normalized display
      // already produces on its own without any nudge here.
      //
      // The move is ASYMMETRIC on a fight. Applying one identical delta to both
      // participants made the aggressor and the person they jumped equally less
      // likely to win, which reads as random jitter rather than as narrative:
      // starting a fight is evidence about you, and being on the receiving end
      // of one is different evidence. The realized signed move is captured
      // rather than discarded because it is exactly the "your position moved X
      // points because Y happened" figure the spectator alerts below quote.
      let driftA = 0;
      let driftB = 0;
      if (a && b) {
        const base = marketDriftFor(outcome.outcome);
        if (base !== 0) {
          // Read by property path at the use site, not destructured at module
          // load, for the same reason as the escalation weights above:
          // reloadTunables mutates tunables in place and a captured copy would
          // go stale on the next reload.
          const initiatorScale =
            outcome.outcome === "fight" ? tunables.market.initiatorDriftScale : 1;
          const aIsInitiator = outcome.fightInitiator === a.id;
          const bIsInitiator = outcome.fightInitiator === b.id;
          driftA = applyMarketDrift(a.id, base * (aIsInitiator ? initiatorScale : 1), now);
          driftB = applyMarketDrift(b.id, base * (bIsInitiator ? initiatorScale : 1), now);
        }
      }

      // Publish the socially visible outcomes to the feed so islanders who were
      // not involved can still react to them.
      if (a && b) {
        if (outcome.outcome === "alliance") {
          pushWorldEvent("allianceFormed", [a.id, b.id], `${a.name} and ${b.name} teamed up.`, now);
        } else if (outcome.outcome === "tension") {
          pushWorldEvent("tension", [a.id, b.id], `${a.name} and ${b.name} are not getting on.`, now);
        } else if (outcome.outcome === "amicable") {
          pushWorldEvent("amicable", [a.id, b.id], `${a.name} and ${b.name} are getting close.`, now);
        }
      }

      // Tell the people with something at stake. This is the best site in the
      // codebase for it: the outcome, both Contestants and the realized market
      // move are all in scope on the same lines. notifyAboutContestant resolves
      // the islander's OWNER and every HOLDER of a position on them, so it
      // serves both halves of the user's ask - "my agent" and "my investments"
      // - from one call, and it silently no-ops for house-seeded islanders with
      // no owner phone and for spectators who never opted in.
      if (a && b) notifyPair(a, b, outcome, driftA, driftB, now);

      unpin(a);
      unpin(b);

      if (outcome.outcome === "fight" && outcome.fightInitiator) {
        const attacker = state.contestants[outcome.fightInitiator];
        const defenderId = conv.participants.find((p) => p !== outcome.fightInitiator);
        const defender = defenderId ? state.contestants[defenderId] : undefined;
        if (attacker && defender && attacker.alive && defender.alive) {
          // Set attack intent; the fight engine (combat.ts) starts the fight -
          // and emits fight:started with the betrayal flag - once the attacker
          // closes to contact.
          attacker.intent = { kind: "attack", target: defender.id };
          pushMemory(attacker, `turned on ${defender.name}`, now);
          pushMemory(defender, `${attacker.name} attacked me`, now);
          pushWorldEvent(
            "fight",
            [attacker.id, defender.id],
            `${attacker.name} turned on ${defender.name}.`,
            now,
          );
          // Betraying a current ally: leak the private scheme to viewers only.
          if (attacker.allies.includes(defender.id)) {
            emitAgentThought(room, attacker, betrayalLine(defender.name), "scheme");
          }
        }
      }

      room.io.emit("conv:ended", {
        convId,
        outcome: outcome.outcome,
        fightInitiatorId: outcome.fightInitiator,
      });
    },

    reportSwarmTelemetry(e: SwarmTelemetry): void {
      const room = roomOfAgent(e.agentId);
      (room?.io ?? io).emit("swarm:telemetry", e);
    },
  };
}

// ---------------------------------------------------------------------------
// Conversation gate (task 4.5) - runs in the fast tick, per room, throttled to
// one scan per tick-window. Bookkeeping is per room (Phase 9): `curGate` is
// pointed at the active room's gate by useGate().
// ---------------------------------------------------------------------------
let curGate: GateState = { convRequests: new Map(), pairLastConvAt: new Map(), lastGateScanAt: 0 };
export function useGate(g: GateState): void {
  curGate = g;
}

function pairKey(x: string, y: string): string {
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

// The swarm context (world/sink/backend/spend) the conversation runner needs;
// set once by startSwarmLoop.
type SwarmCtx = Parameters<typeof runConversation>[0];
let swarmCtx: SwarmCtx | null = null;

// Starts a conversation in `room`, pins both participants, emits to the room's
// sockets, and kicks off the async turn runner.
function startConversation(room: Room, a: Contestant, b: Contestant): void {
  const now = Date.now();
  const conv = {
    id: randomUUID(),
    participants: [a.id, b.id],
    messages: [],
    outcome: "ongoing" as const,
    fightInitiator: null,
    startedAt: now,
    endedAt: null,
    maxTurns: 2 + Math.floor(Math.random() * 3), // 2..4
  };
  room.state.conversations[conv.id] = conv;
  a.intent = { kind: "converse", convId: conv.id };
  b.intent = { kind: "converse", convId: conv.id };
  // A fragment is NOT retired here any more. Retiring on conversation START
  // marked every scrap either of them held as "passed on" before a single word
  // had been said, so gossip was consumed by the mere fact of talking and
  // could never actually reach a line. Per the OverheardFragment.fresh
  // contract, only the speech path may clear it, which it now does through the
  // markOverheardSpoken hook installed in startSwarmLoop.
  curGate.pairLastConvAt.set(pairKey(a.id, b.id), now);
  curGate.convRequests.delete(a.id);
  curGate.convRequests.delete(b.id);
  room.io.emit("conv:started", {
    id: conv.id,
    participantIds: [a.id, b.id],
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });
  if (swarmCtx) void runConversation(swarmCtx, conv.id);
}

function tickConversationGate(room: Room, now: number): void {
  if (room.state.phase !== "running") return;
  if (now - curGate.lastGateScanAt < CONV_SCAN_MS) return;
  curGate.lastGateScanAt = now;

  const active = Object.values(room.state.conversations).filter((c) => c.endedAt === null).length;
  if (active >= MAX_CONCURRENT_CONV) return;

  const avail = Object.values(room.state.contestants).filter(
    (c) => c.alive && c.intent.kind !== "converse" && c.activeFightId === null,
  );

  for (let i = 0; i < avail.length; i++) {
    for (let j = i + 1; j < avail.length; j++) {
      const a = avail[i]!;
      const b = avail[j]!;
      if (a.intent.kind === "converse" || b.intent.kind === "converse") continue; // paired this scan
      if (dist(a, b) > CONV_RADIUS_PX) continue;
      const key = pairKey(a.id, b.id);
      if (now - (curGate.pairLastConvAt.get(key) ?? 0) < PAIR_COOLDOWN_MS) continue;

      // Auto-fire when either just requested an alliance with the other.
      const autoFire =
        curGate.convRequests.get(a.id) === b.id || curGate.convRequests.get(b.id) === a.id;
      let prob = BASE_CONV_PROB;
      if (a.allies.includes(b.id) === false) prob += 0.05; // never allied yet
      if (hpFraction(a) < 0.4 || hpFraction(b) < 0.4) prob += 0.15;
      if (a.notoriety > 20 || b.notoriety > 20) prob += 0.15;

      if (autoFire || Math.random() < prob) {
        startConversation(room, a, b);
        return; // at most one new conversation per scan
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Swarm loop + spend broadcast
// ---------------------------------------------------------------------------
const THINK_SCAN_MS = 1000;
const SPEND_BROADCAST_MS = 3000;

let spendTracker: SpendTracker | null = null;

// Called from the fast tick (tick.ts), once per room, so conversation gating is
// step 3 of that room's tick (ARCHITECTURE.md 6.1). The caller has already
// activated the room; useGate points the gate bookkeeping at it.
export function runConversationGate(room: Room, now: number): void {
  useGate(room.gate);
  tickConversationGate(room, now);
}

// Operator override (task 8.6): force the shared rule-engine fallback on to
// prove the spend-cap path, and broadcast the new (global, shared) spend state
// to every room's demo view.
export function forceFallbackNow(io: ArenaServer): boolean {
  if (!spendTracker) return false;
  spendTracker.forceFallback();
  const snap = spendTracker.snapshot();
  io.emit("spend:update", {
    estimatedUsd: snap.estimatedUsd,
    capUsd: snap.capUsd,
    throttled: spendTracker.throttled,
    fallbackActive: spendTracker.fallbackActive,
  });
  return true;
}

// Operator override: force an interaction between the two nearest eligible
// islanders in `room`, bypassing the proximity/probability/cooldown gate.
export function forceConversation(room: Room): boolean {
  if (room.state.phase !== "running") return false;
  useGate(room.gate);
  const avail = Object.values(room.state.contestants).filter(
    (c) => c.alive && c.intent.kind !== "converse" && c.activeFightId === null,
  );
  if (avail.length < 2) return false;
  let best: [Contestant, Contestant] | null = null;
  let bestD = Infinity;
  for (let i = 0; i < avail.length; i++) {
    for (let j = i + 1; j < avail.length; j++) {
      const d = dist(avail[i]!, avail[j]!);
      if (d < bestD) {
        bestD = d;
        best = [avail[i]!, avail[j]!];
      }
    }
  }
  if (!best) return false;
  startConversation(room, best[0], best[1]);
  return true;
}

// Reset a single room's conversation-gate bookkeeping (its state is recreated
// elsewhere). The shared spend budget is NOT reset here -- it spans all rooms.
export function resetSwarmState(room: Room): void {
  room.gate.convRequests.clear();
  room.gate.pairLastConvAt.clear();
  room.gate.lastGateScanAt = 0;
}

// The one shared spend budget across all rooms (product decision). Reset only on
// a full server-wide reset, never per room.
export function resetSharedSpend(): void {
  spendTracker?.reset();
}

export function startSwarmLoop(io: ArenaServer): NodeJS.Timeout {
  const world = createWorldView();
  const sink = createDecisionSink(io);
  const spend = new SpendTracker();
  spendTracker = spend;
  // Behind SWARM_BACKEND_ENABLED: pick the configured backend (local by
  // default) with the rule engine wired underneath it, so the sim keeps running
  // when no model is reachable. With the flag off, fall back to the original
  // wiring: a hosted client built straight from the environment.
  const backend = swarmConfig.enabled
    ? createBackend(swarmConfig, (stateName, reason) => {
        console.log(`[swarm] decisions now served by ${stateName}: ${reason}`);
      })
    : toBackend(
        process.env.ANTHROPIC_API_KEY ? createAnthropic(process.env.ANTHROPIC_API_KEY) : null,
      );
  console.log(
    `[swarm] backend=${swarmConfig.enabled ? swarmConfig.backend : "anthropic (seam disabled)"}`,
  );
  const thinker = createThinker(backend, spend);
  // Present only when the active backend can batch its own decide calls (the
  // hosted free-tier path, which is the one rate limited enough for batching
  // to matter). Returns null for every other backend, and the scheduler
  // treats an absent batchThinker exactly as it did before the option existed,
  // so wiring it here can only add a capability, never remove the per-agent
  // path.
  const batchThinker = createBatchThinker(backend, spend) ?? undefined;
  // Retire an overheard fragment at the moment it actually reaches a line the
  // listener speaks. packages/swarm may never import apps/server, so the
  // prompt layer exposes this injection seam and the server owns the store;
  // installing it here is what closes the gossip lifecycle. The hook is
  // internally try/caught on the prompt side, so a throw can never take down
  // a prompt build.
  setOverheardUsedHook((listenerId, fragment) => {
    markOverheardSpoken(listenerId, fragment.heardAt);
  });
  // One scheduler drives every room's agents (ids are globally unique); the
  // world reports living agents across all running rooms.
  const scheduler = createSwarmScheduler({
    world,
    sink,
    thinker,
    batchThinker,
    throttled: () => spend.throttled,
  });
  // The conversation runner the gate fires; the sink resolves the room per
  // conversation, so one context serves all rooms.
  swarmCtx = { world, sink, backend: backend ?? undefined, spend };

  let lastSpendBroadcast = 0;
  return setInterval(() => {
    const running = runningRooms();
    if (running.length === 0) return;
    const now = Date.now();
    scheduler.tick(now);
    // Mirror the shared spend into every running room's snapshot, and broadcast
    // it globally on a cadence (it's the same budget for all rooms).
    const snap = spend.snapshot();
    for (const r of running) r.state.spend = snap;
    if (now - lastSpendBroadcast >= SPEND_BROADCAST_MS) {
      lastSpendBroadcast = now;
      io.emit("spend:update", {
        estimatedUsd: snap.estimatedUsd,
        capUsd: snap.capUsd,
        throttled: spend.throttled,
        fallbackActive: spend.fallbackActive,
      });
    }
  }, THINK_SCAN_MS);
}

export { NOTORIETY_PER_KILL };
