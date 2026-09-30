import { invoke } from "@tauri-apps/api/core";

export interface ThemeDef {
  id: string;
}

/** Order shown in the theme menu; "dark" is first since it's the default.
 * Labels live in i18n (themeChip.themes.<id>) since they're user-facing. */
export const THEMES: ThemeDef[] = [
  { id: "dark" },
  { id: "light" },
  { id: "sky" },
  { id: "paper" },
  { id: "mono" },
];

export const DEFAULT_THEME = "dark";

/** The current theme id, shared app-wide: session.ts reads it for a new
 * terminal's ANSI palette, and the theme chip mutates it in place (and
 * persists it) when the user changes it. */
export const current = { theme: DEFAULT_THEME };

function apply(theme: string) {
  document.documentElement.dataset.theme = theme;
}

interface ConfigLike {
  theme?: string;
  [key: string]: unknown;
}

/** Loads the saved theme into `current` and applies it. Call once at
 * startup, before the first paint, so the app doesn't flash dark first. */
export async function loadTheme(): Promise<string> {
  try {
    const config = await invoke<ConfigLike>("store_get", { kind: "config" });
    current.theme = THEMES.find((t) => t.id === config.theme)?.id ?? DEFAULT_THEME;
  } catch {
    current.theme = DEFAULT_THEME;
  }
  apply(current.theme);
  return current.theme;
}

export async function saveTheme(theme: string): Promise<void> {
  current.theme = theme;
  apply(theme);
  const config = await invoke<ConfigLike>("store_get", { kind: "config" }).catch(() => ({}));
  await invoke("store_put", { kind: "config", value: { ...config, theme } });
}
