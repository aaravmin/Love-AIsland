import assert from "node:assert/strict";
import { test } from "node:test";
import { isOperatorKey, operatorKey } from "./admin.js";

test("operator authorization only accepts the configured key", () => {
  const key = operatorKey();

  assert.equal(isOperatorKey(key), true);
  assert.equal(isOperatorKey(`${key}-wrong`), false);
  assert.equal(isOperatorKey(""), false);
  assert.equal(isOperatorKey(undefined), false);
  assert.equal(isOperatorKey({ key }), false);
});
