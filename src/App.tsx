import { useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  ClientMessage,
  GameSettings,
  LocalPlayer,
  Power,
  PowerRules,
  RoomView,
  ServerMessage,
  Turn,
} from "../shared/types";
import { MAP_SIZES, POWERS } from "../shared/types";
import { PLAYER_PALETTE } from "../shared/player-palette";
import GameCanvas, { type FrameData } from "./GameCanvas";
import type { PredictionInputState } from "./prediction";
import { DEFAULT_KEYS, isControlKey, keyLabel, newId, steering } from "./controls";
import s from "./App.module.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

type Slot = LocalPlayer & { enabled: boolean; keys: string[] };
const COLORS = PLAYER_PALETTE.slice(0, 6).map(({ color }) => color);
const NAMES = PLAYER_PALETTE.slice(0, 6).map(({ name }) => name);
const DEFAULT_SETTINGS: GameSettings = {
  mapSize: "recommended",
  speed: "normal",
  targetScore: 0,
  gaps: true,
  gapSize: "large",
  customGapSize: 24,
};
const POWER_NAMES: Record<Power, string> = {
  none: "No superpower",
  boost: "Run faster",
  slow: "Run slower",
  jump: "Jump",
  shield: "Invisible",
  bar: "Vertical bar",
  wrap: "Cross walls",
  dark: "Dark knight",
  hydra: "Hydra",
  reverse: "Reverse",
  square: "Square head",
  chuck: "Chuck Norris",
  holes: "Shoot holes",
  random: "Random",
};
const POWER_ORDER = Object.keys(POWER_NAMES) as Power[];

function playerPower(rules: PowerRules, id: string) {
  return Object.hasOwn(rules.players, id) ? rules.players[id] : undefined;
}

function isPowerForced(room: RoomView | null, id: string) {
  return !!room &&
    (room.powerRules.everyone !== null ||
      playerPower(room.powerRules, id) !== undefined);
}

function loadSlots(): Slot[] {
  try {
    const rejoiningRoom = !!sessionStorage.getItem("kurve-room");
    const saved = JSON.parse(
      sessionStorage.getItem("kurve-players") ?? "null",
    ) as unknown;
    if (
      Array.isArray(saved) && saved.length === 6 &&
      saved.every(
        (slot) =>
          slot !== null && typeof slot === "object" &&
          typeof slot.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(slot.id) &&
          typeof slot.name === "string" && slot.name.length <= 24 &&
          typeof slot.enabled === "boolean" &&
          (slot.power === undefined || POWERS.some((power) => power === slot.power)) &&
          Array.isArray(slot.keys) && slot.keys.length === 3 && slot.keys.every(isControlKey),
      ) &&
      new Set(saved.map((slot) => slot.id)).size === 6 &&
      new Set(saved.flatMap((slot) => slot.keys)).size === 18
    )
      return saved.map((slot) => ({
        ...slot,
        enabled: rejoiningRoom && slot.enabled,
      }));
  } catch {
    /* A corrupt preference should never prevent opening the game. */
  }
  return NAMES.map((name, i) => ({
    id: newId(),
    name,
    enabled: false,
    keys: DEFAULT_KEYS[i],
    power: "none",
  }));
}

export default function App() {
  const [slots, setSlots] = useState<Slot[]>(loadSlots);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const [deviceId] = useState(() => {
    let id = sessionStorage.getItem("kurve-device");
    if (!id) {
      id = newId();
      sessionStorage.setItem("kurve-device", id);
    }
    return id;
  });
  const [sessionToken] = useState(() => {
    let token = sessionStorage.getItem("kurve-session-token");
    if (!token) {
      token = newId();
      sessionStorage.setItem("kurve-session-token", token);
    }
    return token;
  });
  const [room, setRoom] = useState<RoomView | null>(null);
  const roomRef = useRef(room);
  roomRef.current = room;
  const confirmedRoomRef = useRef<RoomView | null>(null);
  const powerRulesDraft = useRef<PowerRules | null>(null);
  const pendingPowerRulesRequests = useRef(0);
  const pendingRosterRequests = useRef(0);
  const [powerPreset, setPowerPreset] = useState<Power | "">("");
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const editingNameRef = useRef(editingNameId);
  editingNameRef.current = editingNameId;
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [latency, setLatency] = useState<number | null>(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [joinCode, setJoinCode] = useState(
    () => new URLSearchParams(location.search).get("room") ?? "",
  );
  const [tab, setTab] = useState<"host" | "join">(() =>
    location.search.includes("room=") ? "join" : "host",
  );
  const [spectator, setSpectator] = useState(
    () => sessionStorage.getItem("kurve-spectator") === "true",
  );
  const spectatorRef = useRef(spectator);
  spectatorRef.current = spectator;
  const [projector, setProjector] = useState(false);
  const [binding, setBinding] = useState<{ id: string; index: number } | null>(
    null,
  );
  const [connectionReplaced, setConnectionReplaced] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const ws = useRef<WebSocket | null>(null);
  const frameRef = useRef<FrameData>({
    tick: 0,
    heads: [],
    segments: [],
    receivedAt: 0,
    reset: 0,
    phase: "lobby",
    inputAck: 0,
    trailRevision: 0,
    holes: [],
    effects: { darkUntil: 0 },
  });
  const inputRef = useRef<PredictionInputState>({
    deviceId,
    sequence: 0,
    history: [],
    latencyMs: 0,
  });
  const [countdown, setCountdown] = useState(3);
  const pressed = useRef(new Set<string>());
  const touch = useRef(new Map<string, Map<number, Turn>>());
  const touchPower = useRef(new Map<number, string>());
  const host = room?.hostDeviceId === deviceId;
  const inGame = !!room && room.phase !== "lobby";
  const enabled = slots.filter((slot) => slot.enabled);
  const winner = room?.players.find((player) => player.id === room.winnerId);
  const target =
    room?.matchTarget ||
    room?.settings.targetScore ||
    Math.max(1, (room?.players.length ?? enabled.length) - 1) * 10;

  function send(message: ClientMessage) {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(message));
      return true;
    }
    setError("The server is reconnecting. Try again in a moment.");
    return false;
  }

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    function connect() {
      let rejoining = false;
      const endpoint = new URL(import.meta.env.VITE_GAME_SERVER_URL || location.origin);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      endpoint.pathname = "/ws";
      endpoint.search = endpoint.hash = "";
      const socket = new WebSocket(endpoint.href);
      ws.current = socket;
      socket.onopen = () => {
        if (!active) return socket.close();
        setConnected(true);
        setConnectionReplaced(false);
        attempts = 0;
        setError("");
        const code = sessionStorage.getItem("kurve-room");
        if (code) {
          rejoining = true;
          socket.send(
            JSON.stringify(
              spectatorRef.current
                ? { type: "spectate", code, deviceId, sessionToken }
                : {
                    type: "join",
                    code,
                    deviceId,
                    sessionToken,
                    players: slotsRef.current
                      .filter((slot) => slot.enabled)
                      .map(({ id, name, power }) => ({ id, name, power })),
                  },
            ),
          );
        }
      };
      socket.onmessage = (event) => {
        if (!active) return;
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "room" || message.type === "snapshot") {
          rejoining = false;
          const previous = roomRef.current;
          confirmedRoomRef.current = message.room;
          if (message.type === "snapshot") pendingPowerRulesRequests.current = 0;
          else if (message.requestType === "powerRules") {
            pendingPowerRulesRequests.current = Math.max(0, pendingPowerRulesRequests.current - 1);
          }
          if (
            message.type === "snapshot" || message.room.phase !== "lobby" ||
            message.room.hostDeviceId !== deviceId ||
            !pendingPowerRulesRequests.current
          ) powerRulesDraft.current = null;
          if (
            message.type === "snapshot" ||
            message.room.round !== previous?.round ||
            (message.room.phase === "ready" &&
              previous?.phase !== "ready") ||
            (message.room.phase === "countdown" &&
              previous?.phase !== "countdown" &&
              previous?.phase !== "ready")
          ) {
            frameRef.current.reset++;
            inputRef.current.history = [];
            frameRef.current.segments =
              message.type === "snapshot" ? message.segments : [];
            frameRef.current.heads =
              message.type === "snapshot" ? message.heads : [];
            frameRef.current.receivedAt = performance.now();
            frameRef.current.tick =
              message.type === "snapshot" ? message.tick : 0;
            frameRef.current.holes =
              message.type === "snapshot" ? message.holes : [];
            frameRef.current.trailRevision =
              message.type === "snapshot" ? message.trailRevision : 0;
            frameRef.current.trailColors =
              message.type === "snapshot" ? message.trailColors : undefined;
            frameRef.current.effects =
              message.type === "snapshot" ? message.effects : { darkUntil: 0 };
            frameRef.current.inputAck =
              message.type === "snapshot" ? message.inputAck : 0;
            setCountdown(3);
          }
          frameRef.current.phase = message.room.phase;
          if (message.room.phase !== "playing") {
            pressed.current.clear();
            touch.current.clear();
            touchPower.current.clear();
            inputRef.current.history = [];
          }
          const nextRoom = powerRulesDraft.current
            ? { ...message.room, powerRules: powerRulesDraft.current }
            : message.room;
          roomRef.current = nextRoom;
          setRoom(nextRoom);
          if (message.type === "snapshot") {
            pendingRosterRequests.current = 0;
            reconcileRoster(message.room);
          } else if (message.requestType === "players") {
            pendingRosterRequests.current = Math.max(0, pendingRosterRequests.current - 1);
            if (!pendingRosterRequests.current) reconcileRoster(message.room);
          }
          setSettings(message.room.settings);
          setPending(false);
          sessionStorage.setItem("kurve-room", message.room.code);
        } else if (message.type === "frame") {
          const frame = frameRef.current;
          if (frame.trailRevision !== message.trailRevision) {
            frame.segments = [];
            frame.holes = [];
            frame.trailColors = undefined;
          }
          frame.tick = message.tick;
          frame.phase = message.phase;
          frame.heads = message.heads;
          frame.trailRevision = message.trailRevision;
          frame.effects = message.effects;
          frame.inputAck = message.inputAck;
          frame.segments.push(...message.segments);
          frame.holes.push(...message.holes);
          frame.receivedAt = performance.now();
          inputRef.current.history = inputRef.current.history.filter(
            (change) => change.seq > message.inputAck,
          );
          if (message.countdown !== undefined)
            setCountdown(Math.max(1, Math.ceil(message.countdown)));
        } else if (message.type === "error") {
          setError(message.message);
          setPending(false);
          const rejoinRejected = rejoining &&
            (message.requestType === "join" || message.requestType === "spectate");
          if (rejoinRejected) {
            setJoinCode(sessionStorage.getItem("kurve-room") ?? roomRef.current?.code ?? "");
            setTab("join");
            setProjector(false);
          }
          if (message.requestType === "players") {
            pendingRosterRequests.current = Math.max(0, pendingRosterRequests.current - 1);
            const accepted = message.room ?? confirmedRoomRef.current;
            if (accepted && !pendingRosterRequests.current) reconcileRoster(accepted);
          }
          if (message.requestType === "powerRules") {
            pendingPowerRulesRequests.current = Math.max(0, pendingPowerRulesRequests.current - 1);
            if (!pendingPowerRulesRequests.current) {
              powerRulesDraft.current = null;
              roomRef.current = confirmedRoomRef.current;
              setRoom(confirmedRoomRef.current);
            }
          }
          if (
            !roomRef.current ||
            rejoinRejected ||
            message.message.startsWith("Room not found.")
          ) {
            rejoining = false;
            sessionStorage.removeItem("kurve-room");
            roomRef.current = null;
            confirmedRoomRef.current = null;
            powerRulesDraft.current = null;
            pendingPowerRulesRequests.current = 0;
            pendingRosterRequests.current = 0;
            setRoom(null);
          }
        } else if (message.type === "pong") {
          const rtt = Math.max(0, performance.now() - message.at);
          inputRef.current.latencyMs = rtt;
          setLatency(Math.round(rtt));
        }
      };
      socket.onclose = (event) => {
        if (!active) return;
        setConnected(false);
        pressed.current.clear();
        touch.current.clear();
        touchPower.current.clear();
        powerRulesDraft.current = null;
        pendingPowerRulesRequests.current = 0;
        pendingRosterRequests.current = 0;
        inputRef.current.history = [];
        setPending(false);
        if (event.code === 1008 && event.reason === "This device reconnected in another tab.") {
          setConnectionReplaced(true);
          setError("This game is open in another tab. Reconnect here to take control.");
          return;
        }
        timer = setTimeout(connect, Math.min(8000, 500 * 2 ** attempts++));
      };
      socket.onerror = () => socket.close();
    }
    connect();
    const ping = setInterval(() => {
      if (ws.current?.readyState === WebSocket.OPEN)
        ws.current.send(
          JSON.stringify({ type: "ping", at: performance.now() }),
        );
    }, 2000);
    return () => {
      active = false;
      clearTimeout(timer);
      clearInterval(ping);
      ws.current?.close();
    };
  }, [deviceId, sessionToken, connectionAttempt]);

  useEffect(() => {
    sessionStorage.setItem("kurve-players", JSON.stringify(slots));
  }, [slots]);
  useEffect(() => {
    setPowerPreset(room?.powerRules.everyone ?? "");
  }, [room?.powerRules.everyone]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  function sendInputs() {
    if (
      roomRef.current?.phase !== "playing" ||
      spectatorRef.current ||
      ws.current?.readyState !== WebSocket.OPEN
    )
      return;
    const localIds = new Set(
      roomRef.current.players
        .filter((player) => player.deviceId === deviceId)
        .map((player) => player.id),
    );
    const inputs = slotsRef.current
      .filter((slot) => localIds.has(slot.id))
      .map((slot) => {
        const touchKeys = [...(touch.current.get(slot.id)?.values() ?? [])];
        return {
          id: slot.id,
          turn: steering(
            pressed.current.has(slot.keys[0]) || touchKeys.includes(-1),
            pressed.current.has(slot.keys[1]) || touchKeys.includes(1),
          ),
          power:
            pressed.current.has(slot.keys[2]) ||
            [...touchPower.current.values()].includes(slot.id),
        };
      });
    const seq = ++inputRef.current.sequence;
    inputRef.current.history.push({ seq, at: performance.now(), inputs });
    // Bound unacknowledged history during a stalled connection.
    if (inputRef.current.history.length > 120) inputRef.current.history.shift();
    ws.current.send(JSON.stringify({ type: "input", seq, inputs }));
  }

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement
      )
        return;
      if (binding) {
        event.preventDefault();
        if (event.code === "Escape") {
          setBinding(null);
          return;
        }
        if (!isControlKey(event.code)) {
          setError("Use a letter, number, or arrow key.");
          return;
        }
        if (
          slotsRef.current.some((slot) =>
            slot.keys.some(
              (code, index) =>
                code === event.code &&
                (slot.id !== binding.id || index !== binding.index),
            ),
          )
        ) {
          setError("That key is already assigned to another control.");
          return;
        }
        setSlots((current) =>
          current.map((slot) =>
            slot.id === binding.id
              ? {
                  ...slot,
                  keys: slot.keys.map((key, index) =>
                    index === binding.index ? event.code : key,
                  ),
                }
              : slot,
          ),
        );
        setBinding(null);
        setError("");
        return;
      }
      if (
        event.code === "Space" &&
        roomRef.current?.hostDeviceId === deviceId
      ) {
        event.preventDefault();
        if (
          !event.repeat &&
          roomRef.current?.phase === "lobby" &&
          roomRef.current.players.filter((player) => player.connected).length >= 2
        )
          send({ type: "start" });
        else if (!event.repeat && roomRef.current?.phase === "ready")
          send({ type: "countdown" });
        else if (!event.repeat && roomRef.current?.phase === "roundEnd")
          send({ type: "next" });
        else if (
          !event.repeat &&
          ["playing", "countdown", "paused"].includes(
            roomRef.current?.phase ?? "",
          )
        )
          send({ type: "pause" });
        return;
      }
      if (
        (roomRef.current?.phase ?? "lobby") === "lobby" &&
        !spectatorRef.current
      ) {
        const slot = slotsRef.current.find((candidate) =>
          candidate.keys.includes(event.code),
        );
        if (slot) {
          event.preventDefault();
          if (event.repeat) return;
          if (slot.keys[2] === event.code) {
            if (isPowerForced(roomRef.current, slot.id)) {
              if (!slot.enabled) changeSlot(slot.id, { enabled: true });
            } else {
              const index = POWER_ORDER.indexOf(slot.power ?? "none");
              changeSlot(slot.id, {
                enabled: true,
                power: POWER_ORDER[(index + 1) % POWER_ORDER.length],
              });
            }
          } else if (!slot.enabled) {
            changeSlot(slot.id, { enabled: true });
          }
          return;
        }
      }
      if (
        !slotsRef.current.some(
          (slot) => slot.enabled && slot.keys.includes(event.code),
        ) ||
        roomRef.current?.phase !== "playing"
      )
        return;
      event.preventDefault();
      if (pressed.current.has(event.code)) return;
      pressed.current.add(event.code);
      sendInputs();
    };
    const up = (event: KeyboardEvent) => {
      if (pressed.current.delete(event.code)) {
        event.preventDefault();
        sendInputs();
      }
    };
    const release = () => {
      pressed.current.clear();
      touch.current.clear();
      touchPower.current.clear();
      sendInputs();
    };
    const hidden = () => {
      if (document.hidden) release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", hidden);
    const heartbeat = setInterval(() => {
      if (!document.hidden) sendInputs();
    }, 200);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", hidden);
      clearInterval(heartbeat);
    };
  }, [binding, deviceId]);

  function roster(values = slotsRef.current): LocalPlayer[] {
    return values
      .filter((slot) => slot.enabled)
      .map(({ id, name, power }) => ({
        id,
        name: name.trim() || "Player",
        power,
      }));
  }
  function reconcileRoster(accepted: RoomView) {
    const own = accepted.players.filter((player) => player.deviceId === deviceId);
    const missing = own.filter((player) => !slotsRef.current.some((slot) => slot.id === player.id));
    const next = slotsRef.current.map((slot) => {
      const player = own.find((player) => player.id === slot.id) ?? missing.shift();
      return player ? {
        ...slot, id: player.id,
        name: editingNameRef.current === player.id ? slot.name : player.name,
        enabled: true,
        power: isPowerForced(accepted, player.id) ? slot.power : player.power,
      } : { ...slot, enabled: false };
    });
    slotsRef.current = next;
    setSlots(next);
  }
  function changePowerRules(rules: PowerRules) {
    if (!roomRef.current || !send({ type: "powerRules", rules })) return;
    pendingPowerRulesRequests.current++;
    powerRulesDraft.current = rules;
    roomRef.current = { ...roomRef.current, powerRules: rules };
    setRoom(roomRef.current);
  }
  function changeSlot(id: string, change: Partial<Slot>, updateServer = true) {
    const next = slotsRef.current.map((slot) =>
      slot.id === id ? { ...slot, ...change } : slot,
    );
    slotsRef.current = next;
    setSlots(next);
    if (
      updateServer &&
      roomRef.current?.phase === "lobby" &&
      !spectatorRef.current
    ) {
      if (send({ type: "players", players: roster(next) })) pendingRosterRequests.current++;
    }
  }
  function createRoom() {
    setError("");
    if (!enabled.length) {
      setError("Choose at least one player on this device.");
      return;
    }
    spectatorRef.current = false;
    setSpectator(false);
    sessionStorage.setItem("kurve-spectator", "false");
    setPending(
      send({
        type: "create",
        deviceId,
        sessionToken,
        players: roster(),
        settings,
      }),
    );
  }
  function joinRoom(watch = false) {
    setError("");
    if (!/^[A-Z0-9]{5,6}$/.test(joinCode.trim().toUpperCase())) {
      setError("Enter the room code shown on the host’s screen.");
      return;
    }
    if (!watch && !enabled.length) {
      setError("Choose at least one player, or join as a spectator.");
      return;
    }
    spectatorRef.current = watch;
    setSpectator(watch);
    sessionStorage.setItem("kurve-spectator", String(watch));
    setPending(
      send(
        watch
          ? {
              type: "spectate",
              code: joinCode.trim().toUpperCase(),
              deviceId,
              sessionToken,
            }
          : {
              type: "join",
              code: joinCode.trim().toUpperCase(),
              deviceId,
              sessionToken,
              players: roster(),
            },
      ),
    );
  }
  function changeSettings(change: Partial<GameSettings>) {
    setSettings((previous) => ({ ...previous, ...change }));
    if (room) send({ type: "settings", settings: change });
  }
  async function inviteLink() {
    if (!room) return;
    const link = `${location.origin}/?room=${room.code}`;
    try {
      await navigator.clipboard.writeText(link);
      setToast("Invite link copied");
    } catch {
      const input = document.createElement("textarea");
      input.value = link;
      input.style.position = "fixed";
      input.style.opacity = "0";
      let copied = false;
      try {
        document.body.appendChild(input);
        input.select();
        copied = document.execCommand("copy");
      } catch {
        // Legacy clipboard access can also be blocked by browser policy.
      } finally {
        input.remove();
      }
      setToast(copied ? "Invite link copied" : `Invite: ${link}`);
    }
  }
  function leaveRoom() {
    sessionStorage.removeItem("kurve-room");
    sessionStorage.removeItem("kurve-spectator");
    // Reopening the page closes this device’s connection and releases its player slots.
    location.assign(location.pathname);
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setToast("Use your browser’s fullscreen shortcut (F11).");
    }
  }
  const connectionLabel = connected
    ? latency === null
      ? "Connected"
      : `${latency} ms`
    : connectionReplaced ? "Open in another tab" : "Reconnecting…";

  return (
    <div
      className={`${s.app} ${inGame ? s.gameApp : ""} ${projector ? s.projector : ""}`}
    >
      <header className={s.header}>
        <span className={s.connection}>{connectionLabel}</span>
        {connectionReplaced && (
          <Button variant="outline" className={s.button} onClick={() => {
            setConnectionReplaced(false);
            setConnectionAttempt((attempt) => attempt + 1);
          }}>Reconnect here</Button>
        )}
        <Button variant="ghost" className={s.textButton} onClick={fullscreen}>
          Fullscreen
        </Button>
      </header>
      <main className={s.main}>
        {!inGame ? (
          <div className={s.layout}>
            <section
              className={s.playersPanel}
              aria-label="Players on this device"
            >
              <Table className={s.table}>
                <TableHeader>
                  <TableRow className={s.tableHeader}>
                    <TableHead>player</TableHead>
                    <TableHead>left</TableHead>
                    <TableHead>right</TableHead>
                    <TableHead>power</TableHead>
                    <TableHead>superpower</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {slots.map((slot, i) => {
                    const actual = room?.players.find(
                      (player) => player.id === slot.id,
                    );
                    const powerForced = isPowerForced(room, slot.id);
                    const displayedName =
                      editingNameId === slot.id
                        ? slot.name
                        : (actual?.name ?? slot.name);
                    const color = actual?.color ?? COLORS[i];
                    return (
                      <TableRow
                        key={slot.id}
                        className={`${s.playerRow} ${slot.enabled ? s.activeRow : ""}`}
                        style={{ "--player-color": color } as CSSProperties}
                      >
                        <TableCell>
                          <div className={s.playerIdentity}>
                            <Button
                              variant="ghost"
                              className={s.playerToggle}
                              role="switch"
                              aria-checked={slot.enabled}
                              aria-label={`Enable ${displayedName}`}
                              disabled={!!room && spectator}
                              onClick={() =>
                                changeSlot(slot.id, { enabled: !slot.enabled })
                              }
                            >
                              <span className={s.colorDot}>
                                {slot.enabled ? "✓" : "+"}
                              </span>
                            </Button>
                            <Input
                              className={s.customNameInput}
                              aria-label={`Player ${i + 1} name`}
                              value={displayedName}
                              maxLength={24}
                              disabled={!!room && spectator}
                              onFocus={() => setEditingNameId(slot.id)}
                              onChange={(event) =>
                                changeSlot(
                                  slot.id,
                                  { name: event.target.value },
                                  false,
                                )
                              }
                              onBlur={() => {
                                changeSlot(slot.id, {
                                  name: slot.name.trim() || NAMES[i],
                                });
                                setEditingNameId(null);
                              }}
                            />
                          </div>
                        </TableCell>
                        {slot.keys.map((key, index) => (
                          <TableCell key={index}>
                            <Button
                              variant="ghost"
                              className={s.keyButton}
                              onClick={() => setBinding({ id: slot.id, index })}
                              aria-label={`Change ${displayedName} ${["left", "right", "power"][index]} key`}
                              title="Click, then press a new key"
                            >
                              {binding?.id === slot.id &&
                              binding.index === index
                                ? "…"
                                : keyLabel(key)}
                            </Button>
                          </TableCell>
                        ))}
                        <TableCell>
                          <NativeSelect
                            className={s.power}
                            aria-label={`${displayedName} ability`}
                            value={
                              powerForced
                                ? ((room ? playerPower(room.powerRules, slot.id) : undefined) ??
                                  room?.powerRules.everyone ??
                                  actual?.power ??
                                  slot.power ??
                                  "none")
                                : (slot.power ?? "none")
                            }
                            disabled={(!!room && spectator) || powerForced}
                            onChange={(event) =>
                              changeSlot(slot.id, {
                                power: event.target
                                  .value as LocalPlayer["power"],
                              })
                            }
                          >
                            {Object.entries(POWER_NAMES).map(
                              ([value, name]) => (
                                <NativeSelectOption key={value} value={value}>
                                  {name.toLowerCase()}
                                </NativeSelectOption>
                              ),
                            )}
                          </NativeSelect>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {!(room && spectator) && (
                <p className={s.muted}>
                  Press any player key to join; in the lobby, their power key cycles superpowers.
                </p>
              )}
            </section>
            <section className={s.roomPanel} aria-label="Multiplayer room">
              {!room ? (
                <>
                  <div className={s.tabs}>
                    <Button
                      variant="outline"
                      className={`${s.tab} ${tab === "host" ? s.selectedTab : ""}`}
                      onClick={() => setTab("host")}
                    >
                      Create a room
                    </Button>
                    <Button
                      variant="outline"
                      className={`${s.tab} ${tab === "join" ? s.selectedTab : ""}`}
                      onClick={() => setTab("join")}
                    >
                      Join a room
                    </Button>
                  </div>
                  <div className={s.roomBody}>
                    {tab === "host" ? (
                      <>
                        <GameOptions
                          settings={settings}
                          change={changeSettings}
                        />
                        <Button
                          className={`${s.button} ${s.primaryButton}`}
                          disabled={!connected || pending}
                          onClick={createRoom}
                        >
                          {pending ? "Creating…" : "Create room"}
                        </Button>
                      </>
                    ) : (
                      <div className={s.joinFields}>
                        <Input
                          className={`${s.input} ${s.roomCodeInput}`}
                          aria-label="Room code"
                          value={joinCode}
                          maxLength={6}
                          placeholder="Room code"
                          autoComplete="off"
                          autoCapitalize="characters"
                          onChange={(event) =>
                            setJoinCode(
                              event.target.value
                                .replace(/[^a-z0-9]/gi, "")
                                .toUpperCase(),
                            )
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") joinRoom();
                          }}
                        />
                        <Button
                          className={s.button}
                          disabled={!connected || pending}
                          onClick={() => joinRoom()}
                        >
                          {pending ? "Joining…" : "Join game"}
                        </Button>
                        <Button
                          variant="outline"
                          className={s.button}
                          disabled={!connected || pending}
                          onClick={() => joinRoom(true)}
                        >
                          Spectate
                        </Button>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className={s.roomBody}>
                  <div className={s.codeBar}>
                    <span>
                      Room <strong className={s.roomCode}>{room.code}</strong>
                    </span>
                    <Button
                      variant="outline"
                      className={s.button}
                      onClick={inviteLink}
                    >
                      Copy invite link
                    </Button>
                    <Button
                      variant="ghost"
                      className={s.textButton}
                      onClick={leaveRoom}
                    >
                      Leave room
                    </Button>
                  </div>
                  <div className={s.roomMembers} aria-label="Room players">
                    {room.players.map((player) => (
                      <span
                        className={s.member}
                        key={player.id}
                        style={{ color: player.color }}
                      >
                        {player.name}
                        {!player.connected ? " (offline)" : ""}
                      </span>
                    ))}
                  </div>
                  {host && room.phase === "lobby" && (
                    <section
                      className={s.powerManager}
                      aria-label="Party superpower management"
                    >
                      <h3 className={s.roomHeading}>Superpower rules</h3>
                      <div className={s.powerManagerControls}>
                        <NativeSelect
                          className={s.select}
                          aria-label="Superpower for everyone"
                          value={powerPreset}
                          onChange={(event) =>
                            setPowerPreset(event.target.value as Power | "")
                          }
                        >
                          <NativeSelectOption value="">
                            Player choice
                          </NativeSelectOption>
                          {POWER_ORDER.map((power) => (
                            <NativeSelectOption key={power} value={power}>
                              {POWER_NAMES[power].toLowerCase()}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                        <Button
                          className={s.button}
                          disabled={!connected}
                          onClick={() =>
                            changePowerRules({
                                everyone: powerPreset || null,
                                players: {},
                            })
                          }
                        >
                          Apply to everyone
                        </Button>
                        <Button
                          variant="outline"
                          className={s.button}
                          disabled={!connected}
                          onClick={() =>
                            changePowerRules({ everyone: "random", players: {} })
                          }
                        >
                          Everyone random
                        </Button>
                      </div>
                      <p className={s.muted}>
                        Applying a party setting clears individual rules; set per-player exceptions below.
                      </p>
                      <div className={s.powerManagerList}>
                        {room.players.map((player) => (
                          <div className={s.powerManagerRow} key={player.id}>
                            <span
                              className={s.powerManagerName}
                              style={{ color: player.color }}
                            >
                              {player.name}
                              {!player.connected ? " (offline)" : ""}
                            </span>
                            <NativeSelect
                              className={s.select}
                              aria-label={`Force superpower for ${player.name}`}
                              value={playerPower(room.powerRules, player.id) ?? ""}
                              disabled={!connected}
                              onChange={(event) => {
                                const rules = powerRulesDraft.current ?? roomRef.current!.powerRules;
                                const players: Record<string, Power> = Object.assign(Object.create(null), rules.players);
                                if (event.target.value)
                                  players[player.id] = event.target.value as Power;
                                else delete players[player.id];
                                changePowerRules({
                                    everyone: rules.everyone,
                                    players,
                                });
                              }}
                            >
                              <NativeSelectOption value="">
                                {room.powerRules.everyone
                                  ? `Everyone: ${POWER_NAMES[room.powerRules.everyone].toLowerCase()}`
                                  : "Player choice"}
                              </NativeSelectOption>
                              {POWER_ORDER.map((power) => (
                                <NativeSelectOption key={power} value={power}>
                                  {POWER_NAMES[power].toLowerCase()}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                  <div className={s.roomActions}>
                    <span className={s.muted}>
                      {room.players.length} / 50 players
                    </span>
                    {room.players.filter((player) => player.connected).length <
                      2 && (
                      <span className={s.muted}>
                        At least two connected players are needed to start.
                      </span>
                    )}
                    {host ? (
                      <Button
                        className={`${s.button} ${s.primaryButton}`}
                        disabled={
                          !connected ||
                          room.players.filter((player) => player.connected)
                            .length < 2
                        }
                        onClick={() => send({ type: "start" })}
                      >
                        Start game <kbd>SPACE</kbd>
                      </Button>
                    ) : (
                      <span className={s.muted}>
                        {spectator ? "Spectating" : "Waiting for host"}
                      </span>
                    )}
                  </div>
                  {host && (
                    <GameOptions settings={settings} change={changeSettings} />
                  )}
                </div>
              )}
            </section>
          </div>
        ) : (
          <>
            <div
              className={`${s.gameLayout} ${projector && room.phase === "ready" ? s.projectorReady : ""}`}
            >
              <section className={s.arenaPanel}>
                <div className={s.arenaHeader}>
                  <span>
                    {room.deathmatch ? "Deathmatch" : `Round ${room.round}`}
                  </span>
                  <Button
                    variant="ghost"
                    className={s.textButton}
                    onClick={() => {
                      touch.current.clear();
                      touchPower.current.clear();
                      sendInputs();
                      setProjector(!projector);
                    }}
                  >
                    {projector ? "Exit projector" : "Projector view"}
                  </Button>
                </div>
                <div className={s.canvasWrap}>
                  <GameCanvas
                    room={room}
                    frameRef={frameRef}
                    inputRef={inputRef}
                    projector={projector}
                  />
                  {room.phase !== "ready" &&
                    (room.phase !== "playing" || !connected) && (
                    <div className={s.arenaOverlay}>
                      {!connected ? (
                        <h2 className={s.overlayTitle}>{connectionReplaced ? "Open in another tab" : "Reconnecting…"}</h2>
                      ) : room.phase === "paused" ? (
                        <>
                          <h2 className={s.overlayTitle}>Paused</h2>
                          {host && (
                            <Button
                              className={s.button}
                              onClick={() => send({ type: "pause" })}
                            >
                              Resume game
                            </Button>
                          )}
                        </>
                      ) : room.phase === "countdown" ? (
                        <span className={s.countdown}>{countdown}</span>
                      ) : (
                        <>
                          <h2
                            className={s.overlayTitle}
                            style={{ color: winner?.color }}
                          >
                            {winner
                              ? `${winner.name} wins${room.phase === "finished" ? " the game" : " the round"}`
                              : "Draw"}
                          </h2>
                          {room.deathmatch && room.phase !== "finished" && (
                            <p className={s.overlayCopy}>
                              Tied leaders play a deathmatch.
                            </p>
                          )}
                          {host ? (
                            <Button
                              className={s.button}
                              onClick={() =>
                                send({
                                  type:
                                    room.phase === "finished"
                                      ? "lobby"
                                      : "next",
                                })
                              }
                            >
                              {room.phase === "finished"
                                ? "Back to lobby"
                                : "Next round"}
                            </Button>
                          ) : (
                            <span className={s.muted}>Waiting for host</span>
                          )}
                          {room.phase === "roundEnd" && (
                            <p className={s.overlayCopy}>
                              Press <kbd>SPACE</kbd> to prepare the next round.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
                {!projector && host && (
                  <div className={s.controlsBar}>
                    {["playing", "countdown", "paused"].includes(
                      room.phase,
                    ) && (
                      <Button
                        variant="outline"
                        className={s.button}
                        onClick={() => send({ type: "pause" })}
                      >
                        {room.phase === "paused" ? "Resume" : "Pause"}{" "}
                        <kbd>SPACE</kbd>
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      className={s.button}
                      onClick={() => send({ type: "lobby" })}
                    >
                      Lobby
                    </Button>
                  </div>
                )}
              </section>
              {(!projector || room.phase === "ready") && (
                <aside className={s.scoreboard}>
                  {room.phase === "ready" && (
                    <div className={s.readyPrompt}>
                      <h2 className={s.overlayTitle}>
                        Find your name on the board
                      </h2>
                      <p className={s.overlayCopy}>
                        {host ? (
                          <>
                            When everyone’s ready, press <kbd>SPACE</kbd> or start
                            the countdown below.
                          </>
                        ) : (
                          "Waiting for the host to start the countdown."
                        )}
                      </p>
                      {host && (
                        <Button className={s.button} disabled={!connected}
                          onClick={() => send({ type: "countdown" })}>
                          Start countdown
                        </Button>
                      )}
                    </div>
                  )}
                  <div className={s.panelHeader}>
                    <span>Score</span>
                    <span className={s.muted}>First to {target}</span>
                  </div>
                  {[...room.players]
                    .sort((a, b) => b.score - a.score)
                    .map((player) => (
                      <div className={s.scoreRow} key={player.id}>
                        <div
                          className={s.scoreName}
                          style={{ color: player.color }}
                        >
                          <strong>{player.name}</strong>
                          {player.power !== "none" && (
                            <small>
                              {POWER_NAMES[player.roundPower ?? player.power]}
                              {!["none", "chuck"].includes(
                                player.roundPower ?? player.power,
                              ) && ` · ${player.charges}`}
                            </small>
                          )}
                        </div>
                        <span className={s.scoreValue}>{player.score}</span>
                      </div>
                    ))}
                  <div className={s.roomBody}>
                    <span className={s.roomCode}>{room.code}</span>
                    {spectator && <span className={s.muted}>Spectating</span>}
                  </div>
                </aside>
              )}
            </div>
            {!spectator && !projector && (
              <div className={s.touchControls} aria-label="Touch controls">
                {room.players
                  .filter((player) => player.deviceId === deviceId)
                  .map((player) => {
                    const slot = slots.find((value) => value.id === player.id);
                    return (
                      <div
                        className={s.touchPlayer}
                        style={
                          { "--player-color": player.color } as CSSProperties
                        }
                        key={player.id}
                      >
                        <span>{player.name}</span>
                        {([-1, 1] as Turn[]).map((turn, index) => (
                          <Button
                            variant="outline"
                            className={s.touchButton}
                            key={turn}
                            aria-label={`${player.name} turn ${turn === -1 ? "left" : "right"}`}
                            onPointerDown={(event) => {
                              event.currentTarget.setPointerCapture(
                                event.pointerId,
                              );
                              const keys =
                                touch.current.get(player.id) ?? new Map<number, Turn>();
                              keys.set(event.pointerId, turn);
                              touch.current.set(player.id, keys);
                              sendInputs();
                            }}
                            onPointerUp={(event) => {
                              touch.current.get(player.id)?.delete(event.pointerId);
                              sendInputs();
                            }}
                            onPointerCancel={(event) => {
                              touch.current.get(player.id)?.delete(event.pointerId);
                              sendInputs();
                            }}
                            onLostPointerCapture={(event) => {
                              touch.current.get(player.id)?.delete(event.pointerId);
                              sendInputs();
                            }}
                          >
                            {turn === -1 ? "↶" : "↷"}
                            <kbd>{slot ? keyLabel(slot.keys[index]) : ""}</kbd>
                          </Button>
                        ))}
                        {!["none", "wrap", "chuck"].includes(
                          player.roundPower ?? player.power,
                        ) && (
                          <Button
                            variant="outline"
                            className={s.touchButton}
                            disabled={player.charges === 0}
                            onPointerDown={(event) => {
                              event.currentTarget.setPointerCapture(
                                event.pointerId,
                              );
                              touchPower.current.set(event.pointerId, player.id);
                              sendInputs();
                            }}
                            onPointerUp={(event) => {
                              touchPower.current.delete(event.pointerId);
                              sendInputs();
                            }}
                            onPointerCancel={(event) => {
                              touchPower.current.delete(event.pointerId);
                              sendInputs();
                            }}
                            onLostPointerCapture={(event) => {
                              touchPower.current.delete(event.pointerId);
                              sendInputs();
                            }}
                            aria-label={`${player.name} use ${POWER_NAMES[player.roundPower ?? player.power]}`}
                          >
                            ⚡<kbd>{slot ? keyLabel(slot.keys[2]) : ""}</kbd>
                          </Button>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </>
        )}
        {error && (
          <div className={s.error} role="alert">
            {error}
            <Button
              variant="ghost"
              className={s.textButton}
              onClick={() => setError("")}
              aria-label="Dismiss error"
            >
              ×
            </Button>
          </div>
        )}
      </main>
      {toast && (
        <div className={s.toast} role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function GameOptions({
  settings,
  change,
}: {
  settings: GameSettings;
  change: (value: Partial<GameSettings>) => void;
}) {
  return (
    <div className={s.settings}>
      <div className={`${s.settingRow} ${s.mapSizeRow}`}>
        <label htmlFor="map-size">Map size</label>
        <NativeSelect
          id="map-size"
          className={s.select}
          value={settings.mapSize}
          onChange={(event) =>
            change({ mapSize: event.target.value as GameSettings["mapSize"] })
          }
        >
          {Object.entries(MAP_SIZES).map(([value, size]) => (
            <NativeSelectOption key={value} value={value}>
              {size.label} · {size.width} × {size.height}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className={s.settingRow}>
        <label htmlFor="speed">Speed</label>
        <NativeSelect
          id="speed"
          className={s.select}
          value={settings.speed}
          onChange={(event) =>
            change({ speed: event.target.value as GameSettings["speed"] })
          }
        >
          <NativeSelectOption value="slow">Relaxed</NativeSelectOption>
          <NativeSelectOption value="normal">Classic</NativeSelectOption>
          <NativeSelectOption value="fast">Fast</NativeSelectOption>
        </NativeSelect>
      </div>
      <div className={s.settingRow}>
        <label htmlFor="target">Play to</label>
        <NativeSelect
          id="target"
          className={s.select}
          value={settings.targetScore}
          onChange={(event) =>
            change({ targetScore: Number(event.target.value) })
          }
        >
          <NativeSelectOption value="0">Classic score</NativeSelectOption>
          <NativeSelectOption value="10">10 points</NativeSelectOption>
          <NativeSelectOption value="20">20 points</NativeSelectOption>
          <NativeSelectOption value="50">50 points</NativeSelectOption>
        </NativeSelect>
      </div>
      <div className={s.settingRow}>
        <label htmlFor="gap-size">Gap size</label>
        <NativeSelect
          id="gap-size"
          className={s.select}
          value={settings.gapSize}
          onChange={(event) =>
            change({ gapSize: event.target.value as GameSettings["gapSize"] })
          }
        >
          <NativeSelectOption value="small">Small</NativeSelectOption>
          <NativeSelectOption value="medium">Medium</NativeSelectOption>
          <NativeSelectOption value="large">Large</NativeSelectOption>
          <NativeSelectOption value="custom">Custom</NativeSelectOption>
        </NativeSelect>
      </div>
      {settings.gapSize === "custom" && (
        <div className={s.settingRow}>
          <span id="custom-gap-size-label">Custom length</span>
          <Slider
            aria-labelledby="custom-gap-size-label"
            className="w-36"
            min={8}
            max={50}
            step={1}
            value={[settings.customGapSize]}
            onValueChange={(value) =>
              change({ customGapSize: value[0] ?? settings.customGapSize })
            }
          />
          <output>{settings.customGapSize} ticks</output>
        </div>
      )}
      <div className={s.settingRow}>
        <span id="gaps-label">Gaps</span>
        <Switch
          aria-labelledby="gaps-label"
          checked={settings.gaps}
          onCheckedChange={(checked) => change({ gaps: checked })}
        />
      </div>
    </div>
  );
}
