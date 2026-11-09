import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearSlot,
  emptyDrafts,
  normalizeDrafts,
  pickSlot,
  preview,
  pushRecent,
  resolveTarget,
  saveToSlot,
  stats,
  targetKey,
} from "./draft-logic.ts";

const slot = (text: string, savedAt: number) => ({ text, target: null, savedAt });

test("a draft goes to the first empty slot, or the picked one", () => {
  const slots = [slot("a", 5), null, slot("c", 7), null, null];
  assert.deepEqual(pickSlot(slots, null), { index: 1, replaces: null });
  assert.deepEqual(pickSlot(slots, 2), { index: 2, replaces: slots[2] });
  assert.deepEqual(pickSlot(slots, 9), { index: 1, replaces: null });
});

test("when all five are taken the one saved longest ago is replaced", () => {
  const slots = [slot("a", 50), slot("b", 10), slot("c", 40), slot("d", 30), slot("e", 20)];
  assert.deepEqual(pickSlot(slots, null), { index: 1, replaces: slots[1] });
});

test("a replaced slot stays reachable under recent, once", () => {
  let file = emptyDrafts();
  file = saveToSlot(file, 0, "first", null, 1);
  file = saveToSlot(file, 0, "second", "s:be", 2);
  assert.equal(file.slots[0]?.text, "second");
  assert.equal(file.slots[0]?.target, "s:be");
  assert.deepEqual(
    file.recent.map((r) => r.text),
    ["first"],
  );
  // Saving the same text again replaces nothing worth keeping.
  assert.equal(saveToSlot(file, 0, "second", null, 3).recent.length, 1);
});

test("clearing a slot keeps its text in recent", () => {
  let file = saveToSlot(emptyDrafts(), 2, "keep me", null, 1);
  file = clearSlot(file, 2, 2);
  assert.equal(file.slots[2], null);
  assert.equal(file.recent[0].text, "keep me");
  assert.equal(clearSlot(file, 2, 3), file);
});

test("recent is newest first, deduplicated, without blanks, and capped at ten", () => {
  let recent: ReturnType<typeof pushRecent> = [];
  for (let i = 0; i < 12; i++) recent = pushRecent(recent, `t${i}`, null, i);
  assert.equal(recent.length, 10);
  assert.equal(recent[0].text, "t11");
  recent = pushRecent(recent, "t5", null, 99);
  assert.equal(recent[0].text, "t5");
  assert.equal(recent.filter((r) => r.text === "t5").length, 1);
  assert.equal(pushRecent(recent, "  \n ", null, 100), recent);
});

test("normalizing forces five slots and ten recent", () => {
  const messy = {
    ...emptyDrafts(),
    slots: [slot("a", 1)],
    recent: Array.from({ length: 14 }, (_, i) => ({ text: `r${i}`, target: null, at: i })),
  };
  const file = normalizeDrafts(messy);
  assert.equal(file.slots.length, 5);
  assert.equal(file.slots[0]?.text, "a");
  assert.equal(file.recent.length, 10);
});

test("preview is the first non-empty line, shortened", () => {
  assert.equal(preview("\n\n  hello  \nworld"), "hello");
  assert.equal(preview("가".repeat(60)).length, 40);
  assert.ok(preview("x".repeat(60)).endsWith("…"));
  assert.equal(preview(""), "");
});

test("stats count lines and characters (not bytes)", () => {
  assert.deepEqual(stats(""), { lines: 0, chars: 0 });
  assert.deepEqual(stats("한글\nab"), { lines: 2, chars: 5 });
});

test("a stored target finds the live window with the same session and name", () => {
  const windows = [
    { session: "movion", windowName: "be", id: 1 },
    { session: "movion", windowName: "fe", id: 2 },
  ];
  assert.equal(resolveTarget("movion:fe", windows)?.id, 2);
  assert.equal(resolveTarget("movion:qa", windows), undefined);
  assert.equal(resolveTarget(null, windows), undefined);
  assert.equal(targetKey(windows[0]), "movion:be");
});
