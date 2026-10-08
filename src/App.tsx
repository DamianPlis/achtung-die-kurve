import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ClientMessage, GameSettings, LocalPlayer, RoomView, ServerMessage, Turn } from '../shared/types';
import GameCanvas, { type FrameData } from './GameCanvas';
import { DEFAULT_KEYS, keyLabel, newId, steering } from './controls';
import s from './App.module.css';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

type Slot = LocalPlayer & { enabled: boolean; keys: string[] };
const COLORS = ['#f36a6e', '#f5ad63', '#91ce7d', '#79b9f5', '#b394e8', '#e48db9'];
const NAMES = ['Red', 'Orange', 'Green', 'Blue', 'Purple', 'Pink'];
const DEFAULT_SETTINGS: GameSettings = { speed: 'normal', targetScore: 0, gaps: true };
const POWER_NAMES = { none: 'No power', jump: 'Jump', boost: 'Speed boost', shield: 'Invisible' };

function loadSlots(): Slot[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem('kurve-players') ?? 'null') as Slot[] | null;
    if (saved?.length === 6 && saved.every(slot => typeof slot.id === 'string' && typeof slot.name === 'string' && slot.keys?.length === 3)) return saved;
  } catch { /* A corrupt preference should never prevent opening the game. */ }
  return NAMES.map((name, i) => ({ id: newId(), name, enabled: i < 2, keys: DEFAULT_KEYS[i], power: 'none' }));
}

export default function App() {
  const [slots, setSlots] = useState<Slot[]>(loadSlots);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const [deviceId] = useState(() => {
    let id = sessionStorage.getItem('kurve-device');
    if (!id) { id = newId(); sessionStorage.setItem('kurve-device', id); }
    return id;
  });
  const [sessionToken] = useState(() => {
    let token = sessionStorage.getItem('kurve-session-token');
    if (!token) { token = newId(); sessionStorage.setItem('kurve-session-token', token); }
    return token;
  });
  const [room, setRoom] = useState<RoomView | null>(null);
  const roomRef = useRef(room);
  roomRef.current = room;
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [latency, setLatency] = useState<number | null>(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [joinCode, setJoinCode] = useState(() => new URLSearchParams(location.search).get('room') ?? '');
  const [tab, setTab] = useState<'host' | 'join'>(() => location.search.includes('room=') ? 'join' : 'host');
  const [spectator, setSpectator] = useState(() => sessionStorage.getItem('kurve-spectator') === 'true');
  const spectatorRef = useRef(spectator);
  spectatorRef.current = spectator;
  const [projector, setProjector] = useState(false);
  const [binding, setBinding] = useState<{ id: string; index: number } | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const frameRef = useRef<FrameData>({ tick: 0, heads: [], segments: [], receivedAt: 0, reset: 0 });
  const [countdown, setCountdown] = useState(3);
  const pressed = useRef(new Set<string>());
  const touch = useRef(new Map<string, Set<Turn>>());
  const host = room?.hostDeviceId === deviceId;
  const inGame = !!room && room.phase !== 'lobby';
  const enabled = slots.filter(slot => slot.enabled);
  const winner = room?.players.find(player => player.id === room.winnerId);
  const target = room?.matchTarget || room?.settings.targetScore || Math.max(1, (room?.players.length ?? enabled.length) - 1) * 10;

  function send(message: ClientMessage) {
    if (ws.current?.readyState === WebSocket.OPEN) { ws.current.send(JSON.stringify(message)); return true; }
    setError('The server is reconnecting. Try again in a moment.');
    return false;
  }

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    function connect() {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.current = socket;
      socket.onopen = () => {
        if (!active) return socket.close();
        setConnected(true); attempts = 0; setError('');
        const code = sessionStorage.getItem('kurve-room');
        if (code) socket.send(JSON.stringify(spectatorRef.current
          ? { type: 'spectate', code, deviceId, sessionToken }
          : { type: 'join', code, deviceId, sessionToken, players: slotsRef.current.filter(slot => slot.enabled).map(({ id, name, power }) => ({ id, name, power })) }));
      };
      socket.onmessage = event => {
        if (!active) return;
        let message: ServerMessage;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'room' || message.type === 'snapshot') {
          const previous = roomRef.current;
          if (message.type === 'snapshot' || message.room.round !== previous?.round || (message.room.phase === 'countdown' && previous?.phase !== 'countdown')) {
            frameRef.current.reset++;
            frameRef.current.segments = message.type === 'snapshot' ? message.segments : [];
            frameRef.current.heads = message.type === 'snapshot' ? message.heads : [];
            frameRef.current.receivedAt = performance.now();
            setCountdown(3);
          }
          roomRef.current = message.room;
          setRoom(message.room); setSettings(message.room.settings); setPending(false);
          sessionStorage.setItem('kurve-room', message.room.code);
        } else if (message.type === 'frame') {
          frameRef.current.tick = message.tick;
          frameRef.current.heads = message.heads;
          frameRef.current.segments.push(...message.segments);
          frameRef.current.receivedAt = performance.now();
          if (message.countdown !== undefined) setCountdown(Math.max(1, Math.ceil(message.countdown)));
        } else if (message.type === 'error') {
          setError(message.message); setPending(false);
          if (!roomRef.current || message.message.startsWith('Room not found.')) {
            sessionStorage.removeItem('kurve-room');
            roomRef.current = null; setRoom(null);
          }
        } else if (message.type === 'pong') setLatency(Math.round(performance.now() - message.at));
      };
      socket.onclose = () => {
        if (!active) return;
        setConnected(false); setPending(false);
        timer = setTimeout(connect, Math.min(8000, 500 * 2 ** attempts++));
      };
      socket.onerror = () => socket.close();
    }
    connect();
    const ping = setInterval(() => {
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: 'ping', at: performance.now() }));
    }, 2000);
    return () => { active = false; clearTimeout(timer); clearInterval(ping); ws.current?.close(); };
  }, [deviceId, sessionToken]);

  useEffect(() => { sessionStorage.setItem('kurve-players', JSON.stringify(slots)); }, [slots]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3000); return () => clearTimeout(timer); }, [toast]);

  function sendInputs(powerId?: string) {
    if (roomRef.current?.phase !== 'playing' || spectatorRef.current || ws.current?.readyState !== WebSocket.OPEN) return;
    const localIds = new Set(roomRef.current.players.filter(player => player.deviceId === deviceId).map(player => player.id));
    const inputs = slotsRef.current.filter(slot => localIds.has(slot.id)).map(slot => {
      const touchKeys = touch.current.get(slot.id);
      return { id: slot.id, turn: steering(pressed.current.has(slot.keys[0]) || !!touchKeys?.has(-1), pressed.current.has(slot.keys[1]) || !!touchKeys?.has(1)), power: powerId === slot.id };
    });
    ws.current.send(JSON.stringify({ type: 'input', inputs }));
  }

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (binding) {
        event.preventDefault();
        if (event.code === 'Escape') { setBinding(null); return; }
        if (['Space', 'Tab', 'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight'].includes(event.code)) { setError('Use a letter, number, or arrow key.'); return; }
        if (slotsRef.current.some(slot => slot.keys.some((code, index) => code === event.code && (slot.id !== binding.id || index !== binding.index)))) { setError('That key is already assigned to another control.'); return; }
        setSlots(current => current.map(slot => slot.id === binding.id ? { ...slot, keys: slot.keys.map((key, index) => index === binding.index ? event.code : key) } : slot));
        setBinding(null); setError(''); return;
      }
      if (event.code === 'Space' && roomRef.current?.hostDeviceId === deviceId) {
        event.preventDefault();
        if (!event.repeat && roomRef.current?.phase === 'lobby') send({ type: 'start' });
        else if (!event.repeat && roomRef.current?.phase === 'roundEnd') send({ type: 'next' });
        else if (!event.repeat && ['playing', 'countdown', 'paused'].includes(roomRef.current?.phase ?? '')) send({ type: 'pause' });
        return;
      }
      if (!slotsRef.current.some(slot => slot.enabled && slot.keys.includes(event.code)) || roomRef.current?.phase !== 'playing') return;
      event.preventDefault();
      pressed.current.add(event.code);
      const powerSlot = !event.repeat ? slotsRef.current.find(slot => slot.enabled && slot.keys[2] === event.code) : undefined;
      sendInputs(powerSlot?.id);
    };
    const up = (event: KeyboardEvent) => {
      if (pressed.current.delete(event.code)) { event.preventDefault(); sendInputs(); }
    };
    const release = () => { pressed.current.clear(); touch.current.clear(); sendInputs(); };
    const hidden = () => { if (document.hidden) release(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    window.addEventListener('blur', release); document.addEventListener('visibilitychange', hidden);
    const heartbeat = setInterval(() => { if (!document.hidden) sendInputs(); }, 200);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', hidden); clearInterval(heartbeat); };
  }, [binding, deviceId]);

  function roster(values = slotsRef.current): LocalPlayer[] {
    return values.filter(slot => slot.enabled).map(({ id, name, power }) => ({ id, name: name.trim() || 'Player', power }));
  }
  function changeSlot(id: string, change: Partial<Slot>, updateServer = true) {
    const next = slotsRef.current.map(slot => slot.id === id ? { ...slot, ...change } : slot);
    slotsRef.current = next; setSlots(next);
    if (updateServer && roomRef.current?.phase === 'lobby' && !spectatorRef.current) send({ type: 'players', players: roster(next) });
  }
  function createRoom() {
    setError('');
    if (!enabled.length) { setError('Choose at least one player on this device.'); return; }
    spectatorRef.current = false; setSpectator(false); sessionStorage.setItem('kurve-spectator', 'false');
    setPending(send({ type: 'create', deviceId, sessionToken, players: roster(), settings }));
  }
  function joinRoom(watch = false) {
    setError('');
    if (!/^[A-Z0-9]{5,6}$/.test(joinCode.trim().toUpperCase())) { setError('Enter the room code shown on the host’s screen.'); return; }
    if (!watch && !enabled.length) { setError('Choose at least one player, or join as a spectator.'); return; }
    spectatorRef.current = watch; setSpectator(watch); sessionStorage.setItem('kurve-spectator', String(watch));
    setPending(send(watch ? { type: 'spectate', code: joinCode.trim().toUpperCase(), deviceId, sessionToken } : { type: 'join', code: joinCode.trim().toUpperCase(), deviceId, sessionToken, players: roster() }));
  }
  function changeSettings(change: Partial<GameSettings>) {
    setSettings(previous => ({ ...previous, ...change }));
    if (room) send({ type: 'settings', settings: change });
  }
  async function inviteLink() {
    if (!room) return;
    const link = `${location.origin}/?room=${room.code}`;
    try { await navigator.clipboard.writeText(link); setToast('Invite link copied'); }
    catch { setToast(`Invite: ${link}`); }
  }
  function leaveRoom() {
    sessionStorage.removeItem('kurve-room'); sessionStorage.removeItem('kurve-spectator');
    // Reopening the page closes this device’s connection and releases its player slots.
    location.assign(location.pathname);
  }
  async function fullscreen() {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { setToast('Use your browser’s fullscreen shortcut (F11).'); }
  }
  const connectionLabel = connected ? latency === null ? 'Connected' : `${latency} ms` : 'Reconnecting…';

  return <div className={`${s.app} ${inGame ? s.gameApp : ''} ${projector ? s.projector : ''}`}>
    <header className={s.header}>
      <span className={s.connection}>{connectionLabel}</span>
      <Button variant="ghost" className={s.textButton} onClick={fullscreen}>Fullscreen</Button>
    </header>
    <main className={s.main}>
      {!inGame ? <div className={s.layout}>
        <section className={s.playersPanel} aria-label="Players on this device">
          <Table className={s.table}>
            <TableHeader><TableRow className={s.tableHeader}><TableHead>player</TableHead><TableHead>left</TableHead><TableHead>right</TableHead><TableHead>power</TableHead><TableHead>superpower</TableHead></TableRow></TableHeader>
            <TableBody>{slots.map((slot, i) => {
              const actual = room?.players.find(player => player.id === slot.id);
              const color = actual?.color ?? COLORS[i];
              return <TableRow key={slot.id} className={`${s.playerRow} ${slot.enabled ? s.activeRow : ''}`} style={{ '--player-color': color } as CSSProperties}>
                <TableCell><div className={s.playerIdentity}>
                  <Button variant="ghost" className={s.playerToggle} role="switch" aria-checked={slot.enabled} aria-label={`Enable ${slot.name}`} disabled={!!room && spectator} onClick={() => changeSlot(slot.id, { enabled: !slot.enabled })}><span className={s.colorDot}>{slot.enabled ? '✓' : '+'}</span></Button>
                  <Input className={s.customNameInput} aria-label={`Player ${i + 1} name`} value={slot.name} maxLength={24} disabled={!!room && spectator} onChange={event => changeSlot(slot.id, { name: event.target.value }, false)} onBlur={() => changeSlot(slot.id, { name: slot.name.trim() || NAMES[i] })} />
                </div></TableCell>
                {slot.keys.map((key, index) => <TableCell key={index}><Button variant="ghost" className={s.keyButton} onClick={() => setBinding({ id: slot.id, index })} aria-label={`Change ${slot.name} ${['left', 'right', 'power'][index]} key`} title="Click, then press a new key">{binding?.id === slot.id && binding.index === index ? '…' : keyLabel(key)}</Button></TableCell>)}
                <TableCell><NativeSelect className={s.power} aria-label={`${slot.name} ability`} value={slot.power ?? 'none'} disabled={!!room && spectator} onChange={event => changeSlot(slot.id, { power: event.target.value as LocalPlayer['power'] })}><NativeSelectOption value="none">no superpower</NativeSelectOption><NativeSelectOption value="jump">jump</NativeSelectOption><NativeSelectOption value="boost">speed boost</NativeSelectOption><NativeSelectOption value="shield">invisible</NativeSelectOption></NativeSelect></TableCell>
              </TableRow>;
            })}</TableBody>
          </Table>
        </section>
        <section className={s.roomPanel} aria-label="Multiplayer room">
          {!room ? <>
            <div className={s.tabs}><Button variant="outline" className={`${s.tab} ${tab === 'host' ? s.selectedTab : ''}`} onClick={() => setTab('host')}>Create a room</Button><Button variant="outline" className={`${s.tab} ${tab === 'join' ? s.selectedTab : ''}`} onClick={() => setTab('join')}>Join a room</Button></div>
            <div className={s.roomBody}>{tab === 'host' ? <>
              <GameOptions settings={settings} change={changeSettings} />
              <Button className={`${s.button} ${s.primaryButton}`} disabled={!connected || pending} onClick={createRoom}>{pending ? 'Creating…' : 'Create room'}</Button>
            </> : <div className={s.joinFields}>
              <Input className={`${s.input} ${s.roomCodeInput}`} aria-label="Room code" value={joinCode} maxLength={6} placeholder="Room code" autoComplete="off" autoCapitalize="characters" onChange={event => setJoinCode(event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase())} onKeyDown={event => { if (event.key === 'Enter') joinRoom(); }} />
              <Button className={s.button} disabled={!connected || pending} onClick={() => joinRoom()}>{pending ? 'Joining…' : 'Join game'}</Button>
              <Button variant="outline" className={s.button} disabled={!connected || pending} onClick={() => joinRoom(true)}>Spectate</Button>
            </div>}</div>
          </> : <div className={s.roomBody}>
            <div className={s.codeBar}><span>Room <strong className={s.roomCode}>{room.code}</strong></span><Button variant="outline" className={s.button} onClick={inviteLink}>Copy invite link</Button><Button variant="ghost" className={s.textButton} onClick={leaveRoom}>Leave room</Button></div>
            <div className={s.roomMembers} aria-label="Room players">{room.players.map(player => <span className={s.member} key={player.id} style={{ color: player.color }}>{player.name}{!player.connected ? ' (offline)' : ''}</span>)}</div>
            <div className={s.roomActions}><span className={s.muted}>{room.players.length} / 18 players</span>{host ? <Button className={`${s.button} ${s.primaryButton}`} disabled={!connected || room.players.filter(player => player.connected).length < 2} onClick={() => send({ type: 'start' })}>Start game <kbd>SPACE</kbd></Button> : <span className={s.muted}>{spectator ? 'Spectating' : 'Waiting for host'}</span>}</div>
            {host && <GameOptions settings={settings} change={changeSettings} />}
          </div>}
        </section>
      </div> : <>
        <div className={s.gameLayout}>
          <section className={s.arenaPanel}>
            <div className={s.arenaHeader}><span>{room.deathmatch ? 'Deathmatch' : `Round ${room.round}`}</span><Button variant="ghost" className={s.textButton} onClick={() => setProjector(!projector)}>{projector ? 'Exit projector' : 'Projector view'}</Button></div>
            <div className={s.canvasWrap}>
              <GameCanvas room={room} frameRef={frameRef} projector={projector} />
              {(room.phase !== 'playing' || !connected) && <div className={s.arenaOverlay}>
                {!connected ? <h2 className={s.overlayTitle}>Reconnecting…</h2> : room.phase === 'paused' ? <><h2 className={s.overlayTitle}>Paused</h2>{host && <Button className={s.button} onClick={() => send({ type: 'pause' })}>Resume game</Button>}</> : room.phase === 'countdown' ? <span className={s.countdown}>{countdown}</span> : <>
                  <h2 className={s.overlayTitle} style={{ color: winner?.color }}>{winner ? `${winner.name} wins${room.phase === 'finished' ? ' the game' : ' the round'}` : 'Draw'}</h2>
                  {room.deathmatch && room.phase !== 'finished' && <p className={s.overlayCopy}>Tied leaders play a deathmatch.</p>}
                  {host ? <Button className={s.button} onClick={() => send({ type: room.phase === 'finished' ? 'lobby' : 'next' })}>{room.phase === 'finished' ? 'Back to lobby' : 'Next round'}</Button> : <span className={s.muted}>Waiting for host</span>}
                </>}
              </div>}
            </div>
            {!projector && host && <div className={s.controlsBar}>{['playing', 'countdown', 'paused'].includes(room.phase) && <Button variant="outline" className={s.button} onClick={() => send({ type: 'pause' })}>{room.phase === 'paused' ? 'Resume' : 'Pause'} <kbd>SPACE</kbd></Button>}<Button variant="outline" className={s.button} onClick={() => send({ type: 'lobby' })}>Lobby</Button></div>}
          </section>
          {!projector && <aside className={s.scoreboard}><div className={s.panelHeader}><span>Score</span><span className={s.muted}>First to {target}</span></div>{[...room.players].sort((a, b) => b.score - a.score).map(player => <div className={s.scoreRow} key={player.id}><div className={s.scoreName} style={{ color: player.color }}><strong>{player.name}</strong>{player.power !== 'none' && <small>{POWER_NAMES[player.power]} · {player.charges}</small>}</div><span className={s.scoreValue}>{player.score}</span></div>)}<div className={s.roomBody}><span className={s.roomCode}>{room.code}</span>{spectator && <span className={s.muted}>Spectating</span>}</div></aside>}
        </div>
        {!spectator && !projector && <div className={s.touchControls} aria-label="Touch controls">{room.players.filter(player => player.deviceId === deviceId).map(player => {
          const slot = slots.find(value => value.id === player.id);
          return <div className={s.touchPlayer} style={{ '--player-color': player.color } as CSSProperties} key={player.id}><span>{player.name}</span>{([-1, 1] as Turn[]).map((turn, index) => <Button variant="outline" className={s.touchButton} key={turn} aria-label={`${player.name} turn ${turn === -1 ? 'left' : 'right'}`} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); const keys = touch.current.get(player.id) ?? new Set<Turn>(); keys.add(turn); touch.current.set(player.id, keys); sendInputs(); }} onPointerUp={() => { touch.current.get(player.id)?.delete(turn); sendInputs(); }} onPointerCancel={() => { touch.current.get(player.id)?.delete(turn); sendInputs(); }}>{turn === -1 ? '↶' : '↷'}<kbd>{slot ? keyLabel(slot.keys[index]) : ''}</kbd></Button>)}{player.power !== 'none' && <Button variant="outline" className={s.touchButton} disabled={player.charges === 0} onPointerDown={() => sendInputs(player.id)} aria-label={`${player.name} use ${POWER_NAMES[player.power]}`}>⚡<kbd>{slot ? keyLabel(slot.keys[2]) : ''}</kbd></Button>}</div>;
        })}</div>}
      </>}
      {error && <div className={s.error} role="alert">{error}<Button variant="ghost" className={s.textButton} onClick={() => setError('')} aria-label="Dismiss error">×</Button></div>}
    </main>
    {toast && <div className={s.toast} role="status">{toast}</div>}
  </div>;
}

function GameOptions({ settings, change }: { settings: GameSettings; change: (value: Partial<GameSettings>) => void }) {
  return <div className={s.settings}>
    <div className={s.settingRow}><label htmlFor="speed">Speed</label><NativeSelect id="speed" className={s.select} value={settings.speed} onChange={event => change({ speed: event.target.value as GameSettings['speed'] })}><NativeSelectOption value="slow">Relaxed</NativeSelectOption><NativeSelectOption value="normal">Classic</NativeSelectOption><NativeSelectOption value="fast">Fast</NativeSelectOption></NativeSelect></div>
    <div className={s.settingRow}><label htmlFor="target">Play to</label><NativeSelect id="target" className={s.select} value={settings.targetScore} onChange={event => change({ targetScore: Number(event.target.value) })}><NativeSelectOption value="0">Classic score</NativeSelectOption><NativeSelectOption value="10">10 points</NativeSelectOption><NativeSelectOption value="20">20 points</NativeSelectOption><NativeSelectOption value="50">50 points</NativeSelectOption></NativeSelect></div>
    <div className={s.settingRow}><span id="gaps-label">Gaps</span><Switch aria-labelledby="gaps-label" checked={settings.gaps} onCheckedChange={checked => change({ gaps: checked })} /></div>
  </div>;
}
