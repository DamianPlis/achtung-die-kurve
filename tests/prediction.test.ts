import { test } from "node:test";
import assert from "node:assert/strict";
import type { Head } from "../shared/types";
import { advancePose } from "../shared/movement";
import {
  appendDrawEvents,
  MAX_EXTRAPOLATION_MS,
  displayPose,
  predictHead,
  reconcile,
  type PredictionInputState,
  type VisualPose,
} from "../src/prediction";

const head = (changes: Partial<Head> = {}): Head => ({
  id: "player",
  ownerId: "player",
  x: 100,
  y: 100,
  angle: 0,
  alive: true,
  gap: false,
  powerActive: false,
  turn: 0,
  speed: 84,
  turnRate: 2.1,
  revision: 0,
  wrap: false,
  square: false,
  invisible: false,
  invulnerable: false,
  ...changes,
});
const state = (
  changes: Partial<PredictionInputState> = {},
): PredictionInputState => ({
  deviceId: "local",
  sequence: 0,
  history: [],
  latencyMs: 0,
  ...changes,
});

test("local steering replays immediately while unacknowledged and only on its owner", () => {
  const input = state({
    sequence: 1,
    history: [{ seq: 1, at: 1010, inputs: [{ id: "player", turn: 1 }] }],
  });
  const local = predictHead(
    head(),
    input,
    0,
    1000,
    1030,
    1200,
    800,
    true,
    true,
  );
  const remote = predictHead(
    head(),
    input,
    0,
    1000,
    1030,
    1200,
    800,
    true,
    false,
  );
  const acknowledged = predictHead(
    head(),
    input,
    1,
    1000,
    1030,
    1200,
    800,
    true,
    true,
  );
  assert.ok(local.angle > 0);
  assert.ok(local.y > 100);
  assert.equal(remote.angle, 0);
  assert.equal(acknowledged.angle, 0);
  const hydra = predictHead(
    head({ id: "hydra:player:1" }),
    input,
    0,
    1000,
    1030,
    1200,
    800,
    true,
    true,
  );
  assert.deepEqual(hydra, local);
});

test("replay preserves press and release times instead of extending the latest turn over the frame", () => {
  const input = state({
    sequence: 2,
    history: [
      { seq: 1, at: 1010, inputs: [{ id: "player", turn: 1 }] },
      { seq: 2, at: 1030, inputs: [{ id: "player", turn: 0 }] },
    ],
  });
  const predicted = predictHead(
    head(),
    input,
    0,
    1000,
    1060,
    1200,
    800,
    true,
    true,
  );
  assert.ok(Math.abs(predicted.angle - 2.1 * 0.02) < 0.00001);
  assert.ok(predicted.x > 105 && predicted.y > 100);
});

test("prediction uses the same 60 Hz movement step as the server", () => {
  const source = head({ turn: -1, speed: 168, turnRate: 4.2 });
  const expected = { x: source.x, y: source.y, angle: source.angle };
  for (let i = 0; i < 6; i++)
    advancePose(expected, -1, source.speed, source.turnRate, 1 / 60);
  const predicted = predictHead(
    source,
    state(),
    0,
    1000,
    1100,
    1200,
    800,
    true,
    false,
  );
  assert.ok(Math.abs(predicted.x - expected.x) < 0.00001);
  assert.ok(Math.abs(predicted.y - expected.y) < 0.00001);
  assert.ok(Math.abs(predicted.angle - expected.angle) < 0.00001);
});

test("missing updates stop motion after 150 ms; pause and death never extrapolate", () => {
  const stale = predictHead(
    head(),
    state({ latencyMs: 30 }),
    0,
    1000,
    5000,
    1200,
    800,
    true,
    false,
  );
  assert.ok(
    Math.abs(stale.x - (100 + (84 * MAX_EXTRAPOLATION_MS) / 1000)) < 0.00001,
  );
  assert.deepEqual(
    predictHead(head(), state(), 0, 1000, 1200, 1200, 800, false, true),
    { x: 100, y: 100, angle: 0 },
  );
  assert.deepEqual(
    predictHead(
      head({ alive: false }),
      state(),
      0,
      1000,
      1200,
      1200,
      800,
      true,
      true,
    ),
    { x: 100, y: 100, angle: 0 },
  );
});

test("square turn prediction applies one right-angle edge and wraps without crossing the map", () => {
  const input = state({
    history: [
      { seq: 1, at: 1000, inputs: [{ id: "player", turn: 1 }] },
      { seq: 2, at: 1020, inputs: [{ id: "player", turn: 1 }] },
    ],
  });
  const square = predictHead(
    head({ square: true }),
    input,
    0,
    1000,
    1050,
    1200,
    800,
    true,
    true,
  );
  assert.ok(Math.abs(square.angle - Math.PI / 2) < 0.00001);
  assert.ok(Math.abs(square.x - 100) < 0.00001);
  const wrapped = predictHead(
    head({ x: 1198, wrap: true }),
    state(),
    0,
    1000,
    1050,
    1200,
    800,
    true,
    false,
  );
  assert.ok(Math.abs(wrapped.x - 6.2) < 0.00001);
  const invisible = predictHead(
    head({ x: 1198, invisible: true, invulnerable: true }),
    state(),
    0,
    1000,
    1050,
    1200,
    800,
    true,
    false,
  );
  assert.ok(invisible.x > 1200);
  const immune = predictHead(
    head({ x: 1198, invulnerable: true }),
    state(),
    0,
    1000,
    1050,
    1200,
    800,
    true,
    false,
  );
  assert.equal(immune.x, 1198);
});

test("small corrections smooth briefly, while powers, death and large corrections snap", () => {
  const visual: VisualPose = {
    x: 101,
    y: 100,
    angle: 0,
    offsetX: 0,
    offsetY: 0,
    correctionAt: 0,
    revision: 0,
    alive: true,
  };
  const target = { x: 100, y: 100, angle: 0 };
  reconcile(visual, target, head(), 1000, true);
  displayPose(visual, target, 1000);
  assert.equal(visual.x, 101);
  displayPose(visual, target, 1065);
  assert.equal(visual.x, 100);
  visual.x = 110;
  reconcile(visual, target, head({ revision: 1 }), 1100, true);
  displayPose(visual, target, 1100);
  assert.equal(visual.x, 100);
  visual.x = 1000;
  reconcile(visual, target, head({ revision: 1 }), 1200, true);
  displayPose(visual, target, 1200);
  assert.equal(visual.x, 100);
  visual.x = 105;
  reconcile(visual, target, head({ revision: 1, alive: false }), 1300, true);
  displayPose(visual, target, 1300);
  assert.equal(visual.x, 100);
});

for (const latencyMs of [15, 30]) {
  test(
    "20 Hz updates render steady motion with synthetic " +
      latencyMs +
      " ms RTT and packet jitter",
    () => {
      const input = state({ latencyMs });
      const jitter = [0, 4, -3, 2, -2, 0];
      const frames = Array.from({ length: 25 }, (_, i) => ({
        head: head({ x: 100 + (i * 50 * 84) / 1000 }),
        receivedAt: 1000 + i * 50 + latencyMs / 2 + jitter[i % jitter.length],
      }));
      let index = 0;
      let source = frames[0];
      const first = predictHead(
        source.head,
        input,
        0,
        source.receivedAt,
        1050,
        1200,
        800,
        true,
        false,
      );
      const visual: VisualPose = {
        ...first,
        offsetX: 0,
        offsetY: 0,
        correctionAt: 1050,
        revision: 0,
        alive: true,
      };
      let previousX: number | undefined;
      let worstStepError = 0;
      for (let i = 0; i < 60; i++) {
        const now = 1050 + (i * 1000) / 60;
        while (
          index + 1 < frames.length &&
          frames[index + 1].receivedAt <= now
        ) {
          const next = frames[++index];
          const oldPose = predictHead(
            source.head,
            input,
            0,
            source.receivedAt,
            now,
            1200,
            800,
            true,
            false,
          );
          displayPose(visual, oldPose, now);
          const target = predictHead(
            next.head,
            input,
            0,
            next.receivedAt,
            now,
            1200,
            800,
            true,
            false,
          );
          reconcile(visual, target, next.head, now, true);
          source = next;
        }
        const target = predictHead(
          source.head,
          input,
          0,
          source.receivedAt,
          now,
          1200,
          800,
          true,
          false,
        );
        displayPose(visual, target, now);
        if (previousX !== undefined) {
          const step = visual.x - previousX;
          worstStepError = Math.max(worstStepError, Math.abs(step - 84 / 60));
          assert.ok(step > 0.7 && step < 2.1);
        }
        previousX = visual.x;
      }
      assert.ok(
        worstStepError < 0.2,
        "maximum per-paint error was " + worstStepError,
      );
    },
  );
}

test("snapshot and repeated pending frames preserve erased trails and accept later drawing", () => {
  type Event = { order: number; kind: "trail" | "hole" };
  const history: Event[] = [];
  let filled = false;
  const paint = (event: Event) => {
    filled = event.kind === "trail";
  };
  const oldTrail: Event = { order: 1, kind: "trail" };
  const hole: Event = { order: 2, kind: "hole" };
  let lastOrder = appendDrawEvents(history, [hole, oldTrail], 0, paint);
  assert.equal(filled, false, "the snapshot must cut the old trail");
  lastOrder = appendDrawEvents(history, [oldTrail, hole], lastOrder, paint);
  assert.equal(
    filled,
    false,
    "a repeated pending trail must not fill the cut again",
  );
  lastOrder = appendDrawEvents(
    history,
    [oldTrail, { order: 3, kind: "trail" }],
    lastOrder,
    paint,
  );
  assert.equal(filled, true, "new drawing after the cut must remain visible");
  lastOrder = appendDrawEvents(history, [hole], lastOrder, paint);
  assert.equal(filled, true, "a repeated hole must not erase newer drawing");
  assert.deepEqual(
    history.map((event) => event.order),
    [1, 2, 3],
  );
  const nextRound: Event[] = [];
  lastOrder = appendDrawEvents(nextRound, [oldTrail], 0, paint);
  assert.equal(lastOrder, 1, "new rounds restart draw ordering");
  assert.equal(nextRound.length, 1);
});
