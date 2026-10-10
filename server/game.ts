import { advancePose, type Pose } from "../shared/movement.js";
import { getMapDimensions } from "../shared/map-size.js";
import {
  MAP_SIZES,
  POWERS,
  type GameSettings,
  type Head,
  type Hole,
  type Phase,
  type Player,
  type Power,
  type Segment,
  type Turn,
  type WorldEffects,
} from "../shared/types.js";

export const WIDTH = MAP_SIZES.recommended.width;
export const HEIGHT = MAP_SIZES.recommended.height;
export const MAX_PLAYERS = 50;
export const MAX_HEADS_PER_PLAYER = 16;
export const MAX_ALIVE_HEADS = 256;
export const DEFAULT_SETTINGS: GameSettings = {
  mapSize: "recommended",
  customMapSize: 100,
  speed: "normal",
  targetScore: 0,
  gaps: true,
  gapSize: "large",
  customGapSize: 24,
};
const SPEED = { slow: 60, normal: 84, fast: 115 };
const GAP_SIZE = { small: 8, medium: 16, large: 24 };
const GRID = 2;
const DURATION: Partial<Record<Power, number>> = {
  boost: 240,
  slow: 360,
  shield: 240,
  square: 360,
  dark: 180,
};

interface Runner extends Head {
  index: number;
  ownerIndex: number;
  nextGap: number;
  gapUntil: number;
  powerUntil: number;
  immuneUntil: number;
  reversePose: Pose;
}
interface Control {
  turn: Turn;
  powerDown: boolean;
  until: number;
  active?: Power;
  pickupReady: number;
}

export class Game {
  phase: Phase = "lobby";
  width: number = WIDTH;
  height: number = HEIGHT;
  round = 0;
  tick = 0;
  countdown = 0;
  winnerId?: string;
  deathmatch?: string[];
  matchTarget = 0;
  trailRevision = 0;
  trailColors: Record<string, string> = Object.create(null);
  effects: WorldEffects = { darkUntil: 0 };
  heads: Runner[] = [];
  segments: Segment[] = [];
  pending: (Segment & { headId: string })[] = [];
  holes: Hole[] = [];
  pendingHoles: Hole[] = [];
  private cols = WIDTH / GRID;
  private rows = HEIGHT / GRID;
  private occupied = new Uint32Array(this.cols * this.rows);
  private written = new Uint32Array(this.cols * this.rows);
  private gaps = new Uint8Array(this.cols * this.rows);
  private controls = new Map<string, Control>();
  private headOwners = new Map<number, string>();
  private headIndex = 0;
  private holeIndex = 0;
  private drawOrder = 0;
  private eraseOrders: number[] = [];
  private pausedPhase: "countdown" | "playing" = "playing";

  constructor(
    public players: Player[],
    public settings: GameSettings,
    private random = Math.random,
  ) {}

  start() {
    const count = this.players.filter((player) => player.connected).length;
    if (count < 2)
      throw new Error("Add at least two connected players to start.");
    const dimensions = getMapDimensions(this.settings, count);
    this.width = dimensions.width;
    this.height = dimensions.height;
    this.cols = this.width / GRID;
    this.rows = this.height / GRID;
    this.occupied = new Uint32Array(this.cols * this.rows);
    this.written = new Uint32Array(this.cols * this.rows);
    this.gaps = new Uint8Array(this.cols * this.rows);
    for (const player of this.players) {
      player.score = 0;
      player.charges = 2;
    }
    this.round = 0;
    this.matchTarget = this.settings.targetScore || (count - 1) * 10;
    this.winnerId = undefined;
    this.deathmatch = undefined;
    this.startRound();
  }

  startRound() {
    const eligible = this.players.filter(
      (player) =>
        player.connected &&
        (!this.deathmatch || this.deathmatch.includes(player.id)),
    );
    if (this.deathmatch && eligible.length <= 1) {
      this.phase = "finished";
      this.winnerId = eligible[0]?.id;
      return;
    }
    if (eligible.length < 2)
      throw new Error(
        "At least two connected players are needed for the next round.",
      );
    this.round++;
    this.winnerId = undefined;
    this.phase = "ready";
    this.countdown = 0;
    this.clearTrails();
    this.effects = { darkUntil: 0 };
    this.heads = [];
    this.controls.clear();
    this.headIndex = 0;
    this.headOwners.clear();
    this.players.forEach((player, index) => {
      if (!eligible.includes(player)) return;
      player.roundPower =
        player.power === "random"
          ? POWERS[Math.floor(this.random() * (POWERS.length - 1))]
          : player.power;
      this.trailColors[player.id] =
        player.roundPower === "chuck" ? "#fff" : player.color;
      this.controls.set(player.id, {
        turn: 0,
        powerDown: false,
        until: 0,
        pickupReady: 0,
      });
      let x = 0,
        y = 0;
      for (let attempt = 0; attempt < 200; attempt++) {
        x = 80 + this.random() * (this.width - 160);
        y = 80 + this.random() * (this.height - 160);
        if (this.heads.every((head) => Math.hypot(head.x - x, head.y - y) > 75))
          break;
      }
      const angle =
        Math.atan2(this.height / 2 - y, this.width / 2 - x) +
        (this.random() - 0.5);
      this.heads.push({
        id: player.id,
        ownerId: player.id,
        x,
        y,
        angle,
        alive: true,
        gap: false,
        powerActive: false,
        turn: 0,
        speed: SPEED[this.settings.speed],
        turnRate: 2.1,
        revision: 0,
        wrap: false,
        square: false,
        invisible: false,
        invulnerable: false,
        index: ++this.headIndex,
        ownerIndex: index + 1,
        nextGap: this.tick + 180 + this.gapDelay(),
        gapUntil: 0,
        powerUntil: 0,
        immuneUntil: 0,
        reversePose: { x, y, angle: angle + Math.PI },
      });
      this.headOwners.set(this.headIndex, player.id);
    });
  }

  beginCountdown() {
    if (this.phase !== "ready")
      throw new Error("The round is not ready for countdown.");
    this.phase = "countdown";
    this.countdown = 180;
  }

  private clearTrails() {
    this.trailRevision++;
    this.trailColors = Object.create(null);
    this.segments = [];
    this.pending = [];
    this.holes = [];
    this.pendingHoles = [];
    this.drawOrder = 0;
    this.eraseOrders = [];
    this.occupied.fill(0);
    this.written.fill(0);
    this.gaps.fill(0);
  }

  lobby() {
    this.phase = "lobby";
    this.heads = [];
    this.clearTrails();
    this.controls.clear();
    this.effects = { darkUntil: 0 };
    this.round = 0;
    this.matchTarget = 0;
    this.winnerId = undefined;
    this.deathmatch = undefined;
    for (const player of this.players) {
      player.score = 0;
      player.charges = 2;
      player.roundPower = undefined;
    }
  }

  input(id: string, turn: Turn, power = false): boolean {
    if (this.phase !== "playing") return false;
    const heads = this.heads.filter(
      (head) => head.ownerId === id && head.alive,
    );
    const control = this.controls.get(id);
    if (!heads.length || !control) return false;
    const player = this.players.find((item) => item.id === id)!;
    const ability =
      player.power === "random" ? player.roundPower! : player.power;
    for (const head of heads) {
      if (head.square && turn !== 0 && turn !== control.turn) {
        head.angle += (turn * Math.PI) / 2;
        head.revision++;
      }
      head.turn = turn;
    }
    control.turn = turn;
    const wasDown = control.powerDown;
    control.powerDown = power;
    if (
      !power ||
      this.phase !== "playing" ||
      player.charges < 1 ||
      ability === "none" ||
      ability === "chuck" ||
      ability === "wrap"
    )
      return false;
    const timed =
      ability === "boost" ||
      ability === "slow" ||
      ability === "shield" ||
      ability === "square";
    if (
      (wasDown && !timed) ||
      this.tick < control.until ||
      (ability === "dark" && this.tick < this.effects.darkUntil)
    )
      return false;
    let spread = Math.PI / 20;
    if (ability === "hydra") {
      if (
        this.headIndex + heads.length > 0xffffffff ||
        heads.length * 2 > MAX_HEADS_PER_PLAYER ||
        this.heads.filter((head) => head.alive).length + heads.length > MAX_ALIVE_HEADS
      ) return false;
      // Leave equal angular room between siblings and neighboring families.
      for (let index = 0; index < heads.length; index++) {
        for (let other = index + 1; other < heads.length; other++) {
          const angle = heads[index].angle - heads[other].angle;
          spread = Math.min(spread, Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))) / 4);
        }
      }
      // Effectively parallel branches cannot separate without excessive immunity.
      if (spread < 1e-6) return false;
    }
    player.charges--;
    if (timed) {
      control.active = ability;
      control.until = this.tick + DURATION[ability]!;
    } else if (ability === "dark")
      this.effects.darkUntil = this.tick + DURATION.dark!;
    for (const head of heads) {
      if (ability === "jump") {
        head.x += Math.cos(head.angle) * 33.6;
        head.y += Math.sin(head.angle) * 33.6;
        head.revision++;
      } else if (ability === "bar") {
        const dx = Math.cos(head.angle + Math.PI / 2) * 50;
        const dy = Math.sin(head.angle + Math.PI / 2) * 50;
        const segment = {
          id,
          x1: head.x - dx,
          y1: head.y - dy,
          x2: head.x + dx,
          y2: head.y + dy,
          tick: this.tick,
          order: ++this.drawOrder,
        };
        this.pending.push({ ...segment, headId: head.id });
        this.rasterLine(
          head,
          segment.x1,
          segment.y1,
          segment.x2,
          segment.y2,
          false,
        );
      } else if (ability === "hydra") {
        const before = head.angle;
        head.angle -= spread;
        // Keep siblings immune until their trails separate, including at slow speed.
        head.immuneUntil =
          this.tick +
          Math.ceil(((4 + GRID) * 60) / (2 * head.speed * Math.sin(spread))) +
          1;
        head.revision++;
        const index = ++this.headIndex;
        this.headOwners.set(index, id);
        this.heads.push({
          ...head,
          id: `${id}:hydra:${index}`,
          index,
          angle: before + spread,
          reversePose: { ...head.reversePose },
        });
      } else if (ability === "reverse") {
        const previous = { x: head.x, y: head.y, angle: head.angle };
        Object.assign(head, head.reversePose);
        head.reversePose = previous;
        head.immuneUntil = this.tick + 10;
        head.revision++;
      } else if (ability === "square") {
        head.angle = (Math.round(head.angle / (Math.PI / 2)) * Math.PI) / 2;
        head.revision++;
      } else if (ability === "holes") {
        const hole: Hole = {
          id: `hole-${++this.holeIndex}`,
          x1: head.x,
          y1: head.y,
          x2: head.x + Math.cos(head.angle) * 60,
          y2: head.y + Math.sin(head.angle) * 60,
          width: 8,
          tick: this.tick,
          order: ++this.drawOrder,
        };
        this.holes.push(hole);
        this.pendingHoles.push(hole);
        this.eraseOrders.push(hole.order);
        this.erase(hole);
      }
      this.attributes(head, player, control);
    }
    return true;
  }

  stopInputs(ids: string[]) {
    for (const id of ids) {
      const control = this.controls.get(id);
      if (control) {
        control.turn = 0;
        control.powerDown = false;
      }
    }
    for (const head of this.heads)
      if (ids.includes(head.ownerId)) head.turn = 0;
  }

  pause() {
    if (this.phase === "paused") this.phase = this.pausedPhase;
    else if (this.phase === "playing" || this.phase === "countdown") {
      this.pausedPhase = this.phase;
      this.phase = "paused";
      this.stopInputs(this.players.map((player) => player.id));
    } else throw new Error("A running round can be paused.");
  }

  eliminate(ids: string[]): boolean {
    return this.killHeads(
      this.heads
        .filter((head) => ids.includes(head.ownerId))
        .map((head) => head.id),
    );
  }

  private killHeads(ids: string[]): boolean {
    const previouslyAlive = new Set(
      this.heads.filter((head) => head.alive).map((head) => head.ownerId),
    );
    const dead = this.heads.filter(
      (head) => head.alive && ids.includes(head.id),
    );
    if (!dead.length) return false;
    for (const head of dead) head.alive = false;
    const surviving = new Set(
      this.heads.filter((head) => head.alive).map((head) => head.ownerId),
    );
    const deadOwners = [...previouslyAlive].filter((id) => !surviving.has(id));
    for (const player of this.players)
      if (surviving.has(player.id)) player.score += deadOwners.length;
    const markers = new Map<string, Runner>();
    for (const head of this.heads)
      if (!head.alive && !surviving.has(head.ownerId))
        markers.set(head.ownerId, head);
    this.heads = this.heads.filter(
      (head) => head.alive || markers.get(head.ownerId) === head,
    );
    if (
      surviving.size <= 1 &&
      (this.phase === "ready" ||
        this.phase === "playing" ||
        this.phase === "paused" ||
        this.phase === "countdown")
    ) {
      this.effects.darkUntil = 0;
      for (const control of this.controls.values()) {
        control.active = undefined;
        control.until = 0;
        control.turn = 0;
        control.powerDown = false;
      }
      for (const head of this.heads) {
        head.gap = false;
        head.immuneUntil = 0;
      }
      const maximum = Math.max(...this.players.map((player) => player.score));
      const qualified = this.players.filter(
        (player) => player.score >= this.matchTarget,
      );
      if (
        (this.deathmatch && surviving.size === 1) ||
        (!this.deathmatch && qualified.length === 1)
      ) {
        this.phase = "finished";
        this.winnerId = this.deathmatch ? [...surviving][0] : qualified[0].id;
      } else {
        this.phase = "roundEnd";
        this.winnerId = [...surviving][0];
        if (!this.deathmatch && qualified.length > 1)
          this.deathmatch = qualified.map((player) => player.id);
        const minimum = Math.min(...this.players.map((player) => player.score));
        for (const player of this.players) {
          const power =
            player.power === "random" ? player.roundPower : player.power;
          if (power === "none" || power === "chuck") continue;
          const extra =
            this.players.length === 2
              ? 1
              : Number(player.score < maximum) +
                Number(player.score === minimum);
          player.charges = Math.min(6, player.charges + extra);
        }
      }
    }
    return true;
  }

  private attributes(head: Runner, player: Player, control: Control) {
    const ability =
      player.power === "random" ? player.roundPower : player.power;
    head.powerUntil = control.until;
    head.powerActive = this.tick < control.until;
    head.invisible = head.powerActive && control.active === "shield";
    head.invulnerable = head.invisible || this.tick < head.immuneUntil;
    head.square = head.powerActive && control.active === "square";
    head.wrap = ability === "wrap" && player.charges > 0;
    head.speed =
      SPEED[this.settings.speed] *
      (head.powerActive && control.active === "boost"
        ? 2
        : head.powerActive && control.active === "slow"
          ? 0.5
          : 1);
    head.turnRate =
      2.1 * (head.powerActive && control.active === "boost" ? 2 : 1);
    head.turn = control.turn;
  }

  step(): boolean {
    if (this.phase === "paused" || this.phase === "ready") return false;
    this.tick++;
    if (this.phase === "countdown") {
      this.countdown--;
      if (!this.countdown) {
        this.phase = "playing";
        return true;
      }
      return false;
    }
    if (this.phase !== "playing") return false;
    const playerById = new Map(
      this.players.map((player) => [player.id, player]),
    );
    const movements: { head: Runner; x: number; y: number; safe: boolean }[] =
      [];
    const dead = new Set<string>();
    let changed = false;
    for (const head of this.heads) {
      if (!head.alive) continue;
      const player = playerById.get(head.ownerId)!;
      const control = this.controls.get(head.ownerId)!;
      this.attributes(head, player, control);
      if (this.settings.gaps && this.tick >= head.nextGap) {
        head.gapUntil = this.tick + (
          this.settings.gapSize === "custom"
            ? this.settings.customGapSize
            : GAP_SIZE[this.settings.gapSize]
        );
        head.nextGap = this.tick + this.gapDelay();
      }
      head.gap = head.invisible || this.tick < head.gapUntil;
      const pose = { x: head.x, y: head.y, angle: head.angle };
      advancePose(
        pose,
        head.square ? 0 : head.turn,
        head.speed,
        head.turnRate,
        1 / 60,
      );
      head.angle = pose.angle;
      let { x, y } = pose;
      const outside =
        x < 2 || x > this.width - 2 || y < 2 || y > this.height - 2;
      const wrapped = outside && head.wrap;
      if (outside && head.wrap) {
        player.charges--;
        x =
          ((((x - 2) % (this.width - 4)) + this.width - 4) % (this.width - 4)) +
          2;
        y =
          ((((y - 2) % (this.height - 4)) + this.height - 4) %
            (this.height - 4)) +
          2;
        head.x = x;
        head.y = y;
        head.revision++;
        head.wrap = player.charges > 0;
        changed = true;
      }
      movements.push({ head, x, y, safe: head.invisible });
      if (
        (outside && !head.invisible && !wrapped) ||
        (!head.invisible && this.collides(head, x, y))
      )
        dead.add(head.id);
      const power =
        player.power === "random" ? player.roundPower : player.power;
      if (
        !head.invisible &&
        power !== "none" &&
        power !== "chuck" &&
        this.tick >= control.pickupReady &&
        player.charges < 6 &&
        x >= 0 &&
        y >= 0 &&
        x < this.width &&
        y < this.height
      ) {
        const owner =
          this.gaps[Math.floor(y / GRID) * this.cols + Math.floor(x / GRID)];
        if (owner && owner !== head.ownerIndex) {
          player.charges++;
          control.pickupReady = this.tick + 5;
          changed = true;
        }
      }
    }
    const buckets = new Map<string, typeof movements>();
    // Candidate pairs must include both heads' maximum boosted travel this tick.
    const bucketSize = 4 + (4 * SPEED.fast) / 60;
    for (const movement of movements) {
      const cx = Math.floor(movement.x / bucketSize),
        cy = Math.floor(movement.y / bucketSize);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          for (const other of buckets.get(`${cx + dx},${cy + dy}`) ?? []) {
            const siblingsImmune =
              movement.head.ownerId === other.head.ownerId &&
              (this.tick < movement.head.immuneUntil ||
                this.tick < other.head.immuneUntil);
            if (movement.safe || other.safe || siblingsImmune) continue;
            const x = movement.head.x - other.head.x;
            const y = movement.head.y - other.head.y;
            const dx = movement.x - movement.head.x - (other.x - other.head.x);
            const dy = movement.y - movement.head.y - (other.y - other.head.y);
            const distance = dx * dx + dy * dy;
            const time = distance
              ? Math.max(0, Math.min(1, -(x * dx + y * dy) / distance))
              : 0;
            if ((x + dx * time) ** 2 + (y + dy * time) ** 2 < 16) {
              dead.add(movement.head.id);
              dead.add(other.head.id);
            }
          }
        }
      const key = `${cx},${cy}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(movement);
      buckets.set(key, bucket);
    }
    for (const { head, x, y } of movements) {
      if (!dead.has(head.id)) {
        if (!head.invisible || this.tick < head.gapUntil)
          this.rasterLine(head, head.x, head.y, x, y, head.gap);
        if (!head.gap)
          this.pending.push({
            id: head.ownerId,
            headId: head.id,
            x1: head.x,
            y1: head.y,
            x2: x,
            y2: y,
            tick: this.tick,
            order: ++this.drawOrder,
          });
      }
      head.x = x;
      head.y = y;
    }
    return this.killHeads([...dead]) || changed;
  }

  publicHeads(): Head[] {
    return this.heads.map((head) => {
      const player = this.players.find((player) => player.id === head.ownerId);
      const control = this.controls.get(head.ownerId);
      if (player && control) this.attributes(head, player, control);
      const {
        id,
        ownerId,
        x,
        y,
        angle,
        alive,
        gap,
        powerActive,
        turn,
        speed,
        turnRate,
        revision,
        wrap,
        square,
        invisible,
        invulnerable,
      } = head;
      return {
        id,
        ownerId,
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        angle: Math.round(angle * 1000) / 1000,
        alive,
        gap,
        powerActive,
        turn,
        speed,
        turnRate,
        revision,
        wrap,
        square,
        invisible,
        invulnerable,
      };
    });
  }

  takeSegments(): Segment[] {
    const pending: Segment[] = [];
    const last = new Map<string, Segment>();
    for (const segment of this.pending) {
      const previous = last.get(segment.headId);
      if (
        previous &&
        previous.x2 === segment.x1 &&
        previous.y2 === segment.y1 &&
        !this.eraseOrders.some(
          (order) => order >= previous.order && order < segment.order,
        )
      ) {
        previous.x2 = segment.x2;
        previous.y2 = segment.y2;
        previous.tick = segment.tick;
        previous.order = segment.order;
      } else {
        const { headId, ...copy } = segment;
        pending.push(copy);
        last.set(headId, copy);
      }
    }
    for (const segment of pending)
      for (const key of ["x1", "y1", "x2", "y2"] as const)
        segment[key] = Math.round(segment[key] * 10) / 10;
    this.segments.push(...pending);
    this.pending = [];
    this.eraseOrders = [];
    return pending;
  }

  snapshotSegments(): Segment[] {
    return [
      ...this.segments,
      ...this.pending.map(({ headId: _headId, ...segment }) => segment),
    ];
  }

  takeHoles(): Hole[] {
    const pending = this.pendingHoles;
    this.pendingHoles = [];
    return pending;
  }
  private gapDelay() {
    return 150 + Math.floor(this.random() * 300);
  }

  private collides(head: Runner, x: number, y: number): boolean {
    let hit = false;
    this.cells(head.x, head.y, x, y, (index) => {
      const owner = this.occupied[index];
      if (
        this.tick < head.immuneUntil &&
        this.headOwners.get(owner) === head.ownerId
      )
        return;
      if (
        owner &&
        (owner !== head.index || this.tick - this.written[index] > 8)
      )
        hit = true;
    });
    return hit;
  }

  private cells(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    visit: (index: number) => void,
    radius = 2,
  ) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
    const around = Math.ceil(radius / GRID);
    for (let step = 0; step <= steps; step++) {
      const px = x1 + ((x2 - x1) * step) / steps,
        py = y1 + ((y2 - y1) * step) / steps;
      const cx = Math.floor(px / GRID),
        cy = Math.floor(py / GRID);
      for (let dy = -around; dy <= around; dy++)
        for (let dx = -around; dx <= around; dx++) {
          if (
            cx + dx < 0 ||
            cx + dx >= this.cols ||
            cy + dy < 0 ||
            cy + dy >= this.rows
          )
            continue;
          if (
            ((cx + dx + 0.5) * GRID - px) ** 2 +
              ((cy + dy + 0.5) * GRID - py) ** 2 >
            radius ** 2
          )
            continue;
          visit((cy + dy) * this.cols + cx + dx);
        }
    }
  }

  private rasterLine(
    head: Runner,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    gap: boolean,
  ) {
    this.cells(x1, y1, x2, y2, (index) => {
      if (gap) this.gaps[index] = head.ownerIndex;
      else {
        this.occupied[index] = head.index;
        this.written[index] = this.tick;
      }
    });
  }
  private erase(hole: Hole) {
    this.cells(
      hole.x1,
      hole.y1,
      hole.x2,
      hole.y2,
      (index) => {
        this.occupied[index] = 0;
        this.written[index] = 0;
      },
      hole.width / 2,
    );
  }
}
