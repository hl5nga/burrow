import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgentClassifier, type ToolPatterns } from "./agent-status.ts";

// The presets Burrow ships (Rust embeds the same file).
const presets = JSON.parse(
  readFileSync(new URL("../../src-tauri/src/store/agent-presets.json", import.meta.url), "utf8"),
) as Record<string, ToolPatterns>;
const agents = new AgentClassifier(presets);

test("every preset regex compiles", () => {
  for (const [id, tool] of Object.entries(presets)) {
    for (const source of [
      ...tool.detect,
      ...tool.waitingApproval,
      ...tool.working,
      ...tool.error,
      ...tool.idle,
    ]) {
      assert.doesNotThrow(() => new RegExp(source, "m"), `${id}: ${source}`);
    }
  }
});

test("commands map to tools, through env vars, paths and npx", () => {
  assert.equal(agents.toolForCommand("claude"), "claude-code");
  assert.equal(agents.toolForCommand("claude --resume"), "claude-code");
  assert.equal(agents.toolForCommand("ANTHROPIC_LOG=debug ~/.local/bin/claude"), "claude-code");
  assert.equal(agents.toolForCommand("npx codex"), "codex");
  assert.equal(agents.toolForCommand("git status"), undefined);
  assert.equal(agents.toolForCommand("claudette"), undefined);
});

const claudeWorking = `
> fix the failing test

✻ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)
`;
const claudeApproval = `
 Bash command
   npm test
 Do you want to proceed?
 ❯ 1. Yes
   2. No, and tell Claude what to do differently (esc)
`;
const claudeIdle = `
⏺ All tests pass now.

╭──────────────────────────────╮
│ >                            │
╰──────────────────────────────╯
  ? for shortcuts
`;

test("Claude Code screens classify by what the user needs to do", () => {
  assert.equal(agents.classify("claude-code", claudeWorking), "working");
  assert.equal(agents.classify("claude-code", claudeApproval), "waiting");
  assert.equal(agents.classify("claude-code", claudeIdle), "done");
  assert.equal(agents.classify("claude-code", "  ⎿  Error: ENOENT"), "error");
  assert.equal(agents.classify("claude-code", "plain output"), "unknown");
  // Still working while an old error is on screen.
  assert.equal(agents.classify("claude-code", `  ⎿  Error: x\n${claudeWorking}`), "working");
  // An answered approval still visible above newer output doesn't count.
  assert.equal(agents.classify("claude-code", `${claudeApproval}\n${claudeWorking}`), "working");
  assert.equal(agents.classify("claude-code", `${claudeWorking}\n${claudeApproval}`), "waiting");
  assert.equal(agents.classify("claude-code", `${claudeApproval}\n${claudeIdle}`), "done");
  // An idle footer under the working line is still working.
  assert.equal(agents.classify("claude-code", `${claudeWorking}\n  ? for shortcuts`), "working");
});

test("screen text identifies the tool when no exec event did", () => {
  assert.equal(agents.detect(claudeIdle), "claude-code");
  assert.equal(agents.detect("$ ls\nfoo bar"), undefined);
});

test("a broken user pattern is skipped, not fatal", () => {
  const custom = new AgentClassifier({
    mine: { ...presets["aider"], waitingApproval: ["(unclosed", "Proceed\\?"] },
  });
  assert.equal(custom.classify("mine", "Proceed?"), "waiting");
});
