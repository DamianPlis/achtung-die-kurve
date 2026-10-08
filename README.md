# Achtung, die Kurve! — Classroom edition

A fresh multiplayer implementation inspired by [achtungkurve.com](https://achtungkurve.com/) and its [reference repository](https://github.com/maechler/kurve). No original source, artwork, audio, or styles are included. React + TypeScript, CSS Modules, Canvas, and a small Node WebSocket server.

## Run on school Wi-Fi

Install Node.js 22 or newer, then open a terminal in this folder:

```sh
npm ci
npm run dev
```

Open **http://localhost:5173** on the host computer. The terminal prints the LAN addresses for other devices, for example `http://192.168.1.42:5173`. All players must open the **same host computer's address**; `localhost` on another device points at that other device.

1. Select up to six players on each device. Click their color, edit their name, and click a key to rebind it.
2. The host clicks **Create room** and shares the five-character code or invite link.
3. Other devices open the host's address, choose **Join a room**, and enter the code. The room supports 18 players total.
4. The host clicks **Start game** or presses Space. Space pauses/resumes a running round and starts the next round after it ends.
5. A projector browser can **Join as a spectator** without using a player slot, then select **Projector view** and fullscreen.

Phones and tablets have touch steering buttons. A keyboard's physical key rollover may limit how many simultaneous keys it detects; spreading players across more devices avoids that hardware limit.

If other devices cannot connect, check Windows Firewall permission for Node and ask the school's IT team whether Wi-Fi client isolation blocks direct connections. No router port forwarding is needed for LAN play.

## Production / public internet

```sh
npm run build
npm start
```

One Node process serves both the built website and `/ws` on port **3000**, listening on all interfaces. Set `PORT` to override it. `/health` returns the server status. Deploy this folder to a Node host, or use the included Dockerfile. Configure the host or reverse proxy to support WebSocket upgrades and HTTPS/WSS. Room codes and invite links work unchanged on a public origin.

The room code selects a room on the server whose URL players opened; it does not discover other computers or servers by itself. A copied `localhost` invite works only on the host; use the LAN address when sharing at school.

No paid service or external account is required for LAN play. A public deployment requires a Node hosting account; no public deployment is created by this repository.

## How the multiplayer works

- The server simulates movement, collisions, gaps, powers, elimination, and scoring at **60 ticks per second**. Clients cannot submit positions or scores.
- Browsers send steering changes immediately and repeat held inputs every 200 ms so a disconnected or hidden page cannot leave a turn stuck.
- The server broadcasts heads and newly drawn trail segments at **20 updates per second**. Trails are accumulated on a canvas; old trails are not repeatedly downloaded or redrawn.
- Every device gets at most six owned players. Inputs are checked against that device's roster; messages are validated and bounded.
- Reconnecting players retain their seat briefly. A disconnected host passes control to another connected device. A late spectator receives a full arena snapshot.
- Rooms stay in memory. Restarting the Node server clears games. This single process is intended for classroom sessions; use room routing and a shared session directory before scaling across server instances.

## Rules and differences from the reference

Move continuously, steer left or right, and avoid walls and every solid trail, including your own. Occasional gaps can be crossed. Each elimination awards one point to surviving players. Classic target score is `(number of players − 1) × 10`; fixed targets are also available.

Tied match leaders play a final deathmatch. This first version implements **Jump**, **Speed boost**, and **Invisible** abilities, including charges gained by crossing another player’s trail gap. The reference has additional powers and music that are not included. UI elements and game code are written independently so you can modify this project.

## Development

```sh
npm test
npm run build
```

Main files:

- `src/App.tsx`: setup, rooms, keyboard/touch controls, scoreboard.
- `src/App.module.css`: appearance and responsive layout.
- `src/GameCanvas.tsx`: frame rendering and persistent trails.
- `shared/types.ts`: client/server protocol.
- `server/game.ts`: authoritative game simulation.
- `server/app.ts`: room lifecycle and WebSocket handling.
- `server/index.ts`: server entry point.

Tests include three devices with six players each, room limits, input ownership, reconnect behavior, host controls, and simulation checks. Browser checks should also be performed after UI changes.
