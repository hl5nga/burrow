import { Channel, invoke } from "@tauri-apps/api/core";
import {
  openTerminalSession,
  type SessionContext,
  type SessionOptions,
  type TerminalSession,
} from "../terminal/session";
import type { HookEvent } from "../terminal/hook-events";
import { showToast } from "./toast";
import { checkReachable, type Reachability } from "./reachability";
import { guardPaste } from "./paste-guard";
import type { Level, ResourceTarget } from "./resource-chip";
import { t } from "../i18n";

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
  /** When the VPN was last brought up for this outage (rate limit); cleared once connected. */
  vpnTriedAt?: number;
  /** The user pressed reconnect: try the VPN again regardless of the rate limit. */
  forceVpn?: boolean;
}

/** A process that dies this soon after starting never really connected. */
const QUICK_EXIT_MS = 5000;
const MAX_BACKOFF_S = 30;
const VPN_RETRY_MS = 120_000;
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
  /** The side-channel event stream of a Mosh tab. */
  eventStream?: Promise<number | undefined>;
  /** This tab's profile's vpnPostDisconnect, only set if the VPN step
   * actually ran for THIS connection (never for a home-network connect). */
  vpnDisconnectCmd?: string;
  /** Runs when the tab is closed (a connection picker tab cancels its picker). */
  onClose?: () => void;
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
  /**
   * About to close the very last tab, which would end the whole app: asks
   * before anything is torn down. False (or the user cancelling) leaves the
   * tab exactly as it was.
   */
  confirmCloseLastTab(): Promise<boolean>;
  onLastTabClosed(): void;
  /**
   * The host can't be reached while reconnecting: the app may bring the
   * profile's VPN back up (a drop usually takes the VPN down too). Resolves
   * with the reachability afterwards and the disconnect command to remember,
   * or undefined if there is no VPN to bring up.
   */
  reconnectVpn(
    profileId: string,
  ): Promise<{ reach: Reachability; vpnDisconnect: string | null } | undefined>;
  /** The ＋ button: the app decides what a new tab is (usually a connection picker). */
  onNewTabRequest(): void;
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
  /** Copy on mouse release (config copyOnSelect). */
  copyOnSelect = false;
  private readonly refs = new Map<Tab, TabRef>();

  constructor(
    private readonly bar: HTMLElement,
    private readonly body: HTMLElement,
    private readonly events: TabEvents,
  ) {
    const add = document.createElement("button");
    add.className = "tab-add";
    add.textContent = "＋";
    add.title = t("tabs.newTabTitle");
    add.addEventListener("click", () => this.events.onNewTabRequest());
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
  newSshTab(
    profileId: string,
    label: string,
    withHooks: boolean,
    transport: SessionTransport,
    moshServer: string | null = null,
    vpnDisconnect: string | null = null,
  ) {
    // Mosh drops the hooks' OSC events; they come over a side channel instead.
    const eventLog = transport === "mosh" && withHooks ? crypto.randomUUID() : null;
    return this.newTab({
      label,
      connection: { profileId, transport },
      eventLog,
      vpnDisconnect,
      options: {
        remote: true,
        spawn: (cols, rows, onOutput) =>
          invoke<number>("pty_spawn_ssh", {
            profileId,
            withHooks,
            transport,
            moshServer,
            eventLog,
            cols,
            rows,
            onOutput,
          }),
      },
    });
  }

  private async startEvents(
    tab: Tab,
    profileId: string,
    session: string,
    attempt = 0,
  ): Promise<number | undefined> {
    const channel = new Channel<string>();
    channel.onmessage = (line) => {
      if (line !== "burrow:stream-ended") return tab.session?.hookEvent(line);
      // The side channel's ssh died (network change) while Mosh kept going:
      // reconnect it once the host answers again, backing off up to 30 s.
      if (!this.tabs.includes(tab)) return;
      const delay = Math.min(2 ** attempt, 30) * 1000;
      window.setTimeout(async () => {
        if (!this.tabs.includes(tab)) return;
        const reach = await checkReachable(profileId, true);
        tab.eventStream =
          reach.state === "offline"
            ? Promise.resolve(undefined).then(() => {
                channel.onmessage?.("burrow:stream-ended");
                return undefined;
              })
            : this.startEvents(tab, profileId, session, attempt + 1);
      }, delay);
    };
    try {
      const id = await invoke<number>("remote_event_stream", {
        profileId,
        session,
        onEvent: channel,
      });
      // Healthy for a while: the next drop starts the backoff over.
      window.setTimeout(() => (attempt = 0), 30_000);
      return id;
    } catch (err) {
      if (attempt === 0) showToast(t("tabs.moshTrackingFailed", { error: String(err) }));
      channel.onmessage?.("burrow:stream-ended");
      return undefined;
    }
  }

  /**
   * Saves the clipboard image as a file on the tab's host and pastes its path,
   * which is how Claude Code and other CLIs take images.
   */
  private async pasteImage(tab: Tab) {
    if (!tab.connection && tab.context.host !== "local") {
      // ssh'd by hand from a local tab: Burrow can't reach that host.
      showToast(t("tabs.pasteImageForeignShell"));
      return;
    }
    const where = tab.connection ? (tab.title ?? t("tabs.remoteLabel")) : t("launcher.thisMac");
    showToast(t("tabs.pasteImageSaving", { where }));
    try {
      const path = await invoke<string>("clip_image_save", {
        profileId: tab.connection?.profileId ?? null,
      });
      // Bracketed paste, no Enter: the user decides when to send it.
      tab.session?.paste(path);
      tab.session?.focus();
    } catch (err) {
      showToast(t("tabs.pasteImageFailed", { error: String(err) }));
    }
  }

  /** The active tab's host and folder, for per-host actions like hook installs. */
  activeTarget() {
    const tab = this.active;
    if (!tab) return undefined;
    return {
      profileId: tab.connection?.profileId,
      hostLabel: tab.connection ? (tab.title ?? tab.context.host) : t("launcher.thisMac"),
      cwd: tab.context.cwd,
      foreignShell: !tab.connection && tab.context.host !== "local",
    };
  }

  /** Connected SSH/Mosh tabs, for polling their hosts' tmux panes. */
  sshTabs(): { profileId: string; tab: TabRef }[] {
    return this.tabs.flatMap((tab) =>
      tab.connection?.state === "connected"
        ? [{ profileId: tab.connection.profileId, tab: this.ref(tab) }]
        : [],
    );
  }

  /** Applies a new font size/line height to every open tab immediately. */
  applyTextSettings(fontSize: number, lineHeight: number) {
    for (const tab of this.tabs) tab.session?.setTextSize(fontSize, lineHeight);
  }

  /** Applies a new color profile to every open tab's terminal immediately. */
  applyTheme(themeId: string) {
    for (const tab of this.tabs) tab.session?.setTheme(themeId);
  }

  /** Each tab's host for the CPU/RAM monitor, with a hook for its tab dot. */
  resourceTargets(): ResourceTarget[] {
    return this.tabs.map((tab) => ({
      profileId: tab.connection?.profileId,
      label: tab.title ?? t("launcher.thisMac"),
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
          ok: t("tabs.resourceOk"),
          warn: t("tabs.resourceWarn"),
          high: t("tabs.resourceHigh"),
        }[value];
      },
    }));
  }

  /** Mosh roams on its own; SSH tabs that are waiting to reconnect retry now. */
  /** One VPN attempt per outage, then at most one every two minutes (or when asked to). */
  private shouldTryVpn(c: ConnectionControl): boolean {
    return c.forceVpn === true || !c.vpnTriedAt || Date.now() - c.vpnTriedAt > VPN_RETRY_MS;
  }

  /**
   * The status-bar chip: reconnect the active tab right now, like pressing
   * Enter in a dropped tab. False when there is nothing to reconnect.
   */
  reconnectNow(): boolean {
    const tab = this.active;
    const c = tab?.connection;
    if (!tab || !c || c.state === "connected" || c.state === "connecting") return false;
    window.clearTimeout(c.timer);
    c.attempt = 0;
    c.quickFailures = 0;
    c.forceVpn = true;
    this.scheduleReconnect(tab, 0);
    return true;
  }

  networkChanged() {
    const connections = this.tabs.flatMap((t) => (t.connection ? [t.connection] : []));
    if (connections.some((c) => c.transport === "mosh")) {
      showToast(t("tabs.networkChangedMosh"));
    } else if (connections.some((c) => c.state === "connected")) {
      showToast(t("tabs.networkChangedSsh"));
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
      /** Session id of a Mosh tab's event log on the host. */
      eventLog?: string | null;
      /** This connection's vpnPostDisconnect, if the VPN was actually engaged for it. */
      vpnDisconnect?: string | null;
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
    label.textContent = spec.label ?? t("tabs.localLabel");
    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "×";
    close.title = t("tabs.closeTabTitle");
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
      vpnDisconnectCmd: spec.vpnDisconnect ?? undefined,
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
              tab.connection.forceVpn = true;
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
          onPasteImage: () => void this.pasteImage(tab),
          onPaste: (text) => {
            if (tab.session) void guardPaste(tab.session, text);
          },
          onScreenChange: () => {
            for (const o of this.observers) o.onScreenChange(this.ref(tab));
          },
        },
        spec.options,
      );
      if (tab === this.active) tab.session.focus();
      if (spec.eventLog && spec.connection) {
        tab.eventStream = this.startEvents(tab, spec.connection.profileId, spec.eventLog);
      }
      host.addEventListener("mouseup", () => {
        if (this.copyOnSelect) void tab.session?.copySelection();
      });
      this.setConnectionState(tab, "connected");
    } catch (err) {
      showToast(t("tabs.startFailed", { error: String(err) }));
      this.close(tab);
    }
  }

  /**
   * ＋ new tab: a tab of its own whose body is the connection picker, so the
   * open tabs stay exactly as they are. Picking an entry opens it as a normal
   * tab in that spot; closing the picker tab cancels.
   */
  async pickInNewTab<E>(
    make: (host: HTMLElement) => { open(): Promise<E | undefined>; cancel(): void },
    open: (entry: E) => Promise<void>,
  ) {
    const host = document.createElement("div");
    host.className = "term-host";
    this.body.append(host);
    const element = document.createElement("div");
    element.className = "tab";
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = t("tabs.newTabLabel");
    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "×";
    close.title = t("tabs.closeTabTitle");
    element.append(
      Object.assign(document.createElement("span"), { className: "dot" }),
      label,
      close,
    );
    this.bar.insertBefore(element, this.bar.lastElementChild);
    const tab: Tab = {
      id: this.nextId++,
      host,
      label,
      element,
      context: { host: "", cwd: "", branch: "" },
    };
    this.tabs.push(tab);
    element.addEventListener("mousedown", (e) => {
      if (e.target !== close) this.activate(tab);
    });
    close.addEventListener("click", () => this.close(tab));
    this.activate(tab);

    for (;;) {
      const picker = make(host);
      tab.onClose = () => picker.cancel();
      const entry = await picker.open();
      if (entry === undefined || !this.tabs.includes(tab)) break;
      const before = this.tabs.length;
      await open(entry);
      // A failed connect leaves no new tab: stay on the picker to try again.
      if (this.tabs.length > before) break;
    }
    tab.onClose = undefined;
    if (this.tabs.includes(tab)) this.remove(tab);
  }

  close(tab = this.active) {
    if (!tab || !this.tabs.includes(tab)) return;
    if (this.tabs.length === 1) {
      // Closing this one ends the whole app: ask before touching anything,
      // so a cancel truly leaves the session running, not just the tab UI.
      void this.closeLast(tab);
      return;
    }
    this.remove(tab);
  }

  private async closeLast(tab: Tab) {
    if (await this.events.confirmCloseLastTab()) this.remove(tab);
  }

  private remove(tab: Tab) {
    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);
    window.clearTimeout(tab.connection?.timer);
    void tab.eventStream?.then((id) => id && invoke("remote_event_stop", { id }).catch(() => {}));
    for (const o of this.observers) o.onClosed(this.ref(tab));
    this.refs.delete(tab);
    tab.onClose?.();
    tab.session?.dispose();
    tab.host.remove();
    tab.element.remove();
    // No remaining tab still needs this VPN: this one was the last to use it.
    if (
      tab.vpnDisconnectCmd &&
      !this.tabs.some((t) => t.vpnDisconnectCmd === tab.vpnDisconnectCmd)
    ) {
      void this.disconnectVpn(tab);
    }
    if (this.tabs.length === 0) {
      this.active = undefined;
      this.events.onLastTabClosed();
      return;
    }
    if (tab === this.active) this.activate(this.tabs[Math.min(index, this.tabs.length - 1)]);
  }

  private async disconnectVpn(tab: Tab) {
    const profileId = tab.connection?.profileId;
    if (!profileId) return;
    try {
      await invoke("vpn_post_disconnect", { profileId });
      showToast(t("tabs.vpnDisconnected", { cmd: tab.vpnDisconnectCmd ?? "" }));
    } catch (err) {
      showToast(t("tabs.vpnDisconnectFailed", { error: String(err) }));
    }
  }

  /**
   * The whole app is about to close (native window close, ⌘Q, Dock Quit —
   * paths that don't go through remove()'s own per-tab check): disconnect
   * every VPN currently engaged by an open tab, once each.
   */
  async disconnectAllVpns() {
    const seen = new Set<string>();
    for (const tab of this.tabs) {
      if (!tab.vpnDisconnectCmd || seen.has(tab.vpnDisconnectCmd)) continue;
      seen.add(tab.vpnDisconnectCmd);
      await this.disconnectVpn(tab);
    }
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
      const codeSuffix = code !== null ? t("tabs.exitCodeSuffix", { code: String(code) }) : "";
      session.notice(t("tabs.connectFailedNotice", { codeSuffix }));
      this.setConnectionState(tab, "stopped");
      return;
    }
    if (quick) c.quickFailures++;
    else c.quickFailures = 0;
    if (c.quickFailures >= MAX_QUICK_FAILURES) {
      session.notice(t("tabs.reconnectFailedAuthNotice"));
      this.setConnectionState(tab, "stopped");
      return;
    }
    const delay = Math.min(2 ** c.attempt, MAX_BACKOFF_S);
    session.notice(t("tabs.droppedRetryNotice", { delay: String(delay) }));
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
    let reach = await checkReachable(c.profileId, true);
    if (!this.tabs.includes(tab)) return;
    if (reach.state === "offline" && this.shouldTryVpn(c)) {
      c.vpnTriedAt = Date.now();
      c.forceVpn = false;
      session.notice(t("tabs.vpnReconnectNotice"));
      try {
        const vpn = await this.events.reconnectVpn(c.profileId);
        if (!this.tabs.includes(tab)) return;
        if (vpn) {
          reach = vpn.reach;
          // The VPN is now this tab's to turn off when it closes.
          if (vpn.vpnDisconnect && !tab.vpnDisconnectCmd) tab.vpnDisconnectCmd = vpn.vpnDisconnect;
        }
      } catch {
        // The VPN step is best effort; fall through to the normal retry.
      }
    }
    if (reach.state === "offline") {
      const delay = Math.min(2 ** c.attempt, MAX_BACKOFF_S);
      if (c.state !== "offline")
        session.notice(t("tabs.unreachableRetryNotice", { reason: reach.reason }));
      this.setConnectionState(tab, "offline");
      c.timer = window.setTimeout(() => void this.reconnect(tab), delay * 1000);
      return;
    }
    session.notice(t("tabs.reconnectingNotice"));
    c.startedAt = Date.now();
    try {
      await session.restart();
      this.setConnectionState(tab, "connected");
      // Reset the backoff only once the connection has proven itself.
      const started = c.startedAt;
      window.setTimeout(() => {
        if (c.startedAt === started && c.state === "connected") {
          c.attempt = 0;
          c.vpnTriedAt = undefined;
        }
      }, QUICK_EXIT_MS);
    } catch (err) {
      session.notice(t("tabs.reconnectErrorNotice", { error: String(err) }));
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
    const where =
      tab.title ?? (tab.context.host === "local" ? t("tabs.localLabel") : tab.context.host);
    tab.label.textContent = tab.context.cwd ? `${where} — ${basename(tab.context.cwd)}` : where;
    tab.element.title = tab.context.cwd;
  }
}
