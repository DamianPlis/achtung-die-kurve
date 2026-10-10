import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_KEYS, keyLabel, newId, normalizeControlKey, steering } from "../src/controls";

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

test("Y and Z share a control and label on QWERTY and QWERTZ keyboards", () => {
  assert.equal(normalizeControlKey("KeyY"), "KeyY");
  assert.equal(normalizeControlKey("KeyZ"), "KeyY");
  assert.equal(normalizeControlKey("KeyX"), "KeyX");
  assert.equal(keyLabel("KeyY"), "Y/Z");
  assert.equal(keyLabel("KeyZ"), "Y/Z");
});
