import { test } from "node:test";
import assert from "node:assert/strict";
import { DEL, ImeLineSync } from "./ime-sync.ts";

// A zsh-like line buffer: DEL removes the last character.
function applyToLine(line: string[], data: string) {
  for (const ch of Array.from(data)) {
    if (ch === DEL) line.pop();
    else line.push(ch);
  }
}

// Textarea values in the order WKWebView's Korean IME produced them for "하나하"
// ($TMPDIR/burrow-dev-events.log): insertText, then insertReplacementText edits.
test("replacement edits from the macOS Korean IME rewrite the shell line", () => {
  const sync = new ImeLineSync();
  const line: string[] = [];
  const values = ["ㅎ", "하", "한", "하", "하나", "하낳", "하나", "하나하"];
  const sent: string[] = [];
  for (const v of values) {
    const data = sync.update(v);
    sent.push(data);
    applyToLine(line, data);
  }
  assert.equal(line.join(""), "하나하");
  assert.deepEqual(sent.slice(0, 3), ["ㅎ", `${DEL}하`, `${DEL}한`]);
});

test("the full sentence types correctly including spaces sent by xterm", () => {
  const sync = new ImeLineSync();
  const line: string[] = [];
  const type = (value: string) => applyToLine(line, sync.update(value));
  const xtermSpace = () => {
    // xterm sends the space itself on keydown; the browser then inserts it.
    applyToLine(line, " ");
    sync.reset();
    sync.adopt(" ");
  };

  for (const v of ["ㅎ", "하", "항", "하", "하이"]) type(v);
  xtermSpace();
  for (const v of [" ㄴ", " 나", " 난", " 나", " 나느", " 나는"]) type(v);
  xtermSpace();
  for (const v of [
    " ㅈ",
    " 저",
    " 정",
    " 정ㅅ",
    " 정스",
    " 정승",
    " 정승ㅎ",
    " 정승호",
    " 정승홍",
    " 정승호",
    " 정승호야",
  ]) {
    type(v);
  }
  assert.equal(line.join(""), "하이 나는 정승호야");
});

test("a backspace handled by the shell keeps both sides aligned", () => {
  const sync = new ImeLineSync();
  const line: string[] = [];
  applyToLine(line, sync.update("한"));
  applyToLine(line, DEL);
  const textarea = sync.backspace();
  assert.equal(textarea, "");
  applyToLine(line, sync.update(textarea + "ㄱ"));
  assert.equal(line.join(""), "ㄱ");
});

test("committed newlines become carriage returns", () => {
  const sync = new ImeLineSync();
  assert.equal(sync.update("한\n"), "한\r");
});
