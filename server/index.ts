import { resolve } from 'node:path';
import { createGameServer } from './app.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const gameServer = createGameServer({ distDir: resolve('dist') });
gameServer.server.listen(port, '0.0.0.0', () => {
  console.log(`Achtung Die Kurve is ready at http://localhost:${port}. Devices on the same Wi-Fi can use this computer's LAN IP and port ${port}.`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void gameServer.close().then(() => process.exit(0)); });
