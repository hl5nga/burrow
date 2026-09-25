import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parseHookEvent } from "./hook-events.ts";

// Build payloads exactly the way the zsh hook does, so the test fails if the
// shell side and the parser ever disagree.
function zshPayload(...fields: string[]): string {
  const script = `printf '%s\\0' "$@" | base64 | tr -d '\\n'`;
  return execFileSync("zsh", ["-c", script, "zsh", ...fields], { encoding: "utf8" });
}

test("exec events keep commands with separators, quotes and Hangul intact", () => {
  const cmd = `echo "한글; 테스트" | grep -v '\\a' && ls ~/a\\;b`;
  const event = parseHookEvent(`exec;${zshPayload("MacProFX", "/tmp/a;b c", cmd)}`);
  assert.deepEqual(event, { type: "exec", host: "MacProFX", cwd: "/tmp/a;b c", cmd });
});

test("prompt events carry the exit status", () => {
  assert.deepEqual(parseHookEvent(`prompt;${zshPayload("h", "/", "127")}`), {
    type: "prompt",
    host: "h",
    cwd: "/",
    exit: 127,
  });
});

test("multi-line commands survive", () => {
  const cmd = "for f in *; do\n  echo $f\ndone";
  const event = parseHookEvent(`exec;${zshPayload("h", "/", cmd)}`);
  assert.equal(event?.type === "exec" && event.cmd, cmd);
});

test("malformed or unknown events are rejected", () => {
  assert.equal(parseHookEvent("exec"), undefined);
  assert.equal(parseHookEvent("exec;not base64!!"), undefined);
  assert.equal(parseHookEvent(`exec;${zshPayload("only", "two")}`), undefined);
  assert.equal(parseHookEvent(`other;${zshPayload("a", "b", "c")}`), undefined);
});
