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

test("inside tmux, events are DCS-wrapped and passthrough is enabled for the pane only", () => {
  withHome({}, (home) => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    // A stand-in tmux that records how it was called.
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho "$@" >> "${join(home, "tmux-calls")}"\n`, {
      mode: 0o755,
    });
    const out = runThroughWrappers(home, "__burrow_emit exec h /c 'echo hi'", {
      TMUX: "/tmp/tmux-test,1,0",
      PATH: `${bin}:${process.env.PATH}`,
    });
    const payload = Buffer.from("h\0/c\0echo hi\0").toString("base64");
    assert.ok(out.includes(`\x1bPtmux;\x1b\x1b]9999;exec;${payload}\x07\x1b\\`), "DCS-wrapped OSC");
    assert.match(readFileSync(join(home, "tmux-calls"), "utf8"), /^set -p allow-passthrough on$/m);
  });
});

test("outside tmux, events are plain OSC", () => {
  withHome({}, (home) => {
    const out = runThroughWrappers(home, "__burrow_emit exec h /c 'echo hi'");
    const payload = Buffer.from("h\0/c\0echo hi\0").toString("base64");
    assert.ok(out.includes(`\x1b]9999;exec;${payload}\x07`));
    assert.ok(!out.includes("\x1bPtmux;"));
  });
});

// Some sandboxes let zpty start a shell but never hand it the terminal, so the
// shell never reaches its prompt. Detect that once and skip instead of failing.
const ZPTY_WORKS = (() => {
  try {
    const out = execFileSync(
      "zsh",
      [
        "-f",
        "-c",
        "zmodload zsh/zpty; zpty p zsh -f -i; sleep 0.5; zpty -w p 'print -r -- zpty-ok'; sleep 0.5; o=; while zpty -r -t p c; do o+=$c; done; zpty -d p; print -r -- $o",
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH! }, timeout: 10_000 },
    );
    return out.split("zpty-ok").length > 2; // echoed input plus the output
  } catch {
    return false;
  }
})();
const ptyTest = ZPTY_WORKS ? test : test.skip;

// Types into a real interactive zsh (in a pty, so ZLE runs) and returns once
// the script is done. Each entry of `lines` is sent followed by Enter.
function typeIntoZsh(home: string, rules: string, lines: string[]) {
  const rulesFile = join(home, "guardrails.zsh");
  writeFileSync(rulesFile, rules);
  const sends = lines.map((l) => `zpty -w z ${JSON.stringify(l)}; sleep 0.4`).join("\n");
  const driver = `
zmodload zsh/zpty
zpty z env ZDOTDIR=${WRAPPERS} HOME=${home} BURROW_GUARDRAILS=${rulesFile} TERM=xterm zsh -il
sleep 1
${sends}
zpty -d z`;
  execFileSync("zsh", ["-f", "-c", driver], { encoding: "utf8", env: { PATH: process.env.PATH! } });
}

const RULES = `# burrow-guardrails test
__burrow_guard_patterns=('touch .*/blocked' 'touch .*/warned')
__burrow_guard_severity=(block warn)
__burrow_guard_labels=('test block' 'test warn')
`;

ptyTest("block rules need a second Enter; warn rules run at once", () => {
  withHome({ ".zshrc": "" }, (home) => {
    typeIntoZsh(home, RULES, [`touch ${home}/blocked`]);
    assert.equal(existsSync(join(home, "blocked")), false, "one Enter must not run it");
    typeIntoZsh(home, RULES, [`touch ${home}/blocked`, ""]);
    assert.equal(existsSync(join(home, "blocked")), true, "the second Enter confirms");
    typeIntoZsh(home, RULES, [`touch ${home}/warned`]);
    assert.equal(existsSync(join(home, "warned")), true);
  });
});

ptyTest("an edited line is checked again, and plugins wrapping accept-line keep working", () => {
  withHome(
    {
      // Like zsh-autosuggestions / syntax-highlighting: the user's own widget.
      ".zshrc": `my-accept() { print -rn -- x >> $HOME/chain; zle .accept-line }\nzle -N accept-line my-accept`,
    },
    (home) => {
      // Blocked, then the line changes (Ctrl-U, retype): must block again.
      typeIntoZsh(home, RULES, [`touch ${home}/blocked`, `\x15touch ${home}/blocked`]);
      assert.equal(existsSync(join(home, "blocked")), false);
      typeIntoZsh(home, RULES, ["true"]);
      assert.ok(readFileSync(join(home, "chain"), "utf8").length >= 1, "user widget still runs");
    },
  );
});
