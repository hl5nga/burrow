# Burrow

A terminal built for developers who SSH into a home development machine and
work there with AI coding agents (Claude Code and similar CLIs) over SSH and
tmux — from the office, a café, or anywhere else.

Burrow is a native macOS app (Tauri + Rust + xterm.js), not a plugin for an
existing terminal. It never edits your real shell dotfiles: on both the local
machine and every remote host, its hooks live in their own directory and are
loaded through `ZDOTDIR`, so your own `.zshrc` runs exactly as it always has.

## Why

The "SSH + Tailscale + tmux + Mosh" combination is already the de facto way
people do this today, hand-assembled from separate tools. Burrow packages
that combination into one app and adds the parts that combination doesn't
cover: knowing which of your background AI agents needs your attention, and a
safety net for commands that are hard to undo.

## Features

- **Connection list on launch** — pick the local terminal or a saved SSH
  profile from a start screen; mark one to auto-open on every launch instead.
- **SSH profiles** with automatic hook install (opt-in, writes only to
  `~/.burrow/shell/zsh` on the remote host), tmux session reattachment, and
  automatic transport selection (SSH or [Mosh](https://mosh.org/), when both
  ends have it).
- **Connection resilience** — reachability checks before connecting, automatic
  reconnect with backoff on drops, and tmux panes that survive network
  changes under Mosh.
- **VPN integration** — runs a profile's own VPN command only when its host
  isn't reachable yet, and skips it entirely on networks you've marked as
  "home" (identified by the router's hardware address, since macOS hides the
  Wi-Fi name from apps).
- **Command palette and per-folder ranking** — register commands or SSH
  profiles once; commands used often enough in a given folder or host get
  promoted into a quick-access panel automatically.
- **Agent dashboard** — tracks Claude Code, Codex, Gemini CLI and Aider by
  screen text, both in the active tab and in every pane of a remote tmux
  session, with OS notifications when one needs approval.
- **Guardrails** — a configurable set of regex rules blocks or warns on
  dangerous commands (`rm -rf ~`, `git push --force`, …) at the shell's input
  line, and the same rules can be installed as a Claude Code `PreToolUse`
  hook so agent-issued commands are checked too.
- **Resource and connection chips** — CPU/RAM for the active tab's host
  (local or remote, sampled the same way), VPN status, and internet
  reachability, all in one corner.
- **Clipboard image paste** — a screenshot pasted into a remote tab is saved
  as a file on that host and its path is inserted, ready for an agent to read.
- **Read-only file browser and viewer** — follows the shell's current
  directory; renders Markdown, JSON and syntax-highlighted code, and HTML in a
  script-disabled sandboxed frame. No write path exists at all.
- **Safer copy/paste** — multi-line pastes are shown for confirmation before
  they reach the shell, with extra warning on `curl | sh`-style pipelines.
- **Editable keybindings** — every shortcut can be rebound, with conflict
  detection and an option to pass a shortcut through to full-screen apps like
  vim.
- Full CJK (Korean/Japanese/Chinese) input support, including Korean IME
  composition inside a WKWebView, where it usually breaks.

## Status

Actively developed; see [docs/README.md](docs/README.md) (Korean) for the
running task log and design notes. A few items are intentionally on hold:
secret masking, a context menu, inline remote-image rendering, and signed/
notarized release packaging.

## Getting started

Requirements: Rust (stable), Node 20+, Xcode Command Line Tools.

```bash
npm install
npm run tauri dev
```

```bash
npm run format   # prettier + cargo fmt
npm run lint     # tsc, prettier --check, cargo fmt --check, cargo clippy
npm run test     # TypeScript unit tests
```

A release build:

```bash
npm run tauri build
```

## Project structure

```
src-tauri/src/   Rust core: PTY, storage, remote side channel, monitoring
src/             Frontend: xterm.js terminal, UI panels
shell/           zsh hook scripts placed under ZDOTDIR (local and remote)
docs/            Design notes, UI mockups, and the task log
```

## License

[GPL-3.0-or-later](LICENSE). If you distribute a modified build, its source
must be shared too, under the same license — the goal is that improvements
made to Burrow flow back to everyone using it, not just the person who made
them.

All dependencies (Rust crates and npm packages, scanned via `cargo metadata`
and `license-checker`) are MIT/Apache-2.0/BSD/MPL-2.0 or similarly permissive
and compatible with GPL-3.0; none introduce a conflicting license
obligation.
