import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRAPPERS = new URL(".", import.meta.url).pathname;

// Runs an interactive login zsh through Burrow's wrappers with a throwaway HOME,
// so the user's real dotfiles are never involved.
function runThroughWrappers(home: string, script: string, env: Record<string, string> = {}) {
  return execFileSync("zsh", ["-il", "-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH!, HOME: home, TERM: "xterm-256color", ZDOTDIR: WRAPPERS, ...env },
  });
}

function withHome(files: Record<string, string>, fn: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "burrow-home-"));
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(home, path, ".."), { recursive: true });
      writeFileSync(join(home, path), body);
    }
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const REPORT = `print -r -- "zdotdir=\${ZDOTDIR-<unset>}"
print -r -- "histfile=$HISTFILE"
print -r -- "order=$BURROW_TEST_ORDER"
print -r -- "precmd=$precmd_functions"
print -r -- "preexec=$preexec_functions"`;

function parse(out: string) {
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

test("user startup files load in order and the session looks untouched", () => {
  withHome(
    {
      ".zshenv": "BURROW_TEST_ORDER+=env,",
      ".zprofile": "BURROW_TEST_ORDER+=profile,",
      ".zshrc": "BURROW_TEST_ORDER+=rc,\nmy_precmd() {}\nprecmd_functions+=(my_precmd)",
      ".zlogin": "BURROW_TEST_ORDER+=login,",
    },
    (home) => {
      const r = parse(runThroughWrappers(home, REPORT));
      assert.equal(r.zdotdir, "<unset>");
      assert.equal(r.order, "env,profile,rc,login,");
      assert.equal(r.histfile, join(home, ".zsh_history"));
      assert.equal(r.precmd, "__burrow_precmd my_precmd");
      assert.equal(r.preexec, "__burrow_preexec");
    },
  );
});

test("a ZDOTDIR set by the user's .zshenv (XDG layout) is followed", () => {
  withHome(
    {
      ".zshenv": 'ZDOTDIR="$HOME/.config/zsh"',
      ".config/zsh/.zprofile": "BURROW_TEST_ORDER+=profile,",
      ".config/zsh/.zshrc": "BURROW_TEST_ORDER+=rc,",
      ".config/zsh/.zlogin": "BURROW_TEST_ORDER+=login,",
    },
    (home) => {
      const r = parse(runThroughWrappers(home, REPORT));
      assert.equal(r.zdotdir, join(home, ".config/zsh"));
      assert.equal(r.order, "profile,rc,login,");
      assert.equal(r.histfile, join(home, ".config/zsh/.zsh_history"));
    },
  );
});

test("a ZDOTDIR the app inherited is handed back to the user", () => {
  withHome({ "dots/.zshrc": "BURROW_TEST_ORDER+=rc," }, (home) => {
    const r = parse(runThroughWrappers(home, REPORT, { BURROW_USER_ZDOTDIR: join(home, "dots") }));
    assert.equal(r.zdotdir, join(home, "dots"));
    assert.equal(r.order, "rc,");
  });
});

test("nothing is written into the wrapper directory", () => {
  withHome({ ".zshrc": "setopt INC_APPEND_HISTORY" }, (home) => {
    runThroughWrappers(home, "print -s 'recorded'; fc -AI");
    assert.ok(!existsSync(join(WRAPPERS, ".zsh_history")), "history leaked into the wrappers");
    assert.match(readFileSync(join(home, ".zsh_history"), "utf8"), /recorded/);
  });
});

test("the git branch is read without running git", () => {
  withHome({}, (home) => {
    mkdirSync(join(home, "repo/.git"), { recursive: true });
    mkdirSync(join(home, "repo/src/deep"), { recursive: true });
    writeFileSync(join(home, "repo/.git/HEAD"), "ref: refs/heads/feature/login\n");
    mkdirSync(join(home, "wt"), { recursive: true });
    mkdirSync(join(home, "repo/.git/worktrees/wt"), { recursive: true });
    writeFileSync(join(home, "repo/.git/worktrees/wt/HEAD"), "3f9a2c1d8e7b6a5\n");
    writeFileSync(join(home, "wt/.git"), `gitdir: ${join(home, "repo/.git/worktrees/wt")}\n`);

    const branch = (dir: string) =>
      runThroughWrappers(home, `cd ${dir} && print -r -- "[$(__burrow_git_branch)]"`)
        .trim()
        .split("\n")
        .pop();
    assert.equal(branch(join(home, "repo/src/deep")), "[feature/login]");
    assert.equal(branch(join(home, "wt")), "[3f9a2c1]");
    assert.equal(branch(home), "[]");
  });
});
