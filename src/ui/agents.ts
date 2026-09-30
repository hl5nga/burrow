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
import type { StoredCommand } from "./command-validation";
import type { TabObserver, TabRef } from "./tabs";
import { t, onLocaleChange } from "../i18n";

/** Tier 1: an agent seen on a tab's own screen. */
interface TabAgent {
  tab: TabRef;
  tool: string;
  state: AgentState;
  since: number;
  /** The tool's process ended (shell prompt came back); scans no longer apply. */
  exited: boolean;
}

interface Pane {
  id: string;
  session: string;
  window: number;
  index: number;
  /** tmux's window name (renamed by the user, or defaulted to the command) — what shows in tmux's own status line. */
  windowName: string;
  command: string;
  active: boolean;
  screen: string;
}

function paneLabel(pane: Pane): string {
  return pane.windowName || `pane ${pane.window}.${pane.index}`;
}

/** Tier 2: an agent in a pane of a remote tmux server. */
interface PaneAgent {
  profileId: string;
  pane: Pane;
  tool: string;
  state: AgentState;
  since: number;
}

/** A tmux pane a task can be sent to, with what is known about it right now. */
export interface AssignTarget {
  paneId: string;
  /** tmux window name (cpo, be, fe …). */
  windowName: string;
  session: string;
  /** "none": not a recognised AI agent (a plain shell, say). */
  state: AgentState | "none";
  toolLabel?: string;
  /** The agent runs with permission prompts off. */
  bypass: boolean;
}

type TmuxPanes = { state: "panes"; panes: Pane[] } | { state: "none" };

const SCAN_DEBOUNCE_MS = 300;
const PANE_POLL_OPEN_MS = 5000;
const PANE_POLL_CLOSED_MS = 6000;

function stateText(state: AgentState): string {
  return t(`agents.state.${state}`);
}

/** Which state a tab badge shows when several agents share a tab. */
const URGENCY: AgentState[] = ["waiting", "error", "working", "done", "unknown"];

function elapsed(since: number): string {
  const s = Math.floor((Date.now() - since) / 1000);
  if (s < 60) return t("agents.elapsedSeconds", { s: String(s) });
  const m = Math.floor(s / 60);
  return m < 60
    ? t("agents.elapsedMinutes", { m: String(m) })
    : t("agents.elapsedHoursMinutes", { h: String(Math.floor(m / 60)), m: String(m % 60) });
}

/**
 * Tracks AI CLIs and shows them in a dashboard (⌘⇧A).
 * Tier 1 reads each tab's own screen (debounced, bottom rows only, so it never
 * competes with typing). Tier 2 asks each SSH host's tmux server for all of its
 * panes over the side channel, so agents in background panes show up too.
 */
export class AgentMonitor implements TabObserver {
  private classifier = new AgentClassifier({});
  private readonly agents = new Map<number, TabAgent>();
  /** Keyed by `${profileId} ${pane id}`. */
  private readonly panes = new Map<string, PaneAgent>();
  /** Every pane of the profile's tmux session, agent or not — for the status
   * bar summary, which shows plain (non-agent) panes too, unlike `panes`
   * above (agent panes only, used for badges/notifications/the dashboard). */
  private readonly allPanes = new Map<string, Pane[]>();
  /** One pending scan per tab: output keeps coming, the scan runs once per 300ms. */
  private readonly scans = new Map<number, number>();
  private readonly overlay = document.createElement("div");
  private readonly list = document.createElement("div");
  private readonly titleText = document.createElement("h3");
  private readonly closeHint = document.createElement("span");
  private readonly note = document.createElement("div");
  private tick = 0;
  private pollTimer = 0;
  private readonly updateListeners: (() => void)[] = [];

  constructor(
    private readonly sshTabs: () => { profileId: string; tab: TabRef }[],
    /** Fires after every Tier 1/2 update, whether or not the dashboard is open —
     * lets a status-bar summary stay live without polling this class itself. */
    private readonly onUpdate: () => void = () => {},
  ) {
    this.overlay.className = "agents-overlay";
    this.overlay.hidden = true;
    const box = document.createElement("div");
    box.className = "agents";
    const head = document.createElement("div");
    head.className = "agents-head";
    this.closeHint.className = "kbd";
    head.append(this.titleText, this.closeHint);
    this.note.className = "agents-note";
    box.append(head, this.list, this.note);
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
    // Set directly rather than through retranslate() below: that also calls
    // updateBadges(), which fires the onUpdate callback (main.ts's
    // updateAgentStatusBar) — main.ts calls `new AgentMonitor(...)` as
    // `const agents = new AgentMonitor(...)`, so invoking that callback
    // synchronously from inside this constructor reads `agents` before its
    // own assignment finishes (a TDZ crash). Nothing has panes/tabs to badge
    // yet at construction time anyway; the first real updateBadges() comes
    // from the load()/poll below, safely after construction returns.
    this.titleText.textContent = t("agents.title");
    this.closeHint.textContent = t("agents.closeHint");
    this.note.textContent = t("agents.note");
    void this.load();
    this.schedulePoll(PANE_POLL_CLOSED_MS);

    // Lives for the app's lifetime (a top-level singleton, see main.ts), so
    // this subscription is never unsubscribed — same as command-manager.ts.
    onLocaleChange(() => this.retranslate());
  }

  private retranslate() {
    this.titleText.textContent = t("agents.title");
    this.closeHint.textContent = t("agents.closeHint");
    this.note.textContent = t("agents.note");
    this.updateBadges();
    if (this.isOpen) this.render();
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
    this.schedulePoll(0);
  }

  close() {
    this.hide();
    this.sshTabs()
      .map((t) => t.tab)
      .concat([...this.agents.values()].map((a) => a.tab))
      .find((t) => t.isActive())
      ?.session()
      ?.focus();
  }

  private hide() {
    this.overlay.hidden = true;
    window.clearInterval(this.tick);
  }

  // ---------- Tier 1: the tab's own screen ----------

  onHookEvent(tab: TabRef, event: HookEvent) {
    if (event.type === "exec") {
      const tool = this.classifier.toolForCommand(event.cmd);
      if (tool) {
        this.setTab(tab, tool, "working");
      } else if (this.agents.get(tab.id)?.exited) {
        // Another command after the agent ended: the tab is no longer an agent.
        this.removeTab(tab);
      }
    } else if (event.type === "prompt") {
      const agent = this.agents.get(tab.id);
      if (agent && !agent.exited) {
        agent.exited = true;
        this.setTab(tab, agent.tool, event.exit === 0 ? "done" : "error");
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

  private scan(tab: TabRef) {
    this.scans.delete(tab.id);
    const agent = this.agents.get(tab.id);
    if (agent?.exited) return;
    const screen = tab.session()?.screenText(SCAN_LINES);
    if (screen === undefined) return;
    // No exec event named a tool (tmux, or a host without hooks): go by the screen.
    const tool = agent?.tool ?? this.classifier.detect(screen);
    if (!tool) return;
    this.setTab(tab, tool, this.classifier.classify(tool, screen));
  }

  onClosed(tab: TabRef) {
    this.removeTab(tab);
  }

  private removeTab(tab: TabRef) {
    window.clearTimeout(this.scans.get(tab.id));
    this.scans.delete(tab.id);
    this.agents.delete(tab.id);
    this.updateBadges();
    if (this.isOpen) this.render();
  }

  private setTab(tab: TabRef, tool: string, state: AgentState) {
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
    // A tab attached to tmux shows one of the panes Tier 2 already reports.
    if (state === "waiting" && !this.hasPanes(tab)) {
      void this.notify(this.classifier.label(tool), tab.label(), tab);
    }
    this.updateBadges();
    if (this.isOpen) this.render();
  }

  // ---------- Tier 2: remote tmux panes ----------

  private schedulePoll(delay: number) {
    window.clearTimeout(this.pollTimer);
    this.pollTimer = window.setTimeout(() => void this.poll(), delay);
  }

  private async poll() {
    const byProfile = new Map<string, TabRef[]>();
    for (const { profileId, tab } of this.sshTabs()) {
      byProfile.set(profileId, [...(byProfile.get(profileId) ?? []), tab]);
    }
    const sessions = await this.profileSessions();
    await Promise.all(
      [...byProfile.entries()].map(async ([profileId, tabs]) => {
        let result: TmuxPanes;
        try {
          result = await invoke<TmuxPanes>("tmux_panes", { profileId });
        } catch {
          result = { state: "none" }; // Unreachable right now: Tier 1 only.
        }
        const session = sessions.get(profileId);
        const panes =
          result.state === "panes"
            ? // A profile with a tmux session only shows that session's panes,
              // so profiles for different projects on one host stay apart.
              result.panes.filter((p) => !session || p.session === session)
            : [];
        this.allPanes.set(profileId, panes);
        this.updatePanes(profileId, panes, tabs);
      }),
    );
    // Profiles whose tabs are gone.
    for (const [key, agent] of this.panes) {
      if (!byProfile.has(agent.profileId)) this.panes.delete(key);
    }
    for (const profileId of this.allPanes.keys()) {
      if (!byProfile.has(profileId)) this.allPanes.delete(profileId);
    }
    this.updateBadges();
    if (this.isOpen) this.render();
    this.schedulePoll(this.isOpen ? PANE_POLL_OPEN_MS : PANE_POLL_CLOSED_MS);
  }

  private async profileSessions(): Promise<Map<string, string>> {
    try {
      const file = await invoke<{ commands: StoredCommand[] }>("store_get", { kind: "commands" });
      return new Map(
        file.commands.flatMap((c) => (c.tmuxSession ? [[c.id, c.tmuxSession] as const] : [])),
      );
    } catch {
      return new Map();
    }
  }

  private updatePanes(profileId: string, panes: Pane[], tabs: TabRef[]) {
    const seen = new Set<string>();
    for (const pane of panes) {
      const screen = pane.screen.split("\n").slice(-SCAN_LINES).join("\n");
      const tool = this.classifier.toolForCommand(pane.command) ?? this.classifier.detect(screen);
      if (!tool) continue;
      const key = `${profileId} ${pane.id}`;
      seen.add(key);
      const state = this.classifier.classify(tool, screen);
      const old = this.panes.get(key);
      const changed = !old || old.state !== state || old.tool !== tool;
      this.panes.set(key, {
        profileId,
        pane,
        tool,
        state,
        since: changed ? Date.now() : old.since,
      });
      if (changed && state === "waiting") {
        const where = `${tabs[0]?.label() ?? ""} › ${pane.session} › ${paneLabel(pane)}`;
        void this.notify(this.classifier.label(tool), where);
      }
    }
    for (const [key, agent] of this.panes) {
      if (agent.profileId === profileId && !seen.has(key)) this.panes.delete(key);
    }
  }

  private hasPanes(tab: TabRef) {
    const profile = this.sshTabs().find((t) => t.tab.id === tab.id)?.profileId;
    return !!profile && [...this.panes.values()].some((p) => p.profileId === profile);
  }

  private async selectPane(agent: PaneAgent) {
    const tab =
      this.sshTabs().find((t) => t.profileId === agent.profileId && t.tab.isActive()) ??
      this.sshTabs().find((t) => t.profileId === agent.profileId);
    tab?.tab.select();
    try {
      await invoke("tmux_select_pane", { profileId: agent.profileId, paneId: agent.pane.id });
    } catch {
      // The pane may have closed since the last poll.
    }
    this.schedulePoll(500);
  }

  // ---------- badges, notifications, dashboard ----------

  private updateBadges() {
    const ssh = this.sshTabs();
    const seen = new Set<number>();
    const all = [...ssh.map((t) => t.tab), ...[...this.agents.values()].map((a) => a.tab)];
    for (const tab of all) {
      if (seen.has(tab.id)) continue;
      seen.add(tab.id);
      const profile = ssh.find((t) => t.tab.id === tab.id)?.profileId;
      const states: { state: AgentState; tool: string }[] = [
        ...[...this.panes.values()].filter((p) => p.profileId === profile),
        ...(this.agents.has(tab.id) ? [this.agents.get(tab.id)!] : []),
      ];
      if (states.length === 0) {
        tab.setBadge(undefined);
        continue;
      }
      const top = URGENCY.find((u) => states.some((s) => s.state === u)) ?? "unknown";
      const count = states.filter((s) => s.state === top).length;
      const tool = this.classifier.label(states.find((s) => s.state === top)!.tool);
      tab.setBadge(
        top,
        `${tool} · ${stateText(top)}${count > 1 ? t("agents.countSuffix", { count: String(count) }) : ""}`,
      );
    }
    this.onUpdate();
    for (const fn of this.updateListeners) fn();
  }

  /** Runs after every pane update (same moments as the status bar refreshes). */
  addUpdateListener(fn: () => void) {
    this.updateListeners.push(fn);
  }

  /** The state the last poll saw for a pane; undefined if it isn't a known agent. */
  stateOf(profileId: string, paneId: string): AgentState | undefined {
    return this.panes.get(`${profileId} ${paneId}`)?.state;
  }

  /**
   * Panes of the profile's host, read fresh (not from the last poll), for the
   * Assign dialog: what a task is about to be sent to must be current.
   */
  async targetsFor(profileId: string, session?: string | null): Promise<AssignTarget[]> {
    const result = await invoke<TmuxPanes>("tmux_panes", { profileId });
    if (result.state !== "panes") return [];
    return result.panes
      .filter((p) => !session || p.session === session)
      .sort(
        (x, y) => x.session.localeCompare(y.session) || x.window - y.window || x.index - y.index,
      )
      .map((pane) => {
        const screen = pane.screen.split("\n").slice(-SCAN_LINES).join("\n");
        const tool = this.classifier.toolForCommand(pane.command) ?? this.classifier.detect(screen);
        return {
          paneId: pane.id,
          windowName: paneLabel(pane),
          session: pane.session,
          state: tool ? this.classifier.classify(tool, screen) : "none",
          toolLabel: tool ? this.classifier.label(tool) : undefined,
          bypass: /bypass permissions on/.test(screen),
        };
      });
  }

  /**
   * For a persistent status-bar summary (not the ⌘⇧A modal): the active tab's
   * tmux panes if it's an SSH+tmux connection with agents in them, else its own
   * single Tier 1 agent if it has one, else empty (nothing to show).
   */
  summaryForActiveTab(): { label: string; state: AgentState | "none" }[] {
    const ssh = this.sshTabs().find((t) => t.tab.isActive());
    if (ssh) {
      const all = (this.allPanes.get(ssh.profileId) ?? [])
        .slice()
        .sort(
          (x, y) => x.session.localeCompare(y.session) || x.window - y.window || x.index - y.index,
        );
      if (all.length) {
        return all.map((pane) => {
          const agent = this.panes.get(`${ssh.profileId} ${pane.id}`);
          return { label: paneLabel(pane), state: agent?.state ?? "none" };
        });
      }
    }
    const agent = [...this.agents.values()].find((a) => a.tab.isActive());
    return agent ? [{ label: this.classifier.label(agent.tool), state: agent.state }] : [];
  }

  /** An OS notification for something the user should know while Burrow is in the background. */
  async notifyText(title: string, body: string) {
    if (document.hasFocus()) return;
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) sendNotification({ title, body });
    } catch {
      // Notifications are a convenience; the toast and the row banner still show.
    }
  }

  /** Only when the user can't already see it: another tab, or Burrow in the background. */
  private async notify(tool: string, where: string, tab?: TabRef) {
    // A tab agent is in view when its tab is; a pane agent when the dashboard is open.
    if (document.hasFocus() && (tab ? tab.isActive() : this.isOpen)) return;
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted)
        sendNotification({ title: t("agents.notifyWaitingTitle", { tool }), body: where });
    } catch {
      // Notifications unavailable; the tab badge still shows it.
    }
  }

  private row(
    state: AgentState,
    name: string,
    where: string,
    since: number,
    onClick: () => void,
  ): HTMLElement {
    const row = document.createElement("button");
    row.className = "agent-row";
    const badge = document.createElement("span");
    badge.className = `agent-state ${state}`;
    badge.textContent = stateText(state);
    const main = document.createElement("span");
    main.className = "agent-main";
    const title = document.createElement("span");
    title.className = "agent-name";
    title.textContent = name;
    const sub = document.createElement("span");
    sub.className = "agent-where";
    sub.textContent = where;
    main.append(title, sub);
    const time = document.createElement("span");
    time.className = "agent-time";
    time.textContent = elapsed(since);
    row.append(badge, main, time);
    row.addEventListener("click", () => {
      this.hide();
      onClick();
    });
    return row;
  }

  private render() {
    const rows: HTMLElement[] = [];
    const ssh = this.sshTabs();
    const shownProfiles = new Set<string>();
    for (const a of [...this.agents.values()].sort((x, y) => x.tab.id - y.tab.id)) {
      // Tabs attached to tmux are covered, pane by pane, below.
      if (this.hasPanes(a.tab)) continue;
      rows.push(
        this.row(a.state, this.classifier.label(a.tool), a.tab.label(), a.since, () =>
          a.tab.select(),
        ),
      );
    }
    const paneAgents = [...this.panes.values()].sort(
      (x, y) =>
        x.profileId.localeCompare(y.profileId) ||
        x.pane.session.localeCompare(y.pane.session) ||
        x.pane.window - y.pane.window ||
        x.pane.index - y.pane.index,
    );
    for (const p of paneAgents) {
      if (!shownProfiles.has(p.profileId)) {
        shownProfiles.add(p.profileId);
        const head = document.createElement("div");
        head.className = "agents-host";
        head.textContent =
          ssh.find((entry) => entry.profileId === p.profileId)?.tab.label() ??
          t("tabs.remoteLabel");
        rows.push(head);
      }
      const where = `${p.pane.session} › ${paneLabel(p.pane)}${p.pane.active ? t("agents.visiblePaneSuffix") : ""}`;
      rows.push(
        this.row(
          p.state,
          this.classifier.label(p.tool),
          where,
          p.since,
          () => void this.selectPane(p),
        ),
      );
    }
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "agents-empty";
      empty.textContent = t("agents.emptyDashboard");
      rows.push(empty);
    }
    this.list.replaceChildren(...rows);
  }
}
