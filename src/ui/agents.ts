import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  AgentClassifier,
  SCAN_LINES,
  type AgentState,
  type ToolPatterns,
} from "../terminal/agent-status";
import type { HookEvent } from "../terminal/hook-events";
import type { TabObserver, TabRef } from "./tabs";

interface AgentInfo {
  tab: TabRef;
  tool: string;
  state: AgentState;
  since: number;
  /** The tool's process ended (shell prompt came back); scans no longer apply. */
  exited: boolean;
}

const SCAN_DEBOUNCE_MS = 300;

const STATE_TEXT: Record<AgentState, string> = {
  unknown: "알 수 없음",
  working: "작업 중",
  waiting: "승인 대기",
  done: "완료",
  error: "에러",
};

function elapsed(since: number): string {
  const s = Math.floor((Date.now() - since) / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/**
 * Tracks AI CLIs per tab from the screen text (Tier 1) and shows them in a
 * dashboard (⌘⇧A). Screen scans are debounced and read only the bottom rows,
 * so they never compete with typing.
 */
export class AgentMonitor implements TabObserver {
  private classifier = new AgentClassifier({});
  private readonly agents = new Map<number, AgentInfo>();
  private readonly overlay = document.createElement("div");
  private readonly list = document.createElement("div");
  private tick = 0;

  constructor() {
    this.overlay.className = "agents-overlay";
    this.overlay.hidden = true;
    const box = document.createElement("div");
    box.className = "agents";
    const head = document.createElement("div");
    head.className = "agents-head";
    head.innerHTML = `<h3>에이전트</h3><span class="kbd">⌘⇧A · esc 닫기</span>`;
    const note = document.createElement("div");
    note.className = "agents-note";
    note.textContent =
      "화면 문구로 추정한 상태입니다 — 문구는 ~/.burrow/agent-patterns.json에서 고칠 수 있습니다";
    box.append(head, this.list, note);
    this.overlay.append(box);
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close();
    });
    this.overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    this.overlay.tabIndex = -1;
    document.body.append(this.overlay);
    void this.load();
  }

  async load() {
    try {
      const file = await invoke<{ tools: Record<string, ToolPatterns> }>("store_get", {
        kind: "agent-patterns",
      });
      this.classifier = new AgentClassifier(file.tools);
    } catch {
      // Keep the empty classifier: no agents detected rather than a crash.
    }
  }

  get isOpen() {
    return !this.overlay.hidden;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    this.overlay.hidden = false;
    this.render();
    this.overlay.focus();
    this.tick = window.setInterval(() => this.render(), 1000);
  }

  close() {
    this.overlay.hidden = true;
    window.clearInterval(this.tick);
    [...this.agents.values()]
      .find((a) => a.tab.isActive())
      ?.tab.session()
      ?.focus();
  }

  onHookEvent(tab: TabRef, event: HookEvent) {
    if (event.type === "exec") {
      const tool = this.classifier.toolForCommand(event.cmd);
      if (tool) {
        this.set(tab, tool, "working");
      } else if (this.agents.get(tab.id)?.exited) {
        // Another command after the agent ended: the tab is no longer an agent.
        this.remove(tab);
      }
    } else {
      const agent = this.agents.get(tab.id);
      if (agent && !agent.exited) {
        agent.exited = true;
        this.set(tab, agent.tool, event.exit === 0 ? "done" : "error");
      }
    }
  }

  onScreenChange(tab: TabRef) {
    if (this.agents.get(tab.id)?.exited || this.scans.has(tab.id)) return;
    this.scans.set(
      tab.id,
      window.setTimeout(() => this.scan(tab), SCAN_DEBOUNCE_MS),
    );
  }

  /** One pending scan per tab: output keeps coming, the scan runs once per 300ms. */
  private readonly scans = new Map<number, number>();

  private scan(tab: TabRef) {
    this.scans.delete(tab.id);
    const agent = this.agents.get(tab.id);
    if (agent?.exited) return;
    const screen = tab.session()?.screenText(SCAN_LINES);
    if (screen === undefined) return;
    // No exec event named a tool (tmux, or a host without hooks): go by the screen.
    const tool = agent?.tool ?? this.classifier.detect(screen);
    if (!tool) return;
    this.set(tab, tool, this.classifier.classify(tool, screen));
  }

  onClosed(tab: TabRef) {
    this.remove(tab);
  }

  private remove(tab: TabRef) {
    window.clearTimeout(this.scans.get(tab.id));
    this.scans.delete(tab.id);
    this.agents.delete(tab.id);
    tab.setBadge(undefined);
    if (this.isOpen) this.render();
  }

  private set(tab: TabRef, tool: string, state: AgentState) {
    let agent = this.agents.get(tab.id);
    const before = agent?.state;
    if (!agent || agent.tool !== tool) {
      agent = { tab, tool, state, since: Date.now(), exited: false };
      this.agents.set(tab.id, agent);
    } else if (state !== agent.state) {
      agent.state = state;
      agent.since = Date.now();
    }
    if (state === "working" && agent.exited) agent.exited = false;
    if (before === state) return;
    const label = this.classifier.label(tool);
    tab.setBadge(state, `${label} · ${STATE_TEXT[state]}`);
    if (state === "waiting") void this.notify(tab, label);
    if (this.isOpen) this.render();
  }

  /** Only when the user can't already see it: another tab, or Burrow in the background. */
  private async notify(tab: TabRef, label: string) {
    if (document.hasFocus() && tab.isActive()) return;
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) sendNotification({ title: `${label} · 승인 대기`, body: tab.label() });
    } catch {
      // Notifications unavailable; the tab badge still shows it.
    }
  }

  private render() {
    const agents = [...this.agents.values()].sort((a, b) => a.tab.id - b.tab.id);
    if (agents.length === 0) {
      const empty = document.createElement("div");
      empty.className = "agents-empty";
      empty.textContent =
        "지금 도는 에이전트가 없습니다. claude·codex·gemini·aider를 실행하면 여기에 나타납니다.";
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(
      ...agents.map((a) => {
        const row = document.createElement("button");
        row.className = "agent-row";
        const badge = document.createElement("span");
        badge.className = `agent-state ${a.state}`;
        badge.textContent = STATE_TEXT[a.state];
        const main = document.createElement("span");
        main.className = "agent-main";
        const name = document.createElement("span");
        name.className = "agent-name";
        name.textContent = this.classifier.label(a.tool);
        const where = document.createElement("span");
        where.className = "agent-where";
        where.textContent = a.tab.label();
        main.append(name, where);
        const time = document.createElement("span");
        time.className = "agent-time";
        time.textContent = elapsed(a.since);
        row.append(badge, main, time);
        row.addEventListener("click", () => {
          this.overlay.hidden = true;
          window.clearInterval(this.tick);
          a.tab.select();
        });
        return row;
      }),
    );
  }
}
