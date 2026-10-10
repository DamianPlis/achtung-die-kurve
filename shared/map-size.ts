import { MAP_SIZES, type GameSettings } from "./types.js";

export const MIN_CUSTOM_MAP_SIZE = 50;
export const MAX_CUSTOM_MAP_SIZE = 200;

export function getMapDimensions(
  settings: Pick<GameSettings, "mapSize" | "customMapSize">,
  playerCount: number,
) {
  const map = MAP_SIZES[settings.mapSize === "custom" ? "recommended" : settings.mapSize];
  const scale = Math.sqrt(Math.max(6, playerCount) / 6) *
    (settings.mapSize === "custom" ? settings.customMapSize / 100 : 1);
  return {
    width: Math.ceil((map.width * scale) / 2) * 2,
    height: Math.ceil((map.height * scale) / 2) * 2,
  };
}
