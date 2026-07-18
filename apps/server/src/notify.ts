import { tunables, winProbabilities } from "@arena/shared";
import type { Spectator } from "@arena/shared";
import {
  buildPayoutBody,
  buildPurgeDigestBody,
  composeEventBody,
  type NotifyCategory,
  type NotifyEvent,
  type PayoutInfo,
  type PurgeDigestEntry,
  type Voice,
} from "./notifyContent.js";
import { priceYes, spectatorByClientId, state } from "./state.js";

// ---------------------------------------------------------------------------
// SMS delivery engine (Twilio-ready, zero new dependencies).
//
// This module owns WHO gets texted and WHEN (opt-in, phone resolution, rate
// limiting, priority preemption, batching). What the text SAYS lives in
// notifyContent.ts, which this module calls into but never duplicates -- see
// that file's header for why the split is drawn there.
//
// Sends are fire-and-forget and degrade to a console log when Twilio
// credentials are absent, so the whole flow is testable locally without an
// account (RESOLVED DECISION 3: SMS acceptance is proven via [sms:noop]).
// ---------------------------------------------------------------------------

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_FROM;

// Legacy global window (spectator.lastNotifiedAt), still honored by the
// legacy call shape of notifyHolders below (no category passed) so the two
// call sites that predate the category system (combat.ts, market.ts) see
// byte-identical rate limiting to before this file changed. New callers all
// go through the category system instead.
const NOTIFY_COOLDOWN_MS = tunables.notify.cooldownMs;

// Fire-and-forget SMS via Twilio's REST API. Never throws; on any failure (or
// missing credentials) it logs and returns. Callers must not await this.
export function sendSms(to: string, body: string): void {
  if (!SID || !TOKEN || !FROM) {
    // No credentials configured -> log the intended message instead of sending.
    console.log(`[sms:noop] -> ${to}: ${body}`);
    return;
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`;
  const form = new URLSearchParams({ From: FROM, To: to, Body: body });
  const auth = Buffer.from(`${SID}:${TOKEN}`).toString("base64");
  fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  })
    .then((res) => {
      if (!res.ok) console.error(`[sms] Twilio ${res.status} sending to ${to}`);
    })
    .catch((err) => {
      console.error(`[sms] failed sending to ${to}:`, err);
    });
}

// The position a holder has on the contestant an alert is about; the message
// builder reads it to tailor the wording (e.g. No-payout vs Yes-loss on death).
//
// WIDENED beside the original two fields (golden rule: extend, never rename).
// yesSpent/noSpent are the cost basis already tracked one line away in
// state.positions (types.ts Position) but never threaded through to a message
// builder before, so a builder had no way to compute unrealized P&L. rawPriceYes
// and winProbability are the two numbers a builder needs to value a live
// (unsettled) position: winProbability is the number every UI surface actually
// shows (see livingWinProbabilities below), rawPriceYes is the underlying LMSR
// price. market.ts and combat.ts never construct a HolderPosition themselves
// (notifyHolders below does, once per holder) -- they only READ
// pos.yesShares/pos.noShares from the object notifyHolders hands them, so
// widening the shape with extra fields those two files never touch keeps them
// compiling unmodified.
export type HolderPosition = {
  yesShares: number;
  noShares: number;
  yesSpent: number;
  noSpent: number;
  rawPriceYes: number;
  winProbability: number;
};

// The normalized "chance to win the whole game" for every living, unsettled
// market: each market's raw priceYes divided by the sum across all others in
// the same state, so displayed odds are coherent and sum to ~100%. This is a
// server-side mirror of the same filter every UI surface applies by convention
// (markets-list.tsx, IslandScene.ts, contestant-panel.tsx each independently
// filter to !settled && contestant.alive before calling shared's
// winProbabilities), so an SMS quoting "43%" can never disagree with what the
// screen shows. Recomputed on demand rather than cached: notifications are not
// a hot path, and a cache would need its own invalidation on every trade/drift.
export function livingWinProbabilities(): Map<string, number> {
  const entries = Object.values(state.markets)
    .filter((m) => !m.settled && state.contestants[m.contestantId]?.alive)
    .map((m) => ({ id: m.contestantId, priceYes: priceYes(m) }));
  return winProbabilities(entries);
}

export function winProbabilityFor(contestantId: string): number | null {
  return livingWinProbabilities().get(contestantId) ?? null;
}

// Build the full HolderPosition for one spectator's stake in one contestant, or
// null if they hold nothing. winProbability falls back to rawPriceYes (which
// itself falls back to 0 for an unknown market) when the market is settled or
// the contestant has died -- livingWinProbabilities excludes both, and a
// dead/settled market has no "chance to win" left to normalize.
function holderPositionFor(spectatorId: string, contestantId: string): HolderPosition | null {
  const pos = state.positions.find(
    (p) => p.spectatorId === spectatorId && p.contestantId === contestantId,
  );
  if (!pos || (pos.yesShares <= 0 && pos.noShares <= 0)) return null;
  const m = state.markets[contestantId];
  const rawPriceYes = m ? priceYes(m) : 0;
  const winProbability = winProbabilityFor(contestantId) ?? rawPriceYes;
  return {
    yesShares: pos.yesShares,
    noShares: pos.noShares,
    yesSpent: pos.yesSpent,
    noSpent: pos.noSpent,
    rawPriceYes,
    winProbability,
  };
}

// ---------------------------------------------------------------------------
// Prioritized per-category cooldown buckets.
//
// Before this, one 60s window per spectator (spectator.lastNotifiedAt) was
// shared across every alert type with no priority: first writer wins. A
// low-value surge alert at t=0 silently swallowed a death or a purge at t=5s.
//
// The fix keeps a single "slot" per recipient (identified by phone -- the
// actual send target, which is not always the same as a spectator id; see
// notifyOwner) but the slot now remembers WHICH category opened it. A new
// send is admitted when either the incumbent category's own cooldown has
// elapsed, or the new category outranks the incumbent -- that second clause
// is the preemption rule: a death or a purge can always cut through a stale
// surge window, but two same-priority alerts still queue behind one another
// like a normal cooldown would.
// ---------------------------------------------------------------------------

// Ordered most urgent first. Irreversible, money-real events (a payout, a
// death, a purge) rank above ambient market noise (a surge, a drop) and social
// color (tension, amicable) -- mirrors the ordering already documented next to
// tunables.notify.perCategoryCooldownMs.
const CATEGORY_PRIORITY: readonly NotifyCategory[] = [
  "payout",
  "death",
  "purge",
  "fight",
  "allianceBroken",
  "voteResult",
  "ousterSupport",
  "allianceFormed",
  "drop",
  "surge",
  "tension",
  "amicable",
];

// An unrecognized category (forward compatibility) ranks last rather than
// throwing, so a future category added to the enum but not yet to this list
// still degrades to "never preempts, always waits its turn" instead of a crash.
function priorityRank(category: NotifyCategory): number {
  const i = CATEGORY_PRIORITY.indexOf(category);
  return i === -1 ? CATEGORY_PRIORITY.length : i;
}

function categoryCooldownMs(category: NotifyCategory): number {
  return tunables.notify.perCategoryCooldownMs[category] ?? tunables.notify.defaultCategoryCooldownMs;
}

// Per-room bookkeeping (Phase 9 pattern, matching MarketState/CombatState):
// one active "slot" per recipient phone number, remembering which category
// last claimed it and when. `cur` is pointed at the active room by useNotify().
export type NotifyState = {
  slots: Map<string, { category: NotifyCategory; sentAt: number }>;
};
export function createNotifyState(): NotifyState {
  return { slots: new Map() };
}
let cur: NotifyState = createNotifyState();
export function useNotify(s: NotifyState): void {
  cur = s;
}
export function resetNotify(): void {
  cur.slots.clear();
}

function canSend(phone: string, category: NotifyCategory, now: number): boolean {
  const slot = cur.slots.get(phone);
  if (!slot) return true;
  if (now - slot.sentAt >= categoryCooldownMs(slot.category)) return true;
  // Window still open. Only a STRICTLY higher priority category preempts it;
  // an equal-or-lower priority category (including a repeat of the same
  // category) waits, which is what keeps this a cooldown and not a free-for-all.
  return priorityRank(category) < priorityRank(slot.category);
}

function recordSend(phone: string, category: NotifyCategory, now: number, spec?: Spectator): void {
  cur.slots.set(phone, { category, sentAt: now });
  // Legacy field, kept written for backward compatibility: any code still
  // reading spectator.lastNotifiedAt directly (or a future call site using the
  // legacy notifyHolders path) sees a timestamp that reflects the latest send.
  if (spec) spec.lastNotifiedAt = now;
}

// Text every opted-in spectator in the active room who holds a position on
// `contestantId`. `build` turns a holder's position into the message body, or
// returns null to skip that holder.
//
// TWO CALL SHAPES, on purpose. Called with 3 args (no category), this is
// byte-identical to the pre-spec function: one shared 60s window per
// spectator via spectator.lastNotifiedAt. That is the shape combat.ts:230 and
// market.ts:101 already call, and per this workstream's contract those two
// files are read-only from here, so their behavior must not shift out from
// under them. Called with a 4th `category` argument, sends route through the
// prioritized per-category bucket system instead. New callers (and WS-H, when
// it revisits combat.ts/market.ts) should prefer the 4-arg form.
export function notifyHolders(
  contestantId: string,
  now: number,
  build: (pos: HolderPosition) => string | null,
  category?: NotifyCategory,
): void {
  for (const spec of Object.values(state.spectators)) {
    if (!spec.notify || !spec.phone) continue;
    if (category) {
      if (!canSend(spec.phone, category, now)) continue;
    } else if (spec.lastNotifiedAt !== undefined && now - spec.lastNotifiedAt < NOTIFY_COOLDOWN_MS) {
      continue;
    }
    const pos = state.positions.find(
      (p) => p.spectatorId === spec.id && p.contestantId === contestantId,
    );
    if (!pos || (pos.yesShares <= 0 && pos.noShares <= 0)) continue;
    const holderPos =
      holderPositionFor(spec.id, contestantId) ??
      ({
        yesShares: pos.yesShares,
        noShares: pos.noShares,
        yesSpent: pos.yesSpent,
        noSpent: pos.noSpent,
        rawPriceYes: 0,
        winProbability: 0,
      } satisfies HolderPosition);
    const body = build(holderPos);
    if (!body) continue;
    if (category) recordSend(spec.phone, category, now, spec);
    else spec.lastNotifiedAt = now;
    sendSms(spec.phone, body);
  }
}

// The "my agent" case, which did not exist at all before. notifyHolders
// selects purely on state.positions, so a user who CREATED an islander but
// never bet on it was invisible to every alert. This resolves ownership
// instead: contestant -> ownerClientId -> the owning spectator's opt-in, then
// sends to contestant.ownerPhone (the prize contact, which may differ from the
// spectator's own phone). Guards ownerPhone === "" for house-seeded and
// harness islanders (devSeed.ts, harness.ts both pass ownerPhone: ""), and
// silently no-ops when the owner has no matching spectator (a room reset that
// orphaned the clientId) or has not opted in -- never throws.
export function notifyOwner(
  contestantId: string,
  now: number,
  build: (contestant: { name: string }) => string | null,
  category: NotifyCategory,
): void {
  const c = state.contestants[contestantId];
  if (!c || !c.ownerPhone) return;
  const ownerSpec = spectatorByClientId(c.ownerClientId);
  if (!ownerSpec || !ownerSpec.notify) return;
  if (!canSend(c.ownerPhone, category, now)) return;
  const body = build({ name: c.name });
  if (!body) return;
  recordSend(c.ownerPhone, category, now, ownerSpec);
  sendSms(c.ownerPhone, body);
}

// The one fan-out every caller should use going forward (WS-E, WS-F, WS-H):
// resolves the owner and every holder of `contestantId`, dedupes a recipient
// who is both (by phone -- the actual send target) so they get exactly one
// text in the richer owner voice, composes the body via notifyContent's
// composeEventBody, and applies the priority bucket for `event.kind`.
export function notifyAboutContestant(contestantId: string, now: number, event: NotifyEvent): void {
  const c = state.contestants[contestantId];
  if (!c) return;
  const category = event.kind;

  const recipients = new Map<string, Voice>();
  if (c.ownerPhone) {
    const ownerSpec = spectatorByClientId(c.ownerClientId);
    if (ownerSpec && ownerSpec.notify) recipients.set(c.ownerPhone, "owner");
  }
  for (const spec of Object.values(state.spectators)) {
    if (!spec.notify || !spec.phone || recipients.has(spec.phone)) continue;
    const pos = state.positions.find(
      (p) => p.spectatorId === spec.id && p.contestantId === contestantId,
    );
    if (!pos || (pos.yesShares <= 0 && pos.noShares <= 0)) continue;
    recipients.set(spec.phone, "holder");
  }

  for (const [phone, voice] of recipients) {
    if (!canSend(phone, category, now)) continue;
    const spec = Object.values(state.spectators).find((s) => s.phone === phone);
    const pos = spec ? holderPositionFor(spec.id, contestantId) : null;
    const body = composeEventBody(event, voice, pos);
    if (!body) continue;
    recordSend(phone, category, now, spec);
    sendSms(phone, body);
  }
}

// ---------------------------------------------------------------------------
// The end-of-game payout alert. lifecycle.ts already computes per-spectator
// spent/net and the winner + owner name when it builds GameResultsPayload;
// there was no SMS at all on game end before this, which is the moment a
// user most wants a text. WS-H wires the call once it touches lifecycle.ts.
// ---------------------------------------------------------------------------
export function notifyPayout(
  phone: string,
  now: number,
  info: PayoutInfo,
  spec?: Spectator,
): void {
  if (!phone) return;
  if (!canSend(phone, "payout", now)) return;
  const body = buildPayoutBody(info);
  recordSend(phone, "payout", now, spec);
  sendSms(phone, body);
}

// ---------------------------------------------------------------------------
// Batching for mass events (the Purge). Between openDigest and closeDigest,
// per-recipient positions are read fresh at close time rather than sent one
// alert per victim, so a spectator holding three positions gets ONE coherent
// text naming all three ("Your position on Maya is gone, you are down 12
// tokens; Rio is up 4 points.") instead of whichever single alert happened to
// win the old shared cooldown window.
//
// This intentionally does not hook into notifyAboutContestant's per-event call
// path. A purge fires many deaths in one tick; re-scanning every spectator's
// full position list once at close time is simpler and strictly more correct
// than accumulating individual death events, because it also picks up
// survivors whose price moved from the purge (renormalization) without a
// second bookkeeping structure for "who to also mention".
// ---------------------------------------------------------------------------

let digestOpenedAt: number | null = null;

export function openDigest(now: number): void {
  digestOpenedAt = now;
}

export function closeDigest(now: number): void {
  if (digestOpenedAt === null) return;
  digestOpenedAt = null;

  for (const spec of Object.values(state.spectators)) {
    if (!spec.notify || !spec.phone) continue;

    const entries: PurgeDigestEntry[] = [];
    const owned = Object.values(state.contestants).find((c) => c.ownerClientId === spec.clientId);
    if (owned) {
      entries.push({
        subjectName: owned.name,
        voice: "owner",
        survived: owned.alive,
        pos: holderPositionFor(spec.id, owned.id),
      });
    }
    for (const pos of state.positions) {
      if (pos.spectatorId !== spec.id) continue;
      if (pos.yesShares <= 0 && pos.noShares <= 0) continue;
      if (owned && pos.contestantId === owned.id) continue; // already added above
      const c = state.contestants[pos.contestantId];
      if (!c) continue;
      entries.push({
        subjectName: c.name,
        voice: "holder",
        survived: c.alive,
        pos: holderPositionFor(spec.id, c.id),
      });
    }
    if (entries.length === 0) continue;
    if (!canSend(spec.phone, "purge", now)) continue;
    const body = buildPurgeDigestBody(entries);
    recordSend(spec.phone, "purge", now, spec);
    sendSms(spec.phone, body);
  }
}
