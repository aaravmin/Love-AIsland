import { test } from "node:test";
import assert from "node:assert/strict";
import { isNotableOutcome, outcomePresentation } from "./outcomes";

// WS-P acceptance: "No dove badge appears for a truce." truce keeps its icon
// in outcomePresentation (the panel/feed still render it), but the island's
// notable-badge gate must exclude it now that it's a demoted legacy outcome.
test("truce is presented (kept, not deleted) but is no longer a notable outcome", () => {
  assert.equal(outcomePresentation("truce").icon, "\u{1F54A}"); // dove, unchanged
  assert.equal(isNotableOutcome("truce"), false);
});

test("the four spec outcomes remain notable", () => {
  assert.equal(isNotableOutcome("alliance"), true);
  assert.equal(isNotableOutcome("fight"), true);
  assert.equal(isNotableOutcome("tension"), true);
  assert.equal(isNotableOutcome("amicable"), true);
});

test("nothing and ongoing remain non-notable", () => {
  assert.equal(isNotableOutcome("nothing"), false);
  assert.equal(isNotableOutcome("ongoing"), false);
  assert.equal(isNotableOutcome(null), false);
  assert.equal(isNotableOutcome(undefined), false);
});
