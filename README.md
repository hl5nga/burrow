# Burrow

집 개발 머신에 SSH로 붙어 AI 에이전트(Claude Code 등)와 일하는 개발자를 위한 터미널.
설계와 작업 계획은 [docs/](docs/README.md)에 있다.

## 개발

```bash
npm install
npm run tauri dev
```

```bash
npm run format
npm run lint
```

필요: Rust stable, Xcode Command Line Tools, Node 20+.

## 구조

```
src-tauri/src/   Rust 코어 (PTY, 저장소, 원격 사이드채널, 모니터링)
src/             프론트엔드 (xterm.js, UI 패널)
shell/           ZDOTDIR에 배치하는 zsh 훅 스크립트 (로컬·원격 공용)
docs/            설계 문서, UI 목업, 태스크 (0_plan → 1_progress → 9_done / 5_hold)
```

하위 모듈 디렉토리(`src-tauri/src/pty/` 등)는 해당 기능을 구현하는 태스크에서 만든다.
