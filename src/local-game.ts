import { Game } from "../shared/game.js";
import type { ClientMessage, RoomView } from "../shared/types.js";

export type LocalEndMessage = Extract<ClientMessage, { type: "localEnd" }>;

export class LocalRound {
  // shortcut: unfinished rounds restart on reload; persist checkpoints if reload recovery is needed.
  readonly game: Game;
  readonly eliminations: string[][] = [];

  constructor(room: RoomView) {
    this.game = Game.fromRoom({
      ...room,
      players: room.localRound
        ? room.players.filter(player => player.deviceId === room.localRound!.deviceId)
        : room.players,
    });
  }

  step(): boolean {
    if (this.game.phase !== "countdown" && this.game.phase !== "playing")
      return false;
    const alive = new Set(
      this.game.heads.filter((head) => head.alive).map((head) => head.ownerId),
    );
    const changed = this.game.step();
    const remaining = new Set(
      this.game.heads.filter((head) => head.alive).map((head) => head.ownerId),
    );
    const eliminated = [...alive].filter((id) => !remaining.has(id));
    if (eliminated.length) this.eliminations.push(eliminated);
    return changed;
  }

  result(): LocalEndMessage {
    return {
      type: "localEnd",
      round: this.game.round,
      tick: this.game.tick,
      eliminations: this.eliminations.map((group) => [...group]),
      players: this.game.players.map(({ id, charges, roundPower }) => ({
        id,
        charges,
        roundPower,
      })),
    };
  }
}
