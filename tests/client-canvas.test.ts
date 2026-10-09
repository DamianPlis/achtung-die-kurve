import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import * as prediction from "../src/prediction";
import type { RoomView } from "../shared/types";
import type { FrameData } from "../src/GameCanvas";

const compiled = transformSync(readFileSync("src/GameCanvas.tsx", "utf8"), {
  loader: "tsx", format: "cjs", jsx: "automatic",
}).code;

// Capture calls to the actual renderer without a browser or pixel emulation.
function harness() {
  const view: RoomView = {
    code: "ABCDE", hostDeviceId: "local", phase: "playing", round: 1,
    width: 1200, height: 800, matchTarget: 10,
    settings: { speed: "normal", targetScore: 0, gaps: true, gapSize: "large", customGapSize: 24 },
    powerRules: { everyone: null, players: {} },
    players: ["one", "two"].map((id, i) => ({
      id, deviceId: "local", name: id, color: ["#f00", "#00f"][i],
      power: "none", roundPower: "none", score: 0, charges: 0, connected: true,
    })),
  };
  const frameRef: { current: FrameData } = { current: {
    tick: 100, phase: "playing", receivedAt: 1000, reset: 1, inputAck: 0,
    trailRevision: 1, effects: { darkUntil: 0 }, heads: [], holes: [], segments: [],
  } };
  const inputRef = { current: { deviceId: "local", sequence: 0, history: [], latencyMs: 0 } };
  let frameCallback: ((now: number) => void) | undefined;
  let resizeCallback: (() => void) | undefined;
  let width = 600, animation = 0, index = 0;
  const refs: any[] = [];
  let effect: (() => void) | undefined;
  class Context {
    strokeStyle = "#000";
    globalCompositeOperation = "source-over";
    lineWidth = 1;
    strokes: { color: string; composite: string; width: number }[] = [];
    images = 0;
    circles = 0;
    setTransform() {}
    clearRect() {}
    beginPath() {}
    moveTo() {}
    lineTo() {}
    stroke() { this.strokes.push({ color: this.strokeStyle, composite: this.globalCompositeOperation, width: this.lineWidth }); }
    fillRect() {}
    drawImage() { this.images++; }
    arc() { this.circles++; }
    fill() {}
    setLineDash() {}
    fillText() {}
  }
  const arenaContext = new Context(), trailContext = new Context();
  const canvas = { width: 1200, height: 800, getContext: () => arenaContext, getBoundingClientRect: () => ({ width }) };
  const exported: any = {};
  const context = vm.createContext({
    module: { exports: exported }, exports: exported,
    require(path: string) {
      if (path === "react") return {
        useRef(value: any) { const i = index++; return refs[i] ??= { current: i === 0 ? canvas : value }; },
        useEffect(callback: () => void) { effect ??= callback; },
      };
      if (path === "react/jsx-runtime") return { jsx: (type: unknown, props: unknown) => ({ type, props }) };
      if (path === "./prediction") return prediction;
      if (path.endsWith(".css")) return { __esModule: true, default: { canvas: "canvas" } };
      throw new Error(`Unexpected import: ${path}`);
    },
    document: { createElement: () => ({ width: 300, height: 150, getContext: () => trailContext }) },
    window: { devicePixelRatio: 1 },
    ResizeObserver: class { constructor(callback: () => void) { resizeCallback = callback; } observe() {} disconnect() {} },
    requestAnimationFrame: (callback: (now: number) => void) => { frameCallback = callback; return ++animation; },
    cancelAnimationFrame() {},
  });
  new vm.Script(compiled).runInContext(context);
  function render(nextRoom = view) {
    index = 0;
    context.module.exports.default({ room: nextRoom, frameRef, inputRef, projector: false });
  }
  render();
  effect!();
  return {
    view, frameRef, arenaContext, trailContext, render,
    draw(now = 1000) { const callback = frameCallback!; frameCallback = undefined; callback(now); },
    resize(nextWidth: number) { width = nextWidth; resizeCallback!(); },
  };
}

test("resize preserves departed players' trail colors and erased-trail ordering", () => {
  const app = harness();
  app.frameRef.current.segments = [
    { id: "one", x1: 10, y1: 10, x2: 20, y2: 10, tick: 1, order: 1 },
    { id: "two", x1: 10, y1: 10, x2: 20, y2: 10, tick: 1, order: 3 },
  ];
  app.frameRef.current.holes = [{ id: "hole", x1: 10, y1: 10, x2: 20, y2: 10, width: 8, tick: 1, order: 2 }];
  app.draw();
  const first = app.trailContext.strokes.slice();
  assert.equal(first[0].color, "#f00");
  assert.equal(first[1].composite, "destination-out");
  assert.equal(first[2].color, "#00f");
  app.render({ ...app.view, players: app.view.players.slice(1) });
  app.draw(1016);
  app.resize(800);
  app.draw(1032);
  assert.deepEqual(app.trailContext.strokes.slice(-3), first);
});

test("Dark knight still records drawing while hiding it, then reveals retained trails", () => {
  const app = harness();
  app.frameRef.current.effects.darkUntil = 200;
  app.frameRef.current.segments = [{ id: "one", x1: 10, y1: 10, x2: 20, y2: 10, tick: 100, order: 1 }];
  app.draw();
  assert.equal(app.trailContext.strokes.length, 1);
  assert.equal(app.arenaContext.images, 0);
  app.frameRef.current.tick = 200;
  app.draw(1016);
  assert.equal(app.arenaContext.images, 1);
});

test("late snapshots preserve departed owners' colors without rendering absent-owner heads", () => {
  const app = harness();
  app.render({ ...app.view, players: app.view.players.slice(1) });
  app.frameRef.current.trailColors = { one: "#f00", two: "#00f" };
  app.frameRef.current.segments = [{ id: "one", x1: 10, y1: 10, x2: 20, y2: 10, tick: 1, order: 1 }];
  app.frameRef.current.heads = [{
    id: "one", ownerId: "one", x: 10, y: 10, angle: 0, alive: false, gap: false, powerActive: false,
    turn: 0, speed: 84, turnRate: 2.1, revision: 0, wrap: false, square: false, invisible: false, invulnerable: false,
  }];
  app.draw();
  assert.equal(app.trailContext.strokes[0].color, "#f00");
  assert.equal(app.arenaContext.circles, 0);
  app.resize(800);
  app.draw(1016);
  assert.equal(app.trailContext.strokes.at(-1)!.color, "#f00");
  app.frameRef.current.reset++;
  app.frameRef.current.trailRevision++;
  app.frameRef.current.trailColors = undefined;
  app.frameRef.current.heads = [];
  app.frameRef.current.segments = [{ id: "two", x1: 30, y1: 30, x2: 40, y2: 30, tick: 1, order: 1 }];
  app.draw(1032);
  const strokes = app.trailContext.strokes.length;
  app.resize(600);
  app.draw(1048);
  assert.equal(app.trailContext.strokes.length, strokes + 1);
  assert.equal(app.trailContext.strokes.at(-1)!.color, "#00f");
});
