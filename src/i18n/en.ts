import type ko from "./ko";

/** Every leaf widened to `string` (ko's `as const` makes them literal types)
 * and every level optional, so a translation can differ from ko's exact
 * text and a module can be only partially translated. */
type Loose<T> = T extends string ? string : { [K in keyof T]?: Loose<T[K]> };

/** Partial on purpose — `t()` falls back to `ko` for any key missing here,
 * so this can be filled in module by module without ever breaking the app.
 * See docs/i18n-plan.md for the migration order. */
const en: Loose<typeof ko> = {
  launcher: {
    title: "Burrow",
    subtitle: "Choose a connection",
    online: "🌐 Online",
    offline: "🌐 Offline",
    offlineHint: "No internet connection",
    localTerminal: "Local terminal",
    thisMac: "This Mac",
    ssh: "SSH",
    connect: "Connect",
    open: "Open",
    autoOpen: "Open automatically",
    autoOpenHint: "Skips this list and opens this one straight away next time",
    newConnection: "＋ New connection",
    noProfiles: "No SSH profiles yet. Register a new connection below.",
  },
  language: {
    label: "Language",
    system: "Follow system setting",
    ko: "한국어",
    en: "English",
  },
};

export default en;
