import { invoke } from "@tauri-apps/api/core";

/**
 * Font size levels 1 (smallest) .. 5 (largest); index 0 = level 1. Shifted
 * down from an earlier [11, 12.5, 13.5, 15, 17]: at 13.5px (old level 3, the
 * default), Burrow's monospace computed ~11% fewer columns than a typical
 * terminal's ~12px default at the same window width, so a remote CLI's
 * column-sensitive prompt box could wrap in Burrow but not elsewhere at the
 * same window size. Level 3 now sits at 11.5px — comfortably under that
 * 12px reference point rather than merely matching it — so levels 1-3 all
 * have real margin before hitting the same wrap.
 */
export const FONT_SIZES = [9.5, 10.5, 11.5, 13, 15];
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
