import assert from "node:assert/strict";
import test from "node:test";
import configure from "../vite.config";

test("public game backends accept HTTP(S) origins and reject credentials or URL paths", async () => {
  assert.ok(typeof configure === "function");
  const previous = process.env.VITE_GAME_SERVER_URL;
  try {
    for (const origin of ["", "http://127.0.0.1:3100", "https://game.example.com/"]) {
      process.env.VITE_GAME_SERVER_URL = origin;
      await configure({ command: "build", mode: "test" });
    }
    for (const origin of ["invalid URL", "ftp://game.example.com", "https://name:secret@game.example.com", "https://game.example.com/path", "https://game.example.com/?room=ABCDE", "https://game.example.com/#room"]) {
      process.env.VITE_GAME_SERVER_URL = origin;
      await assert.rejects(async () => configure({ command: "build", mode: "test" }));
    }
  } finally {
    if (previous === undefined) delete process.env.VITE_GAME_SERVER_URL;
    else process.env.VITE_GAME_SERVER_URL = previous;
  }
});
