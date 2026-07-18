import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOutcome,
  applyWitnessedKill,
  describeRelationship,
  emptyRelationship,
  weightedOutcomeCount,
} from "./relationships.js";
import { tunables } from "./tunables.js";

const HALF_LIFE = tunables.relationships.halfLifeMs;

test("weightedOutcomeCount halves a fight's contribution after one half life", () => {
  const t0 = 1_000_000;
  const r = emptyRelationship("a", "b", t0);
  applyOutcome(r, "fight", t0);

  const fresh = weightedOutcomeCount(r, "fight", t0);
  assert.ok(Math.abs(fresh - 1) < 1e-9, `expected ~1, got ${fresh}`);

  const afterOneHalfLife = weightedOutcomeCount(r, "fight", t0 + HALF_LIFE);
  assert.ok(
    Math.abs(afterOneHalfLife - 0.5) < 1e-6,
    `expected ~0.5 after one half life, got ${afterOneHalfLife}`,
  );

  const afterTwoHalfLives = weightedOutcomeCount(r, "fight", t0 + HALF_LIFE * 2);
  assert.ok(
    Math.abs(afterTwoHalfLives - 0.25) < 1e-6,
    `expected ~0.25 after two half lives, got ${afterTwoHalfLives}`,
  );
});

test("weightedOutcomeCount does not erase old history, only fades its weight", () => {
  const t0 = 1_000_000;
  const r = emptyRelationship("a", "b", t0);
  applyOutcome(r, "fight", t0);
  // Long after the half life, the event is still IN history (never pruned)
  // but its weighted contribution should be small.
  const farFuture = t0 + HALF_LIFE * 10;
  assert.equal(r.history.length, 1, "history must not be pruned by decay");
  const weight = weightedOutcomeCount(r, "fight", farFuture);
  assert.ok(weight > 0 && weight < 0.01, `expected a small residual weight, got ${weight}`);
});

test("describeRelationship's narrated intensity tracks the numeric trust instead of diverging from it", () => {
  const t0 = 1_000_000;
  const r = emptyRelationship("a", "b", t0);
  applyOutcome(r, "fight", t0, "argued about the vote");

  // Immediately after: both the raw numeric trust AND the narration should
  // read as "you fought once".
  const freshLine = describeRelationship(r, "Dana", t0);
  assert.ok(freshLine?.includes("you fought once"), freshLine ?? "null");

  // Long after decay: numeric trust has faded back toward neutral. Before the
  // WS-B fix, describeRelationship counted history RAW, so it would still
  // say "you fought once" even though the numbers no longer show a grudge.
  // Now the weighted count is small enough that the fight clause drops out,
  // so the narration and the (decayed-to-neutral) numbers agree.
  const farFuture = t0 + HALF_LIFE * 10;
  const staleLine = describeRelationship(r, "Dana", farFuture);
  assert.ok(
    !staleLine || !staleLine.includes("fought"),
    `expected the fight clause to have faded out, got ${staleLine}`,
  );
});

test("applyWitnessedKill pushes a narratable history entry", () => {
  const t0 = 1_000_000;
  const r = emptyRelationship("a", "b", t0);
  assert.equal(describeRelationship(r, "Dana", t0), null, "no history yet");

  applyWitnessedKill(r, t0);
  assert.equal(r.history.length, 1);
  assert.equal(r.history[0]?.outcome, "witnessedKill");

  const line = describeRelationship(r, "Dana", t0);
  assert.ok(line?.includes("you saw them kill someone"), line ?? "null");
});
