import type { GameSettings, Head, Phase, Player, Segment, Turn } from '../shared/types.js';

export const WIDTH = 1200;
export const HEIGHT = 800;
export const DEFAULT_SETTINGS: GameSettings = { speed: 'normal', targetScore: 0, gaps: true };
const SPEED = { slow: 60, normal: 84, fast: 115 };
const GRID = 2;
const COLS = WIDTH / GRID;
const ROWS = HEIGHT / GRID;

interface Runner extends Head {
  turn: Turn;
  index: number;
  nextGap: number;
  gapUntil: number;
  powerUntil: number;
  powerReady: number;
  pickupReady: number;
}

export class Game {
  phase: Phase = 'lobby';
  round = 0;
  tick = 0;
  countdown = 0;
  winnerId?: string;
  deathmatch?: string[];
  matchTarget = 0;
  heads: Runner[] = [];
  segments: Segment[] = [];
  pending: Segment[] = [];
  private occupied = new Uint8Array(COLS * ROWS);
  private written = new Uint32Array(COLS * ROWS);
  private gaps = new Uint8Array(COLS * ROWS);
  private pausedPhase: 'countdown' | 'playing' = 'playing';

  constructor(public players: Player[], public settings: GameSettings, private random = Math.random) {}

  start() {
    if (this.players.filter((player) => player.connected).length < 2) throw new Error('Add at least two connected players to start.');
    for (const player of this.players) { player.score = 0; player.charges = 2; }
    this.round = 0;
    this.matchTarget = this.settings.targetScore || (this.players.length - 1) * 10;
    this.winnerId = undefined;
    this.deathmatch = undefined;
    this.startRound();
  }

  startRound() {
    const eligible = this.players.filter((player) => player.connected && (!this.deathmatch || this.deathmatch.includes(player.id)));
    if (this.deathmatch && eligible.length === 1) { this.phase = 'finished'; this.winnerId = eligible[0].id; return; }
    if (eligible.length < 2) throw new Error('At least two connected players are needed for the next round.');
    this.round++;
    this.winnerId = undefined;
    this.phase = 'countdown';
    this.countdown = 180;
    this.segments = [];
    this.pending = [];
    this.occupied.fill(0);
    this.written.fill(0);
    this.gaps.fill(0);
    this.heads = [];
    this.players.forEach((player, index) => {
      if (!eligible.includes(player)) return;
      let x = 0, y = 0;
      for (let attempt = 0; attempt < 200; attempt++) {
        x = 80 + this.random() * (WIDTH - 160);
        y = 80 + this.random() * (HEIGHT - 160);
        if (this.heads.every((head) => Math.hypot(head.x - x, head.y - y) > 75)) break;
      }
      this.heads.push({ id: player.id, x, y, angle: Math.atan2(HEIGHT / 2 - y, WIDTH / 2 - x) + (this.random() - .5), alive: true, gap: false, powerActive: false, turn: 0, index: index + 1, nextGap: this.tick + 180 + this.gapDelay(), gapUntil: 0, powerUntil: 0, powerReady: 0, pickupReady: 0 });
    });
  }

  lobby() {
    this.phase = 'lobby';
    this.heads = [];
    this.segments = [];
    this.pending = [];
    this.round = 0;
    this.matchTarget = 0;
    this.winnerId = undefined;
    this.deathmatch = undefined;
    for (const player of this.players) { player.score = 0; player.charges = 2; }
  }

  input(id: string, turn: Turn, power = false): boolean {
    const head = this.heads.find((item) => item.id === id);
    if (!head || !head.alive) return false;
    head.turn = turn;
    if (!power || this.phase !== 'playing') return false;
    const player = this.players.find((item) => item.id === id)!;
    if (player.power === 'none' || player.charges < 1 || this.tick < head.powerReady) return false;
    player.charges--;
    if (player.power === 'jump') {
      head.x += Math.cos(head.angle) * 33.6;
      head.y += Math.sin(head.angle) * 33.6;
      head.powerReady = this.tick + 15;
    } else {
      head.powerUntil = this.tick + 240;
      head.powerReady = head.powerUntil;
      head.powerActive = true;
    }
    return true;
  }

  stopInputs(ids: string[]) {
    for (const head of this.heads) if (ids.includes(head.id)) head.turn = 0;
  }

  pause() {
    if (this.phase === 'paused') this.phase = this.pausedPhase;
    else if (this.phase === 'playing' || this.phase === 'countdown') { this.pausedPhase = this.phase; this.phase = 'paused'; }
    else throw new Error('A running round can be paused.');
  }

  eliminate(ids: string[]): boolean {
    const dead = this.heads.filter((head) => head.alive && ids.includes(head.id));
    if (!dead.length) return false;
    for (const head of dead) head.alive = false;
    const survivors = this.heads.filter((head) => head.alive);
    for (const head of survivors) this.players.find((player) => player.id === head.id)!.score += dead.length;
    if (survivors.length <= 1 && (this.phase === 'playing' || this.phase === 'paused')) {
      const maximum = Math.max(...this.players.map((player) => player.score));
      const qualified = this.players.filter((player) => player.score >= this.matchTarget);
      if ((this.deathmatch && survivors.length === 1) || (!this.deathmatch && qualified.length === 1)) {
        this.phase = 'finished';
        this.winnerId = this.deathmatch ? survivors[0].id : qualified[0].id;
      } else {
        this.phase = 'roundEnd';
        this.winnerId = survivors[0]?.id;
        if (!this.deathmatch && qualified.length > 1) this.deathmatch = qualified.map((player) => player.id);
        const minimum = Math.min(...this.players.map((player) => player.score));
        for (const player of this.players) {
          const extra = this.players.length === 2 ? 1 : Number(player.score < maximum) + Number(player.score === minimum);
          player.charges = Math.min(6, player.charges + extra);
        }
      }
    }
    return true;
  }

  step(): boolean {
    if (this.phase === 'paused') return false;
    this.tick++;
    if (this.phase === 'countdown') {
      this.countdown--;
      if (!this.countdown) { this.phase = 'playing'; return true; }
      return false;
    }
    if (this.phase !== 'playing') return false;
    const alive = this.heads.filter((head) => head.alive);
    const dead: string[] = [];
    const movements: { head: Runner; x: number; y: number; shield: boolean }[] = [];
    let changed = false;
    for (const head of alive) {
      const player = this.players.find((item) => item.id === head.id)!;
      head.angle += head.turn * 2.1 / 60;
      head.powerActive = this.tick < head.powerUntil;
      const shield = player.power === 'shield' && head.powerActive;
      if (this.settings.gaps && this.tick >= head.nextGap) {
        head.gapUntil = this.tick + 8;
        head.nextGap = this.tick + this.gapDelay();
      }
      head.gap = shield || this.tick < head.gapUntil;
      const distance = SPEED[this.settings.speed] / 60 * (player.power === 'boost' && head.powerActive ? 2 : 1);
      const x = head.x + Math.cos(head.angle) * distance;
      const y = head.y + Math.sin(head.angle) * distance;
      movements.push({ head, x, y, shield });
      if (x < 2 || x > WIDTH - 2 || y < 2 || y > HEIGHT - 2 || (!shield && this.collides(head, x, y))) dead.push(head.id);
      if (this.tick >= head.pickupReady && player.charges < 6) {
        const owner = this.gaps[Math.floor(y / GRID) * COLS + Math.floor(x / GRID)];
        if (owner && owner !== head.index) { player.charges++; head.pickupReady = this.tick + 5; changed = true; }
      }
    }
    for (let i = 0; i < movements.length; i++) for (let j = i + 1; j < movements.length; j++) {
      const a = movements[i], b = movements[j];
      if (!a.shield && !b.shield && Math.hypot(a.x - b.x, a.y - b.y) < 4) dead.push(a.head.id, b.head.id);
    }
    for (const { head, x, y } of movements) {
      if (!dead.includes(head.id)) {
        const segment = { id: head.id, x1: head.x, y1: head.y, x2: x, y2: y };
        this.raster(head, x, y, head.gap);
        if (!head.gap) this.pending.push(segment);
      }
      head.x = Math.max(0, Math.min(WIDTH, x));
      head.y = Math.max(0, Math.min(HEIGHT, y));
    }
    return this.eliminate(dead) || changed;
  }

  publicHeads(): Head[] {
    return this.heads.map(({ id, x, y, angle, alive, gap, powerActive }) => ({ id, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, angle: Math.round(angle * 1000) / 1000, alive, gap, powerActive }));
  }

  takeSegments(): Segment[] {
    const pending: Segment[] = [];
    const last = new Map<string, Segment>();
    for (const segment of this.pending) {
      const previous = last.get(segment.id);
      if (previous && previous.x2 === segment.x1 && previous.y2 === segment.y1) {
        previous.x2 = segment.x2;
        previous.y2 = segment.y2;
      } else {
        const copy = { ...segment };
        pending.push(copy);
        last.set(segment.id, copy);
      }
    }
    for (const segment of pending) {
      segment.x1 = Math.round(segment.x1 * 10) / 10;
      segment.y1 = Math.round(segment.y1 * 10) / 10;
      segment.x2 = Math.round(segment.x2 * 10) / 10;
      segment.y2 = Math.round(segment.y2 * 10) / 10;
    }
    this.segments.push(...pending);
    this.pending = [];
    return pending;
  }

  private gapDelay() { return 150 + Math.floor(this.random() * 300); }

  private collides(head: Runner, x: number, y: number): boolean {
    const steps = Math.max(1, Math.ceil(Math.hypot(x - head.x, y - head.y)));
    for (let step = 1; step <= steps; step++) {
      const px = head.x + (x - head.x) * step / steps;
      const py = head.y + (y - head.y) * step / steps;
      const cx = Math.floor(px / GRID);
      const cy = Math.floor(py / GRID);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (cx + dx < 0 || cx + dx >= COLS || cy + dy < 0 || cy + dy >= ROWS) continue;
        if (((cx + dx + .5) * GRID - px) ** 2 + ((cy + dy + .5) * GRID - py) ** 2 > 4) continue;
        const index = (cy + dy) * COLS + cx + dx;
        const owner = this.occupied[index];
        if (owner && (owner !== head.index || this.tick - this.written[index] > 8)) return true;
      }
    }
    return false;
  }

  private raster(head: Runner, x: number, y: number, gap: boolean) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x - head.x, y - head.y)));
    for (let step = 0; step <= steps; step++) {
      const px = head.x + (x - head.x) * step / steps;
      const py = head.y + (y - head.y) * step / steps;
      const cx = Math.floor(px / GRID);
      const cy = Math.floor(py / GRID);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (cx + dx < 0 || cx + dx >= COLS || cy + dy < 0 || cy + dy >= ROWS) continue;
        if (((cx + dx + .5) * GRID - px) ** 2 + ((cy + dy + .5) * GRID - py) ** 2 > 4) continue;
        const index = (cy + dy) * COLS + cx + dx;
        if (gap) this.gaps[index] = head.index;
        else { this.occupied[index] = head.index; this.written[index] = this.tick; }
      }
    }
  }
}
