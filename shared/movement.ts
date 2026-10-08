import type { Turn } from "./types.js";

export interface Pose {
  x: number;
  y: number;
  angle: number;
}

export function advancePose(
  pose: Pose,
  turn: Turn,
  speed: number,
  turnRate: number,
  seconds: number,
): void {
  pose.angle += turn * turnRate * seconds;
  pose.x += Math.cos(pose.angle) * speed * seconds;
  pose.y += Math.sin(pose.angle) * speed * seconds;
}
