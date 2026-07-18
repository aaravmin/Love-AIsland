import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAllianceBrokenBody,
  buildAllianceFormedBody,
  buildAmicableBody,
  buildDeathBody,
  buildDropBody,
  buildFightBody,
  buildOusterSupportBody,
  buildPayoutBody,
  buildPurgeDigestBody,
  buildSurgeBody,
  buildTensionBody,
  buildVoteResultBody,
  composeEventBody,
} from "./notifyContent.js";
import type { HolderPosition } from "./notify.js";
import type { NotifyEvent, PurgeDigestEntry } from "./notifyContent.js";

// ---------------------------------------------------------------------------
// notifyContent.ts is pure (no game state), so every test here just builds a
// fixture and reads the returned string -- no server/room setup needed.
// ---------------------------------------------------------------------------

// A dash-like character of any of the shapes stripSpeechDashes' own regex
// targets (packages/swarm/src/fallback.ts), mirrored here since this file
// keeps its own local safety net (see notifyContent.ts's header for why).
const ANY_DASH_RE = /[-‐‑‒–—―−]/;

function assertNoDash(body: string, label: string): void {
  assert.equal(ANY_DASH_RE.test(body), false, `${label} contains a dash: "${body}"`);
}

function pos(over: Partial<HolderPosition> = {}): HolderPosition {
  return {
    yesShares: 0,
    noShares: 0,
    yesSpent: 0,
    noSpent: 0,
    rawPriceYes: 0.5,
    winProbability: 0.5,
    ...over,
  };
}

// -- Every event kind: distinct, non-templated, no dashes --------------------

const EVENTS: NotifyEvent[] = [
  { kind: "allianceFormed", subjectName: "Maya", otherName: "Rio" },
  { kind: "allianceBroken", subjectName: "Maya", otherName: "Rio", betrayedSubject: true },
  { kind: "tension", subjectName: "Maya", otherName: "Rio" },
  { kind: "amicable", subjectName: "Maya", otherName: "Rio" },
  { kind: "fight", subjectName: "Maya", otherName: "Rio", betrayal: true, subjectWon: true },
  { kind: "death", subjectName: "Maya", killerName: "Rio", causeText: "Rio smashed Maya with a rock" },
  {
    kind: "voteResult",
    eliminatedName: "Maya",
    subjectWasEliminated: true,
    tally: [
      ["Maya", 4],
      ["Rio", 1],
    ],
  },
  { kind: "ousterSupport", subjectName: "Maya", supportFraction: 0.4, thresholdFraction: 1 / 3 },
  { kind: "surge", subjectName: "Maya", pctNow: 0.43 },
  { kind: "drop", subjectName: "Maya", pctNow: 0.12 },
];

test("every event kind produces a distinct, non-templated-looking body", () => {
  const bodies = EVENTS.map((e) => composeEventBody(e, "holder", pos({ yesShares: 5, yesSpent: 3 })));
  const distinct = new Set(bodies);
  assert.equal(distinct.size, bodies.length, "expected every kind to produce a unique body");
  // "Non-templated-looking": no two bodies should be identical after removing
  // the one name they share, which is exactly the bug this build replaces
  // (combat.ts's old binary ternary produced two sentences differing only by
  // name). Since every builder above also varies its VERB and its explanation
  // by kind, no pair should collapse to the same shape once the name is
  // blanked either.
  const shapes = bodies.map((b) => b.replaceAll("Maya", "<subject>").replaceAll("Rio", "<other>"));
  assert.equal(new Set(shapes).size, shapes.length, "expected every kind's sentence shape to differ, not just the name");
});

test("no body contains a dash, across every kind and both voices", () => {
  for (const e of EVENTS) {
    for (const voice of ["owner", "holder"] as const) {
      const body = composeEventBody(e, voice, pos({ yesShares: 5, yesSpent: 3 }));
      assertNoDash(body, `${e.kind}/${voice}`);
    }
  }
  assertNoDash(buildPurgeDigestBody([{ subjectName: "Maya", voice: "owner", survived: false, pos: null }]), "purge digest");
  assertNoDash(buildPayoutBody({ winnerName: "Maya", isOwner: true, spent: 40, net: 12 }), "payout");
});

// -- Owner vs holder voice -----------------------------------------------------

test("owner and holder wordings differ for the same event", () => {
  const event: NotifyEvent = { kind: "allianceFormed", subjectName: "Maya", otherName: "Rio" };
  const owner = buildAllianceFormedBody(event, "owner", null);
  const holder = buildAllianceFormedBody(event, "holder", null);
  assert.notEqual(owner, holder);
  assert.match(owner, /your islander/i);
  assert.doesNotMatch(holder, /your islander/i);
});

test("owner voice is used for death, fight, tension and amicable too", () => {
  const death = buildDeathBody(
    { kind: "death", subjectName: "Maya", killerName: "Rio", causeText: "Rio got them" },
    "owner",
    null,
  );
  assert.match(death, /your islander/i);
  const fight = buildFightBody(
    { kind: "fight", subjectName: "Maya", otherName: "Rio", betrayal: false, subjectWon: null },
    "owner",
    null,
  );
  assert.match(fight, /your islander/i);
});

// -- P&L clause ----------------------------------------------------------------

test("a P&L clause appears whenever cost basis is available, and not otherwise", () => {
  const event: NotifyEvent = { kind: "surge", subjectName: "Maya", pctNow: 0.6 };
  const withPosition = buildSurgeBody(event, "holder", pos({ yesShares: 10, yesSpent: 4, winProbability: 0.6 }));
  const withoutPosition = buildSurgeBody(event, "holder", null);
  assert.match(withPosition, /tokens/);
  assert.doesNotMatch(withoutPosition, /tokens/);
});

test("P&L direction matches whether the mark to market is above or below cost basis", () => {
  const event: NotifyEvent = { kind: "surge", subjectName: "Maya", pctNow: 0.8 };
  // 10 Yes shares at winProbability 0.8 mark to 8 tokens; spent only 2 -> up.
  const up = buildSurgeBody(event, "holder", pos({ yesShares: 10, yesSpent: 2, winProbability: 0.8 }));
  assert.match(up, /up about/);
  // 10 Yes shares at winProbability 0.1 mark to 1 token; spent 9 -> down.
  const down = buildSurgeBody(
    { kind: "surge", subjectName: "Maya", pctNow: 0.1 },
    "holder",
    pos({ yesShares: 10, yesSpent: 9, winProbability: 0.1 }),
  );
  assert.match(down, /down about/);
});

test("death uses a settlement clause (paid out / gone), not a mark-to-market P&L clause", () => {
  const event: NotifyEvent = { kind: "death", subjectName: "Maya", killerName: "Rio", causeText: "Rio got them" };
  const noHolder = buildDeathBody(event, "holder", pos({ noShares: 8 }));
  assert.match(noHolder, /paid out 8 tokens/);
  const yesHolder = buildDeathBody(event, "holder", pos({ yesShares: 8 }));
  assert.match(yesHolder, /gone/);
});

// -- Quoted percentage is the normalized win probability, not raw priceYes ----

test("the quoted percentage equals the normalized win probability, not raw priceYes", () => {
  const event: NotifyEvent = { kind: "surge", subjectName: "Maya", pctNow: 0.43 };
  // rawPriceYes and winProbability deliberately diverge, the way they do for
  // real when N > 2 living markets (lmsr.ts's winProbabilities divides by the
  // sum across all of them). pctNow is what the caller (notify.ts) computed
  // FROM winProbabilityFor, so the builder must echo pctNow, never rawPriceYes.
  const body = buildSurgeBody(event, "holder", pos({ rawPriceYes: 0.91, winProbability: 0.43 }));
  assert.match(body, /43 percent/);
  assert.doesNotMatch(body, /91 percent/);
});

// -- Vote result cites the actual tally ---------------------------------------

test("vote result body includes the real tally", () => {
  const body = buildVoteResultBody(
    {
      kind: "voteResult",
      eliminatedName: "Maya",
      subjectWasEliminated: true,
      tally: [
        ["Maya", 4],
        ["Rio", 1],
      ],
    },
    "holder",
    null,
  );
  assert.match(body, /Maya 4/);
  assert.match(body, /Rio 1/);
});

// -- Ouster support digest cites the fraction ---------------------------------

test("ouster support body cites the actual support and threshold fractions", () => {
  const body = buildOusterSupportBody(
    { kind: "ousterSupport", subjectName: "Maya", supportFraction: 0.4, thresholdFraction: 1 / 3 },
    "holder",
    null,
  );
  assert.match(body, /40 percent/);
  assert.match(body, /33 percent/);
});

// -- Purge digest mentions every affected position ----------------------------

test("a purge digest mentions every affected position, not one at random", () => {
  const entries: PurgeDigestEntry[] = [
    { subjectName: "Maya", voice: "holder", survived: false, pos: pos({ yesShares: 6, yesSpent: 6 }) },
    { subjectName: "Rio", voice: "holder", survived: true, pos: pos({ yesShares: 4, yesSpent: 2, winProbability: 0.7 }) },
    { subjectName: "Zed", voice: "owner", survived: true, pos: null },
  ];
  const body = buildPurgeDigestBody(entries);
  assert.match(body, /Maya/);
  assert.match(body, /Rio/);
  assert.match(body, /Zed/);
  assert.match(body, /gone/); // Maya's yes position, void on death
  assert.match(body, /survived/); // Rio and Zed
});

test("a purge digest with no affected positions still returns a safe, non-empty body", () => {
  const body = buildPurgeDigestBody([]);
  assert.ok(body.length > 0);
  assertNoDash(body, "empty purge digest");
});

// -- Payout ---------------------------------------------------------------------

test("payout body reflects net win or loss and the winner's name", () => {
  const up = buildPayoutBody({ winnerName: "Maya", isOwner: false, spent: 20, net: 15 });
  assert.match(up, /up 15 tokens/);
  assert.match(up, /Maya/);
  const down = buildPayoutBody({ winnerName: "Maya", isOwner: false, spent: 20, net: -10 });
  assert.match(down, /down 10 tokens/);
});

// -- Alliance broken / defection distinguishes who did the cutting ------------

test("alliance broken wording distinguishes being cut loose from cutting ties", () => {
  const wasCut = buildAllianceBrokenBody(
    { kind: "allianceBroken", subjectName: "Maya", otherName: "Rio", betrayedSubject: true },
    "holder",
    null,
  );
  const didCutting = buildAllianceBrokenBody(
    { kind: "allianceBroken", subjectName: "Maya", otherName: "Rio", betrayedSubject: false },
    "holder",
    null,
  );
  assert.notEqual(wasCut, didCutting);
});

test("tension and amicable are distinct, non-generic bodies", () => {
  const tension = buildTensionBody({ kind: "tension", subjectName: "Maya", otherName: "Rio" }, "holder", null);
  const amicable = buildAmicableBody({ kind: "amicable", subjectName: "Maya", otherName: "Rio" }, "holder", null);
  assert.notEqual(tension, amicable);
  assert.match(tension, /tense/);
  assert.match(amicable, /good moment/);
});

// ---------------------------------------------------------------------------
// Market impact: the realized move (driftPoints present) and the likely move
// (driftPoints absent). This is the half of the user's ask that reads "shows
// how that impacts the investments or how it might impact the investments", so
// both branches are covered, on both sides of the book, in both voices.
// ---------------------------------------------------------------------------

// A "N points" figure may only ever appear when a driftPoints value was handed
// in. Anything else is a fabricated number, which is the one thing these
// builders must never do.
const POINTS_FIGURE_RE = /\d+ points?/;

const DRIFT_EVENTS: NotifyEvent[] = [
  { kind: "allianceFormed", subjectName: "Marcus", otherName: "Rio", driftPoints: 3 },
  { kind: "allianceBroken", subjectName: "Marcus", otherName: "Rio", betrayedSubject: true, driftPoints: -4 },
  { kind: "tension", subjectName: "Marcus", otherName: "Rio", driftPoints: -2 },
  { kind: "amicable", subjectName: "Marcus", otherName: "Rio", driftPoints: 1 },
  { kind: "fight", subjectName: "Marcus", otherName: "Rio", betrayal: true, subjectWon: false, driftPoints: -6 },
];

test("a realized move is quoted for a Yes holder in the direction the price went", () => {
  const body = buildAllianceFormedBody(
    { kind: "allianceFormed", subjectName: "Marcus", otherName: "Rio", driftPoints: 3 },
    "holder",
    pos({ yesShares: 12, yesSpent: 5 }),
  );
  assert.match(body, /your 12 Yes on Marcus is up about 3 points on that/);
});

test("a No holder gains when the contestant's price FALLS, and loses when it rises", () => {
  const event = { kind: "allianceFormed", subjectName: "Marcus", otherName: "Rio" } as const;
  // Price firmed up by 3. Good for Yes, bad for No.
  const noOnGoodNews = buildAllianceFormedBody({ ...event, driftPoints: 3 }, "holder", pos({ noShares: 9, noSpent: 4 }));
  assert.match(noOnGoodNews, /your 9 No on Marcus is down about 3 points on that/);
  // Price fell by 3. The same holder is now up.
  const noOnBadNews = buildAllianceFormedBody({ ...event, driftPoints: -3 }, "holder", pos({ noShares: 9, noSpent: 4 }));
  assert.match(noOnBadNews, /your 9 No on Marcus is up about 3 points on that/);
});

test("a single point is singular, not '1 points'", () => {
  const body = buildAmicableBody(
    { kind: "amicable", subjectName: "Marcus", otherName: "Rio", driftPoints: 1 },
    "holder",
    pos({ yesShares: 4, yesSpent: 2 }),
  );
  assert.match(body, /up about 1 point on that/);
  assert.doesNotMatch(body, /1 points/);
});

test("an owner with no position still hears which way the market took their islander", () => {
  const body = buildFightBody(
    { kind: "fight", subjectName: "Marcus", otherName: "Rio", betrayal: false, subjectWon: false, driftPoints: -5 },
    "owner",
    null,
  );
  assert.match(body, /your islander/i);
  assert.match(body, /the market moved them down about 5 points/);
});

test("a hedged book is called a wash rather than given a false direction", () => {
  const body = buildTensionBody(
    { kind: "tension", subjectName: "Marcus", otherName: "Rio", driftPoints: -4 },
    "holder",
    pos({ yesShares: 6, yesSpent: 3, noShares: 6, noSpent: 3 }),
  );
  assert.match(body, /hedged on Marcus so that move is close to a wash/);
  assert.doesNotMatch(body, /up about/);
  assert.doesNotMatch(body, /down about/);
});

test("a book held on both sides is attributed to the side it actually leans", () => {
  const body = buildAllianceFormedBody(
    { kind: "allianceFormed", subjectName: "Marcus", otherName: "Rio", driftPoints: 4 },
    "holder",
    pos({ yesShares: 10, yesSpent: 4, noShares: 2, noSpent: 1 }),
  );
  assert.match(body, /your net Yes on Marcus is up about 4 points on that/);
});

test("without a drift figure, the body says the LIKELY direction and invents no number", () => {
  const alliance = buildAllianceFormedBody(
    { kind: "allianceFormed", subjectName: "Marcus", otherName: "Rio" },
    "holder",
    pos({ yesShares: 5, yesSpent: 3 }),
  );
  assert.match(alliance, /alliances usually firm a price up/);
  assert.doesNotMatch(alliance, POINTS_FIGURE_RE);

  const fight = buildFightBody(
    { kind: "fight", subjectName: "Marcus", otherName: "Rio", betrayal: false, subjectWon: null },
    "holder",
    pos({ yesShares: 5, yesSpent: 3 }),
  );
  assert.match(fight, /fights tend to knock a price down/);
  assert.doesNotMatch(fight, POINTS_FIGURE_RE);
});

test("the likely direction is tied to the reader's own side, both ways", () => {
  const event = { kind: "fight", subjectName: "Marcus", otherName: "Rio", betrayal: false, subjectWon: null } as const;
  // A fight leans the price DOWN, so a No holder wants it and a Yes holder does not.
  const noHolder = buildFightBody(event, "holder", pos({ noShares: 7, noSpent: 3 }));
  assert.match(noHolder, /which is the way your No wants it/);
  const yesHolder = buildFightBody(event, "holder", pos({ yesShares: 7, yesSpent: 3 }));
  assert.match(yesHolder, /which cuts against your Yes/);
  // An alliance leans UP, so the same two readers swap places.
  const allianceNo = buildAllianceFormedBody(
    { kind: "allianceFormed", subjectName: "Marcus", otherName: "Rio" },
    "holder",
    pos({ noShares: 7, noSpent: 3 }),
  );
  assert.match(allianceNo, /which cuts against your No/);
});

test("a drift too small to round to a point falls back to the likely direction", () => {
  // 0.2 points would round to "0 points", which is worse than saying nothing.
  const body = buildTensionBody(
    { kind: "tension", subjectName: "Marcus", otherName: "Rio", driftPoints: 0.2 },
    "holder",
    pos({ yesShares: 5, yesSpent: 3 }),
  );
  assert.doesNotMatch(body, POINTS_FIGURE_RE);
  assert.match(body, /bad blood tends to weigh on a price/);
});

test("a non-finite drift degrades to the likely direction instead of printing NaN", () => {
  const body = buildAmicableBody(
    { kind: "amicable", subjectName: "Marcus", otherName: "Rio", driftPoints: Number.NaN },
    "holder",
    pos({ yesShares: 5, yesSpent: 3 }),
  );
  assert.doesNotMatch(body, /NaN/);
  assert.match(body, /goodwill tends to nudge a price up/);
});

test("a social event body carries exactly one money clause, never a run-on of two", () => {
  // Both branches state the consequence of THIS event and stop. The standing
  // P&L figure still reaches the reader through surge, drop, vote, death and
  // the purge digest, none of which this section changed.
  for (const drift of [3, undefined]) {
    const body = buildAllianceFormedBody(
      { kind: "allianceFormed", subjectName: "Marcus", otherName: "Rio", driftPoints: drift },
      "holder",
      pos({ yesShares: 12, yesSpent: 5, winProbability: 0.8 }),
    );
    assert.doesNotMatch(body, /tokens/, `expected no standing P&L tail, got: ${body}`);
    // Tight enough for SMS: two segments at the very worst.
    assert.ok(body.length <= 200, `body too long for SMS at ${body.length} chars: ${body}`);
  }
});

test("the alliance body reads as a sentence, with a verb between the subjects and the outcome", () => {
  const body = buildAllianceFormedBody(
    { kind: "allianceFormed", subjectName: "Marcus", otherName: "Rio" },
    "holder",
    null,
  );
  assert.doesNotMatch(body, /^Marcus and Rio an alliance forms/);
  assert.match(body, /Marcus and Rio just came to an understanding, an alliance forms\./);
});

test("alliance broken carries a realized move and still distinguishes who did the cutting", () => {
  const wasCut = buildAllianceBrokenBody(
    { kind: "allianceBroken", subjectName: "Marcus", otherName: "Rio", betrayedSubject: true, driftPoints: -4 },
    "holder",
    pos({ yesShares: 8, yesSpent: 4 }),
  );
  const didCutting = buildAllianceBrokenBody(
    { kind: "allianceBroken", subjectName: "Marcus", otherName: "Rio", betrayedSubject: false, driftPoints: -4 },
    "holder",
    pos({ yesShares: 8, yesSpent: 4 }),
  );
  assert.notEqual(wasCut, didCutting);
  assert.match(wasCut, /Rio just cut Marcus loose/);
  assert.match(didCutting, /Marcus just cut ties with Rio/);
  for (const body of [wasCut, didCutting]) {
    assert.match(body, /your 8 Yes on Marcus is down about 4 points on that/);
  }
});

test("owner voice leads with the human beat and closes with the market consequence", () => {
  const body = buildAllianceBrokenBody(
    { kind: "allianceBroken", subjectName: "Marcus", otherName: "Rio", betrayedSubject: true, driftPoints: -4 },
    "owner",
    pos({ yesShares: 8, yesSpent: 4 }),
  );
  assert.match(body, /^Rio just cut your islander Marcus loose/);
  // The market consequence is the tail, and in owner voice it says "them"
  // rather than naming the islander a second time.
  assert.match(body, /your 8 Yes on them is down about 4 points on that\.$/);
});

test("drift-carrying bodies stay dash free in both voices", () => {
  for (const e of DRIFT_EVENTS) {
    for (const voice of ["owner", "holder"] as const) {
      const body = composeEventBody(e, voice, pos({ yesShares: 5, yesSpent: 3 }));
      assertNoDash(body, `${e.kind}/${voice}/drift`);
      // A money clause is spliced onto a sentence with a comma, so a period
      // must never immediately precede one.
      assert.doesNotMatch(body, /\.,/, `${e.kind}/${voice} has a stray period before a clause`);
    }
  }
});

test("drop is the symmetric counterpart of surge, with distinct wording", () => {
  const surge = buildSurgeBody({ kind: "surge", subjectName: "Maya", pctNow: 0.6 }, "holder", null);
  const drop = buildDropBody({ kind: "drop", subjectName: "Maya", pctNow: 0.2 }, "holder", null);
  assert.notEqual(surge, drop);
  assert.match(surge, /surging/);
  assert.match(drop, /fading/);
});
