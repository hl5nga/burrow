import { invoke } from "@tauri-apps/api/core";

/** Font size levels 1 (smallest) .. 5 (largest); index 0 = level 1. */
export const FONT_SIZES = [11, 12.5, 13.5, 15, 17];
/** Line spacing levels 1 (tight) .. 3 (loose); index 0 = level 1. */
export const LINE_HEIGHTS = [1.0, 1.2, 1.4];

export const DEFAULT_FONT_LEVEL = 3;
export const DEFAULT_LINE_LEVEL = 2;

const clamp = (level: number, max: number) => Math.min(Math.max(Math.round(level), 1), max);

export function fontSizePx(level: number): number {
  return FONT_SIZES[clamp(level, FONT_SIZES.length) - 1];
}

export function lineHeightFor(level: number): number {
  return LINE_HEIGHTS[clamp(level, LINE_HEIGHTS.length) - 1];
}

export interface TextSettings {
  fontLevel: number;
  lineLevel: number;
}

export const DEFAULT_TEXT_SETTINGS: TextSettings = {
  fontLevel: DEFAULT_FONT_LEVEL,
  lineLevel: DEFAULT_LINE_LEVEL,
};

/**
 * The current settings, shared app-wide: `session.ts` reads this when a new
 * terminal is created, and the text-size chip mutates it in place (and
 * persists it) when the user changes something, so a tab opened afterward
 * picks up the change without any extra wiring.
 */
export const current: TextSettings = { ...DEFAULT_TEXT_SETTINGS };

interface ConfigLike {
  fontLevel?: number;
  lineLevel?: number;
  [key: string]: unknown;
}

/** Loads settings from config.json into `current`. Call once at startup,
 * before the first terminal opens, so it doesn't start at the default and
 * jump. */
export async function loadTextSettings(): Promise<TextSettings> {
  try {
    const config = await invoke<ConfigLike>("store_get", { kind: "config" });
    current.fontLevel = clamp(config.fontLevel ?? DEFAULT_FONT_LEVEL, FONT_SIZES.length);
    current.lineLevel = clamp(config.lineLevel ?? DEFAULT_LINE_LEVEL, LINE_HEIGHTS.length);
  } catch {
    // Keep the defaults already in `current`.
  }
  return { ...current };
}

export async function saveTextSettings(settings: TextSettings): Promise<void> {
  current.fontLevel = settings.fontLevel;
  current.lineLevel = settings.lineLevel;
  const config = await invoke<ConfigLike>("store_get", { kind: "config" }).catch(() => ({}));
  await invoke("store_put", { kind: "config", value: { ...config, ...settings } });
}
