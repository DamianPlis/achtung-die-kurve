import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Head, RoomView, Segment } from '../shared/types';
import styles from './App.module.css';

export type FrameData = {
  tick: number;
  heads: Head[];
  segments: Segment[];
  countdown?: number;
  receivedAt: number;
  reset: number;
};

export default function GameCanvas({ room, frameRef, projector }: {
  room: RoomView;
  frameRef: MutableRefObject<FrameData>;
  projector: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const roomRef = useRef(room);
  const projectorRef = useRef(projector);
  roomRef.current = room;
  projectorRef.current = projector;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const trail = document.createElement('canvas');
    trail.width = room.width;
    trail.height = room.height;
    const trailContext = trail.getContext('2d');
    if (!trailContext) return;
    trailContext.lineWidth = 4;
    trailContext.lineCap = 'round';
    trailContext.lineJoin = 'round';
    let reset = -1;
    let lastTime = performance.now();
    let animation = 0;
    const positions = new Map<string, { x: number; y: number }>();

    function draw(now: number) {
      const frame = frameRef.current;
      const currentRoom = roomRef.current;
      const players = new Map(currentRoom.players.map(player => [player.id, player]));
      if (reset !== frame.reset) {
        reset = frame.reset;
        trailContext!.fillStyle = '#111414';
        trailContext!.fillRect(0, 0, trail.width, trail.height);
        positions.clear();
      }

      // Keep trails on a backing canvas; only newly received segments need drawing.
      for (const segment of frame.segments.splice(0)) {
        trailContext!.strokeStyle = players.get(segment.id)?.color ?? '#eafd71';
        trailContext!.beginPath();
        trailContext!.moveTo(segment.x1, segment.y1);
        trailContext!.lineTo(segment.x2, segment.y2);
        trailContext!.stroke();
      }
      context!.drawImage(trail, 0, 0);
      const amount = Math.min(1, (now - lastTime) / 25);
      lastTime = now;

      for (const head of frame.heads) {
        const player = players.get(head.id);
        if (!player) continue;
        const previous = positions.get(head.id) ?? head;
        const smooth = currentRoom.phase === 'playing' && head.alive && now - frame.receivedAt < 200 && Math.hypot(head.x - previous.x, head.y - previous.y) < 25;
        const x = smooth ? previous.x + (head.x - previous.x) * amount : head.x;
        const y = smooth ? previous.y + (head.y - previous.y) * amount : head.y;
        positions.set(head.id, { x, y });
        context!.fillStyle = player.color;
        context!.globalAlpha = head.alive ? 1 : 0.45;
        context!.beginPath();
        context!.arc(x, y, head.alive ? 5 : 3, 0, Math.PI * 2);
        context!.fill();
        if (head.alive && (head.gap || head.powerActive)) {
          context!.strokeStyle = player.color;
          context!.lineWidth = 1;
          context!.setLineDash(head.gap ? [2, 3] : []);
          context!.beginPath();
          context!.arc(x, y, 9, 0, Math.PI * 2);
          context!.stroke();
          context!.setLineDash([]);
        }
        if (currentRoom.phase === 'countdown') {
          context!.font = `${projectorRef.current ? 18 : 14}px Arial, sans-serif`;
          context!.textAlign = 'center';
          context!.fillText(player.name, x, Math.max(22, y - 18));
        }
        context!.globalAlpha = 1;
      }
      animation = requestAnimationFrame(draw);
    }
    animation = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animation);
  }, [frameRef, room.width, room.height]);

  return <canvas
    ref={canvasRef}
    width={room.width}
    height={room.height}
    className={styles.canvas}
    aria-label={`Game arena, round ${room.round}. Use your assigned left and right keys to steer.`}
    role="img"
  />;
}
