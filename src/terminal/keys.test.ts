import { test } from "node:test";
import assert from "node:assert/strict";
import { displayCombo, eventToCombo, normalizeCombo, parseCombo } from "./keys.ts";

const ev = (
  code: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("combos parse to physical keys", () => {
  assert.equal(parseCombo("Cmd+K")?.code, "KeyK");
  assert.equal(parseCombo("Cmd+Shift+]")?.code, "BracketRight");
  assert.equal(parseCombo("Cmd+,")?.code, "Comma");
  assert.equal(parseCombo("Cmd+1")?.code, "Digit1");
  assert.equal(parseCombo("Hyper+K"), undefined);
  assert.equal(parseCombo("Cmd+"), undefined);
});

test("an event and its stored combo meet in the same canonical text", () => {
  // A Korean input source: key is "ㅏ", code is still KeyK.
  assert.equal(eventToCombo(ev("KeyK", { metaKey: true })), "Cmd+K");
  assert.equal(eventToCombo(ev("BracketLeft", { metaKey: true, shiftKey: true })), "Cmd+Shift+[");
  assert.equal(normalizeCombo("shift+cmd+["), "Cmd+Shift+[");
  assert.equal(eventToCombo(ev("ShiftLeft", { shiftKey: true })), undefined);
});

test("display uses the macOS symbols in the usual order", () => {
  assert.equal(displayCombo("Cmd+Shift+A"), "⇧⌘A");
  assert.equal(displayCombo("Ctrl+Alt+ArrowUp"), "⌃⌥↑");
});
