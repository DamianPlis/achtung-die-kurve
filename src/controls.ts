import type { Turn } from "../shared/types";

// getRandomValues also works on plain HTTP LAN addresses used at school.
export function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export const DEFAULT_KEYS = [
  ["Digit1", "KeyQ", "KeyA"],
  ["ArrowLeft", "ArrowDown", "ArrowRight"],
  ["KeyY", "KeyX", "KeyC"],
  ["KeyB", "KeyN", "KeyM"],
  ["KeyL", "KeyO", "KeyP"],
  ["Digit5", "Digit6", "Digit7"],
];

export function isControlKey(code: unknown): code is string {
  return typeof code === "string" && /^[A-Za-z0-9]{1,32}$/.test(code) &&
    !["Escape", "Space", "Tab", "MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight"].includes(code);
}

export function keyLabel(code: string) {
  const arrows: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Space: "SPACE",
  };
  return arrows[code] ?? code.replace(/^(Key|Digit|Numpad)/, "").toUpperCase();
}

export function steering(left: boolean, right: boolean): Turn {
  return left === right ? 0 : left ? -1 : 1;
}
