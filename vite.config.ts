import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => {
  const backend = loadEnv(mode, process.cwd(), "VITE_").VITE_GAME_SERVER_URL;
  if (backend) {
    const url = new URL(backend);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(
        "VITE_GAME_SERVER_URL must be an HTTP(S) origin, such as https://your-game-server.com.",
      );
  }
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      host: "0.0.0.0",
      proxy: {
        "/ws": { target: "ws://127.0.0.1:3001", ws: true },
        "/health": "http://127.0.0.1:3001",
      },
    },
  };
});
