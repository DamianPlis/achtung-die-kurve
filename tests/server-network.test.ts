import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { ServerMessage } from "../shared/types.js";
import { POWERS } from "../shared/types.js";
import { createGameServer } from "../server/app.js";

class Client {
  readonly socket: WebSocket;
  private inbox: ServerMessage[] = [];
  private waiter?: () => void;
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (data) => {
      this.inbox.push(JSON.parse(data.toString()) as ServerMessage);
      this.waiter?.();
    });
  }
  send(value: object) {
    this.socket.send(JSON.stringify(value));
  }
  assertNoErrors() {
    assert.deepEqual(this.inbox.filter(message => message.type === "error"), []);
  }
  async wait<T extends ServerMessage["type"]>(
    type: T,
    predicate: (message: Extract<ServerMessage, { type: T }>) => boolean = () =>
      true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const index = this.inbox.findIndex(
        (message) =>
          message.type === type &&
          predicate(message as Extract<ServerMessage, { type: T }>),
      );
      if (index >= 0)
        return this.inbox.splice(index, 1)[0] as Extract<
          ServerMessage,
          { type: T }
        >;
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${type}`);
      await new Promise<void>((done) => {
        this.waiter = done;
        const timer = setTimeout(done, 100);
        timer.unref();
      });
      this.waiter = undefined;
    }
  }
}
const device = (id: number) => `device-session-000${id}`;
const token = (id: number) => `private-session-secret-000000000000${id}`;
const roster = (id: number, count = 6) =>
  Array.from({ length: count }, (_, index) => ({
    id: `player-${id}-${index}`,
    name: `Team ${id}, player ${index}`,
    power: "jump",
  }));

async function roomFixture(graceMs = 30_000) {
  const app = createGameServer({ autoTick: false, graceMs });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}/ws`;
  async function connect() {
    const client = new Client(url);
    await once(client.socket, "open");
    return client;
  }
  const host = await connect();
  host.send({
    type: "create", deviceId: device(1), sessionToken: token(1),
    players: roster(1, 2),
  });
  const created = await host.wait("snapshot");
  await host.wait("room");
  const room = app.rooms.get(created.room.code)!;
  async function join(id: number, count = 1) {
    const client = await connect();
    client.send({
      type: "join", code: room.code, deviceId: device(id),
      sessionToken: token(id), players: roster(id, count),
    });
    await client.wait("snapshot");
    await host.wait("room", message =>
      message.room.players.some(player => player.deviceId === device(id)),
    );
    return client;
  }
  return { app, host, room, connect, join };
}

test("three six-player devices share one authoritative match, with spectators and ownership checks", async () => {
  const app = createGameServer({ autoTick: false });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const host = new Client(url),
    second = new Client(url),
    third = new Client(url),
    spectator = new Client(url);
  try {
    await Promise.all(
      [host, second, third, spectator].map((client) =>
        once(client.socket, "open"),
      ),
    );
    host.send({
      type: "create",
      deviceId: device(1),
      sessionToken: token(1),
      players: roster(1),
    });
    const created = await host.wait("snapshot");
    const code = created.room.code;
    second.send({
      type: "join",
      code,
      deviceId: device(2),
      sessionToken: token(2),
      players: roster(2),
    });
    third.send({
      type: "join",
      code,
      deviceId: device(3),
      sessionToken: token(3),
      players: roster(3),
    });
    spectator.send({
      type: "spectate",
      code,
      deviceId: device(4),
      sessionToken: token(4),
    });
    await second.wait("snapshot");
    await third.wait("snapshot");
    await spectator.wait("snapshot");
    const joined = await host.wait(
      "room",
      (message) => message.room.players.length === 18,
    );
    assert.equal(
      new Set(joined.room.players.map((player) => player.color)).size,
      18,
    );
    assert.equal(
      JSON.stringify(joined).includes(token(1)),
      false,
      "private reconnect secrets never appear in shared room state",
    );
    const impostor = new Client(url);
    await once(impostor.socket, "open");
    impostor.send({
      type: "join",
      code,
      deviceId: device(1),
      sessionToken: token(9),
      players: roster(1),
    });
    assert.match((await impostor.wait("error")).message, /another connection/);
    assert.equal(
      host.socket.readyState,
      WebSocket.OPEN,
      "impersonation does not disconnect the real host",
    );
    impostor.socket.close();
    second.send({ type: "start" });
    assert.match((await second.wait("error")).message, /Only the host/);
    second.send({ type: "input", inputs: [{ id: "player-1-0", turn: 1 }] });
    assert.match((await second.wait("error")).message, /own device/);
    host.send({ type: "start" });
    await host.wait("room", (message) => message.room.phase === "ready");
    host.send({ type: "countdown" });
    await host.wait("room", (message) => message.room.phase === "countdown");
    const room = app.rooms.get(code)!;
    assert.equal(room.game.heads.length, 18);
    for (let i = 0; i < 180; i++) app.step();
    const playing = await spectator.wait(
      "room",
      (message) => message.room.phase === "playing",
    );
    assert.equal(playing.room.players.length, 18);
    second.send({ type: "pause" });
    assert.match((await second.wait("error")).message, /Only the host/);
    host.send({ type: "pause" });
    await host.wait("room", (message) => message.room.phase === "paused");
    const pausedFrame = await host.wait(
      "frame",
      (message) => message.phase === "paused",
    );
    assert.ok(pausedFrame.heads.every((head) => head.turn === 0));
    host.send({ type: "pause" });
    await host.wait("room", (message) => message.room.phase === "playing");
    const resumedFrame = await host.wait(
      "frame",
      (message) =>
        message.phase === "playing" && message.tick === pausedFrame.tick,
    );
    assert.deepEqual(
      resumedFrame.heads.map((head) => [head.x, head.y]),
      pausedFrame.heads.map((head) => [head.x, head.y]),
    );
    second.send({
      type: "input",
      inputs: [{ id: "player-2-0", turn: -1, power: true }],
    });
    await second.wait(
      "room",
      (message) =>
        message.room.players.find((player) => player.id === "player-2-0")
          ?.charges === 1,
    );
    assert.equal(
      room.game.heads.find((head) => head.id === "player-2-0")!.turn,
      -1,
    );
    host.socket.close();
    await once(host.socket, "close");
    const transferred = await second.wait(
      "room",
      (message) => message.room.hostDeviceId === device(2),
    );
    assert.equal(
      transferred.room.players.filter((player) => !player.connected).length,
      6,
    );
    const reconnect = new Client(url);
    await once(reconnect.socket, "open");
    reconnect.send({
      type: "join",
      code,
      deviceId: device(1),
      sessionToken: token(1),
      players: roster(1),
    });
    const restored = await reconnect.wait("snapshot");
    assert.equal(restored.room.players.length, 18);
    assert.equal(
      restored.room.players.every((player) => player.connected),
      true,
    );
    reconnect.socket.close();
  } finally {
    await app.close();
  }
});

test("packet floods and oversized messages close connections without affecting the server", async () => {
  const app = createGameServer({ autoTick: false });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}/ws`;
  try {
    const flood = new Client(url);
    await once(flood.socket, "open");
    const closed = once(flood.socket, "close");
    for (let i = 0; i < 121; i++) flood.send({ type: "ping", at: i });
    assert.equal((await closed)[0], 1008);
    const oversized = new Client(url);
    await once(oversized.socket, "open");
    const tooLarge = once(oversized.socket, "close");
    oversized.socket.send("x".repeat(9000));
    assert.equal((await tooLarge)[0], 1009);
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
  } finally {
    await app.close();
  }
});

test("fifty players on nine devices share powers, map size, holes and private monotonic acknowledgments", async () => {
  const app = createGameServer({ autoTick: false });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const clients = Array.from({ length: 11 }, () => new Client(url));
  try {
    await Promise.all(clients.map((client) => once(client.socket, "open")));
    assert.ok(
      clients.every((client) =>
        client.socket.extensions.includes("permessage-deflate"),
      ),
      "normal clients negotiate compressed room traffic",
    );
    const host = clients[0];
    const hostRoster = roster(1).map((player, index) => ({
      ...player,
      power: ["dark", "holes", "hydra", "square", "slow", "shield"][index],
    }));
    host.send({
      type: "create",
      deviceId: device(1),
      sessionToken: token(1),
      players: hostRoster,
    });
    const created = await host.wait("snapshot");
    const code = created.room.code;
    for (let index = 1; index < 9; index++) {
      clients[index].send({
        type: "join",
        code,
        deviceId: device(index + 1),
        sessionToken: token(index + 1),
        players: roster(index + 1, index === 8 ? 2 : 6),
      });
      await clients[index].wait("snapshot");
    }
    clients[9].send({
      type: "spectate",
      code,
      deviceId: device(10),
      sessionToken: token(10),
    });
    await clients[9].wait("snapshot");
    clients[10].send({
      type: "join",
      code,
      deviceId: device(11),
      sessionToken: token(11),
      players: roster(11, 1),
    });
    assert.match((await clients[10].wait("error")).message, /fifty players/);
    const joined = await host.wait(
      "room",
      (message) => message.room.players.length === 50,
    );
    assert.equal(
      new Set(joined.room.players.map((player) => player.color)).size,
      50,
    );
    host.send({ type: "start" });
    await host.wait("room", (message) => message.room.phase === "ready");
    host.send({ type: "countdown" });
    const countdown = await host.wait(
      "room",
      (message) => message.room.phase === "countdown",
    );
    assert.deepEqual(
      [countdown.room.width, countdown.room.height],
      [3466, 2310],
    );
    for (let index = 0; index < 180; index++) app.step();
    await host.wait("room", (message) => message.room.phase === "playing");
    const room = app.rooms.get(code)!;
    host.send({
      type: "input",
      seq: 10,
      inputs: [{ id: "player-1-0", turn: 0, power: true }],
    });
    await host.wait("room", (message) => message.room.players[0].charges === 1);
    for (let index = 0; index < 3; index++) app.step();
    const darkFrames = await Promise.all(
      clients
        .slice(0, 10)
        .map((client) =>
          client.wait(
            "frame",
            (message) => message.effects.darkUntil > message.tick,
          ),
        ),
    );
    assert.ok(
      darkFrames.every(
        (frame) => frame.effects.darkUntil === room.game.effects.darkUntil,
      ),
    );
    assert.equal(darkFrames[0].inputAck, 10);
    assert.ok(darkFrames.slice(1).every((frame) => frame.inputAck === 0));
    host.send({
      type: "input",
      seq: 9,
      inputs: [{ id: "player-1-0", turn: 1, power: false }],
    });
    host.send({ type: "ping", at: 99 });
    await host.wait("pong", (message) => message.at === 99);
    assert.equal(
      room.game.heads[0].turn,
      0,
      "an old steering sequence cannot replace newer input",
    );
    host.send({
      type: "input",
      seq: 11,
      inputs: [
        { id: "player-1-1", turn: 0, power: true },
        { id: "player-1-2", turn: 1, power: true },
      ],
    });
    await host.wait("room", (message) => message.room.players[1].charges === 1);
    for (let index = 0; index < 3; index++) app.step();
    const powerFrames = await Promise.all(
      clients
        .slice(0, 10)
        .map((client) =>
          client.wait("frame", (message) => message.holes.length > 0),
        ),
    );
    assert.ok(
      powerFrames.every(
        (frame) => frame.holes[0].id === powerFrames[0].holes[0].id,
      ),
    );
    assert.ok(
      powerFrames.every(
        (frame) =>
          frame.heads.filter((head) => head.ownerId === "player-1-2").length ===
          2,
      ),
    );
    assert.equal(powerFrames[0].inputAck, 11);
    assert.equal(powerFrames[0].holes[0].width, 8);
    clients[10].send({
      type: "spectate",
      code,
      deviceId: device(11),
      sessionToken: token(11),
    });
    const snapshot = await clients[10].wait("snapshot");
    assert.equal(snapshot.holes[0].id, powerFrames[0].holes[0].id);
    assert.equal(snapshot.effects.darkUntil, room.game.effects.darkUntil);
    assert.ok(
      snapshot.segments.every((segment) => Number.isInteger(segment.tick)),
    );
    host.send({ type: "input", seq: -1, inputs: [] });
    assert.match((await host.wait("error")).message, /input sequence/);
    host.send({ type: "lobby" });
    await host.wait("room", message => message.room.phase === "lobby");

    const serverWatcher = room.devices.get(device(11))!.socket!;
    const originalSend = serverWatcher.send;
    const callbacks: ((error?: Error) => void)[] = [];
    serverWatcher.send = (_data, options?: unknown, callback?: (error?: Error) => void) => {
      callbacks.push(typeof options === "function" ? options as (error?: Error) => void : callback!);
    };
    const closed = once(clients[10].socket, "close");
    for (let update = 0; update < 20 && serverWatcher.readyState === WebSocket.OPEN; update++) {
      for (let index = 0; index < 9; index++)
        clients[index].send({ type: "players", players: roster(index + 1, index === 8 ? 2 : 6) });
      host.send({ type: "ping", at: 2000 + update });
      await host.wait("pong", message => message.at === 2000 + update);
    }
    assert.equal((await closed)[0], 1013, "lobby updates bound the unsent queue even when send callbacks have not completed");
    serverWatcher.send = originalSend;
    for (const callback of callbacks) callback();
  } finally {
    await app.close();
  }
});

test("retained colors stay unique and rejected reconnects preserve the existing session", async () => {
  const { app, host, room, connect, join } = await roomFixture();
  try {
    const retained = room.game.players[1];
    host.send({ type: "players", players: [
      { id: "new-player", name: retained.color, power: "jump" },
      { id: retained.id, name: retained.name, power: retained.power },
    ] });
    const updated = await host.wait("room", message => message.room.players.some(player => player.id === "new-player"));
    assert.equal(updated.requestType, "players");
    assert.equal(new Set(updated.room.players.map(player => player.color)).size, 2);
    assert.equal(updated.room.players.find(player => player.id === retained.id)!.color, retained.color);
    await join(2);
    const original = room.devices.get(device(1))!.socket;
    const replacement = await connect();
    replacement.send({ type: "join", code: room.code, deviceId: device(1), sessionToken: token(1), players: roster(2, 1) });
    const rejected = await replacement.wait("error");
    assert.match(rejected.message, /already in this room/);
    assert.equal(rejected.requestType, "join");
    assert.equal(room.devices.get(device(1))!.socket === original, true);
    assert.equal(host.socket.readyState, WebSocket.OPEN);
    host.send({ type: "players", players: roster(2, 1) });
    const rosterError = await host.wait("error");
    assert.equal(rosterError.requestType, "players");
    assert.deepEqual(rosterError.room?.players.map(player => player.id), room.game.players.map(player => player.id));
    replacement.send({ type: "join", code: room.code, deviceId: device(3), sessionToken: token(3), players: roster(3, 1) });
    assert.equal((await replacement.wait("snapshot")).room.players.length, 4, "a rejected reconnect leaves its socket free to join correctly");
  } finally { await app.close(); }
});

test("rejoining as spectator releases previous players in the lobby and during a match", async () => {
  for (const playing of [false, true]) {
    const { app, host, room, connect, join } = await roomFixture();
    try {
      const participant = await join(2);
      if (playing) {
        host.send({ type: "start" });
        await host.wait("room", message => message.room.phase === "ready");
        host.send({ type: "countdown" });
        await host.wait("room", message => message.room.phase === "countdown");
        for (let tick = 0; tick < 180; tick++) app.step();
        await host.wait("room", message => message.room.phase === "playing");
      }
      participant.socket.close();
      await once(participant.socket, "close");
      const watcher = await connect();
      watcher.send({ type: "spectate", code: room.code, deviceId: device(2), sessionToken: token(2) });
      const snapshot = await watcher.wait("snapshot");
      assert.equal(snapshot.room.players.some(player => player.deviceId === device(2)), false);
      assert.deepEqual(room.devices.get(device(2))!.playerIds, []);
      assert.ok(snapshot.heads.filter(head => head.ownerId === "player-2-0").every(head => !head.alive));
      watcher.send({ type: "input", inputs: [{ id: "player-2-0", turn: 1 }] });
      assert.match((await watcher.wait("error")).message, /own device/);
      if (playing) {
        const latest = await host.wait("frame", frame => frame.phase === "playing" && frame.heads.some(head => head.ownerId === "player-2-0" && !head.alive));
        assert.equal(latest.heads.filter(head => head.ownerId === "player-2-0" && head.alive).length, 0);
        watcher.socket.close();
        await once(watcher.socket, "close");
        const rejoin = await connect();
        rejoin.send({ type: "join", code: room.code, deviceId: device(2), sessionToken: token(2), players: roster(2, 1) });
        assert.match((await rejoin.wait("error")).message, /match is already running/);
      }
    } finally { await app.close(); }
  }
});

test("grace expiry removes forced-power rules before the host edits another player", async () => {
  const { app, host, room, join } = await roomFixture(30);
  try {
    const participant = await join(2);
    host.send({ type: "powerRules", rules: { everyone: null, players: { "player-2-0": "hydra" } } });
    await host.wait("room", message => message.room.powerRules.players["player-2-0"] === "hydra");
    participant.socket.close();
    await once(participant.socket, "close");
    const expired = await host.wait("room", message => !message.room.players.some(player => player.deviceId === device(2)));
    assert.equal(expired.room.powerRules.players["player-2-0"], undefined);
    assert.equal(room.selectedPowers.has("player-2-0"), false);
    host.send({ type: "powerRules", rules: { everyone: null, players: { ...expired.room.powerRules.players, "player-1-0": "boost" } } });
    await host.wait("room", message => message.room.players.find(player => player.id === "player-1-0")?.power === "boost");
  } finally { await app.close(); }
});

test("large compressed initial snapshots preserve later frames and stay connected", async () => {
  const { app, host, room, connect } = await roomFixture();
  try {
    host.send({ type: "start" });
    await host.wait("room", message => message.room.phase === "ready");
    host.send({ type: "countdown" });
    await host.wait("room", message => message.room.phase === "countdown");
    for (let tick = 0; tick < 180; tick++) app.step();
    await host.wait("room", message => message.room.phase === "playing");
    room.game.segments = Array.from({ length: 50_000 }, (_, order) => ({
      id: "player-1-0", x1: 100, y1: 100, x2: 101, y2: 101,
      tick: room.game.tick, order,
    }));
    assert.ok(Buffer.byteLength(JSON.stringify(room.game.segments)) > 1_048_576);
    const frameTick = room.game.tick + 3;
    app.wss.once("connection", serverSocket => {
      serverSocket.on("message", () => {
        for (let tick = 0; tick < 3; tick++) app.step();
      });
    });
    const watcher = await connect();
    watcher.send({ type: "spectate", code: room.code, deviceId: device(2), sessionToken: token(2) });
    const snapshot = await watcher.wait("snapshot");
    assert.equal(snapshot.segments.length, 50_000);
    assert.ok(snapshot.segments.every(segment => !("headId" in segment)));
    const frame = await watcher.wait("frame", message => message.tick === frameTick);
    assert.equal(frame.phase, "playing");
    watcher.send({ type: "ping", at: 12345 });
    await watcher.wait("pong", message => message.at === 12345);
    assert.equal(watcher.socket.readyState, WebSocket.OPEN);
  } finally { await app.close(); }
});

test("a stalled initial snapshot is terminated after the send deadline", async (context) => {
  const { app, room, connect } = await roomFixture();
  try {
    let serverSocket: WebSocket | undefined;
    app.wss.once("connection", socket => { serverSocket = socket; });
    const watcher = await connect();
    assert.ok(serverSocket);
    const originalSend = serverSocket.send;
    serverSocket.send = (data, options?: unknown, callback?: (error?: Error) => void) => {
      if (JSON.parse(String(data)).type !== "snapshot")
        originalSend.call(serverSocket!, data, {}, typeof options === "function" ? options as (error?: Error) => void : callback);
    };
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const handled = once(serverSocket, "message");
    watcher.send({ type: "spectate", code: room.code, deviceId: device(2), sessionToken: token(2) });
    await handled;
    context.mock.timers.tick(29_999);
    assert.equal(serverSocket.readyState, WebSocket.OPEN);
    const closed = once(watcher.socket, "close");
    context.mock.timers.tick(1);
    assert.equal((await closed)[0], 1006);
  } finally { context.mock.timers.reset(); await app.close(); }
});

test("fifty independent player sockets and a spectator share an active match with every power", async () => {
  const { app, host, room, connect, join } = await roomFixture();
  try {
    host.send({ type: "players", players: roster(1, 1) });
    await host.wait("room", message => message.room.players.length === 1);
    const players = [host];
    for (let id = 2; id <= 50; id++) players.push(await join(id));
    const spectator = await connect();
    spectator.send({ type: "spectate", code: room.code, deviceId: device(51), sessionToken: token(51) });
    await spectator.wait("snapshot");
    const clients = [...players, spectator];
    const rules = Object.fromEntries(room.game.players.map((player, index) => [player.id, POWERS[index % POWERS.length]]));
    host.send({ type: "powerRules", rules: { everyone: null, players: rules } });
    const forced = await host.wait("room", message => message.room.players.every(player => player.power === rules[player.id]));
    assert.equal(forced.requestType, "powerRules");
    const observerRules = await players[1].wait("room", message => message.room.players.every(player => player.power === rules[player.id]));
    assert.equal(observerRules.requestType, undefined);
    host.send({ type: "start" });
    await Promise.all(clients.map(client => client.wait("room", message => message.room.phase === "ready")));
    host.send({ type: "countdown" });
    await Promise.all(clients.map(client => client.wait("room", message => message.room.phase === "countdown")));
    async function barrier(at: number) {
      for (const client of clients) client.send({ type: "ping", at });
      await Promise.all(clients.map(client => client.wait("pong", message => message.at === at)));
    }
    for (let batch = 0; batch < 6; batch++) {
      for (let tick = 0; tick < 30; tick++) app.step();
      await barrier(batch);
    }
    await Promise.all(clients.map(client => client.wait("room", message => message.room.phase === "playing")));
    for (let index = 0; index < players.length; index++)
      players[index].send({ type: "input", seq: 1, inputs: [{ id: `player-${index + 1}-0`, turn: 0, power: true }] });
    await barrier(100);
    for (let tick = 0; tick < 6; tick++) app.step();
    const frames = await Promise.all(clients.map(client => client.wait("frame", frame => frame.tick === room.game.tick)));
    for (const [index, client] of clients.entries()) {
      assert.equal(client.socket.readyState, WebSocket.OPEN);
      client.assertNoErrors();
      assert.equal(frames[index].phase, room.game.phase);
      assert.deepEqual(frames[index].heads, frames[0].heads);
      assert.equal(frames[index].inputAck, index < 50 ? 1 : 0);
      assert.ok(frames[index].heads.every(head => Number.isFinite(head.x) && Number.isFinite(head.y) && Number.isFinite(head.angle)));
    }
    assert.ok(room.game.players.some(player => player.charges < 2));
    assert.equal(room.devices.size, 51);
  } finally { await app.close(); }
});

test("roster limits, settings, malformed payloads, reconnect expiry, and HTTP health are bounded", async () => {
  const app = createGameServer({ autoTick: false, graceMs: 30 });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const client = new Client(`ws://127.0.0.1:${address.port}/ws`);
  try {
    await once(client.socket, "open");
    client.send({
      type: "create",
      deviceId: device(1),
      sessionToken: token(1),
      players: roster(1, 7),
    });
    assert.match((await client.wait("error")).message, /six players/);
    assert.equal(app.rooms.size, 0);
    client.socket.send("{invalid json");
    await client.wait("error");
    client.send({
      type: "create",
      deviceId: device(1),
      sessionToken: token(1),
      players: roster(1, 2),
      settings: { targetScore: -1 },
    });
    assert.match((await client.wait("error")).message, /Target score/);
    client.send({
      type: "create",
      deviceId: device(1),
      sessionToken: token(1),
      players: roster(1, 2),
    });
    const created = await client.wait("snapshot");
    client.send({
      type: "settings",
      settings: { speed: "fast", targetScore: 10 },
    });
    assert.equal(
      (
        await client.wait(
          "room",
          (message) => message.room.settings.speed === "fast",
        )
      ).room.settings.targetScore,
      10,
    );
    client.send({
      type: "players",
      players: [
        { id: "duplicate", name: "A" },
        { id: "duplicate", name: "B" },
      ],
    });
    assert.match((await client.wait("error")).message, /unique/);
    const health = (await fetch(`http://127.0.0.1:${address.port}/health`).then(
      (response) => response.json(),
    )) as { status: string; rooms: number };
    assert.deepEqual(
      { status: health.status, rooms: health.rooms },
      { status: "ok", rooms: 1 },
    );
    assert.ok(app.rooms.has(created.room.code));
    client.socket.close();
    await once(client.socket, "close");
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(app.rooms.size, 0);
  } finally {
    await app.close();
  }
});
