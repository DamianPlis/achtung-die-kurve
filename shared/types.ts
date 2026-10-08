export type Turn = -1 | 0 | 1;
export const POWERS = [
  "none",
  "jump",
  "boost",
  "slow",
  "shield",
  "bar",
  "wrap",
  "dark",
  "hydra",
  "reverse",
  "square",
  "chuck",
  "holes",
  "random",
] as const;
export type Power = (typeof POWERS)[number];
export type Phase =
  "lobby" | "countdown" | "playing" | "paused" | "roundEnd" | "finished";

export interface GameSettings {
  speed: "slow" | "normal" | "fast";
  targetScore: number;
  gaps: boolean;
  gapSize: "small" | "medium" | "large" | "custom";
  customGapSize: number;
}
export interface LocalPlayer {
  id: string;
  name: string;
  power?: Power;
}
export interface Player extends LocalPlayer {
  deviceId: string;
  color: string;
  score: number;
  connected: boolean;
  power: Power;
  roundPower?: Power;
  charges: number;
}
export interface RoomView {
  code: string;
  hostDeviceId: string;
  players: Player[];
  settings: GameSettings;
  phase: Phase;
  round: number;
  matchTarget: number;
  width: number;
  height: number;
  winnerId?: string;
  deathmatch?: string[];
}
export interface Head {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  angle: number;
  alive: boolean;
  gap: boolean;
  powerActive: boolean;
  turn: Turn;
  speed: number;
  turnRate: number;
  revision: number;
  wrap: boolean;
  square: boolean;
  invisible: boolean;
  invulnerable: boolean;
}
export interface Segment {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  tick: number;
  order: number;
}
export interface Hole {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  tick: number;
  order: number;
}
export interface WorldEffects {
  darkUntil: number;
}
export interface WorldFrame {
  tick: number;
  heads: Head[];
  segments: Segment[];
  holes: Hole[];
  trailRevision: number;
  effects: WorldEffects;
  phase: Phase;
  inputAck: number;
  countdown?: number;
}
export type ClientMessage =
  | {
      type: "create";
      deviceId: string;
      sessionToken: string;
      players: LocalPlayer[];
      settings?: Partial<GameSettings>;
    }
  | {
      type: "join";
      code: string;
      deviceId: string;
      sessionToken: string;
      players: LocalPlayer[];
    }
  | { type: "spectate"; code: string; deviceId: string; sessionToken: string }
  | { type: "players"; players: LocalPlayer[] }
  | {
      type: "input";
      seq?: number;
      inputs: { id: string; turn: Turn; power?: boolean }[];
    }
  | { type: "start" | "next" | "lobby" | "pause" }
  | { type: "settings"; settings: Partial<GameSettings> }
  | { type: "ping"; at: number };
export type ServerMessage =
  | { type: "room"; room: RoomView; deviceId: string }
  | ({ type: "snapshot"; room: RoomView; deviceId: string } & WorldFrame)
  | ({ type: "frame" } & WorldFrame)
  | { type: "error"; message: string }
  | { type: "pong"; at: number };
