export type Turn = -1 | 0 | 1;
export type Power = 'none' | 'jump' | 'boost' | 'shield';
export type Phase = 'lobby' | 'countdown' | 'playing' | 'paused' | 'roundEnd' | 'finished';

export interface GameSettings {
  speed: 'slow' | 'normal' | 'fast';
  targetScore: number;
  gaps: boolean;
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
  x: number;
  y: number;
  angle: number;
  alive: boolean;
  gap: boolean;
  powerActive: boolean;
}

export interface Segment {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type ClientMessage =
  | { type: 'create'; deviceId: string; sessionToken: string; players: LocalPlayer[]; settings?: Partial<GameSettings> }
  | { type: 'join'; code: string; deviceId: string; sessionToken: string; players: LocalPlayer[] }
  | { type: 'spectate'; code: string; deviceId: string; sessionToken: string }
  | { type: 'players'; players: LocalPlayer[] }
  | { type: 'input'; inputs: { id: string; turn: Turn; power?: boolean }[] }
  | { type: 'start' | 'next' | 'lobby' | 'pause' }
  | { type: 'settings'; settings: Partial<GameSettings> }
  | { type: 'ping'; at: number };

export type ServerMessage =
  | { type: 'room'; room: RoomView; deviceId: string }
  | { type: 'snapshot'; room: RoomView; deviceId: string; tick: number; heads: Head[]; segments: Segment[] }
  | { type: 'frame'; tick: number; heads: Head[]; segments: Segment[]; countdown?: number }
  | { type: 'error'; message: string }
  | { type: 'pong'; at: number };
