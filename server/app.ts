import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type {
  GameSettings,
  LocalPlayer,
  Player,
  RoomView,
  ServerMessage,
  Turn,
} from "../shared/types.js";
import { POWERS } from "../shared/types.js";
import { DEFAULT_SETTINGS, Game, MAX_PLAYERS } from "./game.js";

const COLORS = [
  "#f36a6e",
  "#f5ad63",
  "#91ce7d",
  "#79b9f5",
  "#b394e8",
  "#e48db9",
  "#ffe46b",
  "#54ddd0",
  "#ff956f",
  "#ffffff",
  "#b9ec54",
  "#6893ef",
  "#ffa4da",
  "#c4a16e",
  "#ff454c",
  "#73f6ff",
  "#dfe9ad",
  "#c0c0c0",
];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
interface Device {
  socket?: WebSocket;
  playerIds: string[];
  disconnectedAt?: number;
  sessionToken: string;
}
interface Room {
  code: string;
  hostDeviceId: string;
  game: Game;
  devices: Map<string, Device>;
}
interface Session {
  room?: Room;
  deviceId?: string;
  window: number;
  messages: number;
  alive: boolean;
  inputSeq: number;
}
interface Options {
  distDir?: string;
  graceMs?: number;
  autoTick?: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(message: string): never {
  throw new Error(message);
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value))
    fail("Invalid player identifier.");
  return value;
}
function deviceIdentifier(value: unknown): string {
  const id = identifier(value);
  if (id.length < 16)
    fail("Invalid device session. Refresh the page and try again.");
  return id;
}
function parsePlayers(value: unknown): LocalPlayer[] {
  if (!Array.isArray(value) || value.length > 6)
    fail("A device can have up to six players.");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!record(item)) fail("Invalid player.");
    const id = identifier(item.id);
    if (seen.has(id)) fail("Player identifiers must be unique.");
    seen.add(id);
    if (
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.trim().length > 24
    )
      fail("Player names must have 1–24 characters.");
    const power = item.power ?? "none";
    if (typeof power !== "string" || !POWERS.some((entry) => entry === power))
      fail("Choose a supported power.");
    return { id, name: item.name.trim(), power: power as LocalPlayer["power"] };
  });
}
function settings(value: unknown, current = DEFAULT_SETTINGS): GameSettings {
  if (!record(value)) fail("Invalid game settings.");
  const speed = value.speed ?? current.speed;
  const targetScore = value.targetScore ?? current.targetScore;
  const gaps = value.gaps ?? current.gaps;
  const gapSize = value.gapSize ?? current.gapSize;
  const customGapSize = value.customGapSize ?? current.customGapSize;
  if (speed !== "slow" && speed !== "normal" && speed !== "fast")
    fail("Invalid speed.");
  if (
    typeof targetScore !== "number" ||
    !Number.isInteger(targetScore) ||
    targetScore < 0 ||
    targetScore > 200
  )
    fail("Target score must be between 0 and 200.");
  if (typeof gaps !== "boolean") fail("Invalid trail gap setting.");
  if (
    gapSize !== "small" &&
    gapSize !== "medium" &&
    gapSize !== "large" &&
    gapSize !== "custom"
  )
    fail("Invalid trail gap size.");
  if (
    typeof customGapSize !== "number" ||
    !Number.isInteger(customGapSize) ||
    customGapSize < 8 ||
    customGapSize > 50
  )
    fail("Custom gap size must be between 8 and 50 ticks.");
  return { speed, targetScore, gaps, gapSize, customGapSize };
}

export function createGameServer({
  distDir = resolve("dist"),
  graceMs = 30_000,
  autoTick = true,
}: Options = {}) {
  const rooms = new Map<string, Room>();
  const sessions = new WeakMap<WebSocket, Session>();
  const server = createServer((request, response) => {
    void serve(request, response);
  });
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 8_192,
    perMessageDeflate: {
      threshold: 1024,
      zlibDeflateOptions: { level: 1 },
      concurrencyLimit: 4,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
    },
  });
  let previous = performance.now(),
    accumulator = 0;

  function send(socket: WebSocket, message: ServerMessage) {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  }
  function view(room: Room): RoomView {
    return {
      code: room.code,
      hostDeviceId: room.hostDeviceId,
      players: room.game.players,
      settings: room.game.settings,
      phase: room.game.phase,
      round: room.game.round,
      matchTarget: room.game.matchTarget,
      width: room.game.width,
      height: room.game.height,
      winnerId: room.game.winnerId,
      deathmatch: room.game.deathmatch,
    };
  }
  function broadcastRoom(room: Room) {
    for (const [deviceId, device] of room.devices)
      if (device.socket)
        send(device.socket, { type: "room", room: view(room), deviceId });
  }
  function roster(room: Room, deviceId: string, players: LocalPlayer[]) {
    const others = room.game.players.filter(
      (player) => player.deviceId !== deviceId,
    );
    if (others.length + players.length > MAX_PLAYERS)
      fail("A room can have up to fifty players.");
    if (
      players.some((player) => others.some((other) => other.id === player.id))
    )
      fail("A player identifier is already in this room.");
    const used = new Set(others.map((player) => player.color));
    const existing = new Map(
      room.game.players
        .filter((player) => player.deviceId === deviceId)
        .map((player) => [player.id, player]),
    );
    const own: Player[] = players.map((player) => {
      const old = existing.get(player.id);
      let color = old?.color;
      if (!color || used.has(color))
        color =
          COLORS.find((entry) => !used.has(entry)) ??
          Array.from(
            { length: MAX_PLAYERS },
            (_, index) =>
              `hsl(${Math.round(index * 137.508) % 360} 85% ${index % 2 ? 68 : 55}%)`,
          ).find((entry) => !used.has(entry))!;
      used.add(color);
      return {
        ...player,
        power: player.power ?? "none",
        deviceId,
        color,
        score: old?.score ?? 0,
        charges: old?.charges ?? 2,
        connected: true,
      };
    });
    room.game.players = [...others, ...own];
    room.devices.get(deviceId)!.playerIds = own.map((player) => player.id);
  }
  function bind(
    socket: WebSocket,
    room: Room,
    deviceId: string,
    sessionToken: string,
    players: LocalPlayer[],
    spectator: boolean,
  ) {
    const old = room.devices.get(deviceId);
    if (old && old.sessionToken !== sessionToken)
      fail("This device session belongs to another connection.");
    if (!old && room.devices.size >= 80)
      fail("This room has too many connected devices.");
    if (!old && !spectator && room.game.phase !== "lobby")
      fail(
        "A match is already running. Join as a spectator or wait for the lobby.",
      );
    if (!old && !spectator) {
      const others = room.game.players;
      if (others.length + players.length > MAX_PLAYERS)
        fail("A room can have up to fifty players.");
      if (
        players.some((player) => others.some((other) => other.id === player.id))
      )
        fail("A player identifier is already in this room.");
    }
    if (old?.socket && old.socket !== socket)
      old.socket.close(1008, "This device reconnected in another tab.");
    const device: Device = old ?? { playerIds: [], sessionToken };
    device.socket = socket;
    device.disconnectedAt = undefined;
    room.devices.set(deviceId, device);
    if (!room.devices.get(room.hostDeviceId)?.socket)
      room.hostDeviceId = deviceId;
    const session = sessions.get(socket)!;
    session.room = room;
    session.deviceId = deviceId;
    if (!spectator && room.game.phase === "lobby")
      roster(room, deviceId, players);
    for (const player of room.game.players)
      if (player.deviceId === deviceId) player.connected = true;
    send(socket, {
      type: "snapshot",
      room: view(room),
      deviceId,
      tick: room.game.tick,
      heads: room.game.publicHeads(),
      segments: [...room.game.segments, ...room.game.pending],
      holes: room.game.holes,
      trailRevision: room.game.trailRevision,
      effects: room.game.effects,
      phase: room.game.phase,
      inputAck: session.inputSeq,
    });
    broadcastRoom(room);
  }
  function requireHost(session: Session): Room {
    if (!session.room || session.room.hostDeviceId !== session.deviceId)
      fail("Only the host can manage this match.");
    return session.room;
  }
  function handle(socket: WebSocket, value: unknown) {
    if (!record(value) || typeof value.type !== "string")
      fail("Invalid message.");
    const session = sessions.get(socket)!;
    if (value.type === "ping") {
      if (typeof value.at !== "number" || !Number.isFinite(value.at))
        fail("Invalid ping.");
      send(socket, { type: "pong", at: value.at });
      return;
    }
    if (
      value.type === "create" ||
      value.type === "join" ||
      value.type === "spectate"
    ) {
      if (session.room) fail("Leave the current room before joining another.");
      const deviceId = deviceIdentifier(value.deviceId);
      const sessionToken = identifier(value.sessionToken);
      if (sessionToken.length < 32 || sessionToken === deviceId)
        fail("Invalid private session token. Refresh the page and try again.");
      const players =
        value.type === "spectate" ? [] : parsePlayers(value.players);
      if (value.type === "create") {
        if (rooms.size >= 100) fail("The server is full. Try again later.");
        let code: string;
        do {
          code = [...randomBytes(5)]
            .map((byte) => CODE_CHARS[byte % CODE_CHARS.length])
            .join("");
        } while (rooms.has(code));
        const room: Room = {
          code,
          hostDeviceId: deviceId,
          game: new Game(
            [],
            value.settings === undefined
              ? { ...DEFAULT_SETTINGS }
              : settings(value.settings),
          ),
          devices: new Map(),
        };
        bind(socket, room, deviceId, sessionToken, players, false);
        rooms.set(code, room);
      } else {
        if (typeof value.code !== "string") fail("Enter a room code.");
        const room = rooms.get(value.code.trim().toUpperCase());
        if (!room) fail("Room not found. Check the code and server address.");
        bind(
          socket,
          room,
          deviceId,
          sessionToken,
          players,
          value.type === "spectate",
        );
      }
      return;
    }
    const room = session.room;
    if (!room || !session.deviceId) fail("Join a room first.");
    if (room.devices.get(session.deviceId)?.socket !== socket)
      fail("This session has been replaced.");
    switch (value.type) {
      case "players":
        if (room.game.phase !== "lobby")
          fail("Players can only be changed in the lobby.");
        roster(room, session.deviceId, parsePlayers(value.players));
        broadcastRoom(room);
        break;
      case "input": {
        if (
          value.seq !== undefined &&
          (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1)
        )
          fail("Invalid input sequence.");
        if (!Array.isArray(value.inputs) || value.inputs.length > 6)
          fail("Invalid steering input.");
        const inputs = value.inputs.map((input) => {
          if (
            !record(input) ||
            (input.turn !== -1 && input.turn !== 0 && input.turn !== 1) ||
            (input.power !== undefined && typeof input.power !== "boolean")
          )
            fail("Invalid steering input.");
          const id = identifier(input.id);
          if (!room.devices.get(session.deviceId!)!.playerIds.includes(id))
            fail("You can only steer players on your own device.");
          return { id, turn: input.turn as Turn, power: input.power === true };
        });
        if (
          value.seq !== undefined &&
          (value.seq as number) <= session.inputSeq
        )
          break;
        session.inputSeq =
          value.seq === undefined
            ? session.inputSeq + 1
            : (value.seq as number);
        let changed = false;
        for (const input of inputs)
          changed =
            room.game.input(input.id, input.turn, input.power) || changed;
        if (changed) broadcastRoom(room);
        break;
      }
      case "settings":
        requireHost(session);
        if (room.game.phase !== "lobby")
          fail("Settings can only be changed in the lobby.");
        room.game.settings = settings(value.settings, room.game.settings);
        broadcastRoom(room);
        break;
      case "start":
        requireHost(session);
        if (room.game.phase !== "lobby" && room.game.phase !== "finished")
          fail("The match has already started.");
        room.game.start();
        broadcastRoom(room);
        break;
      case "next":
        requireHost(session);
        if (room.game.phase !== "roundEnd")
          fail("Wait for the round to finish.");
        room.game.startRound();
        broadcastRoom(room);
        break;
      case "lobby":
        requireHost(session);
        room.game.lobby();
        broadcastRoom(room);
        break;
      case "pause":
        requireHost(session);
        room.game.pause();
        broadcastRoom(room);
        broadcastFrame(room);
        break;
      default:
        fail("Unknown message.");
    }
  }

  wss.on("connection", (socket) => {
    if (wss.clients.size > 200) {
      socket.close(1013, "The server is full.");
      return;
    }
    sessions.set(socket, {
      window: Date.now(),
      messages: 0,
      alive: true,
      inputSeq: 0,
    });
    socket.on("pong", () => {
      sessions.get(socket)!.alive = true;
    });
    socket.on("error", () => {
      socket.terminate();
    });
    socket.on("message", (data) => {
      const session = sessions.get(socket)!;
      const now = Date.now();
      if (now - session.window >= 1000) {
        session.window = now;
        session.messages = 0;
      }
      if (++session.messages > 120) {
        socket.close(1008, "Too many messages.");
        return;
      }
      try {
        handle(socket, JSON.parse(data.toString()) as unknown);
      } catch (error) {
        send(socket, {
          type: "error",
          message: error instanceof Error ? error.message : "Invalid message.",
        });
      }
    });
    socket.on("close", () => {
      const session = sessions.get(socket)!;
      if (!session?.room || !session.deviceId) return;
      const room = session.room;
      const device = room.devices.get(session.deviceId);
      if (!device || device.socket !== socket) return;
      device.socket = undefined;
      device.disconnectedAt = Date.now();
      room.game.stopInputs(device.playerIds);
      for (const player of room.game.players)
        if (player.deviceId === session.deviceId) player.connected = false;
      if (room.hostDeviceId === session.deviceId) {
        const connected = [...room.devices].find(
          ([id, entry]) => id !== session.deviceId && entry.socket,
        );
        if (connected) room.hostDeviceId = connected[0];
      }
      broadcastRoom(room);
    });
  });

  function broadcastFrame(room: Room) {
    const message: ServerMessage = {
      type: "frame",
      tick: room.game.tick,
      heads: room.game.publicHeads(),
      segments: room.game.takeSegments(),
      holes: room.game.takeHoles(),
      trailRevision: room.game.trailRevision,
      effects: room.game.effects,
      phase: room.game.phase,
      inputAck: 0,
      countdown:
        room.game.phase === "countdown"
          ? Math.ceil(room.game.countdown / 60)
          : undefined,
    };
    const { inputAck: _inputAck, ...shared } = message;
    const encoded = JSON.stringify(shared).slice(0, -1);
    for (const device of room.devices.values())
      if (device.socket?.readyState === WebSocket.OPEN) {
        if (device.socket.bufferedAmount > 1_048_576)
          device.socket.close(
            1013,
            "Connection too slow. Reconnect to restore the arena.",
          );
        else
          device.socket.send(
            `${encoded},"inputAck":${sessions.get(device.socket)!.inputSeq}}`,
          );
      }
  }
  function step() {
    for (const room of rooms.values()) {
      const phase = room.game.phase;
      const active = phase === "playing" || phase === "countdown";
      if (room.game.step()) broadcastRoom(room);
      if (active && (room.game.tick % 3 === 0 || room.game.phase !== phase)) {
        broadcastFrame(room);
      }
    }
  }
  const loop = autoTick
    ? setInterval(() => {
        const now = performance.now();
        accumulator += Math.min(now - previous, 100);
        previous = now;
        let steps = 0;
        while (accumulator >= 1000 / 60 && steps++ < 5) {
          step();
          accumulator -= 1000 / 60;
        }
        if (accumulator >= 1000 / 60) accumulator = 0;
      }, 1000 / 60)
    : undefined;
  loop?.unref();
  const cleanup = setInterval(
    () => {
      const now = Date.now();
      for (const room of rooms.values()) {
        for (const [deviceId, device] of room.devices)
          if (
            !device.socket &&
            device.disconnectedAt !== undefined &&
            now - device.disconnectedAt > graceMs
          ) {
            const changed = room.game.eliminate(device.playerIds);
            room.game.players = room.game.players.filter(
              (player) => player.deviceId !== deviceId,
            );
            room.devices.delete(deviceId);
            broadcastRoom(room);
            if (changed) broadcastFrame(room);
          }
        if (!room.devices.size) rooms.delete(room.code);
      }
    },
    Math.max(20, Math.min(1000, graceMs)),
  );
  cleanup.unref();
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const session = sessions.get(socket);
      if (!session?.alive) {
        socket.terminate();
        continue;
      }
      session.alive = false;
      socket.ping();
    }
  }, 15_000);
  heartbeat.unref();

  async function serve(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405);
      response.end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (pathname === "/health") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(
        JSON.stringify({
          status: "ok",
          rooms: rooms.size,
          connections: wss.clients.size,
        }),
      );
      return;
    }
    const root = resolve(distDir);
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      let info = await stat(file).catch(() => undefined);
      if (info?.isDirectory() || (!info && !extname(pathname))) {
        file = resolve(root, "index.html");
        info = await stat(file).catch(() => undefined);
      }
      if (!info?.isFile()) {
        response.writeHead(404);
        response.end(
          "Build the client with npm run build, then open this address.",
        );
        return;
      }
      const mime: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".json": "application/json",
      };
      response.writeHead(200, {
        "Content-Type": mime[extname(file)] ?? "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control":
          extname(file) === ".html" ? "no-cache" : "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else
        createReadStream(file)
          .on("error", () => response.destroy())
          .pipe(response);
    } catch {
      response.writeHead(500);
      response.end("Unable to serve the game.");
    }
  }

  async function close() {
    if (loop) clearInterval(loop);
    clearInterval(cleanup);
    clearInterval(heartbeat);
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((done) => wss.close(() => done()));
    if (server.listening)
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
  }
  return { server, rooms, wss, step, close };
}
