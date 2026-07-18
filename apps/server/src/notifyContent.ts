import { tunables } from "@arena/shared";
import type { HolderPosition } from "./notify.js";

// ---------------------------------------------------------------------------
// The single message-composition surface for SMS.
//
// Before this file, there were exactly three message strings in the whole
// game: combat.ts's binary ternary on noShares (No paid out / Yes voided),
// and market.ts's one surge line. Every death in a run produced one of two
// sentences differing only by name -- the notification-layer equivalent of
// the "everything ends in a truce" problem this build exists to fix.
//
// This module is PURE. It takes structured facts about what happened
// (a NotifyEvent, a recipient's voice, and their position, if any) and
// returns a string. It never reads game state, never sends anything, and
// never knows about spectators, opt-in, or cooldowns -- that is notify.ts's
// job (see that file's header for the split). Being pure is what makes this
// file trivial to exhaustively unit test: notifyContent.test.ts calls these
// builders directly with hand-built fixtures, no server state to spin up.
//
// A body composed here says two things, always: WHAT HAPPENED, and WHAT IT
// MEANS FOR THE RECIPIENT'S MONEY. The second half is what the old templates
// never had -- a death text said "your position is gone" at best; nothing
// ever said an alliance or a fight might be about to move the number.
// ---------------------------------------------------------------------------

// Mirrors tunables.notify.perCategoryCooldownMs's key set. Kept here (not
// re-exported from tunables.ts) because the set of categories is a message-
// layer concept -- tunables.ts explicitly documents that its notify.
// perCategoryCooldownMs is an open record for exactly this reason, so a new
// category can be added here without a change there; an unknown key simply
// falls back to defaultCategoryCooldownMs.
export type NotifyCategory =
  | "payout"
  | "death"
  | "purge"
  | "fight"
  | "allianceFormed"
  | "allianceBroken"
  | "voteResult"
  | "ousterSupport"
  | "tension"
  | "amicable"
  | "drop"
  | "surge";

// Which voice a body is written in. "owner" is the "my agent" case (task 2 of
// the user's ask) and refers to the subject as "your islander"; "holder" is
// the "my bet" case and refers to the subject by name. A recipient who is
// both gets exactly one text, in the richer owner voice (see notify.ts's
// notifyAboutContestant).
export type Voice = "owner" | "holder";

// One event about one contestant, in the vocabulary every caller (WS-E, WS-F,
// WS-H) already has on hand at the point they'd otherwise call notifyHolders
// directly. Deliberately carries plain facts (names, booleans, numbers)
// rather than Contestant/Conversation objects, so this file stays decoupled
// from the server's internal shapes and safe to unit test without them.
//
// SHARED MARKET-MOVE FIELD. Every producer of an event is standing at the one
// point in the code where the realized price move is also in scope
// (swarmBridge.ts's notifyPair already receives driftA/driftB from the same
// resolveConversation call that produced the outcome; combat.ts has the fight's
// own drift on the line above its notify call). Before this field existed the
// move was thrown away at the call boundary and a message could only ever
// gesture at consequence. driftPoints carries it through, which is the half of
// the user's ask that reads "shows how that impacts the investments".
export type MarketMove = {
  // SIGNED, in PROBABILITY POINTS on the SUBJECT's own price, not a fraction:
  // a market that went from 40 percent to 43 percent is driftPoints: 3, not
  // 0.03. Positive means the subject firmed up, which is good for a Yes holder
  // and bad for a No holder; the builders below invert it per side rather than
  // assuming the reader is long.
  //
  // Optional on purpose: every producer that predates this field still
  // compiles untouched, and an absent (or zero, or NaN) value is not an error
  // condition. It simply means "no figure to quote", and the builders fall
  // back to directional language about what the event will LIKELY do to the
  // price, which is the other half of the user's ask ("how it MIGHT impact").
  // Nothing here ever fabricates a number it was not handed.
  driftPoints?: number;
};

// The facts half of an event, before the shared market-move field is folded in.
// Kept as its own union so MarketMove can be distributed across every member
// (see WithMarketMove) instead of being repeated on each one by hand.
type NotifyEventFacts =
  | { kind: "allianceFormed"; subjectName: string; otherName: string }
  | { kind: "allianceBroken"; subjectName: string; otherName: string; betrayedSubject: boolean }
  | { kind: "tension"; subjectName: string; otherName: string }
  | { kind: "amicable"; subjectName: string; otherName: string }
  | {
      kind: "fight";
      subjectName: string;
      otherName: string;
      betrayal: boolean; // combat.ts's betrayal boolean: an ally started it
      subjectWon: boolean | null; // null = inconclusive (both walked away)
    }
  | { kind: "death"; subjectName: string; killerName: string | null; causeText: string }
  | {
      kind: "voteResult";
      eliminatedName: string;
      subjectWasEliminated: boolean;
      tally: [name: string, votes: number][];
    }
  | { kind: "ousterSupport"; subjectName: string; supportFraction: number; thresholdFraction: number }
  | { kind: "surge"; subjectName: string; pctNow: number }
  | { kind: "drop"; subjectName: string; pctNow: number };

// Distributive on purpose. Writing `MarketMove & (A | B)` would produce a type
// that is no longer a naked union, and Extract<NotifyEvent, { kind: "fight" }>
// (which every builder signature below uses) would silently resolve to never
// and break all of them. Distributing the intersection member by member keeps
// NotifyEvent a discriminated union that both Extract and switch narrowing
// still understand, while giving driftPoints to every kind from one line.
type WithMarketMove<T> = T extends unknown ? T & MarketMove : never;

// The public event type, unchanged in name and in every existing member's
// required fields. Producers keep passing exactly what they passed before.
export type NotifyEvent = WithMarketMove<NotifyEventFacts>;

// One line item in a purge digest: what happened to ONE of the recipient's
// holdings (their own islander, or a position) during the purge window.
export type PurgeDigestEntry = {
  subjectName: string;
  voice: Voice;
  survived: boolean;
  pos: HolderPosition | null;
};

export type PayoutInfo = {
  winnerName: string;
  isOwner: boolean; // this recipient owns the winning islander
  spent: number;
  net: number; // final tokens - starting 50
};

// ---------------------------------------------------------------------------
// Dash safety net.
//
// The canonical implementation (packages/swarm/src/fallback.ts
// stripSpeechDashes) is not reachable from here: it is not part of
// @arena/swarm's public export surface (only "." -> src/index.ts is exported,
// and index.ts does not re-export it), and this workstream does not own that
// package's index.ts to add it. Filed as a cross-file request: once
// packages/swarm/src/index.ts exports stripSpeechDashes, this local mirror
// should be deleted in favor of importing the real one.
//
// Everything composed in this file is server-authored English, not islander
// speech or raw model output, so the richer rewriting stripSpeechDashes does
// (turning a range like "10-20" into "10 to 20", closing up short compound
// prefixes) is not needed -- house rule is simply that no dash-like character
// ever survives into a body. A plain interpolated name is the only realistic
// vector, and this guards it regardless.
// ---------------------------------------------------------------------------
const DASH_CLASS = "-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015\\u2212";
const LEFTOVER_DASH_RE = new RegExp(`[${DASH_CLASS}]`, "g");

function finalizeBody(s: string): string {
  return s.replace(LEFTOVER_DASH_RE, ",").replace(/\s+/g, " ").trim();
}

// Mirrors apps/web/src/lib/outcomes.ts's PRESENTATION table (task 10): that
// file is the single source of truth for the words a spectator sees on screen
// for a conversation outcome (island badge, panel badge, feed line). This is
// a server-side echo of the same phrases so an SMS about an outcome never
// disagrees with what is on the screen. apps/server cannot import apps/web
// (separate deployable, no workspace dependency between them), so this is a
// hand-kept mirror, not a shared import -- keep the two in sync by hand if
// either changes.
const OUTCOME_PHRASE = {
  alliance: "an alliance forms",
  fight: "it turns into a fight",
  tension: "it leaves tension behind",
  amicable: "they part on good terms",
} as const;

function subjectRef(voice: Voice, subjectName: string): string {
  return voice === "owner" ? `Your islander ${subjectName}` : subjectName;
}

// The same reference for a position that is NOT the start of a sentence, where
// the capitalized form reads as a typo ("Rio just cut Your islander Marcus
// loose"). Split out rather than folded into subjectRef because most callers
// legitimately open their sentence with the subject and need the capital.
function subjectRefMid(voice: Voice, subjectName: string): string {
  return voice === "owner" ? `your islander ${subjectName}` : subjectName;
}

function roundTokens(n: number): number {
  return Math.round(Math.abs(n));
}

// The clause that answers "what does this mean for my money": unrealized P&L
// on a live position, valued at the current normalized win probability (each
// share pays out 1 token if that side wins -- market.ts's own comment on
// buyShares says the same thing about the real payout, this is the same math
// applied to an existing holding instead of a prospective buy). Returns ""
// when the recipient holds nothing, so callers can always splice this in.
function pnlClause(pos: HolderPosition | null): string {
  if (!pos) return "";
  const parts: string[] = [];
  if (pos.yesShares > 0) {
    const net = pos.yesShares * pos.winProbability - pos.yesSpent;
    parts.push(`your Yes position is ${netPhrase(net)}`);
  }
  if (pos.noShares > 0) {
    const net = pos.noShares * (1 - pos.winProbability) - pos.noSpent;
    parts.push(`your No position is ${netPhrase(net)}`);
  }
  if (parts.length === 0) return "";
  return `, ${parts.join(" and ")}`;
}

function netPhrase(net: number): string {
  if (Math.abs(net) < 0.5) return "roughly break even";
  return net > 0 ? `up about ${roundTokens(net)} tokens` : `down about ${roundTokens(net)} tokens`;
}

// ---------------------------------------------------------------------------
// Market impact: the "so what does this do to my money" half of a body.
//
// A social event text used to stop at the human beat ("Maya and Rio form an
// alliance") plus a standing P&L figure that had nothing to do with the event
// being reported. The reader was left to work out for themselves whether the
// thing they just got texted about was good or bad for their position. This
// section closes that, in the two cases the user actually asked for:
//
//   REALIZED  driftPoints was handed to us, so quote the actual move, signed
//             per the reader's own side.
//   LIKELY    no figure available, so say which way this kind of event usually
//             pushes a price, and whether that is the direction the reader
//             wants. Directional words only, never an invented percentage.
// ---------------------------------------------------------------------------

// Behind a tunables flag, per this build's contract. Turning it off falls every
// builder back to its pre-existing wording exactly, so the market-impact copy
// can be compared against the plain messages without a code change.
function marketImpactEnabled(): boolean {
  return tunables.notify.marketImpactCopy;
}

// A drift smaller than this rounds to "0 points", and a text that says a
// position moved zero points is worse than one that says nothing. Below the
// threshold we fall through to the likely-direction wording instead.
const MIN_REPORTABLE_POINTS = 0.5;

// Which way this kind of event usually pushes the subject's price, used only
// when no realized figure is available. "up" and "down" here are about the
// SUBJECT's odds, not about the reader's P&L; whether that is good news for
// the reader depends on which side they are holding, resolved separately.
type MarketLean = "up" | "down";

// The likely-direction sentence per kind. Written as plain spectator English
// and deliberately hedged ("usually", "tend to"), because it is a tendency and
// not a measurement. Only the five social kinds the user named appear here;
// surge, drop, death, voteResult and ousterSupport already quote a real number
// or a real settlement and have no need to guess.
const LIKELY_MOVE: Record<
  "allianceFormed" | "allianceBroken" | "tension" | "amicable" | "fight",
  { lean: MarketLean; phrase: string }
> = {
  allianceFormed: { lean: "up", phrase: "alliances usually firm a price up" },
  allianceBroken: { lean: "down", phrase: "losing an ally usually softens a price" },
  tension: { lean: "down", phrase: "bad blood tends to weigh on a price" },
  amicable: { lean: "up", phrase: "goodwill tends to nudge a price up" },
  fight: { lean: "down", phrase: "fights tend to knock a price down" },
};

// How the reader is exposed, reduced to the one question the copy needs
// answered: does a rise in this contestant's price help them or hurt them?
// leansYes true means a rise helps, false means a fall helps, null means they
// hold both sides in near equal size and the move is close to a wash.
//
// notify.ts only ever builds a HolderPosition when at least one side is
// positive, so "holds nothing" is represented by a null pos, not by a zeroed
// one, and the null case is the owner who never bet on their own islander.
type Exposure = { label: string; leansYes: boolean | null };

function exposureOf(pos: HolderPosition | null, them: string): Exposure | null {
  if (!pos) return null;
  const hasYes = pos.yesShares > 0;
  const hasNo = pos.noShares > 0;
  if (hasYes && !hasNo) return { label: `your ${Math.round(pos.yesShares)} Yes on ${them}`, leansYes: true };
  if (hasNo && !hasYes) return { label: `your ${Math.round(pos.noShares)} No on ${them}`, leansYes: false };
  if (!hasYes && !hasNo) return null;
  // Both sides held. Quoting one side's share count would misstate the other
  // ("your 12 Yes" to someone who is also short 10 of them), so the copy
  // reports the net, which is the exposure the move actually acts on.
  const net = pos.yesShares - pos.noShares;
  if (Math.abs(net) < 1) return { label: `your book on ${them}`, leansYes: null };
  return { label: `your net ${net > 0 ? "Yes" : "No"} on ${them}`, leansYes: net > 0 };
}

// The realized clause. Returns null (not an empty string) when there is no
// figure worth quoting, so callers can tell "nothing to say" apart from "said
// nothing", and fall through to the likely wording in the first case.
function realizedMoveClause(
  them: string,
  pos: HolderPosition | null,
  driftPoints: number | undefined,
): string | null {
  if (driftPoints === undefined || !Number.isFinite(driftPoints)) return null;
  if (Math.abs(driftPoints) < MIN_REPORTABLE_POINTS) return null;
  const n = Math.round(Math.abs(driftPoints));
  const word = n === 1 ? "point" : "points";
  const firmedUp = driftPoints > 0;

  const exp = exposureOf(pos, them);
  // No position: the owner of an islander who never bet on it. They still care
  // which way the market took their agent, so report the move on the subject
  // rather than on a wallet that has nothing in it.
  if (!exp) return `, the market moved ${them} ${firmedUp ? "up" : "down"} about ${n} ${word}`;
  if (exp.leansYes === null) return `, you are hedged on ${them} so that move is close to a wash for you`;
  // A No holder gains exactly when the contestant's price falls. This is the
  // inversion that makes the sentence true for both sides of the book.
  const gained = exp.leansYes ? firmedUp : !firmedUp;
  return `, ${exp.label} is ${gained ? "up" : "down"} about ${n} ${word} on that`;
}

// The likely clause's tail: after "fights tend to knock a price down", say
// whether that is the direction this particular reader is rooting for.
function leanRider(lean: MarketLean, exp: Exposure | null): string {
  if (!exp) return "";
  if (exp.leansYes === null) return ", though you are hedged on them either way";
  const sideWord = exp.leansYes ? "Yes" : "No";
  const aligned = (lean === "up") === exp.leansYes;
  return aligned ? `, which is the way your ${sideWord} wants it` : `, which cuts against your ${sideWord}`;
}

// The single entry point the five social builders splice in where they used to
// splice pnlClause. Always returns either "" or a clause already prefixed with
// ", ", so it drops into a sentence the same way pnlClause did.
function impactClause(
  kind: keyof typeof LIKELY_MOVE,
  voice: Voice,
  subjectName: string,
  pos: HolderPosition | null,
  driftPoints: number | undefined,
): string {
  // Flag off: byte-identical to the wording that shipped before this section.
  if (!marketImpactEnabled()) return pnlClause(pos);

  // In owner voice the sentence has already named the islander as "Your
  // islander Maya", so referring to them again by name reads like a stranger.
  const them = voice === "owner" ? "them" : subjectName;

  const realized = realizedMoveClause(them, pos, driftPoints);
  // The realized move REPLACES the standing P&L figure rather than joining it.
  // Both are token-and-direction statements about the same position, and
  // running them back to back ("up about 3 points on that, your Yes position
  // is up about 2 tokens") says the same thing twice in an SMS that has no
  // room for it. When we know what this event did, that is the more useful of
  // the two, because it is the one the text is actually about.
  if (realized) return realized;

  // Likewise one money clause per message, not two. Appending the standing
  // P&L here as well produced a three comma run-on that no longer reads as a
  // sentence ("..., alliances usually firm a price up, which cuts against your
  // No, your No position is roughly break even") and pushed a social alert
  // past 190 characters. The event's own consequence is what this text is
  // about; the running P&L still reaches the reader on every surge, drop,
  // vote, death and purge digest, all of which are untouched here.
  const { lean, phrase } = LIKELY_MOVE[kind];
  return `, ${phrase}${leanRider(lean, exposureOf(pos, them))}`;
}

// -- Per-kind builders --------------------------------------------------------
// Each is exported individually (in addition to the composeEventBody
// dispatcher below) so notifyContent.test.ts can target one kind directly
// without constructing a full NotifyEvent union member inline every time.

export function buildAllianceFormedBody(
  e: Extract<NotifyEvent, { kind: "allianceFormed" }>,
  voice: Voice,
  pos: HolderPosition | null,
): string {
  const subj = subjectRef(voice, e.subjectName);
  return finalizeBody(
    // The lead beat before the outcome phrase is not decoration: without it
    // this read "Marcus and Rio an alliance forms", the one builder here that
    // spliced OUTCOME_PHRASE straight onto the subjects with no verb between
    // them. Every sibling builder below already had its own lead clause.
    `${subj} and ${e.otherName} just came to an understanding, ${OUTCOME_PHRASE.alliance}. That is one more vote likely in their corner${impactClause("allianceFormed", voice, e.subjectName, pos, e.driftPoints)}.`,
  );
}

export function buildAllianceBrokenBody(
  e: Extract<NotifyEvent, { kind: "allianceBroken" }>,
  voice: Voice,
  pos: HolderPosition | null,
): string {
  const subj = subjectRef(voice, e.subjectName);
  const line = e.betrayedSubject
    ? `${e.otherName} just cut ${subjectRefMid(voice, e.subjectName)} loose`
    : `${subj} just cut ties with ${e.otherName}`;
  return finalizeBody(
    `${line}. That is one fewer vote in their corner${impactClause("allianceBroken", voice, e.subjectName, pos, e.driftPoints)}.`,
  );
}

export function buildTensionBody(
  e: Extract<NotifyEvent, { kind: "tension" }>,
  voice: Voice,
  pos: HolderPosition | null,
): string {
  const subj = subjectRef(voice, e.subjectName);
  return finalizeBody(
    `${subj} and ${e.otherName} just had a tense exchange, ${OUTCOME_PHRASE.tension}. Worth watching if it boils over${impactClause("tension", voice, e.subjectName, pos, e.driftPoints)}.`,
  );
}

export function buildAmicableBody(
  e: Extract<NotifyEvent, { kind: "amicable" }>,
  voice: Voice,
  pos: HolderPosition | null,
): string {
  const subj = subjectRef(voice, e.subjectName);
  return finalizeBody(
    `${subj} and ${e.otherName} had a good moment, ${OUTCOME_PHRASE.amicable}. Could turn into an alliance${impactClause("amicable", voice, e.subjectName, pos, e.driftPoints)}.`,
  );
}

export function buildFightBody(
  e: Extract<NotifyEvent, { kind: "fight" }>,
  voice: Voice,
  pos: HolderPosition | null,
): string {
  const subj = subjectRef(voice, e.subjectName);
  const betrayalNote = e.betrayal ? ` Their own ally started it.` : "";
  // No trailing period on the outcome note: the money clause is spliced onto
  // the end of this same sentence with a comma, and the sentence is closed
  // once at the end. (Previously the period was baked in here, so a holder saw
  // "came out on top., your Yes position is up about 2 tokens".)
  // In owner voice the sentence opened with "Your islander Marcus", so naming
  // them a third time reads like a report about a stranger.
  const who = voice === "owner" ? "They" : e.subjectName;
  const outcomeNote =
    e.subjectWon === true
      ? ` ${who} came out on top`
      : e.subjectWon === false
        ? ` ${who} came out worse for it`
        : ` Both walked away hurt`;
  return finalizeBody(
    `${subj} just got into a fight with ${e.otherName}, ${OUTCOME_PHRASE.fight}.${betrayalNote}${outcomeNote}${impactClause("fight", voice, e.subjectName, pos, e.driftPoints)}.`,
  );
}

export function buildDeathBody(
  e: Extract<NotifyEvent, { kind: "death" }>,
  voice: Voice,
  pos: HolderPosition | null,
): string {
  const subj = subjectRef(voice, e.subjectName);
  // Death settles immediately (combat.ts's settleMarketNo / processDeath): No
  // pays out 1:1 in real tokens right now, Yes voids outright. This is a
  // settlement fact, not a mark to market, so it does NOT go through
  // pnlClause, which prices an ongoing position at the live win probability.
  let moneyClause = "";
  if (pos) {
    if (pos.noShares > 0) moneyClause = `, your No position just paid out ${roundTokens(pos.noShares)} tokens`;
    else if (pos.yesShares > 0) moneyClause = `, your Yes position on them is gone`;
  }
  const cause = e.causeText || (e.killerName ? `${e.killerName} got them` : "they did not make it");
  return finalizeBody(`${subj} is out. ${cause}${moneyClause}.`);
}

export function buildVoteResultBody(
  e: Extract<NotifyEvent, { kind: "voteResult" }>,
  voice: Voice,
  pos: HolderPosition | null,
): string {
  const tallyStr = e.tally.map(([name, votes]) => `${name} ${votes}`).join(", ");
  const subj = e.subjectWasEliminated ? subjectRef(voice, e.eliminatedName) : e.eliminatedName;
  const outcomeLine = e.subjectWasEliminated
    ? `${subj} took the votes and is out`
    : `The vote went against ${e.eliminatedName}`;
  return finalizeBody(`${outcomeLine}. Tally: ${tallyStr}${pnlClause(pos)}.`);
}

export function buildOusterSupportBody(
  e: Extract<NotifyEvent, { kind: "ousterSupport" }>,
  voice: Voice,
  pos: HolderPosition | null,
): string {
  const subj = subjectRef(voice, e.subjectName);
  const pct = Math.round(e.supportFraction * 100);
  const thresholdPct = Math.round(e.thresholdFraction * 100);
  return finalizeBody(
    `${subj} is drawing heat: about ${pct} percent of the villa now wants them gone, it takes ${thresholdPct} percent to force a vote${pnlClause(pos)}.`,
  );
}

export function buildSurgeBody(
  e: Extract<NotifyEvent, { kind: "surge" }>,
  voice: Voice,
  pos: HolderPosition | null,
): string {
  const subj = subjectRef(voice, e.subjectName);
  const pct = Math.round(e.pctNow * 100);
  return finalizeBody(`${subj} is surging, now ${pct} percent to win${pnlClause(pos)}.`);
}

export function buildDropBody(
  e: Extract<NotifyEvent, { kind: "drop" }>,
  voice: Voice,
  pos: HolderPosition | null,
): string {
  const subj = subjectRef(voice, e.subjectName);
  const pct = Math.round(e.pctNow * 100);
  return finalizeBody(`${subj} is fading, now ${pct} percent to win${pnlClause(pos)}.`);
}

// The one dispatcher notify.ts's notifyAboutContestant calls. The switch is
// exhaustive over the closed NotifyEvent union (a missing case is a compile
// error), and the default below is a pure defensive fallback in case a future
// kind is added here without a matching arm -- never crash, degrade to a
// generic line instead.
export function composeEventBody(event: NotifyEvent, voice: Voice, pos: HolderPosition | null): string {
  switch (event.kind) {
    case "allianceFormed":
      return buildAllianceFormedBody(event, voice, pos);
    case "allianceBroken":
      return buildAllianceBrokenBody(event, voice, pos);
    case "tension":
      return buildTensionBody(event, voice, pos);
    case "amicable":
      return buildAmicableBody(event, voice, pos);
    case "fight":
      return buildFightBody(event, voice, pos);
    case "death":
      return buildDeathBody(event, voice, pos);
    case "voteResult":
      return buildVoteResultBody(event, voice, pos);
    case "ousterSupport":
      return buildOusterSupportBody(event, voice, pos);
    case "surge":
      return buildSurgeBody(event, voice, pos);
    case "drop":
      return buildDropBody(event, voice, pos);
    default: {
      // Exhaustiveness guard: if this ever executes, a new NotifyEvent kind
      // was added without a builder. Degrade rather than throw.
      const subj = subjectRef(voice, (event as { subjectName?: string }).subjectName ?? "your islander");
      return finalizeBody(`${subj}: something happened${pnlClause(pos)}.`);
    }
  }
}

// A purge digest: one coherent message per recipient naming every position
// (and their own islander, if any) affected by the purge window, instead of
// one random survivor of the old shared cooldown.
export function buildPurgeDigestBody(entries: PurgeDigestEntry[]): string {
  if (entries.length === 0) return finalizeBody("The Purge just happened.");
  const parts = entries.map((e) => {
    const subj = subjectRef(e.voice, e.subjectName);
    const fate = e.survived ? `${subj} survived` : `${subj} is gone`;
    return `${fate}${pnlClause(e.pos)}`;
  });
  return finalizeBody(`The Purge just hit. ${parts.join("; ")}.`);
}

// End-of-game payout: lifecycle.ts's buildResults already computes spent/net
// per spectator and the winner's name; this is the wording, WS-H wires it in.
export function buildPayoutBody(info: PayoutInfo): string {
  const outcome =
    info.net > 0
      ? `finished up ${roundTokens(info.net)} tokens`
      : info.net < 0
        ? `finished down ${roundTokens(info.net)} tokens`
        : "finished right where you started";
  const winnerNote = info.isOwner
    ? `Your islander ${info.winnerName} won the whole game.`
    : `${info.winnerName} won the whole game.`;
  return finalizeBody(
    `It is over. ${winnerNote} You spent ${roundTokens(info.spent)} tokens across the run and ${outcome}.`,
  );
}
