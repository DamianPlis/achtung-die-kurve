import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

const processes = [
  spawn(
    process.execPath,
    [resolve("node_modules/tsx/dist/cli.mjs"), "watch", "server/index.ts"],
    { stdio: "inherit", env: { ...process.env, PORT: "3001" } },
  ),
  spawn(
    process.execPath,
    [resolve("node_modules/vite/bin/vite.js"), "--host", "0.0.0.0"],
    { stdio: "inherit" },
  ),
];
for (const addresses of Object.values(networkInterfaces())) {
  for (const address of addresses ?? []) {
    if (address.family === "IPv4" && !address.internal)
      console.log(`Join on this Wi-Fi: http://${address.address}:5173`);
  }
}
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  processes.forEach((child) => child.kill());
  process.exit(code);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
processes.forEach((child) => {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => stop(code ?? 1));
});
