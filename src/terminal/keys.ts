/**
 * Key combos as stored in keybindings.json, e.g. "Cmd+Shift+]" or "Ctrl+Alt+K".
 * Matching uses the physical key (KeyboardEvent.code), so shortcuts still work
 * with a Korean or Japanese input source, where `key` is a Hangul/kana letter.
 */

const MODIFIERS = ["Cmd", "Ctrl", "Alt", "Shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

const PUNCTUATION: Record<string, string> = {
  "]": "BracketRight",
  "[": "BracketLeft",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "\\": "Backslash",
};

const NAMED = [
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];

/** The key part of a combo ("K", "]", "F5", "Enter") → KeyboardEvent.code. */
export function keyToCode(key: string): string | undefined {
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^F([1-9]|1[0-9])$/.test(key)) return key;
  if (PUNCTUATION[key]) return PUNCTUATION[key];
  return NAMED.includes(key) ? key : undefined;
}

function codeToKey(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9])$/.test(code)) return code;
  const punct = Object.entries(PUNCTUATION).find(([, c]) => c === code);
  if (punct) return punct[0];
  return NAMED.includes(code) ? code : undefined;
}

export interface Combo {
  mods: Set<Modifier>;
  code: string;
}

/** Parses "Cmd+Shift+]" (modifiers in any order); undefined if malformed. */
export function parseCombo(text: string): Combo | undefined {
  const parts = text.trim().split("+");
  // "Cmd++" means the plus key's neighbour "=" isn't meant; keep it simple.
  const key = parts.pop();
  if (!key) return undefined;
  const mods = new Set<Modifier>();
  for (const p of parts) {
    const mod = MODIFIERS.find((m) => m.toLowerCase() === p.toLowerCase());
    if (!mod) return undefined;
    mods.add(mod);
  }
  const code = keyToCode(key);
  return code ? { mods, code } : undefined;
}

/** The canonical text for a key event, or undefined for bare modifiers/unknown keys. */
export function eventToCombo(e: {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | undefined {
  const key = codeToKey(e.code);
  if (!key) return undefined;
  const mods: Modifier[] = [];
  if (e.metaKey) mods.push("Cmd");
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

/** Same combo regardless of how it was written ("shift+cmd+k" = "Cmd+Shift+K"). */
export function normalizeCombo(text: string): string | undefined {
  const combo = parseCombo(text);
  if (!combo) return undefined;
  const key = codeToKey(combo.code)!;
  return [...MODIFIERS.filter((m) => combo.mods.has(m)), key].join("+");
}

/** How a combo is shown: ⌘⇧K. */
export function displayCombo(text: string): string {
  const combo = parseCombo(text);
  if (!combo) return text;
  const sym: Record<Modifier, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘" };
  const order: Modifier[] = ["Ctrl", "Alt", "Shift", "Cmd"];
  const key = codeToKey(combo.code)!;
  const pretty: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Enter: "↩",
    Escape: "esc",
    Backspace: "⌫",
    Delete: "⌦",
    Tab: "⇥",
    Space: "␣",
  };
  return (
    order
      .filter((m) => combo.mods.has(m))
      .map((m) => sym[m])
      .join("") + (pretty[key] ?? key)
  );
}
