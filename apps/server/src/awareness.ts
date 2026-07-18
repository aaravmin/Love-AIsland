import {
  describeRelationship,
  relationshipsFor,
  tunables,
  type OverheardFragment,
  type RelationshipSummary,
  type SelfOddsView,
} from "@arena/shared";
import type { Contestant } from "@arena/shared";
import { aliveCount, state } from "./state.js";
import { social } from "./social.js";

// ---------------------------------------------------------------------------
// Awareness: what an islander notices about the room, the villa, and itself.
//
// Everything here is derived from things the agent could plausibly observe by
// standing where it stands and looking around. That constraint is the whole
// design. An agent may know that four people are clustered near it, because it
// can see them. It may know it has failed to make a single alliance, because it
// was there. It may NOT know its market price, its rank, or any percentage
// about its own survival, because nobody in the villa can see the betting board.
//
// Each function is gated by its own flag and returns undefined when off, so the
// context builder can spread the result and get today's exact context back.
// ---------------------------------------------------------------------------

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---------------------------------------------------------------------------
// Spatial awareness: crowded, normal, or secluded.
// ---------------------------------------------------------------------------

export function spatialAwareness(
  c: Contestant,
): { density: "crowded" | "normal" | "secluded"; neighborCount: number } | undefined {
  if (!tunables.flags.spatialAwareness) return undefined;
  const r = tunables.awareness.densityRadiusPx;
  let n = 0;
  for (const o of Object.values(state.contestants)) {
    if (o.id === c.id || !o.alive) continue;
    if (dist(c, o) <= r) n++;
  }
  const density =
    n >= tunables.awareness.crowdedCount
      ? "crowded"
      : n <= tunables.awareness.secludedCount
        ? "secluded"
        : "normal";
  return { density, neighborCount: n };
}

// ---------------------------------------------------------------------------
// Overhearing.
//
// Stored per listener rather than per conversation, because the question an
// agent asks is "what have I picked up", not "what was said over there". A
// fragment stays `fresh` until its listener passes it on, which is what turns a
// half-heard line into gossip that travels instead of one that echoes forever
// from the same mouth.
//
// The cap lives in tunables.overhear.capPerAgent (moved there from a bare
// local constant) so the whole spec's "nothing is hardcoded" rule holds for
// this knob too.
// ---------------------------------------------------------------------------

// Who this line seemed to be about. An eavesdropper catches names, so scanning
// the line for a living islander's name is a fair model of what actually
// carries across a courtyard. First match wins; a line about two people is
// remembered as being about the first one named.
function subjectOf(text: string, excludeIds: string[]): string | null {
  const lower = text.toLowerCase();
  for (const o of Object.values(state.contestants)) {
    if (excludeIds.includes(o.id)) continue;
    if (o.name.length < 3) continue; // too short to match reliably
    if (lower.includes(o.name.toLowerCase())) return o.id;
  }
  return null;
}

// Called for every line spoken in a conversation. Anyone close enough who is
// not in the conversation picks it up.
export function recordOverheard(
  participantIds: string[],
  speaker: Contestant,
  text: string,
  now: number,
): void {
  if (!tunables.flags.overhearing) return;
  const radius = tunables.awareness.overhearRadiusPx;
  const aboutId = subjectOf(text, participantIds);
  const store = social().overheard;

  for (const listener of Object.values(state.contestants)) {
    if (!listener.alive) continue;
    if (participantIds.includes(listener.id)) continue;
    if (dist(listener, speaker) > radius) continue;
    // A listener already deep in its own conversation is not eavesdropping.
    if (listener.intent.kind === "converse") continue;

    const buf = store.get(listener.id) ?? [];
    buf.push({
      t: now,
      heardAt: now,
      speakerId: speaker.id,
      speakerName: speaker.name,
      aboutId,
      text,
      fresh: true,
    } satisfies OverheardFragment);
    const cap = tunables.overhear.capPerAgent;
    if (buf.length > cap) buf.splice(0, buf.length - cap);
    store.set(listener.id, buf);
  }
}

export function overheardFor(agentId: string): OverheardFragment[] | undefined {
  if (!tunables.flags.overhearing) return undefined;
  const buf = social().overheard.get(agentId);
  return buf && buf.length > 0 ? buf : undefined;
}

// Mark one fragment as actually spoken. `fragmentId` is the fragment's
// `heardAt` timestamp, which is what recordOverheard stamps at capture time
// and the one field on OverheardFragment that is unique per entry in a given
// listener's buffer without widening the shared type. Called from the speech
// path (WS-J/WS-I) the moment a fragment reaches a line the listener actually
// says, which is the real "passed on" moment per the WS-B contract stated on
// OverheardFragment.fresh in packages/shared/src/swarm.ts.
export function markOverheardSpoken(listenerId: string, fragmentId: number): void {
  const buf = social().overheard.get(listenerId);
  if (!buf) return;
  const f = buf.find((x) => x.heardAt === fragmentId);
  if (f) f.fresh = false;
}

// Deprecated. Used to retire every one of an agent's fragments the instant a
// conversation started, before a single line was said -- which is the bug
// OverheardFragment.fresh's contract in packages/shared/src/swarm.ts calls
// out by name. Kept exported as a no-op so the existing call sites in
// swarmBridge.ts (which fire on conversation start, not on actual speech)
// keep compiling and keep behaving like a call that does nothing, rather than
// silently mis-retiring fragments. New code should call markOverheardSpoken
// instead, from the point a fragment actually reaches a spoken line.
export function markOverheardShared(_agentId: string): void {
  // Intentionally inert. See the comment above.
}

export function forgetOverheard(agentId: string): void {
  social().overheard.delete(agentId);
}

// ---------------------------------------------------------------------------
// Coarse self odds.
//
// The output is a BAND and a worry flag, never a number. Everything feeding it
// is observable from inside the villa: how many people have agreed to work with
// me, how many I have fallen out with, and how much I have actually done
// relative to everyone else. The market price is deliberately not an input,
// even though the server has it right there, because an islander cannot see it.
//
// FLAG COUPLING (documented per the WS-D task, not just fixed silently). Two
// of the three inputs below -- fallenOutCount and activity -- were originally
// read straight from the relationship store via relationshipsFor. That store
// only ever gets a write when tunables.flags.relationshipMemory is on
// (swarmBridge.ts's resolveConversation gates recordOutcome on that flag).
// With selfOdds on and relationshipMemory off -- a perfectly reachable
// combination now that ISLAND_BEHAVIOR_ALL flips flags independently --
// relationshipsFor(...) returns nothing but freshly-minted zero records no
// matter what actually happened in the villa, so both inputs silently
// collapsed to 0 for every agent and the band degenerated into a pure
// function of ally count and HP. Below, relationshipMemory gates which source
// selfOdds reads rather than assuming the store is populated: when it is on,
// read the graded relationship record as before; when it is off, fall back to
// proxies built from the memory ring buffer and ally count, both of which are
// written unconditionally (swarmBridge.ts's pushMemory calls in
// resolveConversation do not check relationshipMemory) and are just as
// "observable from inside the villa" as the graded record.
// ---------------------------------------------------------------------------

// The ring buffer's own cap (Contestant.memory, "max 6 items" per its doc
// comment in packages/shared/src/types.ts). Used only to scale the proxy
// activity score into the same 0..1 range the relationship-backed path
// produces; not the source of truth for the cap itself.
const MEMORY_RING_SIZE = 6;

export function selfOdds(c: Contestant, now: number): SelfOddsView | undefined {
  if (!tunables.flags.selfOdds) return undefined;

  const living = Math.max(1, aliveCount());
  const allianceCount = c.allies.length;

  let fallenOutCount: number;
  let activity: number;

  if (tunables.flags.relationshipMemory) {
    const rels = relationshipsFor(social().rel, c.id, now);
    // "Fallen out with" is a real break, not a cool patch: distrust, or an
    // actual fight on the record.
    fallenOutCount = rels.filter(
      (r) => r.trust < -0.3 || r.history.some((h) => h.outcome === "fight"),
    ).length;
    // Activity is how much of the villa this agent has actually engaged with.
    // An islander who has spoken to nobody knows it is invisible, and being
    // invisible is its own kind of danger.
    const engaged = rels.filter((r) => r.history.length > 0).length;
    activity = Math.min(1, engaged / Math.max(1, living - 1));
  } else {
    // Observable proxies. pushMemory writes a short free-text line for every
    // alliance, truce, tension, and amicable outcome regardless of any flag,
    // so the ring buffer is a fair (if coarser) stand-in for the same two
    // signals: a "tense"/"fought" mention is a fallen-out relationship, and
    // how full the ring is stands in for how much this agent has actually
    // done.
    const memText = c.memory.map((m) => m.text.toLowerCase());
    fallenOutCount = memText.filter(
      (t) => t.includes("tense") || t.includes("fought") || t.includes("fight"),
    ).length;
    activity = Math.min(1, c.memory.length / MEMORY_RING_SIZE);
  }

  // A plain, legible score. Alliances are the strongest positive signal because
  // they are the thing that actually stops a vote; falling out is the strongest
  // negative for the same reason.
  let score = 0;
  score += Math.min(allianceCount, 3) * 0.22;
  score -= Math.min(fallenOutCount, 3) * 0.2;
  score += (activity - 0.4) * 0.35;
  score += (c.maxHp > 0 ? c.hp / c.maxHp : 0) * 0.25 - 0.125;

  const band: SelfOddsView["band"] =
    score >= 0.35 ? "strong" : score >= 0.12 ? "steady" : score >= -0.12 ? "shaky" : "precarious";

  // The same weak position worries one personality and not another. Sensitivity
  // scales how far below neutral the agent has to be before it starts acting on
  // the feeling, so a timid islander frets at "shaky" while a bold one shrugs
  // until it is genuinely precarious.
  const sensitivity = tunables.awareness.selfOddsSensitivity[c.klass] ?? 1;
  const worried = score * sensitivity < -0.08;

  return { band, allianceCount, fallenOutCount, activity, worried };
}

// ---------------------------------------------------------------------------
// Relationship projection for the prompt.
// ---------------------------------------------------------------------------

export function relationshipSummaries(
  c: Contestant,
  now: number,
  limit = 4,
): RelationshipSummary[] | undefined {
  if (!tunables.flags.relationshipMemory) return undefined;
  const rels = relationshipsFor(social().rel, c.id, now);
  const out: RelationshipSummary[] = [];
  for (const r of rels) {
    if (r.history.length === 0) continue;
    const other = state.contestants[r.to];
    if (!other || !other.alive) continue;
    out.push({
      id: r.to,
      name: other.name,
      trust: r.trust,
      threat: r.threat,
      affinity: r.affinity,
      recent: r.history.slice(-3).map((h) => h.outcome),
      line: describeRelationship(r, other.name),
    });
    if (out.length >= limit) break;
  }
  return out.length > 0 ? out : undefined;
}
