import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import type { ServerMessage } from '../shared/types.js';
import { createGameServer } from '../server/app.js';

class Client {
  readonly socket: WebSocket;
  private inbox: ServerMessage[] = [];
  private waiter?: () => void;
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (data) => { this.inbox.push(JSON.parse(data.toString()) as ServerMessage); this.waiter?.(); });
  }
  send(value: object) { this.socket.send(JSON.stringify(value)); }
  async wait<T extends ServerMessage['type']>(type: T, predicate: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const index = this.inbox.findIndex((message) => message.type === type && predicate(message as Extract<ServerMessage, { type: T }>));
      if (index >= 0) return this.inbox.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}`);
      await new Promise<void>((done) => { this.waiter = done; const timer = setTimeout(done, 100); timer.unref(); });
      this.waiter = undefined;
    }
  }
}
const device = (id: number) => `device-session-000${id}`;
const token = (id: number) => `private-session-secret-000000000000${id}`;
const roster = (id: number, count = 6) => Array.from({ length: count }, (_, index) => ({ id: `player-${id}-${index}`, name: `Team ${id}, player ${index}`, power: 'jump' }));

test('three six-player devices share one authoritative match, with spectators and ownership checks', async () => {
  const app = createGameServer({ autoTick: false });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const host = new Client(url), second = new Client(url), third = new Client(url), spectator = new Client(url);
  try {
    await Promise.all([host, second, third, spectator].map((client) => once(client.socket, 'open')));
    host.send({ type: 'create', deviceId: device(1), sessionToken: token(1), players: roster(1) });
    const created = await host.wait('snapshot');
    const code = created.room.code;
    second.send({ type: 'join', code, deviceId: device(2), sessionToken: token(2), players: roster(2) });
    third.send({ type: 'join', code, deviceId: device(3), sessionToken: token(3), players: roster(3) });
    spectator.send({ type: 'spectate', code, deviceId: device(4), sessionToken: token(4) });
    await second.wait('snapshot');
    await third.wait('snapshot');
    await spectator.wait('snapshot');
    const joined = await host.wait('room', (message) => message.room.players.length === 18);
    assert.equal(new Set(joined.room.players.map((player) => player.color)).size, 18);
    assert.equal(JSON.stringify(joined).includes(token(1)), false, 'private reconnect secrets never appear in shared room state');
    const impostor = new Client(url);
    await once(impostor.socket, 'open');
    impostor.send({ type: 'join', code, deviceId: device(1), sessionToken: token(9), players: roster(1) });
    assert.match((await impostor.wait('error')).message, /another connection/);
    assert.equal(host.socket.readyState, WebSocket.OPEN, 'impersonation does not disconnect the real host');
    impostor.socket.close();
    second.send({ type: 'start' });
    assert.match((await second.wait('error')).message, /Only the host/);
    second.send({ type: 'input', inputs: [{ id: 'player-1-0', turn: 1 }] });
    assert.match((await second.wait('error')).message, /own device/);
    host.send({ type: 'start' });
    await host.wait('room', (message) => message.room.phase === 'countdown');
    const room = app.rooms.get(code)!;
    assert.equal(room.game.heads.length, 18);
    for (let i = 0; i < 180; i++) app.step();
    const playing = await spectator.wait('room', (message) => message.room.phase === 'playing');
    assert.equal(playing.room.players.length, 18);
    second.send({ type: 'pause' });
    assert.match((await second.wait('error')).message, /Only the host/);
    host.send({ type: 'pause' });
    await host.wait('room', (message) => message.room.phase === 'paused');
    host.send({ type: 'pause' });
    await host.wait('room', (message) => message.room.phase === 'playing');
    second.send({ type: 'input', inputs: [{ id: 'player-2-0', turn: -1, power: true }] });
    await second.wait('room', (message) => message.room.players.find((player) => player.id === 'player-2-0')?.charges === 1);
    assert.equal(room.game.heads.find((head) => head.id === 'player-2-0')!.turn, -1);
    host.socket.close();
    await once(host.socket, 'close');
    const transferred = await second.wait('room', (message) => message.room.hostDeviceId === device(2));
    assert.equal(transferred.room.players.filter((player) => !player.connected).length, 6);
    const reconnect = new Client(url);
    await once(reconnect.socket, 'open');
    reconnect.send({ type: 'join', code, deviceId: device(1), sessionToken: token(1), players: roster(1) });
    const restored = await reconnect.wait('snapshot');
    assert.equal(restored.room.players.length, 18);
    assert.equal(restored.room.players.every((player) => player.connected), true);
    reconnect.socket.close();
  } finally { await app.close(); }
});

test('packet floods and oversized messages close connections without affecting the server', async () => {
  const app = createGameServer({ autoTick: false });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  try {
    const flood = new Client(url);
    await once(flood.socket, 'open');
    const closed = once(flood.socket, 'close');
    for (let i = 0; i < 121; i++) flood.send({ type: 'ping', at: i });
    assert.equal((await closed)[0], 1008);
    const oversized = new Client(url);
    await once(oversized.socket, 'open');
    const tooLarge = once(oversized.socket, 'close');
    oversized.socket.send('x'.repeat(9000));
    assert.equal((await tooLarge)[0], 1009);
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
  } finally { await app.close(); }
});

test('roster limits, settings, malformed payloads, reconnect expiry, and HTTP health are bounded', async () => {
  const app = createGameServer({ autoTick: false, graceMs: 30 });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new Client(`ws://127.0.0.1:${address.port}/ws`);
  try {
    await once(client.socket, 'open');
    client.send({ type: 'create', deviceId: device(1), sessionToken: token(1), players: roster(1, 7) });
    assert.match((await client.wait('error')).message, /six players/);
    assert.equal(app.rooms.size, 0);
    client.socket.send('{invalid json');
    await client.wait('error');
    client.send({ type: 'create', deviceId: device(1), sessionToken: token(1), players: roster(1, 2), settings: { targetScore: -1 } });
    assert.match((await client.wait('error')).message, /Target score/);
    client.send({ type: 'create', deviceId: device(1), sessionToken: token(1), players: roster(1, 2) });
    const created = await client.wait('snapshot');
    client.send({ type: 'settings', settings: { speed: 'fast', targetScore: 10 } });
    assert.equal((await client.wait('room', (message) => message.room.settings.speed === 'fast')).room.settings.targetScore, 10);
    client.send({ type: 'players', players: [{ id: 'duplicate', name: 'A' }, { id: 'duplicate', name: 'B' }] });
    assert.match((await client.wait('error')).message, /unique/);
    const health = await fetch(`http://127.0.0.1:${address.port}/health`).then((response) => response.json()) as { status: string; rooms: number };
    assert.deepEqual({ status: health.status, rooms: health.rooms }, { status: 'ok', rooms: 1 });
    assert.ok(app.rooms.has(created.room.code));
    client.socket.close();
    await once(client.socket, 'close');
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(app.rooms.size, 0);
  } finally { await app.close(); }
});
