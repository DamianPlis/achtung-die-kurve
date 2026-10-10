import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import * as controls from "../src/controls";
import { PLAYER_PALETTE } from "../shared/player-palette";
import type { RoomView, ServerMessage } from "../shared/types";
import { MAP_SIZES, POWERS } from "../shared/types";

// Execute the actual App component and its callbacks with deterministic browser hooks.
const source = readFileSync("src/App.tsx", "utf8");
const compile = (serverOrigin?: string) => transformSync(source, {
  loader: "tsx", format: "cjs", jsx: "automatic",
  define: { "import.meta.env.VITE_GAME_SERVER_URL": serverOrigin ? JSON.stringify(serverOrigin) : "undefined" },
}).code;
const compiled = compile();
type Element = { type: unknown; props: Record<string, any> };
const jsx = (type: unknown, props: Record<string, any>): Element => ({ type, props });

function room(phase: RoomView["phase"] = "playing"): RoomView {
  return {
    code: "ABCDE", hostDeviceId: "local", powerRules: { everyone: null, players: {} },
    settings: { mapSize: "classic", speed: "normal", targetScore: 0, gaps: true, gapSize: "large", customGapSize: 24 },
    phase, round: 1, matchTarget: 10, width: 1200, height: 800,
    players: ["one", "two"].map((id, i) => ({
      id, deviceId: "local", name: id, color: PLAYER_PALETTE[i].color,
      power: "boost", score: 0, connected: true, charges: 3,
    })),
  };
}

function harness(initialRoom: RoomView | null = room(), savedSlots?: any[], serverOrigin?: string) {
  const states: any[] = [], refs: any[] = [], effects: any[] = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0;
  const listeners = new Map<string, (event?: any) => void>();
  const intervals: { callback: () => void; delay: number }[] = [];
  const timeouts: (() => void)[] = [];
  const storage = new Map<string, string>([
    ["kurve-device", "local"], ["kurve-session-token", "s".repeat(32)],
  ]);
  const slots = savedSlots ?? PLAYER_PALETTE.slice(0, 6).map((p, i) => ({
    id: ["one", "two"][i] ?? `player${i}`, name: p.name,
    enabled: i < 2, power: "boost", keys: controls.DEFAULT_KEYS[i],
  }));
  storage.set("kurve-players", JSON.stringify(slots));
  storage.set("kurve-room", "ABCDE");
  const sockets: MockSocket[] = [];
  class MockSocket {
    static OPEN = 1;
    readyState = 1;
    sent: any[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event?: any) => void;
    constructor(public url: string) { sockets.push(this); }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
  }
  class Input {}
  class Select {}
  const react = {
    useState(init: any) {
      const i = stateIndex++;
      if (!(i in states)) states[i] = i === 3 ? initialRoom : typeof init === "function" ? init() : init;
      return [states[i], (next: any) => { states[i] = typeof next === "function" ? next(states[i]) : next; }];
    },
    useRef(value: any) { const i = refIndex++; return refs[i] ??= { current: value }; },
    useEffect(callback: () => any, deps: any[]) {
      const i = effectIndex++, old = effects[i];
      if (!old || deps.some((v, j) => v !== old.deps[j])) effects[i] = { callback, deps, pending: true, cleanup: old?.cleanup };
    },
  };
  const exported: any = {};
  const context = vm.createContext({
    module: { exports: exported }, exports: exported,
    require(path: string) {
      if (path === "react") return react;
      if (path === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (path === "./controls") return controls;
      if (path === "../shared/types") return { MAP_SIZES, POWERS };
      if (path === "../shared/player-palette") return { PLAYER_PALETTE };
      if (path.endsWith(".css")) return { __esModule: true, default: new Proxy({}, { get: (_obj, key) => key }) };
      if (path === "./GameCanvas") return { __esModule: true, default: "GameCanvas" };
      if (path.startsWith("@/components/ui/")) return new Proxy({}, { get: (_obj, key) => key });
      throw new Error(`Unexpected import: ${path}`);
    },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    location: { search: "", protocol: "http:", host: "localhost:3000", origin: "http://localhost:3000", pathname: "/", assign() {} },
    crypto: globalThis.crypto, WebSocket: MockSocket, HTMLInputElement: Input, HTMLSelectElement: Select,
    URL, URLSearchParams, performance: { now: () => 1000 },
    window: { addEventListener: (name: string, callback: any) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name) },
    document: { hidden: false, addEventListener: (name: string, callback: any) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name) },
    setInterval: (callback: () => void, delay: number) => intervals.push({ callback, delay }), clearInterval() {},
    setTimeout: (callback: () => void) => timeouts.push(callback), clearTimeout() {},
  });
  new vm.Script(serverOrigin ? compile(serverOrigin) : compiled).runInContext(context);
  function render() {
    stateIndex = refIndex = effectIndex = 0;
    const tree = context.module.exports.default();
    for (const effect of effects) if (effect.pending) {
      effect.cleanup?.(); effect.cleanup = effect.callback(); effect.pending = false;
    }
    return tree as Element;
  }
  let tree = render();
  sockets[0].onopen?.();
  if (initialRoom) sockets[0].onmessage?.({ data: JSON.stringify({ type: "room", room: initialRoom, deviceId: "local" }) });
  tree = render();
  return {
    tree, states, storage, intervals, timeouts, listeners, sockets, render,
    message(message: ServerMessage) { sockets.at(-1)!.onmessage?.({ data: JSON.stringify(message) }); },
    key(code: string, down = true, target: any = {}) { listeners.get(down ? "keydown" : "keyup")?.({ code, target, repeat: false, preventDefault() {} }); },
  };
}
function elements(root: any): Element[] {
  if (Array.isArray(root)) return root.flatMap(elements);
  if (!root || typeof root !== "object" || !root.props) return [];
  if (typeof root.type === "function") return elements(root.type(root.props));
  return [root, ...elements(root.props.children)];
}

function text(root: any): string {
  if (Array.isArray(root)) return root.map(text).join("");
  if (root && typeof root === "object") return text(root.props?.children);
  return String(root ?? "");
}

test("map size defaults to recommended and is included when creating a room", () => {
  const app = harness(null);
  const select = elements(app.tree).find(e => e.props.id === "map-size")!;
  assert.equal(select.props.value, "recommended");
  assert.deepEqual(elements(select).filter(e => e.type === "NativeSelectOption").map(e => e.props.value), ["classic", "recommended", "large"]);
  assert.match(text(select), /Recommended.*1440.*960/);
  select.props.onChange({ target: { value: "large" } });
  elements(app.render()).find(e => e.type === "Button" && text(e) === "Create room")!.props.onClick();
  assert.equal(app.sockets[0].sent.at(-1).type, "create");
  assert.equal(app.sockets[0].sent.at(-1).settings.mapSize, "large");
});

test("lobby hosts update map size and guests cannot select it", () => {
  const app = harness(room("lobby"));
  elements(app.tree).find(e => e.props.id === "map-size")!.props.onChange({ target: { value: "recommended" } });
  assert.equal(app.sockets[0].sent.at(-1).type, "settings");
  assert.equal(app.sockets[0].sent.at(-1).settings.mapSize, "recommended");
  const accepted = room("lobby");
  accepted.settings.mapSize = "recommended";
  app.message({ type: "room", room: accepted, deviceId: "local" });
  assert.equal(elements(app.render()).find(e => e.props.id === "map-size")!.props.value, "recommended");
  accepted.hostDeviceId = "other";
  assert.ok(!elements(harness(accepted).tree).some(e => e.props.id === "map-size"));
});

test("ready hosts can begin countdown by touch or keyboard, including projector mode", () => {
  const app = harness(room("ready"));
  elements(app.tree).find(e => text(e) === "Start countdown")!.props.onClick();
  assert.equal(app.sockets[0].sent.at(-1).type, "countdown");
  elements(app.tree).find(e => text(e) === "Projector view")!.props.onClick();
  elements(app.render()).find(e => text(e) === "Start countdown")!.props.onClick();
  assert.equal(app.sockets[0].sent.at(-1).type, "countdown");
  app.key("Space");
  assert.equal(app.sockets[0].sent.at(-1).type, "countdown");
});

test("spectators see ready instructions without a host countdown action", () => {
  const view = room("ready");
  view.hostDeviceId = "other";
  const app = harness(view);
  assert.ok(!elements(app.tree).some(e => text(e) === "Start countdown"));
});

test("keyboard opposite directions cancel, blur releases all inputs, power is sent", () => {
  const app = harness();
  app.key("Digit1");
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].turn, -1);
  app.key("KeyQ");
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].turn, 0);
  app.key("Digit1", false);
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].turn, 1);
  app.key("KeyA");
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].power, true);
  app.listeners.get("blur")!();
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].turn, 0);
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].power, false);
});

test("pause clears held controls and resume waits for fresh input", () => {
  const app = harness();
  app.key("Digit1");
  app.message({ type: "room", room: room("paused"), deviceId: "local" });
  app.message({ type: "room", room: room("playing"), deviceId: "local" });
  app.intervals.find(i => i.delay === 200)!.callback();
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].turn, 0);
});

test("releasing one touch pointer preserves the other held pointer", () => {
  const app = harness();
  const left = elements(app.tree).find(e => e.props["aria-label"] === "one turn left")!;
  const event = (pointerId: number) => ({ pointerId, currentTarget: { setPointerCapture() {} } });
  left.props.onPointerDown(event(1));
  left.props.onPointerDown(event(2));
  left.props.onPointerUp(event(1));
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].turn, -1);
  left.props.onPointerCancel(event(2));
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].turn, 0);
});

test("power touch pointers release independently and capture loss clears held inputs", () => {
  const app = harness();
  const power = elements(app.tree).find(e => e.props["aria-label"] === "one use Run faster")!;
  const event = (pointerId: number) => ({ pointerId, currentTarget: { setPointerCapture() {} } });
  power.props.onPointerDown(event(1));
  power.props.onPointerDown(event(2));
  power.props.onPointerUp(event(1));
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].power, true);
  power.props.onLostPointerCapture(event(2));
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].power, false);
  const left = elements(app.tree).find(e => e.props["aria-label"] === "one turn left")!;
  left.props.onPointerDown(event(3));
  left.props.onLostPointerCapture(event(3));
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].turn, 0);
});

test("entering projector mode releases touch controls before removing their buttons", () => {
  const app = harness();
  elements(app.tree).find(e => e.props["aria-label"] === "one turn left")!.props.onPointerDown({ pointerId: 1, currentTarget: { setPointerCapture() {} } });
  elements(app.tree).find(e => text(e) === "Projector view")!.props.onClick();
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].turn, 0);
});

test("rejected roster updates restore authoritative enabled slots and saved preferences", () => {
  const app = harness(room("lobby"));
  const enableThird = elements(app.tree).find(e => e.props["aria-label"] === `Enable ${PLAYER_PALETTE[2].name}`)!;
  enableThird.props.onClick();
  assert.equal(app.sockets[0].sent.at(-1).players.length, 3);
  app.message({ type: "error", requestType: "players", room: room("lobby"), message: "A room can have up to fifty players." });
  assert.equal(app.states[0][2].enabled, false);
  assert.equal(app.states[3].players.length, 2);
  app.render();
  assert.equal(JSON.parse(app.storage.get("kurve-players")!)[2].enabled, false);
});

test("overlapping roster edits reconcile the final reply without rolling back newer edits", () => {
  for (const finalAccepted of [true, false]) {
    const app = harness(room("lobby"));
    elements(app.tree).find(e => e.props["aria-label"] === `Enable ${PLAYER_PALETTE[2].name}`)!.props.onClick();
    elements(app.render()).find(e => e.props["aria-label"] === "Enable two")!.props.onClick();
    const added = { ...room("lobby").players[1], id: "player2", name: PLAYER_PALETTE[2].name };
    const firstReply = room("lobby");
    if (finalAccepted) app.message({ type: "error", requestType: "players", room: firstReply, message: "Room limit." });
    else {
      firstReply.players.push(added);
      app.message({ type: "room", requestType: "players", room: firstReply, deviceId: "local" });
    }
    assert.equal(app.states[0][1].enabled, false);
    assert.equal(app.states[0][2].enabled, true);
    if (finalAccepted) {
      const finalReply = room("lobby");
      finalReply.players = [finalReply.players[0], added];
      app.message({ type: "room", requestType: "players", room: finalReply, deviceId: "local" });
    } else app.message({ type: "error", requestType: "players", room: firstReply, message: "Roster rejected." });
    assert.equal(app.states[0][1].enabled, !finalAccepted);
    assert.equal(app.states[0][2].enabled, true);
    app.render();
    assert.equal(JSON.parse(app.storage.get("kurve-players")!)[1].enabled, !finalAccepted);
  }
});

test("rapid per-player rule edits preserve earlier pending changes and intermediate replies", () => {
  const app = harness(room("lobby"));
  const selects = elements(app.tree).filter(e => String(e.props["aria-label"]).startsWith("Force superpower for "));
  selects[0].props.onChange({ target: { value: "jump" } });
  selects[1].props.onChange({ target: { value: "hydra" } });
  const sent = app.sockets[0].sent.filter(m => m.type === "powerRules");
  assert.equal(sent[0].rules.players.one, "jump");
  assert.equal(sent[1].rules.players.two, "hydra");
  assert.equal(sent[1].rules.players.one, "jump");
  const firstReply = room("lobby");
  firstReply.powerRules.players.one = "jump";
  app.message({ type: "room", requestType: "powerRules", room: firstReply, deviceId: "local" });
  const afterReply = elements(app.render());
  assert.equal(afterReply.find(e => e.props["aria-label"] === "Force superpower for two")!.props.value, "hydra");
  afterReply.find(e => e.props["aria-label"] === "Force superpower for one")!.props.onChange({ target: { value: "" } });
  const latest = app.sockets[0].sent.at(-1);
  assert.equal(latest.rules.players.one, undefined);
  assert.equal(latest.rules.players.two, "hydra");
  const secondReply = room("lobby");
  secondReply.powerRules.players = { one: "jump", two: "hydra" };
  app.message({ type: "room", requestType: "powerRules", room: secondReply, deviceId: "local" });
  assert.equal(elements(app.render()).find(e => e.props["aria-label"] === "Force superpower for one")!.props.value, "");
  const finalReply = room("lobby");
  finalReply.powerRules.players.two = "hydra";
  app.message({ type: "room", requestType: "powerRules", room: finalReply, deviceId: "local" });
  assert.equal(elements(app.render()).find(e => e.props["aria-label"] === "Force superpower for one")!.props.value, "");
});

test("an older rules rejection cannot discard a newer pending preset or subsequent edit", () => {
  const app = harness(room("lobby"));
  elements(app.tree).find(e => e.props["aria-label"] === "Force superpower for one")!.props.onChange({ target: { value: "jump" } });
  elements(app.tree).find(e => text(e) === "Everyone random")!.props.onClick();
  app.message({ type: "error", requestType: "powerRules", message: "A stale player left the room." });
  elements(app.render()).find(e => e.props["aria-label"] === "Force superpower for one")!.props.onChange({ target: { value: "hydra" } });
  assert.equal(app.sockets[0].sent.at(-1).rules.everyone, "random");
  assert.equal(app.sockets[0].sent.at(-1).rules.players.one, "hydra");
  const presetReply = room("lobby");
  presetReply.powerRules.everyone = "random";
  app.message({ type: "room", requestType: "powerRules", room: presetReply, deviceId: "local" });
  assert.equal(elements(app.render()).find(e => e.props["aria-label"] === "Force superpower for one")!.props.value, "hydra");
  app.message({ type: "error", requestType: "powerRules", message: "Final rule rejected." });
  const restored = elements(app.render());
  assert.equal(restored.find(e => e.props["aria-label"] === "Force superpower for one")!.props.value, "");
  assert.equal(restored.find(e => e.props["aria-label"] === "Superpower for everyone")!.props.value, "random");
});

test("A to B to A rule edits retain the final draft through intermediate matching acknowledgements", () => {
  const app = harness(room("lobby"));
  const select = elements(app.tree).find(e => e.props["aria-label"] === "Force superpower for one")!;
  for (const value of ["jump", "hydra", "jump"]) select.props.onChange({ target: { value } });
  for (const value of ["jump", "hydra"]) {
    const reply = room("lobby");
    reply.powerRules.players.one = value as "jump" | "hydra";
    app.message({ type: "room", requestType: "powerRules", room: reply, deviceId: "local" });
    assert.equal(elements(app.render()).find(e => e.props["aria-label"] === "Force superpower for one")!.props.value, "jump");
  }
  app.message({ type: "error", requestType: "powerRules", message: "Final edit rejected." });
  assert.equal(elements(app.render()).find(e => e.props["aria-label"] === "Force superpower for one")!.props.value, "hydra");
});

test("supported prototype-named player IDs retain explicit power overrides", () => {
  for (const id of ["__proto__", "constructor", "toString"]) {
    const view = room("lobby");
    view.players[0].id = id;
    const slots = PLAYER_PALETTE.slice(0, 6).map((p, i) => ({ id: i === 0 ? id : ["one", "two"][i] ?? `player${i}`, name: p.name, enabled: i < 2, power: "boost", keys: controls.DEFAULT_KEYS[i] }));
    const app = harness(view, slots);
    const select = elements(app.tree).find(e => e.props["aria-label"] === "Force superpower for one")!;
    assert.equal(select.props.value, "");
    assert.equal(elements(app.tree).find(e => e.props["aria-label"] === "one ability")!.props.disabled, false);
    select.props.onChange({ target: { value: "hydra" } });
    const rules = app.sockets[0].sent.at(-1).rules;
    assert.equal(Object.hasOwn(rules.players, id), true);
    assert.equal(rules.players[id], "hydra");
  }
});

test("only a rejected rules request rolls back pending power rules", () => {
  const app = harness(room("lobby"));
  elements(app.tree).find(e => e.props["aria-label"] === "Force superpower for one")!.props.onChange({ target: { value: "jump" } });
  app.message({ type: "error", requestType: "players", room: room("lobby"), message: "Room limit." });
  assert.equal(elements(app.render()).find(e => e.props["aria-label"] === "Force superpower for one")!.props.value, "jump");
  app.message({ type: "error", requestType: "powerRules", message: "Rules rejected." });
  assert.equal(elements(app.render()).find(e => e.props["aria-label"] === "Force superpower for one")!.props.value, "");
});

test("malformed saved keys, duplicate identifiers/keys and unsupported powers recover safely", () => {
  for (const corrupt of [
    (slots: any[]) => { slots[0].keys = [1, 2, 3]; },
    (slots: any[]) => { slots[0].keys = "abc"; },
    (slots: any[]) => { slots[0].id = slots[1].id; },
    (slots: any[]) => { slots[0].keys[0] = slots[1].keys[0]; },
    (slots: any[]) => { slots[0].power = "unknown"; },
    (slots: any[]) => { slots[0] = null; },
  ]) {
    const slots = PLAYER_PALETTE.slice(0, 6).map((p, i) => ({ id: `p${i}`, name: p.name, enabled: true, power: "boost", keys: [...controls.DEFAULT_KEYS[i]] }));
    corrupt(slots);
    const app = harness(null, slots);
    assert.equal(app.states[0].length, 6);
    assert.ok(app.states[0].every((s: any) => !s.enabled));
    assert.equal(new Set(app.states[0].flatMap((s: any) => s.keys)).size, 18);
  }
});

test("a reconnect snapshot recovers owned controls after corrupt preferences were discarded", () => {
  const badSlots = PLAYER_PALETTE.slice(0, 6).map((p, i) => ({ id: `p${i}`, name: p.name, enabled: true, keys: [1, 2, 3] }));
  const app = harness(null, badSlots);
  app.message({
    type: "snapshot", room: room(), deviceId: "local", tick: 1, heads: [], segments: [], holes: [],
    phase: "playing", inputAck: 0, trailRevision: 1, effects: { darkUntil: 0 },
  });
  assert.equal(app.states[0][0].id, "one");
  assert.equal(app.states[0][1].id, "two");
  assert.equal(app.states[0][0].enabled, true);
  app.key("Digit1");
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].id, "one");
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].turn, -1);
});

test("rebinding rejects reserved and duplicate keys, then uses a valid new key", () => {
  const app = harness(room("lobby"));
  elements(app.tree).find(e => e.props["aria-label"] === "Change one left key")!.props.onClick();
  app.render();
  app.key("Space");
  assert.equal(app.states[0][0].keys[0], "Digit1");
  app.key("KeyQ");
  assert.equal(app.states[0][0].keys[0], "Digit1");
  app.key("KeyZ");
  app.render();
  assert.equal(app.states[0][0].keys[0], "KeyZ");
  app.message({ type: "room", room: room(), deviceId: "local" });
  app.key("KeyZ");
  assert.equal(app.sockets[0].sent.at(-1).inputs[0].turn, -1);
});

test("a replaced tab stops automatic retries and offers an explicit reconnect action", () => {
  const app = harness();
  app.sockets[0].readyState = 3;
  app.sockets[0].onclose?.({ code: 1008, reason: "This device reconnected in another tab." });
  assert.equal(app.timeouts.length, 0);
  elements(app.render()).find(e => text(e) === "Reconnect here")!.props.onClick();
  app.render();
  assert.equal(app.sockets.length, 2);
  app.sockets[1].onopen?.();
  assert.equal(app.sockets[1].sent.at(-1).type, "join");
});

test("ordinary network loss still retries and re-enters the room", () => {
  const app = harness();
  app.sockets[0].readyState = 3;
  app.sockets[0].onclose?.({ code: 1006, reason: "" });
  assert.equal(app.timeouts.length, 1);
  app.timeouts[0]();
  app.sockets[1].onopen?.();
  assert.equal(app.sockets[1].sent.at(-1).type, "join");
});

test("an expired seat returns to join setup with the old code and a spectator action", () => {
  const app = harness();
  app.sockets[0].readyState = 3;
  app.sockets[0].onclose?.({ code: 1006, reason: "" });
  app.timeouts[0]();
  app.sockets[1].onopen?.();
  app.message({ type: "error", requestType: "join", message: "A match is already running. Join as a spectator or wait for the lobby." });
  const setup = elements(app.render());
  assert.equal(app.states[3], null);
  assert.equal(app.storage.has("kurve-room"), false);
  assert.equal(setup.find(e => e.props["aria-label"] === "Room code")!.props.value, "ABCDE");
  setup.find(e => text(e) === "Spectate")!.props.onClick();
  assert.equal(app.sockets[1].sent.at(-1).type, "spectate");
  assert.equal(app.sockets[1].sent.at(-1).code, "ABCDE");
});

test("the WebSocket uses the page origin by default or the configured shared server", () => {
  assert.equal(harness().sockets[0].url, "ws://localhost:3000/ws");
  assert.equal(harness(room(), undefined, "https://game.example:8443/ignored/path/?query=1#hash").sockets[0].url, "wss://game.example:8443/ws");
});

test("snapshot colors are discarded on a new round or changed trail revision", () => {
  const app = harness();
  const snapshot = {
    type: "snapshot" as const, room: room(), deviceId: "local", tick: 1, heads: [], segments: [], holes: [],
    phase: "playing" as const, inputAck: 0, trailRevision: 1, effects: { darkUntil: 0 }, trailColors: { departed: "#f00" },
  };
  app.message(snapshot);
  const frame = elements(app.render()).find(e => e.type === "GameCanvas")!.props.frameRef;
  assert.equal(frame.current.trailColors.departed, "#f00");
  const nextRound = room("ready");
  nextRound.round = 2;
  app.message({ type: "room", room: nextRound, deviceId: "local" });
  assert.equal(frame.current.trailColors, undefined);
  app.message(snapshot);
  app.message({
    type: "frame", tick: 2, heads: [], segments: [], holes: [], phase: "playing",
    inputAck: 0, trailRevision: 2, effects: { darkUntil: 0 },
  });
  assert.equal(frame.current.trailColors, undefined);
});
