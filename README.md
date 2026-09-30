# Burrow

A terminal built for developers who SSH into a home development machine and
work there with AI coding agents (Claude Code and similar CLIs) over SSH and
tmux — from the office, a café, or anywhere else.

Burrow is a native macOS app (Tauri + Rust + xterm.js), not a plugin for an
existing terminal. It never edits your real shell dotfiles: on both the local
machine and every remote host, its hooks live in their own directory and are
loaded through `ZDOTDIR`, so your own `.zshrc` runs exactly as it always has.

> 🇰🇷 **한국어**: 집 개발 머신에 SSH로 접속해 AI 코딩 에이전트(Claude Code 등)와 함께
> 작업하는 개발자를 위한 터미널입니다 — 사무실이든 카페든 어디서나. 기존 터미널의
> 플러그인이 아니라 독립된 macOS 네이티브 앱(Tauri + Rust + xterm.js)이며, 실제 셸
> dotfile은 절대 건드리지 않습니다 — 로컬/원격 모두 훅이 별도 디렉터리에서
> `ZDOTDIR`로 로드되어, 원래 쓰던 `.zshrc`가 그대로 동작합니다.

## Why

The "SSH + Tailscale + tmux + Mosh" combination is already the de facto way
people do this today, hand-assembled from separate tools. Burrow packages
that combination into one app and adds the parts that combination doesn't
cover: knowing which of your background AI agents needs your attention, and a
safety net for commands that are hard to undo.

> 🇰🇷 **한국어**: "SSH + Tailscale + tmux + Mosh" 조합은 이미 많은 사람들이 여러
> 도구를 직접 조합해서 쓰고 있는 사실상의 표준 방식입니다. Burrow는 이 조합을
> 하나의 앱으로 묶고, 그 조합만으로는 채워지지 않는 부분을 더합니다: 백그라운드에서
> 돌아가는 AI 에이전트 중 어떤 게 지금 내 확인이 필요한지 알려주는 것, 그리고
> 되돌리기 어려운 명령어에 대한 안전장치.

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
- **Korean and English UI** — follows the OS locale on first launch (Korean
  if the system is set to Korean, English otherwise), with a language chip
  in the corner to override it any time; the choice is remembered locally.
  Migration to `en` is in progress module by module.

<details>
<summary>🇰🇷 <b>한국어로 보기</b></summary>

- **시작 화면 연결 목록** — 로컬 터미널이나 저장해 둔 SSH 프로필을 시작 화면에서
  고를 수 있고, 하나를 "자동 열기"로 지정하면 다음부터는 이 화면을 건너뜁니다.
- **SSH 프로필** — 원격 훅 자동 설치(동의 시, 원격의 `~/.burrow/shell/zsh`에만
  기록), tmux 세션 자동 재부착, 양쪽에 다 있으면 SSH/[Mosh](https://mosh.org/)
  자동 선택.
- **연결 복원력** — 접속 전 도달성 확인, 끊기면 백오프를 두고 자동 재연결,
  Mosh 사용 시 네트워크가 바뀌어도 tmux pane이 그대로 유지.
- **VPN 연동** — 호스트에 아직 닿지 않을 때만 프로필의 VPN 명령을 실행하고,
  "집"으로 등록해 둔 네트워크에서는 아예 건너뜀(공유기 하드웨어 주소로 판별 —
  macOS가 앱에 Wi-Fi 이름을 안 알려주기 때문).
- **커맨드 팔레트 + 폴더별 랭킹** — 명령어나 SSH 프로필을 한 번 등록해 두면,
  특정 폴더·호스트에서 자주 쓴 명령어가 자동으로 빠른 실행 패널에 올라옵니다.
- **에이전트 대시보드** — 화면 텍스트로 Claude Code·Codex·Gemini CLI·Aider의
  상태를 추적, 현재 탭뿐 아니라 원격 tmux 세션의 모든 pane까지 확인하고
  승인이 필요하면 OS 알림을 줍니다.
- **가드레일** — 위험한 명령어(`rm -rf ~`, `git push --force` 등)를 정규식
  규칙으로 셸 입력줄에서 차단하거나 경고하고, 같은 규칙을 Claude Code의
  `PreToolUse` 훅으로도 설치해 에이전트가 내린 명령어까지 검사합니다.
- **리소스·연결 칩** — 활성 탭 호스트의 CPU/RAM(로컬·원격 동일한 방식으로 측정),
  VPN 상태, 인터넷 도달성을 한 자리에서 확인.
- **클립보드 이미지 붙여넣기** — 원격 탭에 붙여넣은 스크린샷을 그 호스트에
  파일로 저장하고 경로를 자동으로 입력줄에 넣어 에이전트가 바로 읽게 합니다.
- **읽기 전용 파일 브라우저/뷰어** — 셸의 현재 폴더를 따라가며 Markdown·JSON·
  문법강조 코드·HTML(스크립트 비활성 sandbox)을 미리보기. 쓰기 기능은 아예 없음.
- **더 안전한 복사/붙여넣기** — 여러 줄 붙여넣기는 셸에 전달되기 전에 확인을
  거치고, `curl | sh` 같은 파이프라인은 추가 경고를 표시합니다.
- **단축키 재설정** — 모든 단축키를 바꿀 수 있고, 충돌 감지와 vim 같은
  전체화면 앱으로 단축키를 그대로 통과시키는 옵션도 있습니다.
- 한중일(한국어/일본어/중국어) 입력 완전 지원 — WKWebView 안에서 보통 깨지는
  한글 IME 조합까지 포함.
- **한/영 UI** — 최초 실행 시 OS 언어를 따라감(한국어 환경이면 한국어, 그 외는
  영어), 코너의 언어 칩으로 언제든 강제 전환 가능하며 선택은 로컬에 저장됩니다.
  영어 번역은 모듈 단위로 진행 중입니다.

</details>

## Status

Actively developed; internal design notes and the running task log (Korean)
are kept locally, not published. A few items are intentionally on hold:
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
