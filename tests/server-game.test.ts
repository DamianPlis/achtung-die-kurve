import assert from 'node:assert/strict';
import test from 'node:test';
import type { Player } from '../shared/types.js';
import { DEFAULT_SETTINGS, Game } from '../server/game.js';

function players(count = 2): Player[] {
  return Array.from({ length: count }, (_, index) => ({ id: `player-${index}`, deviceId: `device-${index}`, name: `Player ${index}`, color: '#ffffff', score: 0, connected: true, power: 'none', charges: 2 }));
}
function running(count = 2, targetScore = 0) {
  const game = new Game(players(count), { ...DEFAULT_SETTINGS, targetScore, gaps: false }, () => .5);
  game.start();
  for (let i = 0; i < 180; i++) game.step();
  game.heads.forEach((head, index) => { head.x = 200 + index * 300; head.y = 200 + index * 150; head.angle = 0; });
  return game;
}

test('classic countdown, movement, and steering run on fixed simulation ticks', () => {
  const game = running(3);
  assert.equal(game.phase, 'playing');
  assert.equal(game.matchTarget, 20);
  game.step();
  assert.ok(Math.abs(game.heads[0].x - 201.4) < .0001);
  game.input('player-0', 1);
  game.step();
  assert.equal(game.heads[0].angle, .035);
  assert.ok(game.heads[0].y > 200);
  const segments = game.takeSegments();
  assert.equal(segments.length, 3, 'three ticks of continuous trail collapse to one segment per player');
  assert.equal(game.segments.length, 3);
});

test('wall elimination awards every survivor, and first to target wins', () => {
  const game = running(3, 2);
  game.heads[0].x = 1198;
  game.step();
  assert.equal(game.heads[0].alive, false);
  assert.deepEqual(game.players.map((player) => player.score), [0, 1, 1]);
  game.heads[1].x = 1198;
  game.step();
  assert.deepEqual(game.players.map((player) => player.score), [0, 1, 2]);
  assert.equal(game.phase, 'finished');
  assert.equal(game.winnerId, 'player-2');
});

test('trail occupancy detects another trail but permits the recent own trail', () => {
  const game = running();
  for (let i = 0; i < 12; i++) game.step();
  assert.equal(game.heads[0].alive, true);
  Object.assign(game.heads[1], { x: 210, y: 207, angle: -Math.PI / 2 });
  for (let i = 0; i < 5 && game.phase === 'playing'; i++) game.step();
  assert.equal(game.heads[1].alive, false);
  assert.equal(game.players[0].score, 1);
  assert.equal(game.phase, 'roundEnd');
  assert.equal(game.winnerId, 'player-0');
});

test('same-tick head collision eliminates both without awarding either a point', () => {
  const game = running();
  Object.assign(game.heads[0], { x: 500, y: 400, angle: 0 });
  Object.assign(game.heads[1], { x: 505, y: 400, angle: Math.PI });
  game.step();
  assert.deepEqual(game.heads.map((head) => head.alive), [false, false]);
  assert.deepEqual(game.players.map((player) => player.score), [0, 0]);
  assert.equal(game.phase, 'roundEnd');
});

test('jump spends one charge and crosses a trail without drawing the jump', () => {
  const game = running();
  game.players[0].power = 'jump';
  const before = game.heads[0].x;
  assert.equal(game.input('player-0', 0, true), true);
  assert.ok(Math.abs(game.heads[0].x - before - 33.6) < .0001);
  assert.equal(game.players[0].charges, 1);
  assert.equal(game.pending.length, 0);
  assert.equal(game.input('player-0', 0, true), false, 'jump cooldown prevents repeated packets from spending all charges');
  game.step();
  assert.equal(game.pending[0].x1, before + 33.6);
});

test('boost and shield have bounded server-side duration and recharge after rounds', () => {
  const game = running();
  game.players[0].power = 'boost';
  game.players[1].power = 'shield';
  assert.equal(game.input('player-0', 0, true), true);
  assert.equal(game.input('player-1', 0, true), true);
  const before = game.heads[0].x;
  game.step();
  assert.ok(Math.abs(game.heads[0].x - before - 2.8) < .0001);
  assert.equal(game.heads[1].gap, true);
  assert.equal(game.pending.filter((segment) => segment.id === 'player-1').length, 0);
  game.heads[0].x = 1198;
  game.step();
  assert.deepEqual(game.players.map((player) => player.charges), [2, 2]);
});

test('next round resets trails and positions; lobby clears match state', () => {
  const game = running();
  game.heads[0].x = 1198;
  game.step();
  game.takeSegments();
  game.startRound();
  assert.equal(game.round, 2);
  assert.equal(game.phase, 'countdown');
  assert.equal(game.winnerId, undefined);
  assert.equal(game.segments.length, 0);
  assert.equal(game.heads.every((head) => head.alive), true);
  game.lobby();
  assert.equal(game.phase, 'lobby');
  assert.deepEqual(game.players.map((player) => player.score), [0, 0]);
  assert.equal(game.heads.length, 0);
});

test('natural eight-tick gaps stay wide enough to cross and restore a power charge', () => {
  const game = running();
  game.settings.gaps = true;
  game.heads[0].x = 200.8;
  game.step();
  const start = game.heads[0].x;
  game.heads[0].nextGap = game.tick + 1;
  for (let i = 0; i < 8; i++) game.step();
  const end = game.heads[0].x;
  for (let i = 0; i < 3; i++) game.step();
  game.players[1].charges = 0;
  Object.assign(game.heads[1], { x: (start + end) / 2, y: 210, angle: -Math.PI / 2 });
  for (let i = 0; i < 10; i++) game.step();
  assert.equal(game.heads[1].alive, true);
  assert.ok(game.players[1].charges >= 1);
  assert.ok(game.heads[1].y < 200);
});

test('an unattended round ends normally within thirty seconds and awards points', () => {
  const game = running(3);
  for (let i = 0; i < 1800 && game.phase === 'playing'; i++) game.step();
  assert.equal(game.phase, 'roundEnd');
  assert.ok(game.players.some((player) => player.score > 0));
  assert.ok(game.winnerId);
  assert.equal(game.heads.filter((head) => head.alive).length, 1);
});

test('pause freezes countdown, movement and power duration until the host resumes', () => {
  const game = running();
  game.players[0].power = 'boost';
  game.input('player-0', 0, true);
  game.pause();
  const before = { tick: game.tick, x: game.heads[0].x, until: game.heads[0].powerUntil };
  for (let i = 0; i < 600; i++) game.step();
  assert.equal(game.phase, 'paused');
  assert.deepEqual({ tick: game.tick, x: game.heads[0].x, until: game.heads[0].powerUntil }, before);
  game.pause();
  game.step();
  assert.equal(game.phase, 'playing');
  assert.equal(game.heads[0].powerActive, true);
  const countdown = new Game(players(), { ...DEFAULT_SETTINGS });
  countdown.start();
  countdown.pause();
  countdown.step();
  assert.equal(countdown.countdown, 180);
  countdown.pause();
  assert.equal(countdown.phase, 'countdown');
});

test('players reaching the target together enter a deathmatch excluding other players', () => {
  const game = running(3, 2);
  game.players[0].score = 1;
  game.players[1].score = 1;
  game.eliminate(['player-2']);
  assert.deepEqual(game.players.map((player) => player.score), [2, 2, 0]);
  game.eliminate(['player-1']);
  assert.equal(game.phase, 'roundEnd');
  assert.deepEqual(game.deathmatch, ['player-0', 'player-1']);
  game.startRound();
  assert.deepEqual(game.heads.map((head) => head.id), ['player-0', 'player-1']);
  for (let i = 0; i < 180; i++) game.step();
  game.eliminate(['player-0']);
  assert.equal(game.phase, 'finished');
  assert.equal(game.winnerId, 'player-1');
});
