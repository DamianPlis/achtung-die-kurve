import assert from "node:assert/strict";
import test from "node:test";
import type { Player } from "../shared/types.js";
import {
  DEFAULT_SETTINGS,
  Game,
  MAX_HEADS_PER_PLAYER,
  MAX_ALIVE_HEADS,
} from "../server/game.js";

function players(count = 2): Player[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `player-${index}`,
    deviceId: `device-${index}`,
    name: `Player ${index}`,
    color: "#ffffff",
    score: 0,
    connected: true,
    power: "none",
    charges: 2,
  }));
}
function running(count = 2, targetScore = 0) {
  const game = new Game(
    players(count),
    { ...DEFAULT_SETTINGS, targetScore, gaps: false },
    () => 0.5,
  );
  game.start();
  game.beginCountdown();
  for (let i = 0; i < 180; i++) game.step();
  game.heads.forEach((head, index) => {
    head.x = 200 + index * 300;
    head.y = 200 + index * 150;
    head.angle = 0;
  });
  return game;
}

test("classic countdown, movement, and steering run on fixed simulation ticks", () => {
  const game = running(3);
  assert.equal(game.phase, "playing");
  assert.equal(game.matchTarget, 20);
  game.step();
  assert.ok(Math.abs(game.heads[0].x - 201.4) < 0.0001);
  game.input("player-0", 1);
  game.step();
  assert.equal(game.heads[0].angle, 0.035);
  assert.ok(game.heads[0].y > 200);
  const segments = game.takeSegments();
  assert.equal(
    segments.length,
    3,
    "three ticks of continuous trail collapse to one segment per player",
  );
  assert.equal(game.segments.length, 3);
});

test("wall elimination awards every survivor, and first to target wins", () => {
  const game = running(3, 2);
  game.heads[0].x = 1198;
  game.step();
  assert.equal(game.heads[0].alive, false);
  assert.deepEqual(
    game.players.map((player) => player.score),
    [0, 1, 1],
  );
  game.heads[1].x = 1198;
  game.step();
  assert.deepEqual(
    game.players.map((player) => player.score),
    [0, 1, 2],
  );
  assert.equal(game.phase, "finished");
  assert.equal(game.winnerId, "player-2");
});

test("trail occupancy detects another trail but permits the recent own trail", () => {
  const game = running();
  for (let i = 0; i < 12; i++) game.step();
  assert.equal(game.heads[0].alive, true);
  Object.assign(game.heads[1], { x: 210, y: 207, angle: -Math.PI / 2 });
  for (let i = 0; i < 5 && game.phase === "playing"; i++) game.step();
  assert.equal(game.heads[1].alive, false);
  assert.equal(game.players[0].score, 1);
  assert.equal(game.phase, "roundEnd");
  assert.equal(game.winnerId, "player-0");
});

test("same-tick head collision eliminates both without awarding either a point", () => {
  const game = running();
  Object.assign(game.heads[0], { x: 500, y: 400, angle: 0 });
  Object.assign(game.heads[1], { x: 505, y: 400, angle: Math.PI });
  game.step();
  assert.deepEqual(
    game.heads.map((head) => head.alive),
    [false, false],
  );
  assert.deepEqual(
    game.players.map((player) => player.score),
    [0, 0],
  );
  assert.equal(game.phase, "roundEnd");
});

test("jump spends one charge and crosses a trail without drawing the jump", () => {
  const game = running();
  game.players[0].power = "jump";
  const before = game.heads[0].x;
  assert.equal(game.input("player-0", 0, true), true);
  assert.ok(Math.abs(game.heads[0].x - before - 33.6) < 0.0001);
  assert.equal(game.players[0].charges, 1);
  assert.equal(game.pending.length, 0);
  assert.equal(
    game.input("player-0", 0, true),
    false,
    "jump cooldown prevents repeated packets from spending all charges",
  );
  game.step();
  assert.equal(game.pending[0].x1, before + 33.6);
});

test("boost and shield have bounded server-side duration and recharge after rounds", () => {
  const game = running();
  game.players[0].power = "boost";
  game.players[1].power = "shield";
  assert.equal(game.input("player-0", 0, true), true);
  assert.equal(game.input("player-1", 0, true), true);
  const before = game.heads[0].x;
  game.step();
  assert.ok(Math.abs(game.heads[0].x - before - 2.8) < 0.0001);
  assert.equal(game.heads[1].gap, true);
  assert.equal(
    game.pending.filter((segment) => segment.id === "player-1").length,
    0,
  );
  game.heads[0].x = 1198;
  game.step();
  assert.deepEqual(
    game.players.map((player) => player.charges),
    [2, 2],
  );
});

test("next round resets trails and positions; lobby clears match state", () => {
  const game = running();
  game.heads[0].x = 1198;
  game.step();
  game.takeSegments();
  game.startRound();
  assert.equal(game.round, 2);
  assert.equal(game.phase, "ready");
  game.beginCountdown();
  assert.equal(game.phase, "countdown");
  assert.equal(game.winnerId, undefined);
  assert.equal(game.segments.length, 0);
  assert.equal(
    game.heads.every((head) => head.alive),
    true,
  );
  game.lobby();
  assert.equal(game.phase, "lobby");
  assert.deepEqual(
    game.players.map((player) => player.score),
    [0, 0],
  );
  assert.equal(game.heads.length, 0);
});

test("natural eight-tick gaps stay wide enough to cross and restore a power charge", () => {
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
  game.players[1].power = "jump";
  Object.assign(game.heads[1], {
    x: (start + end) / 2,
    y: 210,
    angle: -Math.PI / 2,
  });
  for (let i = 0; i < 10; i++) game.step();
  assert.equal(game.heads[1].alive, true);
  assert.ok(game.players[1].charges >= 1);
  assert.ok(game.heads[1].y < 200);
});

test("every original power is server-owned, and instant abilities require release", () => {
  const game = running(3);
  game.players[0].power = "slow";
  game.input("player-0", 1, true);
  const x = game.heads[0].x;
  game.step();
  assert.ok(Math.abs(game.heads[0].x - x - Math.cos(0.035) * 0.7) < 0.00001);
  assert.equal(game.heads[0].turnRate, 2.1);
  assert.equal(game.heads[0].powerUntil, 180 + 360);
  game.players[1].power = "dark";
  assert.equal(game.input("player-1", 0, true), true);
  assert.equal(game.effects.darkUntil, game.tick + 180);
  game.input("player-1", 0, false);
  assert.equal(
    game.input("player-1", 0, true),
    false,
    "an existing blackout cannot be extended",
  );
  assert.equal(game.players[1].charges, 1);
  game.players[2].power = "bar";
  assert.equal(game.input("player-2", 0, true), true);
  assert.equal(game.input("player-2", 0, true), false);
  const bar = game.pending.at(-1)!;
  assert.ok(
    Math.abs(Math.hypot(bar.x2 - bar.x1, bar.y2 - bar.y1) - 100) < 0.00001,
  );
  assert.equal(bar.id, "player-2");
  game.input("player-2", 0, false);
  assert.equal(game.input("player-2", 0, true), true);
});

test("boost doubles steering, square turns once per edge, and expiry restores ordinary steering", () => {
  const game = running(3);
  game.players[0].power = "boost";
  game.input("player-0", 1, true);
  game.step();
  assert.equal(game.heads[0].angle, 0.07);
  assert.equal(game.heads[0].turnRate, 4.2);
  game.players[1].power = "square";
  game.heads[1].angle = 0.2;
  game.input("player-1", 0, true);
  assert.equal(game.heads[1].angle, 0);
  game.input("player-1", 1, false);
  assert.equal(game.heads[1].angle, Math.PI / 2);
  game.input("player-1", 1, false);
  game.step();
  assert.equal(game.heads[1].angle, Math.PI / 2);
  game.input("player-1", 0, false);
  game.input("player-1", 1, false);
  assert.equal(game.heads[1].angle, Math.PI);
  game.tick = game.heads[1].powerUntil;
  const publicHead = game.publicHeads().find((head) => head.id === "player-1")!;
  assert.equal(publicHead.square, false);
  assert.equal(publicHead.powerActive, false);
});

test("invisible bypasses trails and borders only for its timed duration", () => {
  const game = running();
  game.players[0].power = "shield";
  game.input("player-0", 0, true);
  game.heads[0].x = game.width - 1;
  game.step();
  assert.equal(game.heads[0].alive, true);
  assert.ok(game.heads[0].x > game.width);
  assert.equal(
    game.pending.some((segment) => segment.id === "player-0"),
    false,
  );
  game.tick = game.heads[0].powerUntil;
  game.step();
  assert.equal(game.heads[0].alive, false);
});

test("invisible movement does not create an invisible trail of power pickups", () => {
  const game = running(3);
  game.players[0].power = "shield";
  game.players[1].power = "jump";
  game.input("player-0", 0, true);
  game.players[1].charges = 0;
  for (let i = 0; i < 20; i++) game.step();
  Object.assign(game.heads[1], { x: 214, y: 210, angle: -Math.PI / 2 });
  for (let i = 0; i < 15; i++) game.step();
  assert.equal(game.heads[1].alive, true);
  assert.equal(game.players[1].charges, 0);
});

test("cross walls spends the last charge once and cannot wrap a second time", () => {
  const game = running(3);
  game.players[0].power = "wrap";
  game.players[0].charges = 1;
  game.heads[0].x = game.width - 2;
  assert.equal(
    game.input("player-0", 0, true),
    false,
    "cross walls is passive",
  );
  game.step();
  assert.equal(game.heads[0].alive, true);
  assert.equal(game.players[0].charges, 0);
  assert.ok(game.heads[0].x < 4);
  assert.equal(game.heads[0].revision, 1);
  assert.ok(
    game.pending.every((segment) => Math.abs(segment.x2 - segment.x1) < 5),
    "no trail joins opposite edges",
  );
  game.heads[0].x = game.width - 2;
  game.step();
  assert.equal(game.heads[0].alive, false);
});

test("Hydra steers all owned heads and scores only when the final head dies", () => {
  const game = running(3);
  game.players[0].power = "hydra";
  assert.equal(game.input("player-0", 0, true), true);
  const owned = game.heads.filter((head) => head.ownerId === "player-0");
  assert.equal(owned.length, 2);
  assert.equal(new Set(owned.map((head) => head.id)).size, 2);
  game.input("player-0", 1, false);
  assert.ok(owned.every((head) => head.turn === 1));
  Object.assign(owned[0], { x: game.width - 1, angle: 0 });
  game.step();
  assert.equal(owned[0].alive, false);
  assert.equal(owned[1].alive, true);
  assert.deepEqual(
    game.players.map((player) => player.score),
    [0, 0, 0],
  );
  game.eliminate(["player-0"]);
  assert.deepEqual(
    game.players.map((player) => player.score),
    [0, 1, 1],
  );
});

test("Hydra limits stop exponential replication without spending a charge", () => {
  const game = running(3);
  game.players[0].power = "hydra";
  game.players[0].charges = 6;
  for (let i = 0; i < 4; i++) {
    game.input("player-0", 0, false);
    assert.equal(game.input("player-0", 0, true), true);
  }
  assert.equal(
    game.heads.filter((head) => head.ownerId === "player-0").length,
    MAX_HEADS_PER_PLAYER,
  );
  const charges = game.players[0].charges;
  game.input("player-0", 0, false);
  assert.equal(game.input("player-0", 0, true), false);
  assert.equal(game.players[0].charges, charges);
});

test("Hydra cannot create more than the room-wide live head budget", () => {
  const game = running(50);
  for (const player of game.players) {
    player.power = "hydra";
    player.charges = 6;
    for (let use = 0; use < 4; use++) {
      game.input(player.id, 0, false);
      game.input(player.id, 0, true);
    }
  }
  assert.equal(game.heads.filter((head) => head.alive).length, MAX_ALIVE_HEADS);
  const player = game.players.at(-1)!;
  const before = player.charges;
  game.input(player.id, 0, false);
  assert.equal(game.input(player.id, 0, true), false);
  assert.equal(player.charges, before);
});

test("reverse swaps active ends with a discontinuity and temporary own-trail immunity", () => {
  const game = running(3);
  game.players[0].power = "reverse";
  const head = game.heads[0];
  const spawn = { ...head.reversePose };
  const previous = { x: head.x, y: head.y, angle: head.angle };
  game.input("player-0", 0, true);
  assert.deepEqual({ x: head.x, y: head.y, angle: head.angle }, spawn);
  assert.equal(head.revision, 1);
  game.input("player-0", 0, false);
  game.input("player-0", 0, true);
  assert.deepEqual({ x: head.x, y: head.y, angle: head.angle }, previous);
  assert.equal(head.immuneUntil, game.tick + 10);
});

test("shoot holes erases authoritative trail cells and preserves drawing chronology", () => {
  const game = running(3);
  game.players[0].power = "bar";
  Object.assign(game.heads[0], { x: 250, y: 200, angle: 0 });
  game.input("player-0", 0, true);
  game.step();
  game.players[0].power = "holes";
  game.input("player-0", 0, false);
  Object.assign(game.heads[0], { x: 240, y: 200, angle: 0 });
  const holeTick = game.tick;
  assert.equal(game.input("player-0", 0, true), true);
  assert.equal(game.holes[0].x2 - game.holes[0].x1, 60);
  assert.equal(game.holes[0].width, 8);
  game.step();
  const segments = game.takeSegments();
  assert.ok(segments.some((segment) => segment.tick <= holeTick));
  assert.ok(segments.some((segment) => segment.tick > holeTick));
  assert.equal(game.heads[0].alive, true);
  assert.equal(game.takeHoles()[0].tick, holeTick);
  assert.equal(game.takeHoles().length, 0);
});

test("draw event order distinguishes a hole and a new bar in the same simulation tick", () => {
  const game = running(3);
  game.players[0].power = "holes";
  game.players[1].power = "bar";
  Object.assign(game.heads[0], { x: 200, y: 200, angle: 0 });
  Object.assign(game.heads[1], { x: 230, y: 200, angle: 0 });
  game.input("player-0", 0, true);
  game.input("player-1", 0, true);
  const hole = game.holes[0];
  const bar = game.takeSegments()[0];
  assert.equal(bar.tick, hole.tick);
  assert.ok(
    bar.order > hole.order,
    "new trail must be painted after an earlier same-tick erase",
  );
  game.players[0].power = "jump";
  Object.assign(game.heads[0], { x: 222, y: 200, angle: 0 });
  for (let i = 0; i < 6; i++) game.step();
  assert.equal(
    game.heads[0].alive,
    false,
    "the freshly created bar remains solid after the earlier hole",
  );
});

test("round results clear the global blackout and timed effects", () => {
  const game = running(3);
  game.players[0].power = "dark";
  game.players[1].power = "shield";
  game.input("player-0", 0, true);
  game.input("player-1", 0, true);
  assert.ok(game.effects.darkUntil > game.tick);
  game.eliminate(["player-0", "player-2"]);
  assert.equal(game.phase, "roundEnd");
  assert.equal(game.effects.darkUntil, 0);
  assert.equal(
    game.publicHeads().find((head) => head.ownerId === "player-1")!.invisible,
    false,
  );
});

test("random resolves once per round, no-power choices do not gain charges, and arena stays fixed", () => {
  const game = running(50);
  assert.equal(game.width, 3466);
  assert.equal(game.height, 2310);
  assert.equal(game.matchTarget, 490);
  game.players[0].power = "random";
  game.players[1].power = "chuck";
  game.players[1].charges = 0;
  game.startRound();
  assert.notEqual(game.players[0].roundPower, "random");
  assert.ok(game.players[0].roundPower);
  const dimensions = [game.width, game.height];
  game.players[49].connected = false;
  game.startRound();
  assert.deepEqual([game.width, game.height], dimensions);
  game.beginCountdown();
  for (let i = 0; i < 180; i++) game.step();
  game.eliminate(game.players.slice(2).map((player) => player.id));
  game.eliminate(["player-0"]);
  assert.equal(game.players[1].charges, 0);
});

test("an unattended round ends normally within thirty seconds and awards points", () => {
  const game = running(3);
  for (let i = 0; i < 1800 && game.phase === "playing"; i++) game.step();
  assert.equal(game.phase, "roundEnd");
  assert.ok(game.players.some((player) => player.score > 0));
  assert.ok(game.winnerId);
  assert.equal(game.heads.filter((head) => head.alive).length, 1);
});

test("pause freezes countdown, movement and power duration until the host resumes", () => {
  const game = running();
  game.players[0].power = "boost";
  game.input("player-0", 0, true);
  game.pause();
  const before = {
    tick: game.tick,
    x: game.heads[0].x,
    until: game.heads[0].powerUntil,
  };
  for (let i = 0; i < 600; i++) game.step();
  assert.equal(game.phase, "paused");
  assert.deepEqual(
    { tick: game.tick, x: game.heads[0].x, until: game.heads[0].powerUntil },
    before,
  );
  game.pause();
  game.step();
  assert.equal(game.phase, "playing");
  assert.equal(game.heads[0].powerActive, true);
  const countdown = new Game(players(), { ...DEFAULT_SETTINGS });
  countdown.start();
  countdown.beginCountdown();
  countdown.pause();
  countdown.step();
  assert.equal(countdown.countdown, 180);
  countdown.pause();
  assert.equal(countdown.phase, "countdown");
});

test("paused input cannot turn a square head or change its discontinuity revision", () => {
  const game = running(3);
  game.players[0].power = "square";
  game.input("player-0", 0, true);
  game.pause();
  const before = {
    angle: game.heads[0].angle,
    revision: game.heads[0].revision,
    turn: game.heads[0].turn,
  };
  assert.equal(game.input("player-0", 1, true), false);
  assert.deepEqual(
    {
      angle: game.heads[0].angle,
      revision: game.heads[0].revision,
      turn: game.heads[0].turn,
    },
    before,
  );
  game.pause();
  assert.equal(game.heads[0].turn, 0);
});

test("players reaching the target together enter a deathmatch excluding other players", () => {
  const game = running(3, 2);
  game.players[0].score = 1;
  game.players[1].score = 1;
  game.eliminate(["player-2"]);
  assert.deepEqual(
    game.players.map((player) => player.score),
    [2, 2, 0],
  );
  game.eliminate(["player-1"]);
  assert.equal(game.phase, "roundEnd");
  assert.deepEqual(game.deathmatch, ["player-0", "player-1"]);
  game.startRound();
  game.beginCountdown();
  assert.deepEqual(
    game.heads.map((head) => head.id),
    ["player-0", "player-1"],
  );
  for (let i = 0; i < 180; i++) game.step();
  game.eliminate(["player-0"]);
  assert.equal(game.phase, "finished");
  assert.equal(game.winnerId, "player-1");
});
