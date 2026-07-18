import { randomUUID } from "node:crypto";
import { applyWitnessedKill, TICK_MS, tunables } from "@arena/shared";
import type { Contestant, MemoryItem } from "@arena/shared";
import { creditBetrayal, dropSupporter, removeFromAlliances } from "./alliances.js";
import { forgetOverheard } from "./awareness.js";
import { TILE_SIZE } from "./map.js";
import { applyMarketDrift, markMarketDirty } from "./market.js";
import {
  forgetRelationships,
  pushDeathEvent,
  pushLivingCountChangedEvent,
  rand,
  relationship,
} from "./social.js";
import { notifyAboutContestant } from "./notify.js";
import { aliveCount, priceYes, state } from "./state.js";
import type { ArenaServer } from "./io.js";

// ---------------------------------------------------------------------------
// Tasks 5.1-5.3: combat, the strictly-serialized death pipeline, and regen.
//
// A fight is server-internal (not in the snapshot): it resolves in a few
// seconds and clients render it from fight:started + the per-tick hp diffs +
// contestant:died. Every elimination - combat, and later the events - goes
// through the ONE processDeath function, which is the only code that may kill.
// ---------------------------------------------------------------------------

// -- 5.1 Balance spec (tuned via the headless harness, task 5.4) -------------
const EXCHANGE_INTERVAL_MS = 4 * TICK_MS; // ~600 ms between exchanges (ARCH 6.3)
const CONTACT_PX = 0.9 * TILE_SIZE; // how close attack intent must get to start a fight
const HIT_BASE = 0.45;
const HIT_PER_STAT = 0.05; // per (str_att - ins_def)
const HIT_MIN = 0.15;
const HIT_MAX = 0.9;
const DMG_BASE = 14; // damage = 14 + str + U(0,DMG_SPREAD-1)
const DMG_SPREAD = 7; // U(0,6) => floor(rand()*7)
const BOLD_FIRST_MULT = 1.5; // bold: +50% damage on the first exchange
// A fight lasts a bounded number of exchanges (ARCH 6.3). If nobody has fallen
// by then it ends inconclusively -- both retreat, hurt. Lethality therefore
// comes from lopsided matchups (strong vs weak), not from every fight being a
// death march; this is the knob the harness tunes for convergence timing.
const MIN_EXCHANGES = 4;
const MAX_EXCHANGES = 10;
// After a fight (either way) the pair can't immediately re-engage; shorter than
// a full heal, so repeated scuffles grind HP down and even matchups still
// resolve over time.
const FIGHT_COOLDOWN_MS = 30_000;
const NOTORIETY_PER_KILL = 12; // ARCH 6.7
const NOTORIETY_DECAY = 0.5; // per think interval; applied on the slow clock elsewhere
const WITNESS_RADIUS_PX = 10 * TILE_SIZE;
const MEMORY_MAX = 6;

// -- 5.3 Regen ---------------------------------------------------------------
const REGEN_DELAY_MS = 6_000; // no regen within 6 s of combat
const REGEN_FULL_HEAL_MS = 150_000; // ~full heal in 150 s at factor 1 (slow enough that repeated fights grind HP down)

void NOTORIETY_DECAY; // reserved for the slow-clock notoriety decay (task 4.7 polish)

type Fight = {
  id: string;
  aId: string;
  bId: string;
  nextExchangeAt: number;
  exchange: number;
  maxExchanges: number;
};

// Per-room combat state (Phase 9): live fights (in creation order), per-pair
// post-fight cooldowns, and free-hit HP queued between ticks. `cur` is pointed
// at the active room by useCombat(). The RNG stays module-global.
export type CombatState = {
  fights: Map<string, Fight>;
  pairFightCooldownUntil: Map<string, number>;
  queuedHp: Map<string, number>;
};
export function createCombatState(): CombatState {
  return { fights: new Map(), pairFightCooldownUntil: new Map(), queuedHp: new Map() };
}
let cur: CombatState = createCombatState();
export function useCombat(s: CombatState): void {
  cur = s;
}

// Whether this pair has fought within `withinMs`. The combat engine already
// keeps a short cooldown that stops a fight restarting the instant it ends;
// this exposes the same history over a longer, configurable window so the
// conversation gate can decline to escalate a pair that just came to blows.
// The two are different questions: one is "can this fight resume", the other is
// "should these two find a new reason to swing".
export function pairFoughtRecently(x: string, y: string, now: number, withinMs: number): boolean {
  const until = cur.pairFightCooldownUntil.get(fightPairKey(x, y));
  if (until === undefined) return false;
  // The map stores when the cooldown expires, which is the fight's end plus the
  // engine's own cooldown; recover the end to measure against a longer window.
  const endedAt = until - FIGHT_COOLDOWN_MS;
  return now - endedAt < withinMs;
}

function fightPairKey(x: string, y: string): string {
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

// Varied, in-world descriptions of a kill for the feed + tombstone card. Combat
// kills draw from an environmental pool (rng-picked so a killer's deaths read
// differently); events and unattributed combat have their own fixed lines.
const COMBAT_KILL_LINES = [
  (k: string, v: string) => `${k} smashed ${v} with a rock`,
  (k: string, v: string) => `${k} cornered ${v} against the cliffs`,
  (k: string, v: string) => `${k} overpowered ${v} in a brawl`,
  (k: string, v: string) => `${k} caught ${v} off guard by the treeline`,
  (k: string, v: string) => `${k} dragged ${v} under in the shallows`,
  (k: string, v: string) => `${k} bludgeoned ${v} by the dead campfire`,
  (k: string, v: string) => `${k} ran ${v} down through the tall grass`,
  (k: string, v: string) => `${k} left ${v} broken on the rocks`,
];

// The Vote (cause "voteOff"): the villa turns on someone and sends them home.
// No killer -- draw a varied in-world line for the feed + tombstone card.
const VOTE_OFF_LINES = [
  (v: string) => `${v} was voted off the island`,
  (v: string) => `the villa voted ${v} out`,
  (v: string) => `${v} got the most votes and was sent home`,
  (v: string) => `the islanders turned on ${v} in the vote`,
];

function killDescription(
  cause: "combat" | "purge" | "weakestLink" | "voteOff",
  killerName: string | null,
  victimName: string,
): string {
  if (cause === "purge") return `${victimName} was culled in the Purge`;
  if (cause === "weakestLink") return `${victimName} was voted off as the Weakest Link`;
  if (cause === "voteOff") {
    const line = VOTE_OFF_LINES[Math.floor(rng() * VOTE_OFF_LINES.length)]!;
    return line(victimName);
  }
  if (!killerName) return `${victimName} succumbed to their wounds`;
  const line = COMBAT_KILL_LINES[Math.floor(rng() * COMBAT_KILL_LINES.length)]!;
  return line(killerName, victimName);
}

// Combat RNG - defaults to the room's seeded rand() (social.ts) so a run with
// a fixed seed reproduces the same fights, hits and death order every time
// (spec line 214). The headless harness (5.4) can still swap in its own
// generator via setCombatRng for isolated convergence sweeps.
let rng: () => number = rand;
export function setCombatRng(fn: () => number): void {
  rng = fn;
}

export function resetCombat(): void {
  cur.fights.clear();
  cur.pairFightCooldownUntil.clear();
  cur.queuedHp.clear();
  rng = rand;
}

function dist(a: Contestant, b: Contestant): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pushMemory(c: Contestant, text: string, now: number): void {
  c.memory.push({ t: now, text } satisfies MemoryItem);
  if (c.memory.length > MEMORY_MAX) c.memory.shift();
}

// -- The single death pipeline (ARCHITECTURE.md 6.3) -------------------------
// The ONLY code that may kill. Called only from tick code, never concurrently;
// each call completes fully (settlement included) before the caller advances to
// the next fight, so deathIndex is strictly increasing and every No-redemption
// lands before the next elimination.
export function processDeath(
  io: ArenaServer,
  id: string,
  cause: "combat" | "purge" | "weakestLink" | "voteOff",
  killerId: string | null,
  now: number,
): void {
  const c = state.contestants[id];
  if (!c || !c.alive) return;

  c.alive = false;
  c.deathIndex = state.deathOrder.length;
  state.deathOrder.push(id);
  c.diedAt = now;
  c.killedBy = killerId;
  c.causeOfDeath = cause;

  if (killerId) {
    const killer = state.contestants[killerId];
    if (killer) {
      killer.kills += 1;
      killer.notoriety += NOTORIETY_PER_KILL;
      pushMemory(killer, `killed ${c.name}`, now);
    }
  }

  const priceAtDeath = settleMarketNo(io, id);
  dissolveAlliancesOf(id);
  cancelFightsOf(id);
  // Witnesses must be recorded BEFORE the dead islander's relationships are
  // pruned: the records being written here belong to the living witness and
  // point at the killer, not at the dead.
  pushMemoryToWitnesses(c, killerId, now);

  const killerName = killerId ? (state.contestants[killerId]?.name ?? null) : null;
  const causeText = killDescription(cause, killerName, c.name);

  // The feed's typed death producer (feed.ts declares the kind, this is the
  // one call site that appends it -- see social.ts's PRODUCER OWNERSHIP note).
  // Carries the same varied causeText the tombstone card and SMS use, so an
  // agent that reacts to this event and a spectator reading the tombstone see
  // the same story. Replaces the old untyped pushWorldEvent("death", ...) call
  // that lived here before -- one producer for this kind, not two.
  pushDeathEvent(id, causeText, now);
  // A death always changes livingCount; combat kills are one-at-a-time (unlike
  // a purge, which batches many deaths into one livingCountChanged entry), so
  // one call per kill here is correct rather than a double-count.
  pushLivingCountChangedEvent(`${aliveCount()} left standing.`, now);
  // Nobody can ally with or vote for the dead, so their pair records are dead
  // weight. Pruning here keeps the store from growing across a long run.
  forgetRelationships(id);
  forgetOverheard(id);
  // dissolveAlliancesOf above already cut the pairwise links; this drops the
  // group membership so a bloc's size reflects who is actually still standing.
  removeFromAlliances(id);
  dropSupporter(id);

  io.emit("contestant:died", {
    contestantId: id,
    deathIndex: c.deathIndex,
    killerId,
    cause,
    causeText,
    settlement: { priceAtDeath },
  });

  // Rich SMS (WS-G): says what happened (varied causeText, not a generic
  // "was eliminated") and what it means for the recipient's money, in both
  // owner voice ("your islander") and holder voice. Replaces the old
  // notifyHolders binary ternary, which said nothing beyond No-paid/Yes-gone.
  notifyAboutContestant(id, now, { kind: "death", subjectName: c.name, killerName, causeText });
}

// Immediate settlement inside processDeath (ARCHITECTURE.md 6.4): the market
// freezes "no" the instant its contestant dies, and every No position redeems
// 1 token per share right away so those tokens recycle into live betting.
// Runs BEFORE anything else can die (settle-before-next-elimination ordering).
function settleMarketNo(io: ArenaServer, id: string): number {
  const m = state.markets[id];
  if (!m) return 0;
  const price = priceYes(m);
  if (m.settled) return price;
  m.settled = true;
  m.settledOutcome = "no";
  markMarketDirty(id);
  for (const pos of state.positions) {
    if (pos.contestantId !== id || pos.noShares <= 0) continue;
    const spec = state.spectators[pos.spectatorId];
    if (!spec) continue;
    const credit = pos.noShares; // No shares redeem 1 token each; Yes shares void.
    spec.tokens += credit;
    io.to(`spec:${pos.spectatorId}`).emit("balance:update", {
      tokens: spec.tokens,
      delta: credit,
      reason: "deathRedemption",
      contestantId: id,
    });
  }
  io.emit("market:settled", { contestantId: id, outcome: "no" });
  return price;
}

function dissolveAlliancesOf(id: string): void {
  for (const other of Object.values(state.contestants)) {
    const i = other.allies.indexOf(id);
    if (i >= 0) other.allies.splice(i, 1);
  }
}

function cancelFightsOf(id: string): void {
  for (const [fid, f] of cur.fights) {
    if (f.aId === id || f.bId === id) {
      const survivorId = f.aId === id ? f.bId : f.aId;
      const survivor = state.contestants[survivorId];
      if (survivor) survivor.activeFightId = null;
      const dead = state.contestants[id];
      if (dead) dead.activeFightId = null;
      cur.fights.delete(fid);
    }
  }
}

function pushMemoryToWitnesses(dead: Contestant, killerId: string | null, now: number): void {
  const killer = killerId ? state.contestants[killerId] : null;
  const line = killer ? `saw ${killer.name} kill ${dead.name}` : `saw ${dead.name} die`;
  for (const w of Object.values(state.contestants)) {
    if (!w.alive || w.id === dead.id || w.id === killerId) continue;
    if (dist(w, dead) > WITNESS_RADIUS_PX) continue;
    pushMemory(w, line, now);
    // Watching someone kill is the single strongest threat signal in the game,
    // and unlike a conversation outcome it is one-directional: the witness now
    // fears the killer, while the killer may not even know it was seen.
    if (killer && tunables.flags.relationshipMemory) {
      applyWitnessedKill(relationship(w.id, killer.id, now), now);
    }
  }
}

// -- 5.2 Fight engine --------------------------------------------------------
function hitChance(attacker: Contestant, defender: Contestant): number {
  const raw = HIT_BASE + HIT_PER_STAT * (attacker.stats.strength - defender.stats.instinct);
  return Math.min(HIT_MAX, Math.max(HIT_MIN, raw));
}

// One attack from `attacker` on `defender`. Returns true if the defender died.
function applyHit(
  io: ArenaServer,
  attacker: Contestant,
  defender: Contestant,
  exchange: number,
  now: number,
  hpChanges: Map<string, number>,
): boolean {
  if (rng() >= hitChance(attacker, defender)) return false;
  let dmg = DMG_BASE + attacker.stats.strength + Math.floor(rng() * DMG_SPREAD);
  // bold gets +50% damage on the very first exchange (the opener burst).
  if (attacker.klass === "bold" && exchange === 0) dmg = Math.round(dmg * BOLD_FIRST_MULT);
  defender.hp = Math.max(0, defender.hp - dmg);
  hpChanges.set(defender.id, defender.hp);
  if (defender.hp <= 0) {
    processDeath(io, defender.id, "combat", attacker.id, now);
    return true;
  }
  return false;
}

function startFight(io: ArenaServer, a: Contestant, b: Contestant, now: number): void {
  const betrayal = a.allies.includes(b.id);
  // A real in-fiction betrayal must cost the bloc something, not just flip an
  // emit flag. creditBetrayal (alliances.ts) is a no-op unless a and b are in
  // the SAME multi-person bloc, so this is safe to call unconditionally
  // alongside the pairwise `betrayal` check above.
  if (betrayal) creditBetrayal(a.id, b.id, now);
  // Rich SMS (WS-G follow up): the allianceBroken producer gap WS-F flagged.
  // creditBetrayal above updates cohesion (and may itself call defect(), which
  // fires its own allianceBroken notifications for the bloc-level fallout);
  // this is the separate, immediate "your agent made an enemy" text for the
  // pairwise relationship itself, which fires the instant the swing lands
  // regardless of whether the bloc happens to survive it. Both directions, same
  // as the alliances.ts producer: a's own line says they cut ties (they threw
  // the first punch), b's line says they got cut loose. Wrapped defensively --
  // a notification failure can never interrupt the fight that is about to
  // start below.
  if (betrayal) {
    try {
      notifyAboutContestant(a.id, now, {
        kind: "allianceBroken",
        subjectName: a.name,
        otherName: b.name,
        betrayedSubject: false,
      });
      notifyAboutContestant(b.id, now, {
        kind: "allianceBroken",
        subjectName: b.name,
        otherName: a.name,
        betrayedSubject: true,
      });
    } catch (err) {
      console.error("[combat] allianceBroken notification failed:", err);
    }
  }
  const maxExchanges = MIN_EXCHANGES + Math.floor(rng() * (MAX_EXCHANGES - MIN_EXCHANGES + 1));
  const fight: Fight = {
    id: randomUUID(),
    aId: a.id,
    bId: b.id,
    nextExchangeAt: now,
    exchange: 0,
    maxExchanges,
  };
  cur.fights.set(fight.id, fight);
  a.activeFightId = fight.id;
  b.activeFightId = fight.id;
  a.lastCombatAt = now;
  b.lastCombatAt = now;
  io.emit("fight:started", { fightId: fight.id, attackerId: a.id, defenderId: b.id, betrayal });
  // Rich SMS (WS-G): a fight is not settled at this point (inconclusive is
  // possible), so `subjectWon` is deliberately null here -- this alert is
  // about the fight STARTING, not its outcome. subjectName is the attacker
  // (a), otherName the defender (b), matching fight:started's own framing.
  notifyAboutContestant(a.id, now, {
    kind: "fight",
    subjectName: a.name,
    otherName: b.name,
    betrayal,
    subjectWon: null,
  });
  // A schemer betrayal opens with one free surprise hit before the first
  // exchange (ARCHITECTURE.md 6.3), resolved immediately.
  if (betrayal && a.klass === "schemer") {
    const hpChanges = new Map<string, number>();
    applyHit(io, a, b, 0, now, hpChanges);
    for (const [id, hp] of hpChanges) cur.queuedHp.set(id, hp);
  }
}

// hp changes produced between tick calls (free hits) surfaced on the next diff
// live on the room's combat state (cur.queuedHp).

// Step 4 of the tick: start new cur.fights from attack intent at contact, then
// advance every active fight one exchange when due. Returns hp changes for the
// diff.
export function tickCombat(io: ArenaServer, now: number): [id: string, hp: number][] {
  const hpChanges = new Map<string, number>(cur.queuedHp);
  cur.queuedHp.clear();

  // Start fights: a living attacker at contact with a not-yet-fighting target.
  for (const c of Object.values(state.contestants)) {
    if (!c.alive || c.activeFightId || c.intent.kind !== "attack") continue;
    const t = state.contestants[c.intent.target];
    // Target busy in another fight -> keep approaching; engage the survivor
    // when that fight ends (the "finish the weak winner" dynamic emerges from
    // the persistent attack intent, no explicit queue needed).
    if (!t || !t.alive || t.activeFightId) continue;
    if ((cur.pairFightCooldownUntil.get(fightPairKey(c.id, t.id)) ?? 0) > now) continue;
    if (dist(c, t) <= CONTACT_PX) startFight(io, c, t, now);
  }

  // Advance cur.fights in creation order; snapshot keys so a death that deletes a
  // fight mid-loop doesn't disturb iteration.
  for (const fid of [...cur.fights.keys()]) {
    const f = cur.fights.get(fid);
    if (!f || now < f.nextExchangeAt) continue;
    const a = state.contestants[f.aId];
    const b = state.contestants[f.bId];
    if (!a?.alive || !b?.alive) {
      cur.fights.delete(fid);
      if (a) a.activeFightId = null;
      if (b) b.activeFightId = null;
      continue;
    }
    a.lastCombatAt = now;
    b.lastCombatAt = now;
    // One exchange: a strikes, then b retaliates if still standing. processDeath
    // runs fully inside applyHit before the next fight is touched.
    const bDied = applyHit(io, a, b, f.exchange, now, hpChanges);
    if (!bDied) applyHit(io, b, a, f.exchange, now, hpChanges);
    if (cur.fights.has(fid)) {
      f.exchange += 1;
      if (f.exchange >= f.maxExchanges) endFightInconclusive(fid, now);
      else f.nextExchangeAt = now + EXCHANGE_INTERVAL_MS;
    }
  }

  return [...hpChanges];
}

// A fight that reaches its exchange cap with both alive: they break off and
// flee each other, and the pair goes on cooldown. Regen (out of combat) then
// starts healing them a moment later.
function endFightInconclusive(fid: string, now: number): void {
  const f = cur.fights.get(fid);
  if (!f) return;
  const a = state.contestants[f.aId];
  const b = state.contestants[f.bId];
  if (a) {
    a.activeFightId = null;
    if (a.alive) a.intent = { kind: "flee", from: f.bId };
  }
  if (b) {
    b.activeFightId = null;
    if (b.alive) b.intent = { kind: "flee", from: f.aId };
  }
  cur.pairFightCooldownUntil.set(fightPairKey(f.aId, f.bId), now + FIGHT_COOLDOWN_MS);
  cur.fights.delete(fid);
}

// -- 5.3 Regen: step 5 of the tick -------------------------------------------
// hp += regenRate * regenFactor for agents not in a fight and > 5 s since their
// last combat. regenFactor is 1 until hostile mode (Phase 7) decays it.
export function tickRegen(now: number, regenFactor: number): [id: string, hp: number][] {
  const changes: [string, number][] = [];
  for (const c of Object.values(state.contestants)) {
    if (!c.alive || c.activeFightId || c.hp >= c.maxHp) continue;
    if (c.lastCombatAt !== null && now - c.lastCombatAt < REGEN_DELAY_MS) continue;
    const rate = (c.maxHp * TICK_MS) / REGEN_FULL_HEAL_MS;
    const next = Math.min(c.maxHp, c.hp + rate * regenFactor);
    // Only emit when the integer HP the client shows actually changes.
    if (Math.floor(next) !== Math.floor(c.hp)) changes.push([c.id, Math.floor(next)]);
    c.hp = next;
  }
  return changes;
}
