import { invoke } from "@tauri-apps/api/core";
import {
  openTerminalSession,
  type SessionContext,
  type SessionOptions,
  type TerminalSession,
} from "../terminal/session";
import type { HookEvent } from "../terminal/hook-events";
import { showToast } from "./toast";

interface Tab {
  id: number;
  host: HTMLElement;
  label: HTMLElement;
  element: HTMLElement;
  session?: TerminalSession;
  context: SessionContext;
  /** A profile name for SSH tabs, shown instead of the raw hostname. */
  title?: string;
}

export interface TabEvents {
  /** The active tab changed, or the active tab's context did. */
  onActiveContext(context: SessionContext | undefined): void;
  onHookEvent(event: HookEvent): void;
  onLastTabClosed(): void;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "~";
}

/** One terminal session per tab; only the active tab's terminal is shown. */
export class TabManager {
  private tabs: Tab[] = [];
  private active?: Tab;
  private nextId = 1;

  constructor(
    private readonly bar: HTMLElement,
    private readonly body: HTMLElement,
    private readonly events: TabEvents,
  ) {
    const add = document.createElement("button");
    add.className = "tab-add";
    add.textContent = "＋";
    add.title = "새 탭 (⌘T)";
    add.addEventListener("click", () => void this.newTab());
    this.bar.append(add);
  }

  activeSession(): TerminalSession | undefined {
    return this.active?.session;
  }

  /** Opens an SSH session for a stored profile in a new tab. */
  newSshTab(profileId: string, label: string, withHooks: boolean) {
    return this.newTab({
      label,
      options: {
        remote: true,
        spawn: (cols, rows, onOutput) =>
          invoke<number>("pty_spawn_ssh", { profileId, withHooks, cols, rows, onOutput }),
      },
    });
  }

  async newTab(spec: { label?: string; options?: SessionOptions } = {}) {
    const id = this.nextId++;
    const host = document.createElement("div");
    host.className = "term-host";
    this.body.append(host);

    const element = document.createElement("div");
    element.className = "tab";
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = spec.label ?? "로컬";
    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "×";
    close.title = "탭 닫기 (⌘W)";
    element.append(
      Object.assign(document.createElement("span"), { className: "dot" }),
      label,
      close,
    );
    this.bar.insertBefore(element, this.bar.lastElementChild);

    const tab: Tab = {
      id,
      host,
      label,
      element,
      title: spec.label,
      context: { host: spec.options?.remote ? "" : "local", cwd: "", branch: "" },
    };
    this.tabs.push(tab);
    element.addEventListener("mousedown", (e) => {
      if (e.target === close) return;
      this.activate(tab);
    });
    close.addEventListener("click", () => this.close(tab));
    // Visible before xterm opens so it measures a real size.
    this.activate(tab);

    try {
      tab.session = await openTerminalSession(
        host,
        {
          onExit: () => this.close(tab),
          onContext: (context) => {
            tab.context = context;
            this.renderLabel(tab);
            if (tab === this.active) this.events.onActiveContext(context);
          },
          onHookEvent: (event) => {
            if (tab === this.active) this.events.onHookEvent(event);
          },
        },
        spec.options,
      );
      if (tab === this.active) tab.session.focus();
    } catch (err) {
      showToast(`터미널을 시작하지 못했습니다: ${err}`);
      this.close(tab);
    }
  }

  close(tab = this.active) {
    if (!tab || !this.tabs.includes(tab)) return;
    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);
    tab.session?.dispose();
    tab.host.remove();
    tab.element.remove();
    if (this.tabs.length === 0) {
      this.active = undefined;
      this.events.onLastTabClosed();
      return;
    }
    if (tab === this.active) this.activate(this.tabs[Math.min(index, this.tabs.length - 1)]);
  }

  select(index: number) {
    const tab = this.tabs[index];
    if (tab) this.activate(tab);
  }

  selectRelative(step: number) {
    if (!this.active || this.tabs.length < 2) return;
    const index = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(index + step + this.tabs.length) % this.tabs.length]);
  }

  private activate(tab: Tab) {
    this.active = tab;
    for (const t of this.tabs) {
      const on = t === tab;
      t.host.hidden = !on;
      t.element.classList.toggle("active", on);
    }
    tab.session?.focus();
    this.events.onActiveContext(tab.session ? tab.context : undefined);
  }

  private renderLabel(tab: Tab) {
    const where = tab.title ?? (tab.context.host === "local" ? "로컬" : tab.context.host);
    tab.label.textContent = tab.context.cwd ? `${where} — ${basename(tab.context.cwd)}` : where;
    tab.element.title = tab.context.cwd;
  }
}
