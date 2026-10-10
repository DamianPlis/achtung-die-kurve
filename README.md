# Achtung, die Kurve!

A fresh multiplayer implementation inspired by [achtungkurve.com](https://achtungkurve.com/) and its [reference repository](https://github.com/maechler/kurve). No original source, artwork, audio, or styles are included. React + TypeScript, shadcn/ui with Tailwind, CSS Modules, Canvas, and a small Node WebSocket server.

## Run on school Wi-Fi

Install Node.js 22 or newer, then open a terminal in this folder:

```sh
npm ci
npm run dev
```

Open **http://localhost:5173** on the host computer. The terminal prints the LAN addresses for other devices, for example `http://192.168.1.42:5173`. All players must open the **same host computer's address**; `localhost` on another device points at that other device.

1. Players start unselected. Select up to six on each device by pressing any of their keys. In the lobby, press a player's power key to cycle superpowers; click their color, edit their name, and click a key to rebind it. The host can force one power for everyone (including a one-click random preset) or set different powers per player. At least two connected players are needed to start.
2. The host clicks **Create room** and shares the five-character code or invite link.
3. Other devices open the host's address, choose **Join a room**, and enter the code. The room supports 50 players total.
4. The host clicks **Start game**, then **Start countdown** when everyone is ready. Space performs these actions too, pauses/resumes a running round, and prepares the next round after it ends.
5. A projector browser can **Spectate** without using a player slot, then select **Projector view** and fullscreen.

Phones and tablets have touch steering buttons. A keyboard's physical key rollover may limit how many simultaneous keys it detects; spreading players across more devices avoids that hardware limit.

If other devices cannot connect, check Windows Firewall permission for Node and ask the school's IT team whether Wi-Fi client isolation blocks direct connections. No router port forwarding is needed for LAN play.

## Production / public internet

```sh
npm run build
npm start
```

One Node process serves both the built website and `/ws` on port **3000**, listening on all interfaces. Set `PORT` to override it. `/health` returns the server status. Deploy this folder to a Node host, or use the included Dockerfile. Configure the host or reverse proxy to support WebSocket upgrades and HTTPS/WSS. Room codes and invite links work unchanged on a public origin.

### Deploy on Vercel

Set the Vercel Framework Preset to **Container** to deploy the root `Dockerfile.vercel`. Set the project environment variable `PORT=3000` for Preview and Production so HTTP routing matches the server. The Vercel image builds its browser client with `VITE_GAME_SERVER_URL=https://achtung-die-kurve.onrender.com` by default. Both public websites therefore use the Render server's `/ws` and share its rooms. Override that Docker build argument to use a different persistent game server.

`VITE_GAME_SERVER_URL` is a public **build-time HTTP(S) origin**. It can also be set before `npm run build` for another frontend host. Leave it unset for local/LAN play and same-origin Node hosting. Redeploy the frontend after changing it; a runtime environment change cannot modify an already-built client.

Keep the game backend on **one Render instance**. Vercel's frontend may scale independently. Rooms still live in the authoritative server's memory: restarting or redeploying that backend ends its matches. Multi-instance game hosting requires room ownership routing and shared state before enabling backend scaling. The application does not create or change cloud plan settings.

The room code selects a room on the configured game backend; it does not discover other computers or servers by itself. Clients built with different backends have separate rooms. A copied `localhost` invite works only on the host; use the LAN address when sharing at school.

No paid service or external account is required for LAN play. A public deployment requires a hosting account; this repository does not create one automatically.

## How the multiplayer works

- The server simulates movement, collisions, gaps, powers, elimination, and scoring at **60 ticks per second**. Clients cannot submit positions or scores.
- Browsers send steering changes immediately and repeat held inputs every 200 ms so a disconnected or hidden page cannot leave a turn stuck.
- The server broadcasts heads and newly drawn trail segments at **20 updates per second**. The browser predicts local steering immediately, replays unacknowledged inputs, and corrects against authoritative updates. Remote heads move continuously between updates with a bounded prediction window. Only the server decides deaths and scores.
- Trails are accumulated once on a backing canvas sized for the display. New segments and Shoot holes erasures are processed in tick order; old trails are not repeatedly downloaded.
- WebSocket frames negotiate fast level-1 compression for supported browsers; messages under 1 KB skip compression. A representative 50-player local benchmark reduced a 16.4 KB frame to about 2.5 KB (roughly 85% less traffic). Actual traffic depends on active heads and powers.
- Every device gets at most six owned players. Inputs are checked against that device's roster; messages are validated and bounded.
- Reconnecting players retain their seat briefly. A disconnected host passes control to another connected device. A late spectator receives a full arena snapshot.
- Rooms stay in memory. Restarting the Node server clears games. This single process is intended for classroom sessions; use room routing and a shared session directory before scaling across server instances.

## Rules and differences from the reference

Move continuously, steer left or right, and avoid walls and every solid trail, including your own. Occasional gaps can be crossed. Each elimination awards one point to surviving players. Classic target score is `(number of players − 1) × 10`; fixed targets are also available.

If multiple players reach or exceed the target in the same round, all of those qualifiers play a final deathmatch, even when their scores differ. All original power choices are available: Run faster, Run slower, Jump, Invisible, Vertical bar, Cross walls, Dark knight, Hydra, Reverse, Square head, Chuck Norris, No superpower, Shoot holes, and Random. Powers and charge counts are authoritative and shared across all devices, including spectators. Dark knight blacks out the arena on every device for three seconds. Hydra is capped at 16 alive heads per player and 256 alive heads per room to bound network and simulation work. Attempts beyond the cap, or with effectively parallel branches that cannot safely separate, do not consume a charge. Music is not included. UI elements and game code are written independently so you can modify this project.

The host can select Classic (1200 × 800), Recommended (1440 × 960, the default), Large (1800 × 1200), or Custom in the lobby. Custom ranges from 50% to 200% of Recommended's width and height and starts at 100%. Recommended is 20% wider and taller than Classic. These base sizes apply for up to six connected players; above six, arena area grows in proportion to player count. The lobby displays the actual dimensions for the selected size and connected roster, rounded up to the two-unit collision grid. At the maximum Custom setting with 50 players, the arena is 8314 × 5544. Arena dimensions stay fixed during a match, and each device fits the entire arena to its screen.

## Development

```sh
npm test
npm run build
```

Main files:

- `src/App.tsx`: setup, rooms, keyboard/touch controls, scoreboard.
- `src/App.module.css`: appearance and responsive layout.
- `src/GameCanvas.tsx`: frame rendering and persistent trails.
- `src/prediction.ts`: immediate local input prediction and server reconciliation.
- `shared/types.ts`: client/server protocol.
- `server/game.ts`: authoritative game simulation.
- `server/app.ts`: room lifecycle and WebSocket handling.
- `server/index.ts`: server entry point.

Tests cover multiplayer powers, 50-player room limits and arena scaling, input ownership, reconnect behavior, host controls, and prediction under simulated network delay. Browser checks should also be performed after UI changes.

See [the 10 October deep review](docs/deep-review-2026-10-10.md) for the latest fixes, 100-test result, stress measurements, public-site observations, and verification limits.
