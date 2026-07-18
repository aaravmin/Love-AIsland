import assert from "node:assert/strict";
import { test } from "node:test";
import { buyShares, cost, driftPrice, LMSR_B, priceYes, seedShares, spreadForPrice } from "./lmsr.js";

const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

test("seed price is 1/N, clamped to [2%, 98%], with a lone islander near-certain", () => {
  const s10 = seedShares(10);
  assert.ok(approx(s10.seedPrice, 0.1), `N=10 -> 0.10, got ${s10.seedPrice}`);
  assert.equal(s10.qYes, 0);
  // priceYes at the seed shares must equal the seed price.
  assert.ok(approx(priceYes(s10.qYes, s10.qNo), 0.1));
  // N=10, unclamped: qNo = b*ln(9).
  assert.ok(approx(s10.qNo, LMSR_B * Math.log(9)));

  // N=1 is the deliberate exception to the clamp: with no rivals left there is
  // no probability to spread, so a lone islander seeds at ~100% rather than the
  // 98% ceiling used whenever there is someone to lose to.
  assert.ok(approx(seedShares(1).seedPrice, 0.995), "N=1 seeds near-certain");
  assert.ok(approx(seedShares(100).seedPrice, 0.02), "N=100 clamps to 0.02");
  assert.ok(approx(priceYes(0, seedShares(1).qNo), 0.995));
});

test("buying Yes raises priceYes; buying No lowers it", () => {
  const { qYes, qNo } = seedShares(10); // start at 10%
  const up = buyShares(qYes, qNo, "yes", 10);
  assert.ok(up.priceAfter > 0.1, `yes buy should raise price, got ${up.priceAfter}`);
  const down = buyShares(qYes, qNo, "no", 10);
  assert.ok(down.priceAfter < 0.1, `no buy should lower price, got ${down.priceAfter}`);
});

test("realized cost equals spend (cost function round-trip)", () => {
  // Start at 50% so the move is symmetric.
  const qYes = 0;
  const qNo = 0;
  for (const spend of [1, 5, 10, 25]) {
    for (const side of ["yes", "no"] as const) {
      const r = buyShares(qYes, qNo, side, spend);
      const spent = cost(r.qYes, r.qNo) - cost(qYes, qNo);
      assert.ok(approx(spent, spend, 1e-4), `${side} spend ${spend}: realized ${spent}`);
      assert.ok(r.shares > 0, "shares acquired must be positive");
    }
  }
});

test("b=70: 10 tokens on Yes at 50% moves price ~6-7 points", () => {
  const r = buyShares(0, 0, "yes", 10);
  const move = r.priceAfter - 0.5;
  assert.ok(move > 0.05 && move < 0.08, `expected +5..8 pts, got ${(move * 100).toFixed(1)}`);
});

test("tails: cheap longshots swing more per token (correct + exciting)", () => {
  // At a 5% market, 10 tokens on Yes moves more than at 50%.
  const p05 = seedShares(20); // ~5%
  const tail = buyShares(p05.qYes, p05.qNo, "yes", 10);
  const mid = buyShares(0, 0, "yes", 10);
  const tailMove = tail.priceAfter - priceYes(p05.qYes, p05.qNo);
  const midMove = mid.priceAfter - 0.5;
  assert.ok(tailMove > midMove, `tail move ${tailMove} should exceed mid move ${midMove}`);
});

// --- event-driven drift (spec Task E) -------------------------------------
// The band the shipped tunables use, so the tests exercise real defaults.
const MAX_DRIFT = 0.05;
const FLOOR = 0.02;
const CEIL = 0.98;

test("spreadForPrice inverts priceYes", () => {
  for (const p of [0.02, 0.1, 0.5, 0.75, 0.98]) {
    assert.ok(approx(priceYes(spreadForPrice(p), 0), p), `round trip at ${p}`);
  }
});

test("a drift of 0 is a no-op", () => {
  const { qYes, qNo } = seedShares(10);
  const r = driftPrice(qYes, qNo, 0, MAX_DRIFT, FLOOR, CEIL);
  assert.equal(r.applied, 0);
  assert.equal(r.qYes, qYes, "shares must not move");
  assert.equal(r.qNo, qNo, "shares must not move");
  assert.ok(approx(r.priceAfter, 0.1));
});

test("a drift moves the price by exactly the requested amount", () => {
  const { qYes, qNo } = seedShares(10); // 10%
  const up = driftPrice(qYes, qNo, 0.015, MAX_DRIFT, FLOOR, CEIL);
  assert.ok(approx(up.priceAfter, 0.115), `expected 11.5%, got ${up.priceAfter}`);
  assert.ok(approx(up.applied, 0.015));

  // Negative drift is symmetric, and the spread carries the whole move while
  // the two q's shift by equal and opposite halves.
  const down = driftPrice(qYes, qNo, -0.02, MAX_DRIFT, FLOOR, CEIL);
  assert.ok(approx(down.priceAfter, 0.08), `expected 8%, got ${down.priceAfter}`);
  assert.ok(approx(down.qYes - qYes, -(down.qNo - qNo)), "shift splits evenly");
});

test("per-event move is capped at maxDriftPerEvent", () => {
  const r = driftPrice(0, 0, 0.4, MAX_DRIFT, FLOOR, CEIL); // 50% market, huge ask
  assert.ok(approx(r.priceAfter, 0.55), `cap to +5 pts, got ${r.priceAfter}`);
  assert.ok(approx(r.applied, MAX_DRIFT));
});

test("drift clamps at the floor and the ceiling", () => {
  const lowSpread = spreadForPrice(0.04);
  const low = driftPrice(lowSpread, 0, -0.05, MAX_DRIFT, FLOOR, CEIL);
  assert.ok(approx(low.priceAfter, FLOOR), `floor holds, got ${low.priceAfter}`);

  const highSpread = spreadForPrice(0.96);
  const high = driftPrice(highSpread, 0, 0.05, MAX_DRIFT, FLOOR, CEIL);
  assert.ok(approx(high.priceAfter, CEIL), `ceiling holds, got ${high.priceAfter}`);
});

test("a market already outside the band is never reversed by drift", () => {
  // seedShares(1) parks a lone islander at 99.5%, above the drift ceiling. A
  // positive event must not drag it DOWN to 98% as a side effect.
  const s = seedShares(1);
  const r = driftPrice(s.qYes, s.qNo, 0.02, MAX_DRIFT, FLOOR, CEIL);
  assert.ok(r.applied >= 0, `expected no downward reversal, got ${r.applied}`);
  assert.ok(r.priceAfter >= 0.995 - 1e-9, `price must not fall, got ${r.priceAfter}`);
});

test("drift changes the price, not any existing position", () => {
  // A spectator buys first, then the world drifts the market. The shares they
  // already hold and the tokens they already spent are fixed numbers recorded
  // at trade time; drift only rewrites the market's q values, so a later read
  // of that position is unchanged. Model that here: the buy result is captured
  // before the drift and must still describe the same holding after it.
  const { qYes, qNo } = seedShares(10);
  const bet = buyShares(qYes, qNo, "yes", 10);
  const heldShares = bet.shares;
  const spent = bet.cost;

  const drifted = driftPrice(bet.qYes, bet.qNo, -0.02, MAX_DRIFT, FLOOR, CEIL);
  assert.equal(bet.shares, heldShares, "position share count is untouched");
  assert.equal(bet.cost, spent, "tokens spent are untouched");
  assert.ok(drifted.priceAfter < bet.priceAfter, "only the live price moved");

  // And the next bet prices off the drifted market, which is the entire point:
  // the same spend on the drifted (cheaper) market buys more shares than it
  // would have on the same market had the event never fired.
  const withDrift = buyShares(drifted.qYes, drifted.qNo, "yes", 10);
  const withoutDrift = buyShares(bet.qYes, bet.qNo, "yes", 10);
  assert.ok(
    withDrift.shares > withoutDrift.shares,
    "cheaper price -> more shares for the same spend",
  );
});

test("no overflow at large q", () => {
  const c = cost(5000, 100);
  assert.ok(Number.isFinite(c), "cost must stay finite via log-sum-exp");
  assert.ok(approx(priceYes(5000, 100), 1, 1e-6), "extreme yes lead -> ~100%");
});
