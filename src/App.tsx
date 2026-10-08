import { useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  ClientMessage,
  GameSettings,
  LocalPlayer,
  RoomView,
  ServerMessage,
  Turn,
} from "../shared/types";
import GameCanvas, { type FrameData } from "./GameCanvas";
import { DEFAULT_KEYS, keyLabel, newId, steering } from "./controls";
import s from "./App.module.css";

type Slot = LocalPlayer & { enabled: boolean; keys: string[] };
const COLORS = [
  "#f36a6e",
  "#f5ad63",
  "#91ce7d",
  "#79b9f5",
  "#b394e8",
  "#e48db9",
];
const NAMES = ["Red", "Orange", "Green", "Blue", "Purple", "Pink"];
const DEFAULT_SETTINGS: GameSettings = {
  speed: "normal",
  targetScore: 0,
  gaps: true,
};
const POWER_NAMES = {
  none: "No power",
  jump: "Jump",
  boost: "Speed boost",
  shield: "Invisible",
};

function loadSlots(): Slot[] {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem("kurve-players") ?? "null",
    ) as Slot[] | null;
    if (
      saved?.length === 6 &&
      saved.every(
        (slot) =>
          typeof slot.id === "string" &&
          typeof slot.name === "string" &&
          slot.keys?.length === 3,
      )
    )
      return saved;
  } catch {
    /* A corrupt preference should never prevent opening the game. */
  }
  return NAMES.map((name, i) => ({
    id: newId(),
    name,
    enabled: i < 2,
    keys: DEFAULT_KEYS[i],
    power: "none",
  }));
}

function Icon({
  name,
}: {
  name:
    | "help"
    | "expand"
    | "link"
    | "arrow"
    | "keyboard"
    | "wifi"
    | "eye"
    | "close";
}) {
  const paths = {
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.7 9a2.3 2.3 0 1 1 3.3 2.1c-1 .5-1 1-1 1.9M12 16h.01" />
      </>
    ),
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    link: (
      <>
        <path d="m10 13 4-4M9 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1" />
      </>
    ),
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    keyboard: (
      <>
        <rect x="2" y="5" width="20" height="14" rx="3" />
        <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M9 15h6" />
      </>
    ),
    wifi: (
      <path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0m-4 4h.01" />
    ),
    eye: (
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
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
  const [rules, setRules] = useState(false);
  const [binding, setBinding] = useState<{ id: string; index: number } | null>(
    null,
  );
  const ws = useRef<WebSocket | null>(null);
  const frameRef = useRef<FrameData>({
    tick: 0,
    heads: [],
    segments: [],
    receivedAt: 0,
    reset: 0,
  });
  const [countdown, setCountdown] = useState(3);
  const pressed = useRef(new Set<string>());
  const touch = useRef(new Map<string, Set<Turn>>());
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
      const socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      );
      ws.current = socket;
      socket.onopen = () => {
        if (!active) return socket.close();
        setConnected(true);
        attempts = 0;
        setError("");
        const code = sessionStorage.getItem("kurve-room");
        if (code)
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
          const previous = roomRef.current;
          if (
            message.type === "snapshot" ||
            message.room.round !== previous?.round ||
            (message.room.phase === "countdown" &&
              previous?.phase !== "countdown")
          ) {
            frameRef.current.reset++;
            frameRef.current.segments =
              message.type === "snapshot" ? message.segments : [];
            frameRef.current.heads =
              message.type === "snapshot" ? message.heads : [];
            frameRef.current.receivedAt = performance.now();
            setCountdown(3);
          }
          roomRef.current = message.room;
          setRoom(message.room);
          setSettings(message.room.settings);
          setPending(false);
          sessionStorage.setItem("kurve-room", message.room.code);
        } else if (message.type === "frame") {
          frameRef.current.tick = message.tick;
          frameRef.current.heads = message.heads;
          frameRef.current.segments.push(...message.segments);
          frameRef.current.receivedAt = performance.now();
          if (message.countdown !== undefined)
            setCountdown(Math.max(1, Math.ceil(message.countdown)));
        } else if (message.type === "error") {
          setError(message.message);
          setPending(false);
          if (
            !roomRef.current ||
            message.message.startsWith("Room not found.")
          ) {
            sessionStorage.removeItem("kurve-room");
            roomRef.current = null;
            setRoom(null);
          }
        } else if (message.type === "pong")
          setLatency(Math.round(performance.now() - message.at));
      };
      socket.onclose = () => {
        if (!active) return;
        setConnected(false);
        setPending(false);
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
  }, [deviceId, sessionToken]);

  useEffect(() => {
    sessionStorage.setItem("kurve-players", JSON.stringify(slots));
  }, [slots]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!rules) return;
    const dialog = document.querySelector<HTMLDialogElement>("dialog");
    dialog?.showModal();
    return () => dialog?.close();
  }, [rules]);

  function sendInputs(powerId?: string) {
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
        const touchKeys = touch.current.get(slot.id);
        return {
          id: slot.id,
          turn: steering(
            pressed.current.has(slot.keys[0]) || !!touchKeys?.has(-1),
            pressed.current.has(slot.keys[1]) || !!touchKeys?.has(1),
          ),
          power: powerId === slot.id,
        };
      });
    ws.current.send(JSON.stringify({ type: "input", inputs }));
  }

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        rules
      )
        return;
      if (binding) {
        event.preventDefault();
        if (event.code === "Escape") {
          setBinding(null);
          return;
        }
        if (
          [
            "Space",
            "Tab",
            "MetaLeft",
            "MetaRight",
            "ControlLeft",
            "ControlRight",
            "AltLeft",
            "AltRight",
          ].includes(event.code)
        ) {
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
        if (!event.repeat && roomRef.current?.phase === "lobby")
          send({ type: "start" });
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
        !slotsRef.current.some(
          (slot) => slot.enabled && slot.keys.includes(event.code),
        ) ||
        roomRef.current?.phase !== "playing"
      )
        return;
      event.preventDefault();
      pressed.current.add(event.code);
      const powerSlot = !event.repeat
        ? slotsRef.current.find(
            (slot) => slot.enabled && slot.keys[2] === event.code,
          )
        : undefined;
      sendInputs(powerSlot?.id);
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
  }, [binding, rules, deviceId]);

  function roster(values = slotsRef.current): LocalPlayer[] {
    return values
      .filter((slot) => slot.enabled)
      .map(({ id, name, power }) => ({
        id,
        name: name.trim() || "Player",
        power,
      }));
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
    )
      send({ type: "players", players: roster(next) });
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
      setToast(`Invite: ${link}`);
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
    : "Reconnecting…";

  return (
    <div className={`${s.app} ${projector ? s.projector : ""}`}>
      <header className={s.header}>
        <a className={s.brand} href="/" aria-label="Achtung die Kurve home">
          <svg
            className={s.brandMark}
            width="40"
            height="40"
            viewBox="0 0 40 40"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M7 32V17a10 10 0 0 1 20 0v3"
              stroke="currentColor"
              strokeWidth="5"
              strokeLinecap="round"
            />
            <circle cx="27" cy="29" r="3" fill="currentColor" />
          </svg>
          <span className={s.brandText}>
            ACHTUNG<span>die kurve!</span>
          </span>
        </a>
        <div className={s.headerActions}>
          <span className={s.connection}>
            <span
              className={s.statusDot}
              style={{ background: connected ? "#a8cf80" : "#f5ad63" }}
            />
            {connectionLabel}
          </span>
          <button
            className={s.iconButton}
            onClick={() => setRules(true)}
            title="How to play"
            aria-label="How to play"
          >
            <Icon name="help" />
          </button>
          <button
            className={s.iconButton}
            onClick={fullscreen}
            title="Fullscreen"
            aria-label="Fullscreen"
          >
            <Icon name="expand" />
          </button>
        </div>
      </header>

      <main className={s.main}>
        {!inGame ? (
          <>
            <div className={s.intro}>
              <div>
                <p className={s.eyebrow}>
                  <span /> THE CLASSROOM EDITION
                </p>
                <h1 className={s.title}>
                  Small turns. <span>Big chaos.</span>
                </h1>
                <p className={s.subtitle}>
                  The classic game. A whole new crowd.
                  <br />
                  Share a keyboard, join a room, and be the last curve standing.
                </p>
              </div>
              <svg
                width="220"
                height="130"
                viewBox="0 0 220 130"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M15 112V45a25 25 0 0 1 50 0v39a21 21 0 0 0 42 0V28"
                  stroke="#f36a6e"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
                <path
                  d="M12 73h29m12 0h99a26 26 0 0 0 0-52h-5"
                  stroke="#91ce7d"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
                <path
                  d="M190 112V76a23 23 0 0 0-46 0v17"
                  stroke="#79b9f5"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
                <circle cx="107" cy="23" r="5" fill="#f36a6e" />
                <circle cx="139" cy="21" r="5" fill="#91ce7d" />
                <circle cx="144" cy="100" r="5" fill="#79b9f5" />
              </svg>
            </div>
            <div className={s.layout}>
              <section
                className={s.playersPanel}
                aria-labelledby="players-title"
              >
                <div className={s.panelHeader}>
                  <div>
                    <h2 className={s.panelTitle} id="players-title">
                      Your players{" "}
                      <span className={s.localMarker}>THIS DEVICE</span>
                    </h2>
                  </div>
                  <span className={s.badge}>{enabled.length} / 6 selected</span>
                </div>
                <div className={s.table}>
                  <div className={s.tableHeader}>
                    <span>PLAYER</span>
                    <span>LEFT</span>
                    <span>RIGHT</span>
                    <span>POWER</span>
                    <span>ABILITY</span>
                  </div>
                  {slots.map((slot, i) => {
                    const actual = room?.players.find(
                      (player) => player.id === slot.id,
                    );
                    const color = actual?.color ?? COLORS[i];
                    return (
                      <div
                        key={slot.id}
                        className={`${s.playerRow} ${slot.enabled ? s.activeRow : ""}`}
                        style={{ "--player-color": color } as CSSProperties}
                      >
                        <div className={s.playerIdentity}>
                          <button
                            className={s.playerToggle}
                            role="switch"
                            aria-checked={slot.enabled}
                            aria-label={`Enable ${slot.name}`}
                            disabled={!!room && spectator}
                            onClick={() =>
                              changeSlot(slot.id, { enabled: !slot.enabled })
                            }
                          >
                            <span className={s.colorDot}>
                              {slot.enabled ? "✓" : "+"}
                            </span>
                          </button>
                          <input
                            className={s.customNameInput}
                            aria-label={`Player ${i + 1} name`}
                            value={slot.name}
                            maxLength={24}
                            disabled={!!room && spectator}
                            onChange={(event) =>
                              changeSlot(
                                slot.id,
                                { name: event.target.value },
                                false,
                              )
                            }
                            onBlur={() =>
                              changeSlot(slot.id, {
                                name: slot.name.trim() || NAMES[i],
                              })
                            }
                          />
                        </div>
                        {slot.keys.map((key, index) => (
                          <button
                            key={index}
                            className={s.keyButton}
                            onClick={() => setBinding({ id: slot.id, index })}
                            aria-label={`Change ${slot.name} ${["left", "right", "power"][index]} key`}
                            title="Click, then press a new key"
                          >
                            {binding?.id === slot.id && binding.index === index
                              ? "…"
                              : keyLabel(key)}
                          </button>
                        ))}
                        <select
                          className={s.power}
                          aria-label={`${slot.name} ability`}
                          value={slot.power ?? "none"}
                          disabled={!!room && spectator}
                          onChange={(event) =>
                            changeSlot(slot.id, {
                              power: event.target.value as LocalPlayer["power"],
                            })
                          }
                        >
                          <option value="none">No power</option>
                          <option value="jump">Jump</option>
                          <option value="boost">Speed boost</option>
                          <option value="shield">Invisible</option>
                        </select>
                      </div>
                    );
                  })}
                </div>
                <div className={s.tableFooter}>
                  <span className={s.keyboardHint}>
                    <Icon name="keyboard" />
                    Click a color to join. Click a key to change it.
                  </span>
                  <span className={s.muted}>6 players · 1 keyboard</span>
                </div>
                {room && (
                  <div className={s.roomActions}>
                    {host ? (
                      <button
                        className={`${s.button} ${s.primaryButton}`}
                        disabled={
                          !connected ||
                          room.players.filter((player) => player.connected)
                            .length < 2
                        }
                        onClick={() => send({ type: "start" })}
                      >
                        Start game <Icon name="arrow" />
                      </button>
                    ) : (
                      <p className={s.roomCopy}>
                        {spectator
                          ? "You’re watching this room."
                          : "You’re in! The host will start the game."}
                      </p>
                    )}
                    {host && (
                      <span className={s.keyboardHint}>
                        or press <kbd>SPACE</kbd>
                      </span>
                    )}
                  </div>
                )}
              </section>

              <aside className={s.roomPanel}>
                {!room ? (
                  <>
                    <div className={s.tabs}>
                      <button
                        className={`${s.tab} ${tab === "host" ? s.selectedTab : ""}`}
                        onClick={() => setTab("host")}
                      >
                        Create a room
                      </button>
                      <button
                        className={`${s.tab} ${tab === "join" ? s.selectedTab : ""}`}
                        onClick={() => setTab("join")}
                      >
                        Join a room
                      </button>
                    </div>
                    <div className={s.roomBody}>
                      <div className={s.roomIcon}>
                        <Icon name={tab === "host" ? "wifi" : "link"} />
                      </div>
                      <h2 className={s.roomHeading}>
                        {tab === "host"
                          ? "Bring everyone in."
                          : "Find your people."}
                      </h2>
                      <p className={s.roomCopy}>
                        {tab === "host"
                          ? "One room. Up to 18 players. Everyone on the same playing field."
                          : "Choose your players on the left, then enter your host’s room code."}
                      </p>
                      {tab === "join" ? (
                        <div className={s.joinFields}>
                          <label className={s.sectionLabel} htmlFor="room-code">
                            ROOM CODE
                          </label>
                          <input
                            id="room-code"
                            className={`${s.input} ${s.roomCodeInput}`}
                            value={joinCode}
                            maxLength={6}
                            placeholder="ABCDE"
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
                          <button
                            className={`${s.button} ${s.primaryButton}`}
                            disabled={!connected || pending}
                            onClick={() => joinRoom()}
                          >
                            {pending ? "Joining…" : "Join game"}
                            <Icon name="arrow" />
                          </button>
                          <button
                            className={s.textButton}
                            disabled={!connected || pending}
                            onClick={() => joinRoom(true)}
                          >
                            <Icon name="eye" />
                            Join as a spectator
                          </button>
                        </div>
                      ) : (
                        <>
                          <GameOptions
                            settings={settings}
                            change={changeSettings}
                          />
                          <button
                            className={`${s.button} ${s.primaryButton}`}
                            disabled={!connected || pending}
                            onClick={createRoom}
                          >
                            {pending ? "Creating…" : "Create room"}
                            <Icon name="arrow" />
                          </button>
                        </>
                      )}
                      <p className={s.tip}>
                        <span className={s.statusDot} />
                        No accounts. Just a room code.
                      </p>
                    </div>
                  </>
                ) : (
                  <div className={s.roomBody}>
                    <p className={s.eyebrow}>
                      {host ? "YOUR ROOM IS OPEN" : "YOU’RE IN THE ROOM"}
                    </p>
                    <h2 className={s.roomHeading}>More friends. More chaos.</h2>
                    <p className={s.roomCopy}>
                      Open this website on another device and join with this
                      code.
                    </p>
                    <div
                      className={s.roomCode}
                      aria-label={`Room code ${room.code}`}
                    >
                      {room.code}
                    </div>
                    <button
                      className={`${s.button} ${s.secondaryButton}`}
                      onClick={inviteLink}
                    >
                      <Icon name="link" />
                      Copy invite link
                    </button>
                    <p className={s.sectionLabel}>
                      {room.players.length} / 18 PLAYERS ·{" "}
                      {
                        new Set(room.players.map((player) => player.deviceId))
                          .size
                      }{" "}
                      DEVICES
                    </p>
                    <div className={s.roomMembers}>
                      {room.players.map((player) => (
                        <div className={s.member} key={player.id}>
                          <span
                            className={s.memberDot}
                            style={{ background: player.color }}
                          />
                          <span>{player.name}</span>
                          {player.deviceId === deviceId && (
                            <span className={s.meBadge}>YOU</span>
                          )}
                          {!player.connected && (
                            <span className={s.muted}>offline</span>
                          )}
                        </div>
                      ))}
                    </div>
                    {host && (
                      <GameOptions
                        settings={settings}
                        change={changeSettings}
                      />
                    )}
                    <button className={s.textButton} onClick={leaveRoom}>
                      Leave room
                    </button>
                  </div>
                )}
              </aside>
            </div>
            <div className={s.serverNote}>
              <Icon name="wifi" />
              <span>
                Playing on school Wi-Fi? Open the host computer’s network
                address on every device.
              </span>
              <button className={s.textButton} onClick={() => setRules(true)}>
                How it works <span>↗</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={s.gameLayout}>
              <section className={s.arenaPanel}>
                <div className={s.arenaHeader}>
                  <div className={s.arenaTitle}>
                    <span className={s.statusDot} />
                    {room.deathmatch ? "DEATHMATCH" : `ROUND ${room.round}`}
                    <span className={s.muted}>
                      /{" "}
                      {room.phase === "playing"
                        ? "STAY ALIVE"
                        : room.phase === "countdown"
                          ? "GET READY"
                          : room.phase === "paused"
                            ? "PAUSED"
                            : "ROUND COMPLETE"}
                    </span>
                  </div>
                  <button
                    className={s.textButton}
                    onClick={() => setProjector(!projector)}
                  >
                    <Icon name="eye" />
                    {projector ? "Exit projector" : "Projector view"}
                  </button>
                </div>
                <div className={s.canvasWrap}>
                  <GameCanvas
                    room={room}
                    frameRef={frameRef}
                    projector={projector}
                  />
                  {(room.phase !== "playing" || !connected) && (
                    <div className={s.arenaOverlay}>
                      {!connected ? (
                        <>
                          <h2 className={s.overlayTitle}>Reconnecting…</h2>
                          <p className={s.overlayCopy}>
                            Keeping your place in the room.
                          </p>
                        </>
                      ) : room.phase === "paused" ? (
                        <>
                          <p className={s.eyebrow}>TAKE A BREATHER</p>
                          <h2 className={s.overlayTitle}>Game paused.</h2>
                          {host ? (
                            <button
                              className={`${s.button} ${s.primaryButton}`}
                              onClick={() => send({ type: "pause" })}
                            >
                              Resume game
                              <Icon name="arrow" />
                            </button>
                          ) : (
                            <p className={s.overlayCopy}>
                              Waiting for the host to resume…
                            </p>
                          )}
                        </>
                      ) : room.phase === "countdown" ? (
                        <>
                          <p className={s.eyebrow}>HANDS ON YOUR KEYS</p>
                          <span className={s.countdown}>{countdown}</span>
                          <p className={s.overlayCopy}>
                            Watch your color. Trust your turns.
                          </p>
                        </>
                      ) : (
                        <>
                          <p className={s.eyebrow}>
                            {room.phase === "finished"
                              ? "WE HAVE A WINNER"
                              : "LAST CURVE STANDING"}
                          </p>
                          <h2
                            className={s.overlayTitle}
                            style={{ color: winner?.color }}
                          >
                            {winner
                              ? `${winner.name} wins${room.phase === "finished" ? " the game" : " the round"}!`
                              : "A spectacular draw."}
                          </h2>
                          <p className={s.overlayCopy}>
                            {room.phase === "finished"
                              ? "Same friends. Another round of chaos?"
                              : room.deathmatch
                                ? "The leaders are tied. A final deathmatch decides the winner."
                                : `First to ${target} points wins the game.`}
                          </p>
                          {host ? (
                            <button
                              className={`${s.button} ${s.primaryButton}`}
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
                              <Icon name="arrow" />
                            </button>
                          ) : (
                            <p className={s.overlayCopy}>
                              Waiting for the host…
                            </p>
                          )}
                          {host && room.phase === "roundEnd" && (
                            <span className={s.keyboardHint}>
                              or press <kbd>SPACE</kbd>
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
                {!projector && (
                  <div className={s.controlsBar}>
                    <span className={s.keyboardHint}>
                      <Icon name="keyboard" />
                      Keep moving. Avoid the walls and every trail.
                    </span>
                    {host && (
                      <>
                        {["playing", "countdown", "paused"].includes(
                          room.phase,
                        ) && (
                          <button
                            className={s.textButton}
                            onClick={() => send({ type: "pause" })}
                          >
                            {room.phase === "paused" ? "Resume" : "Pause"}{" "}
                            <kbd>SPACE</kbd>
                          </button>
                        )}
                        <button
                          className={s.textButton}
                          onClick={() => send({ type: "lobby" })}
                        >
                          Back to lobby
                        </button>
                      </>
                    )}
                  </div>
                )}
              </section>
              {!projector && (
                <aside className={s.scoreboard}>
                  <div className={s.panelHeader}>
                    <h2 className={s.panelTitle}>Standings</h2>
                    <span className={s.badge}>FIRST TO {target}</span>
                  </div>
                  <div>
                    {[...room.players]
                      .sort((a, b) => b.score - a.score)
                      .map((player, i) => (
                        <div className={s.scoreRow} key={player.id}>
                          <span className={s.playerNumber}>
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <span
                            className={s.memberDot}
                            style={{ background: player.color }}
                          />
                          <div className={s.scoreName}>
                            <strong>{player.name}</strong>
                            <small>
                              {player.power === "none"
                                ? player.deviceId === deviceId
                                  ? "This device"
                                  : "Remote player"
                                : `${POWER_NAMES[player.power]} · ${player.charges} charges`}
                            </small>
                          </div>
                          <span className={s.scoreValue}>{player.score}</span>
                        </div>
                      ))}
                  </div>
                  <div className={s.roomBody}>
                    <p className={s.sectionLabel}>ROOM CODE</p>
                    <div className={s.roomCode}>{room.code}</div>
                    <button className={s.textButton} onClick={inviteLink}>
                      <Icon name="link" />
                      Copy invite link
                    </button>
                    {spectator && (
                      <p className={s.tip}>
                        <Icon name="eye" />
                        Spectator
                      </p>
                    )}
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
                          <button
                            className={s.touchButton}
                            key={turn}
                            aria-label={`${player.name} turn ${turn === -1 ? "left" : "right"}`}
                            onPointerDown={(event) => {
                              event.currentTarget.setPointerCapture(
                                event.pointerId,
                              );
                              const keys =
                                touch.current.get(player.id) ?? new Set<Turn>();
                              keys.add(turn);
                              touch.current.set(player.id, keys);
                              sendInputs();
                            }}
                            onPointerUp={() => {
                              touch.current.get(player.id)?.delete(turn);
                              sendInputs();
                            }}
                            onPointerCancel={() => {
                              touch.current.get(player.id)?.delete(turn);
                              sendInputs();
                            }}
                          >
                            {turn === -1 ? "↶" : "↷"}
                            <kbd>{slot ? keyLabel(slot.keys[index]) : ""}</kbd>
                          </button>
                        ))}
                        {player.power !== "none" && (
                          <button
                            className={s.touchButton}
                            disabled={player.charges === 0}
                            onPointerDown={() => sendInputs(player.id)}
                            aria-label={`${player.name} use ${POWER_NAMES[player.power]}`}
                          >
                            ⚡<kbd>{slot ? keyLabel(slot.keys[2]) : ""}</kbd>
                          </button>
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
            <button
              className={s.iconButton}
              onClick={() => setError("")}
              aria-label="Dismiss error"
            >
              <Icon name="close" />
            </button>
          </div>
        )}
      </main>

      {!projector && (
        <footer className={s.footer}>
          <span>Inspired by a classic. Built for your next break.</span>
          <div className={s.footerLinks}>
            <button onClick={() => setRules(true)}>How to play</button>
            <a
              href="https://achtungkurve.com/"
              target="_blank"
              rel="noreferrer"
            >
              The original ↗
            </a>
            <span>v1.0</span>
          </div>
        </footer>
      )}
      {toast && (
        <div className={s.toast} role="status">
          {toast}
        </div>
      )}
      {rules && (
        <dialog
          className={s.modal}
          onCancel={() => setRules(false)}
          aria-labelledby="rules-title"
        >
          <button
            className={`${s.iconButton} ${s.modalClose}`}
            onClick={() => setRules(false)}
            aria-label="Close how to play"
          >
            <Icon name="close" />
          </button>
          <p className={s.eyebrow}>TWO KEYS. THAT’S ALL IT TAKES.</p>
          <h2 className={s.roomHeading} id="rules-title">
            How to play
          </h2>
          <div className={s.rulesList}>
            {[
              [
                "Choose your crew",
                "Click a color to enable a player. Up to six people can share a keyboard. Rename players, change keys, and pick an ability before starting.",
              ],
              [
                "Join the same room",
                "The host creates a room and shares its code or invite link. Up to 18 players can join. A projector can join as a spectator without taking a player slot.",
              ],
              [
                "Keep your curve alive",
                "You move forward automatically. Hold your left or right key to turn. Hitting a wall or any trail ends your round. Watch for gaps to escape.",
              ],
              [
                "Outlast everyone",
                "Each eliminated player gives the survivors one point. The last curve standing wins the round. The host starts the next round with Space.",
              ],
              [
                "Use your power",
                "Jump skips a short section. Speed boost doubles your speed for four seconds. Invisible lets you cross trails for four seconds. Each use spends a charge.",
              ],
              [
                "Play on the school network",
                "Run the Node server on one computer. Everyone opens that computer’s LAN address, not localhost. A public Node host lets the same game work over the internet.",
              ],
            ].map(([title, text], i) => (
              <div key={title}>
                <span className={s.ruleNumber}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className={s.ruleText}>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              </div>
            ))}
          </div>
          <button
            className={`${s.button} ${s.primaryButton}`}
            onClick={() => setRules(false)}
          >
            Got it. Let’s play.
            <Icon name="arrow" />
          </button>
        </dialog>
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
      <div className={s.settingRow}>
        <label htmlFor="speed">Game speed</label>
        <select
          id="speed"
          className={s.select}
          value={settings.speed}
          onChange={(event) =>
            change({ speed: event.target.value as GameSettings["speed"] })
          }
        >
          <option value="slow">Relaxed</option>
          <option value="normal">Classic</option>
          <option value="fast">Fast</option>
        </select>
      </div>
      <div className={s.settingRow}>
        <label htmlFor="target">Play to</label>
        <select
          id="target"
          className={s.select}
          value={settings.targetScore}
          onChange={(event) =>
            change({ targetScore: Number(event.target.value) })
          }
        >
          <option value="0">Classic score</option>
          <option value="10">10 points</option>
          <option value="20">20 points</option>
          <option value="50">50 points</option>
        </select>
      </div>
      <div className={s.settingRow}>
        <span id="gaps-label">Trail gaps</span>
        <button
          role="switch"
          aria-labelledby="gaps-label"
          aria-checked={settings.gaps}
          className={`${s.switchButton} ${settings.gaps ? s.switchOn : ""}`}
          onClick={() => change({ gaps: !settings.gaps })}
        >
          <span />
        </button>
      </div>
    </div>
  );
}
