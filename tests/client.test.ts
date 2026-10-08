import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_KEYS, keyLabel, newId, steering } from "../src/controls";

test("six keyboard players have unique controls and opposite inputs cancel", () => {
  assert.equal(new Set(DEFAULT_KEYS.flat()).size, 18);
  assert.equal(steering(true, false), -1);
  assert.equal(steering(false, true), 1);
  assert.equal(steering(true, true), 0);
  assert.equal(steering(false, false), 0);
  assert.equal(keyLabel("ArrowDown"), "↓");
  assert.equal(keyLabel("KeyQ"), "Q");
  assert.match(newId(), /^[a-f0-9]{32}$/);
  assert.notEqual(newId(), newId());
});
