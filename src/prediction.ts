import type { Head, Turn } from "../shared/types";
import { advancePose, type Pose } from "../shared/movement";

export interface InputChange {
  seq: number;
  at: number;
  inputs: { id: string; turn: Turn }[];
}
export interface PredictionInputState {
  deviceId: string;
  sequence: number;
  history: InputChange[];
  latencyMs: number;
}
export const MAX_EXTRAPOLATION_MS = 150;

function advanceHead(
  pose: Pose,
  head: Head,
  turn: Turn,
  milliseconds: number,
  width: number,
  height: number,
) {
  let remaining = milliseconds / 1000;
  while (remaining > 0.000001) {
    const dt = Math.min(1 / 60, remaining);
    advancePose(pose, turn, head.speed, head.square ? 0 : head.turnRate, dt);
    if (
      head.wrap &&
      (pose.x < 2 || pose.x > width - 2 || pose.y < 2 || pose.y > height - 2)
    ) {
      pose.x = ((((pose.x - 2) % (width - 4)) + width - 4) % (width - 4)) + 2;
      pose.y =
        ((((pose.y - 2) % (height - 4)) + height - 4) % (height - 4)) + 2;
    }
    remaining -= dt;
  }
}

// Predict only motion. Collisions, gaps and powers stay authoritative.
export function predictHead(
  head: Head,
  state: PredictionInputState,
  inputAck: number,
  receivedAt: number,
  now: number,
  width: number,
  height: number,
  playing: boolean,
  local: boolean,
  result: Pose = { x: 0, y: 0, angle: 0 },
): Pose {
  result.x = head.x;
  result.y = head.y;
  result.angle = head.angle;
  if (!playing || !head.alive) return result;
  const oneWay = Math.min(
    MAX_EXTRAPOLATION_MS,
    Math.max(0, state.latencyMs / 2),
  );
  let cursor = receivedAt - oneWay;
  const target = Math.max(cursor, Math.min(now, cursor + MAX_EXTRAPOLATION_MS));
  let turn = head.turn;
  if (local) {
    for (const change of state.history) {
      if (change.seq <= inputAck || change.at > target) continue;
      const input = change.inputs.find((input) => input.id === head.ownerId);
      if (!input) continue;
      const until = Math.max(cursor, change.at);
      advanceHead(result, head, turn, until - cursor, width, height);
      cursor = until;
      if (
        head.square &&
        head.turnRate !== 0 &&
        input.turn !== 0 &&
        input.turn !== turn
      )
        result.angle += (input.turn * Math.PI) / 2;
      turn = head.turnRate === 0 ? 0 : input.turn;
    }
  }
  advanceHead(result, head, turn, target - cursor, width, height);
  if (!head.wrap && !head.invisible) {
    result.x = Math.max(2, Math.min(width - 2, result.x));
    result.y = Math.max(2, Math.min(height - 2, result.y));
  }
  return result;
}

export interface VisualPose extends Pose {
  offsetX: number;
  offsetY: number;
  correctionAt: number;
  revision: number;
  alive: boolean;
}
export function reconcile(
  visual: VisualPose,
  target: Pose,
  head: Head,
  now: number,
  playing: boolean,
) {
  const dx = visual.x - target.x;
  const dy = visual.y - target.y;
  const continuous =
    playing &&
    head.alive &&
    visual.alive &&
    head.revision === visual.revision &&
    dx * dx + dy * dy < 25 * 25;
  visual.offsetX = continuous ? dx : 0;
  visual.offsetY = continuous ? dy : 0;
  visual.correctionAt = now;
  visual.revision = head.revision;
  visual.alive = head.alive;
}
export function displayPose(visual: VisualPose, target: Pose, now: number) {
  const remaining = Math.max(0, 1 - (now - visual.correctionAt) / 65);
  visual.x = target.x + visual.offsetX * remaining;
  visual.y = target.y + visual.offsetY * remaining;
  visual.angle = target.angle;
}

export function appendDrawEvents<T extends { order: number }>(
  history: T[],
  incoming: T[],
  lastOrder: number,
  paint: (event: T) => void,
): number {
  incoming.sort((a, b) => a.order - b.order);
  for (const event of incoming) {
    // Snapshots include pending trails that the next live frame can repeat.
    if (event.order <= lastOrder) continue;
    history.push(event);
    paint(event);
    lastOrder = event.order;
  }
  return lastOrder;
}
