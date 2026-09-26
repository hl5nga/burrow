import { test } from "node:test";
import assert from "node:assert/strict";
import { joinLines, preparePaste } from "./paste.ts";

test("one line with a trailing newline pastes without it", () => {
  assert.deepEqual(preparePaste("ls -la\n"), {
    text: "ls -la",
    lines: ["ls -la"],
    multiline: false,
  });
  assert.equal(preparePaste("ls -la\r\n").text, "ls -la");
  assert.equal(preparePaste("plain").multiline, false);
});

test("several lines are multiline, whatever the line endings", () => {
  const p = preparePaste("cd /tmp\r\nrm -rf build\r\n");
  assert.equal(p.multiline, true);
  assert.equal(p.text, "cd /tmp\nrm -rf build\n");
  assert.equal(preparePaste("a\n\n").multiline, true);
});

test("joining drops blank lines and indentation", () => {
  assert.equal(joinLines(["  docker run \\", "", "   -it image"]), "docker run -it image");
});
