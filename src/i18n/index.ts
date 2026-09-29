import { invoke } from "@tauri-apps/api/core";
import ko from "./ko";
import en from "./en";

export type Locale = "ko" | "en";
export const LOCALES: Locale[] = ["ko", "en"];

const DICTS: Record<Locale, unknown> = { ko, en };

let locale: Locale = "ko";
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return locale;
}

/** Switches the dictionary in place and notifies every subscriber to
 * re-render — no restart needed. Does not persist; call saveLocale() too
 * (the language chip does both together). */
export function setLocale(next: Locale) {
  if (locale === next) return;
  locale = next;
  listeners.forEach((fn) => fn());
}

/** A component subscribes here and re-renders itself on change (see
 * docs/i18n-plan.md's "컴포넌트를 옮기는 법"). Returns an unsubscribe fn. */
export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function get(dict: unknown, path: string[]): string | undefined {
  let node = dict;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "string" ? node : undefined;
}

/** Looks up a dot-path key in the current locale, falling back to `ko` (the
 * complete dictionary) for anything missing — so a half-translated locale
 * never shows a raw key or breaks. `{{name}}`-style placeholders in the
 * string are replaced from `vars`. */
export function t(key: string, vars?: Record<string, string>): string {
  const path = key.split(".");
  let text = get(DICTS[locale], path) ?? get(ko, path) ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(v);
  return text;
}

/** en unless the OS/browser locale is specifically Korean — everything else
 * (including locales we don't have a translation for) reads more naturally
 * in English than in an unrelated language's translation would. */
function detectLocale(): Locale {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => l.toLowerCase().startsWith("ko")) ? "ko" : "en";
}

interface ConfigLike {
  locale?: string;
  [key: string]: unknown;
}

/** Loads the saved locale (or detects one, the first time) and applies it.
 * Call once at startup, before the first paint, so nothing flashes in the
 * wrong language first. */
export async function loadLocale(): Promise<Locale> {
  let stored: string | undefined;
  try {
    stored = (await invoke<ConfigLike>("store_get", { kind: "config" })).locale;
  } catch {
    // Keep stored undefined; falls through to detection below.
  }
  const resolved = LOCALES.includes(stored as Locale) ? (stored as Locale) : detectLocale();
  // Through setLocale(), not a direct assignment: main.ts's corner chip is
  // constructed (and renders the "ko" starting value) before this resolves,
  // so anything that differs from that default needs the notification to
  // ever be seen.
  setLocale(resolved);
  if (!stored) await saveLocale(resolved); // First run: persist the detected choice.
  return resolved;
}

export async function saveLocale(next: Locale): Promise<void> {
  setLocale(next);
  const config = await invoke<ConfigLike>("store_get", { kind: "config" }).catch(() => ({}));
  await invoke("store_put", { kind: "config", value: { ...config, locale: next } });
}
