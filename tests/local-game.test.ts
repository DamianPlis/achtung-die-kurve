import assert from "node:assert/strict";
import test from "node:test";
import { Game } from "../shared/game.js";
import { LocalRound } from "../src/local-game.js";
import type { RoomView } from "../shared/types.js";

function room(): RoomView {
  return {
    code: "ABCDE",
    hostDeviceId: "device-1",
    players: ["one", "two"].map((id, index) => ({
      id,
      deviceId: "device-1",
      name: id,
      color: index ? "#00f" : "#f00",
      score: index + 3,
      connected: true,
      power: "boost",
      roundPower: "boost",
      charges: index + 2,
    })),
    powerRules: { everyone: null, players: {} },
    settings: {
      mapSize: "classic",
      customMapSize: 100,
      speed: "normal",
      targetScore: 0,
      gaps: false,
      gapSize: "large",
      customGapSize: 24,
    },
    phase: "ready",
    round: 4,
    matchTarget: 10,
    width: 1200,
    height: 800,
    deathmatch: ["one", "two"],
  };
}

test("Game.fromRoom preserves the match and starts the same numbered round on fixed dimensions", () => {
  const source = room();
  const game = Game.fromRoom(source);

  assert.equal(game.round, source.round);
  assert.equal(game.matchTarget, source.matchTarget);
  assert.deepEqual(game.deathmatch, source.deathmatch);
  assert.deepEqual([game.width, game.height], [source.width, source.height]);
  assert.deepEqual(game.players.map(({ score, charges }) => [score, charges]), [[3, 2], [4, 3]]);
  assert.equal(game.phase, "ready");
  game.players[0].score++;
  game.settings.speed = "fast";
  assert.equal(source.players[0].score, 3);
  assert.equal(source.settings.speed, "normal");
});

test("LocalRound steps controls locally and only records owners eliminated in each step", () => {
  const round = new LocalRound(room());
  round.game.beginCountdown();
  for (let i = 0; i < 180; i++) round.step();
  assert.equal(round.game.phase, "playing");

  round.game.heads[0].x = 500;
  round.game.heads[0].y = 200;
  round.game.heads[0].angle = 0;
  round.game.heads[1].x = 1000;
  round.game.heads[1].y = 600;
  round.game.heads[1].angle = 0;
  round.game.input("two", 1);
  round.step();
  assert.ok(round.game.heads.find((head) => head.ownerId === "two")!.angle > 0);

  round.game.heads.find((head) => head.ownerId === "one")!.x = 2;
  round.game.heads.find((head) => head.ownerId === "one")!.angle = Math.PI;
  round.step();

  assert.deepEqual(round.eliminations, [["one"]]);
  assert.equal(round.game.players[1].score, 5);
  assert.deepEqual(round.result(), {
    type: "localEnd",
    round: 4,
    tick: 182,
    eliminations: [["one"]],
    players: [
      { id: "one", charges: 2, roundPower: "boost" },
      { id: "two", charges: 3, roundPower: "boost" },
    ],
  });
});

test("LocalRound does not advance ready or completed phases", () => {
  const round = new LocalRound(room());
  assert.equal(round.step(), false);
  assert.equal(round.game.tick, 0);
  round.game.phase = "finished";
  assert.equal(round.step(), false);
  assert.equal(round.game.tick, 0);
});

test("reloading a local round keeps queued guests out of its simulation and result", () => {
  const source = room();
  source.localRound = { deviceId: "device-1", completed: false };
  source.players.push({ ...source.players[0], id: "guest", deviceId: "device-2" });
  const round = new LocalRound(source);
  assert.deepEqual(round.game.players.map(player => player.id), ["one", "two"]);
  assert.deepEqual(round.result().players.map(player => player.id), ["one", "two"]);
});
