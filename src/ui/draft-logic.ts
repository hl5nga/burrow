/** Pure rules for the Draft editor's saved drafts (T34); no DOM here. */

export const SLOT_COUNT = 5;
export const RECENT_COUNT = 10;
const PREVIEW_CHARS = 40;

export interface DraftSlot {
  text: string;
  /** "session:window" of the tmux window it goes to; null = the active tab's prompt. */
  target: string | null;
  savedAt: number;
}

export interface DraftCurrent {
  text: string;
  cursor: number;
  target: string | null;
  /** The slot (0-based) this draft came from or will be saved to. */
  slot: number | null;
}

export interface DraftRecent {
  text: string;
  target: string | null;
  at: number;
}

export interface DraftsFile {
  version: number;
  slots: (DraftSlot | null)[];
  current: DraftCurrent;
  recent: DraftRecent[];
}

export function emptyDrafts(): DraftsFile {
  return {
    version: 1,
    slots: Array.from({ length: SLOT_COUNT }, () => null),
    current: { text: "", cursor: 0, target: null, slot: null },
    recent: [],
  };
}

/** Exactly five slots, at most ten earlier drafts, whatever came from disk. */
export function normalizeDrafts(file: DraftsFile): DraftsFile {
  const slots = Array.from({ length: SLOT_COUNT }, (_, i) => file.slots?.[i] ?? null);
  return {
    version: file.version ?? 1,
    slots,
    current: { ...emptyDrafts().current, ...file.current },
    recent: (file.recent ?? []).slice(0, RECENT_COUNT),
  };
}

export const isBlank = (text: string) => text.trim() === "";

/** First non-empty line, shortened, for a tooltip. */
export function preview(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const clean = line.trim();
  return clean.length > PREVIEW_CHARS ? `${clean.slice(0, PREVIEW_CHARS - 1)}…` : clean;
}

export function stats(text: string): { lines: number; chars: number } {
  return { lines: text === "" ? 0 : text.split("\n").length, chars: [...text].length };
}

/**
 * Where a draft is saved. `wanted` is the slot the user picked (or the one the
 * draft came from); without one, the first empty slot; when all are taken, the
 * one saved longest ago. `replaces` is what would be overwritten.
 */
export function pickSlot(
  slots: (DraftSlot | null)[],
  wanted: number | null,
): { index: number; replaces: DraftSlot | null } {
  if (wanted !== null && wanted >= 0 && wanted < SLOT_COUNT) {
    return { index: wanted, replaces: slots[wanted] };
  }
  const empty = slots.findIndex((s) => s === null);
  if (empty >= 0) return { index: empty, replaces: null };
  let oldest = 0;
  slots.forEach((s, i) => {
    if (s && s.savedAt < (slots[oldest]?.savedAt ?? Infinity)) oldest = i;
  });
  return { index: oldest, replaces: slots[oldest] };
}

/** Puts a draft in the earlier-drafts list: newest first, no repeats, no blanks. */
export function pushRecent(
  recent: DraftRecent[],
  text: string,
  target: string | null,
  at: number,
): DraftRecent[] {
  if (isBlank(text)) return recent;
  const rest = recent.filter((r) => r.text !== text);
  return [{ text, target, at }, ...rest].slice(0, RECENT_COUNT);
}

/** Saves into a slot; whatever it replaced stays reachable under "recent". */
export function saveToSlot(
  file: DraftsFile,
  index: number,
  text: string,
  target: string | null,
  now: number,
): DraftsFile {
  const slots = file.slots.slice();
  const replaced = slots[index];
  slots[index] = { text, target, savedAt: now };
  const recent =
    replaced && replaced.text !== text
      ? pushRecent(file.recent, replaced.text, replaced.target, now)
      : file.recent;
  return { ...file, slots, recent };
}

export function clearSlot(file: DraftsFile, index: number, now: number): DraftsFile {
  const old = file.slots[index];
  if (!old) return file;
  const slots = file.slots.slice();
  slots[index] = null;
  return { ...file, slots, recent: pushRecent(file.recent, old.text, old.target, now) };
}

/** Looks up the tmux window a stored target names, among the live ones. */
export function resolveTarget<T extends { session: string; windowName: string }>(
  target: string | null,
  windows: T[],
): T | undefined {
  if (!target) return undefined;
  return windows.find((w) => targetKey(w) === target);
}

export const targetKey = (w: { session: string; windowName: string }) =>
  `${w.session}:${w.windowName}`;
