import { useEffect, useRef, type MutableRefObject } from "react";
import type {
  Hole,
  Player,
  RoomView,
  Segment,
  WorldFrame,
} from "../shared/types";
import {
  appendDrawEvents,
  displayPose,
  predictHead,
  reconcile,
  type PredictionInputState,
  type VisualPose,
} from "./prediction";
import type { Pose } from "../shared/movement";
import styles from "./App.module.css";

export type FrameData = WorldFrame & { receivedAt: number; reset: number };
type DrawEvent = Segment | Hole;
type RunnerVisual = VisualPose & {
  head: WorldFrame["heads"][number];
  receivedAt: number;
  inputAck: number;
  inputs: PredictionInputState;
};

export default function GameCanvas({
  room,
  frameRef,
  inputRef,
  projector,
}: {
  room: RoomView;
  frameRef: MutableRefObject<FrameData>;
  inputRef: MutableRefObject<PredictionInputState>;
  projector: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const roomRef = useRef(room);
  const projectorRef = useRef(projector);
  roomRef.current = room;
  projectorRef.current = projector;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !context) return;
    const trail = document.createElement("canvas");
    const trailContext = trail.getContext("2d");
    if (!trailContext) return;
    let reset = -1;
    let trailRevision = -1;
    let receivedAt = -1;
    let resized = true;
    let lastPixelRatio = 0;
    let scale = 1;
    let animation = 0;
    let cachedPlayers: Player[] | undefined;
    const players = new Map<string, Player>();
    const trailColors = new Map<string, string>();
    const visuals = new Map<string, RunnerVisual>();
    const history: DrawEvent[] = [];
    let lastPaintedOrder = 0;
    const target: Pose = { x: 0, y: 0, angle: 0 };
    const oldTarget: Pose = { x: 0, y: 0, angle: 0 };
    const observer = new ResizeObserver(() => {
      resized = true;
    });
    observer.observe(canvas);

    function paintEvent(event: DrawEvent) {
      trailContext!.beginPath();
      trailContext!.moveTo(event.x1, event.y1);
      trailContext!.lineTo(event.x2, event.y2);
      if ("width" in event) {
        trailContext!.globalCompositeOperation = "destination-out";
        trailContext!.lineWidth = event.width;
      } else {
        trailContext!.strokeStyle = trailColors.get(event.id) ?? "#eafd71";
        trailContext!.lineWidth = 4;
      }
      trailContext!.stroke();
      trailContext!.globalCompositeOperation = "source-over";
    }
    function clearTrail() {
      trailContext!.setTransform(1, 0, 0, 1, 0, 0);
      trailContext!.clearRect(0, 0, trail.width, trail.height);
      trailContext!.setTransform(scale, 0, 0, scale, 0, 0);
      trailContext!.lineCap = "round";
      trailContext!.lineJoin = "round";
    }
    function draw(now: number) {
      const frame = frameRef.current;
      const currentRoom = roomRef.current;
      const inputs = inputRef.current;
      if (reset !== frame.reset || trailRevision !== frame.trailRevision) {
        reset = frame.reset;
        trailRevision = frame.trailRevision;
        cachedPlayers = undefined;
        trailColors.clear();
        for (const [id, color] of Object.entries(frame.trailColors ?? {})) trailColors.set(id, color);
        history.length = 0;
        lastPaintedOrder = 0;
        visuals.clear();
        clearTrail();
      }
      if (cachedPlayers !== currentRoom.players) {
        cachedPlayers = currentRoom.players;
        players.clear();
        for (const player of cachedPlayers) {
          players.set(player.id, player);
          trailColors.set(player.id, player.roundPower === "chuck" ? "#fff" : player.color);
        }
      }
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      if (resized || lastPixelRatio !== pixelRatio) {
        const pixelWidth = Math.max(
          1,
          Math.min(
            4096,
            Math.round(canvas!.getBoundingClientRect().width * pixelRatio),
          ),
        );
        const pixelHeight = Math.max(
          1,
          Math.round((pixelWidth * currentRoom.height) / currentRoom.width),
        );
        resized = false;
        lastPixelRatio = pixelRatio;
        canvas!.width = trail.width = pixelWidth;
        canvas!.height = trail.height = pixelHeight;
        scale = pixelWidth / currentRoom.width;
        clearTrail();
        for (const event of history) paintEvent(event);
      }
      if (frame.segments.length || frame.holes.length) {
        const incoming: DrawEvent[] = frame.segments.splice(0);
        incoming.push(...frame.holes.splice(0));
        lastPaintedOrder = appendDrawEvents(
          history,
          incoming,
          lastPaintedOrder,
          paintEvent,
        );
      }

      context!.setTransform(1, 0, 0, 1, 0, 0);
      const dark = frame.tick < frame.effects.darkUntil;
      context!.fillStyle = dark ? "#000" : "#111414";
      context!.fillRect(0, 0, canvas!.width, canvas!.height);
      if (!dark) {
        context!.drawImage(trail, 0, 0);
        context!.setTransform(scale, 0, 0, scale, 0, 0);
        const playing =
          frame.phase === "playing" && currentRoom.phase === "playing";
        const newFrame = receivedAt !== frame.receivedAt;
        for (const head of frame.heads) {
          const player = players.get(head.ownerId);
          if (!player) continue;
          const local = player.deviceId === inputs.deviceId;
          predictHead(
            head,
            inputs,
            frame.inputAck,
            frame.receivedAt,
            now,
            currentRoom.width,
            currentRoom.height,
            playing,
            local,
            target,
          );
          let visual = visuals.get(head.id);
          if (!visual) {
            visual = {
              ...target,
              offsetX: 0,
              offsetY: 0,
              correctionAt: now,
              revision: head.revision,
              alive: head.alive,
              head,
              receivedAt: frame.receivedAt,
              inputAck: frame.inputAck,
              inputs: { ...inputs },
            };
            visuals.set(head.id, visual);
          } else if (newFrame) {
            // Compare both frames at the same render time, not the previous paint.
            predictHead(
              visual.head,
              visual.inputs,
              visual.inputAck,
              visual.receivedAt,
              now,
              currentRoom.width,
              currentRoom.height,
              playing,
              local,
              oldTarget,
            );
            displayPose(visual, oldTarget, now);
            reconcile(visual, target, head, now, playing);
          }
          if (!playing) visual.offsetX = visual.offsetY = 0;
          displayPose(visual, target, now);
          visual.head = head;
          visual.receivedAt = frame.receivedAt;
          visual.inputAck = frame.inputAck;
          visual.inputs.history = inputs.history;
          visual.inputs.latencyMs = inputs.latencyMs;
          visual.inputs.sequence = inputs.sequence;
          if (head.invisible) continue;
          const color = player.roundPower === "chuck" ? "#fff" : player.color;
          const x = visual.x,
            y = visual.y;
          const bridgeDistance = Math.hypot(x - head.x, y - head.y);
          // This short predicted tail is redrawn each paint, never baked into collision trails.
          if (
            playing &&
            head.alive &&
            !head.gap &&
            !head.invisible &&
            bridgeDistance < Math.max(25, head.speed * 0.16)
          ) {
            context!.strokeStyle = color;
            context!.lineWidth = 4;
            context!.lineCap = "round";
            context!.beginPath();
            context!.moveTo(head.x, head.y);
            context!.lineTo(x, y);
            context!.stroke();
          }
          context!.fillStyle = color;
          context!.globalAlpha = head.alive ? 1 : 0.45;
          context!.beginPath();
          context!.arc(x, y, head.alive ? 5 : 3, 0, Math.PI * 2);
          context!.fill();
          if (head.alive && (head.gap || head.powerActive)) {
            context!.strokeStyle = color;
            context!.lineWidth = 1;
            context!.setLineDash(head.gap ? [2, 3] : []);
            context!.beginPath();
            context!.arc(x, y, 9, 0, Math.PI * 2);
            context!.stroke();
            context!.setLineDash([]);
          }
          if (
            currentRoom.phase === "ready" ||
            currentRoom.phase === "countdown"
          ) {
            const labelSize =
              (projectorRef.current ? 18 : 14) * (lastPixelRatio / scale);
            context!.font = `${labelSize}px Arial, sans-serif`;
            context!.textAlign = "center";
            context!.fillText(
              player.name,
              x,
              Math.max(labelSize * 1.4, y - labelSize * 1.4),
            );
          }
          context!.globalAlpha = 1;
        }
        if (newFrame) {
          const present = new Set(frame.heads.map((head) => head.id));
          for (const id of visuals.keys())
            if (!present.has(id)) visuals.delete(id);
        }
      }
      receivedAt = frame.receivedAt;
      animation = requestAnimationFrame(draw);
    }
    animation = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animation);
      observer.disconnect();
    };
  }, [frameRef, inputRef, room.width, room.height]);

  return (
    <canvas
      ref={canvasRef}
      width={room.width}
      height={room.height}
      style={{ aspectRatio: String(room.width / room.height) }}
      className={styles.canvas}
      aria-label={String(
        "Game arena, round " +
          room.round +
          ". Use your assigned left and right keys to steer.",
      )}
      role="img"
    />
  );
}
