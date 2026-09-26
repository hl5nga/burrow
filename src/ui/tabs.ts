import { invoke } from "@tauri-apps/api/core";
import {
  openTerminalSession,
  type SessionContext,
  type SessionOptions,
  type TerminalSession,
} from "../terminal/session";
import type { HookEvent } from "../terminal/hook-events";
import { showToast } from "./toast";
import { checkReachable } from "./reachability";
import type { Level, ResourceTarget } from "./resource-chip";

export type SessionTransport = "ssh" | "mosh";

export interface Connection {
  profileId: string;
  transport: SessionTransport;
  state: "connecting" | "connected" | "reconnecting" | "offline" | "stopped";
}

interface ConnectionControl extends Connection {
  /** When the current process was started. */
  startedAt: number;
  /** A process has stayed up past QUICK_EXIT_MS, so drops are worth retrying. */
  everConnected: boolean;
  /** Consecutive failed reconnects, for the backoff. */
  attempt: number;
  /** Consecutive attempts that reached sshd but failed right away. */
  quickFailures: number;
  timer?: number;
}

/** A process that dies this soon after starting never really connected. */
const QUICK_EXIT_MS = 5000;
const MAX_BACKOFF_S = 30;
/** Probably authentication or a bad host: stop retrying and wait for Enter. */
const MAX_QUICK_FAILURES = 3;

interface Tab {
  id: number;
  host: HTMLElement;
  label: HTMLElement;
  element: HTMLElement;
  session?: TerminalSession;
  context: SessionContext;
  /** A profile name for SSH tabs, shown instead of the raw hostname. */
  title?: string;
  connection?: ConnectionControl;
}

/** What tab-level observers (the agent monitor) get to see of a tab. */
export interface TabRef {
  id: number;
  label(): string;
  session(): TerminalSession | undefined;
  isActive(): boolean;
  select(): void;
  /** Adds, updates or removes (undefined) a small badge next to the label. */
  setBadge(kind: string | undefined, title?: string): void;
}

export interface TabObserver {
  onHookEvent(tab: TabRef, event: HookEvent): void;
  onScreenChange(tab: TabRef): void;
  onClosed(tab: TabRef): void;
}

export interface TabEvents {
  /** The active tab changed, or the active tab's context did. */
  onActiveContext(context: SessionContext | undefined): void;
  onHookEvent(event: HookEvent): void;
  /** The active tab's SSH/Mosh connection changed; undefined for local tabs. */
  onActiveConnection(connection: Connection | undefined): void;
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
  private readonly observers: TabObserver[] = [];
  private readonly refs = new Map<Tab, TabRef>();

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

  observe(observer: TabObserver) {
    this.observers.push(observer);
  }

  private ref(tab: Tab): TabRef {
    let ref = this.refs.get(tab);
    if (!ref) {
      ref = {
        id: tab.id,
        label: () => tab.label.textContent ?? "",
        session: () => tab.session,
        isActive: () => tab === this.active,
        select: () => this.tabs.includes(tab) && this.activate(tab),
        setBadge: (kind, title) => {
          let badge = tab.element.querySelector<HTMLElement>(".agent-badge");
          if (!kind) return badge?.remove();
          if (!badge) {
            badge = document.createElement("span");
            tab.element.insertBefore(badge, tab.label.nextSibling);
          }
          badge.className = `agent-badge ${kind}`;
          badge.title = title ?? "";
        },
      };
      this.refs.set(tab, ref);
    }
    return ref;
  }

  activeSession(): TerminalSession | undefined {
    return this.active?.session;
  }

  /** Opens an SSH or Mosh session for a stored profile in a new tab. */
  newSshTab(profileId: string, label: string, withHooks: boolean, transport: SessionTransport) {
    return this.newTab({
      label,
      connection: { profileId, transport },
      options: {
        remote: true,
        spawn: (cols, rows, onOutput) =>
          invoke<number>("pty_spawn_ssh", {
            profileId,
            withHooks,
            transport,
            cols,
            rows,
            onOutput,
          }),
      },
    });
  }

  /** Connected SSH/Mosh tabs, for polling their hosts' tmux panes. */
  sshTabs(): { profileId: string; tab: TabRef }[] {
    return this.tabs.flatMap((tab) =>
      tab.connection?.state === "connected"
        ? [{ profileId: tab.connection.profileId, tab: this.ref(tab) }]
        : [],
    );
  }

  /** Each tab's host for the CPU/RAM monitor, with a hook for its tab dot. */
  resourceTargets(): ResourceTarget[] {
    return this.tabs.map((tab) => ({
      profileId: tab.connection?.profileId,
      label: tab.title ?? "이 Mac",
      active: tab === this.active,
      reachable: !tab.connection || tab.connection.state === "connected",
      setLevel: (value: Level | undefined) => {
        let dot = tab.element.querySelector<HTMLElement>(".res-dot");
        if (!value) return dot?.remove();
        if (!dot) {
          dot = document.createElement("span");
          tab.element.insertBefore(dot, tab.element.querySelector(".close"));
        }
        dot.className = `res-dot ${value}`;
        dot.title = {
          ok: "CPU·메모리 여유",
          warn: "CPU·메모리 60% 이상",
          high: "CPU·메모리 85% 이상",
        }[value];
      },
    }));
  }

  /** Mosh roams on its own; SSH tabs that are waiting to reconnect retry now. */
  networkChanged() {
    const connections = this.tabs.flatMap((t) => (t.connection ? [t.connection] : []));
    if (connections.some((c) => c.transport === "mosh")) {
      showToast("네트워크가 바뀌었습니다 · Mosh 세션은 그대로 유지됩니다");
    } else if (connections.some((c) => c.state === "connected")) {
      showToast("네트워크가 바뀌었습니다 · SSH가 끊기면 자동으로 다시 연결합니다");
    }
    for (const tab of this.tabs) {
      const c = tab.connection;
      if (c && (c.state === "reconnecting" || c.state === "offline")) {
        c.attempt = 0;
        this.scheduleReconnect(tab, 0);
      }
    }
  }

  async newTab(
    spec: {
      label?: string;
      options?: SessionOptions;
      connection?: Pick<Connection, "profileId" | "transport">;
    } = {},
  ) {
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
      connection: spec.connection && {
        ...spec.connection,
        state: "connecting",
        startedAt: Date.now(),
        everConnected: false,
        attempt: 0,
        quickFailures: 0,
      },
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
          onExit: (code) => this.onExit(tab, code),
          onInputWhileStopped: (data) => {
            if (data.includes("\r") && tab.connection) {
              tab.connection.attempt = 0;
              tab.connection.quickFailures = 0;
              this.scheduleReconnect(tab, 0);
            }
          },
          onContext: (context) => {
            tab.context = context;
            this.renderLabel(tab);
            if (tab === this.active) this.events.onActiveContext(context);
          },
          onHookEvent: (event) => {
            for (const o of this.observers) o.onHookEvent(this.ref(tab), event);
            if (tab === this.active) this.events.onHookEvent(event);
          },
          onScreenChange: () => {
            for (const o of this.observers) o.onScreenChange(this.ref(tab));
          },
        },
        spec.options,
      );
      if (tab === this.active) tab.session.focus();
      this.setConnectionState(tab, "connected");
    } catch (err) {
      showToast(`터미널을 시작하지 못했습니다: ${err}`);
      this.close(tab);
    }
  }

  close(tab = this.active) {
    if (!tab || !this.tabs.includes(tab)) return;
    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);
    window.clearTimeout(tab.connection?.timer);
    for (const o of this.observers) o.onClosed(this.ref(tab));
    this.refs.delete(tab);
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
    this.events.onActiveConnection(tab.connection && { ...tab.connection });
  }

  private onExit(tab: Tab, code: number | null) {
    const c = tab.connection;
    const session = tab.session;
    if (!c || !session) return this.close(tab);
    const quick = Date.now() - c.startedAt < QUICK_EXIT_MS;
    // ssh exits 255 when the connection itself fails or drops. Other codes are
    // the remote shell's own exit, which ends the tab — unless it happened so
    // fast that the user would never see why.
    const dropped = c.transport === "ssh" && code === 255;
    if (!dropped && !quick) return this.close(tab);

    if (!quick) c.everConnected = true;
    if (!dropped || !c.everConnected) {
      session.notice(
        `[연결하지 못했습니다${code !== null ? ` · 종료 코드 ${code}` : ""}] Enter: 다시 시도 · ⌘W: 탭 닫기`,
      );
      this.setConnectionState(tab, "stopped");
      return;
    }
    if (quick) c.quickFailures++;
    else c.quickFailures = 0;
    if (c.quickFailures >= MAX_QUICK_FAILURES) {
      session.notice(
        "[다시 연결하지 못했습니다 — 인증이나 호스트 설정을 확인하세요] Enter: 다시 시도 · ⌘W: 탭 닫기",
      );
      this.setConnectionState(tab, "stopped");
      return;
    }
    const delay = Math.min(2 ** c.attempt, MAX_BACKOFF_S);
    session.notice(`[연결이 끊겼습니다 · ${delay}초 후 다시 연결합니다] Enter: 지금 연결`);
    this.scheduleReconnect(tab, delay);
  }

  private scheduleReconnect(tab: Tab, delaySeconds: number) {
    const c = tab.connection;
    if (!c) return;
    window.clearTimeout(c.timer);
    if (c.state !== "offline") this.setConnectionState(tab, "reconnecting");
    c.timer = window.setTimeout(() => void this.reconnect(tab), delaySeconds * 1000);
  }

  private async reconnect(tab: Tab) {
    const c = tab.connection;
    const session = tab.session;
    if (!c || !session || !this.tabs.includes(tab)) return;
    c.attempt++;
    // Don't let ssh sit in a long TCP timeout while the host is asleep or the
    // network is down; a 2-second check decides whether to try at all.
    const reach = await checkReachable(c.profileId, true);
    if (!this.tabs.includes(tab)) return;
    if (reach.state === "offline") {
      const delay = Math.min(2 ** c.attempt, MAX_BACKOFF_S);
      if (c.state !== "offline")
        session.notice(
          `[호스트에 닿지 않습니다 · ${reach.reason}] 계속 확인합니다 · Enter: 지금 확인`,
        );
      this.setConnectionState(tab, "offline");
      c.timer = window.setTimeout(() => void this.reconnect(tab), delay * 1000);
      return;
    }
    session.notice("[다시 연결하는 중…]");
    c.startedAt = Date.now();
    try {
      await session.restart();
      this.setConnectionState(tab, "connected");
      // Reset the backoff only once the connection has proven itself.
      const started = c.startedAt;
      window.setTimeout(() => {
        if (c.startedAt === started && c.state === "connected") c.attempt = 0;
      }, QUICK_EXIT_MS);
    } catch (err) {
      session.notice(`[다시 연결하지 못했습니다: ${err}] Enter: 다시 시도`);
      this.setConnectionState(tab, "stopped");
    }
  }

  private setConnectionState(tab: Tab, state: Connection["state"]) {
    const c = tab.connection;
    if (!c) return;
    c.state = state;
    const dot = tab.element.querySelector(".dot");
    dot?.classList.toggle("reconnecting", state === "reconnecting" || state === "connecting");
    dot?.classList.toggle("offline", state === "offline" || state === "stopped");
    if (tab === this.active) this.events.onActiveConnection({ ...c });
  }

  private renderLabel(tab: Tab) {
    const where = tab.title ?? (tab.context.host === "local" ? "로컬" : tab.context.host);
    tab.label.textContent = tab.context.cwd ? `${where} — ${basename(tab.context.cwd)}` : where;
    tab.element.title = tab.context.cwd;
  }
}
