import { invoke } from "@tauri-apps/api/core";
import type { TerminalSession } from "../terminal/session";
import { t, onLocaleChange } from "../i18n";
import type { TaskPanel } from "./task-panel";

type Scope = "dir" | "host" | "all";
type View = "commands" | "tasks";

const VIEW_KEY = "burrow.panelView";

interface Ranked {
  command: string;
  count: number;
}

interface Config {
  promotionThreshold: number;
  frequentPanelOpen: boolean;
  frequentPanelWidth: number;
}

const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 240;

/** The widest the panel may get: most of the window stays for the terminal. */
const maxWidth = () => Math.max(MIN_WIDTH, Math.min(760, Math.round(window.innerWidth * 0.6)));
const clampWidth = (w: number) => Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(w)));

const LIMIT = 9;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "/";
}

/**
 * Docked list of the commands used most here (⌘J). Number keys run an entry
 * while the panel has focus; Escape hands focus back to the terminal.
 */
export class FrequentPanel {
  readonly element = el("aside", "freq-panel");
  private readonly rail = el("button", "freq-rail");
  private readonly list = el("div", "freq-list");
  private readonly foot = el("div", "freq-panel-foot");
  private readonly tabs = new Map<Scope, HTMLButtonElement>();
  private readonly hint = el("div", "scope-hint");
  private scope: Scope = "dir";
  private view: View = "commands";
  private readonly viewTabs = new Map<View, HTMLButtonElement>();
  private head?: HTMLElement;
  private tasks?: TaskPanel;
  private items: Ranked[] = [];
  private open = true;
  // What was on screen for the current scope/place, to spot newly promoted entries.
  private seenKey = "";
  private seen = new Set<string>();
  private fresh = new Set<string>();
  // Cached from the last refresh(), so retranslate() can re-render without a session.
  private lastHost?: string;
  private lastCwd = "";
  private lastThreshold = 0;

  constructor(
    host: HTMLElement,
    private readonly getSession: () => TerminalSession | undefined,
  ) {
    const head = el("div", "freq-panel-head");
    const tabRow = el("div", "scope-tabs");
    for (const scope of ["dir", "host", "all"] as Scope[]) {
      const tab = el("button", "st");
      tab.addEventListener("click", () => this.setScope(scope));
      this.tabs.set(scope, tab);
      tabRow.append(tab);
    }
    head.append(tabRow, this.hint);
    this.head = head;
    this.element.append(head, this.list, this.foot);
    this.element.tabIndex = -1;
    this.element.addEventListener("keydown", (e) => this.onKey(e));
    this.element.append(this.makeResizer());

    this.rail.append(
      el("span", "rail-icon", "★"),
      el("span", "rail-hotkey", t("frequentPanel.hotkey")),
    );
    this.rail.addEventListener("click", () => this.setOpen(true, true));

    host.append(this.element, this.rail);
    this.updateTabs();

    // Lives for the app's lifetime (a top-level singleton, see main.ts), so
    // this subscription is never unsubscribed — same as command-manager.ts.
    onLocaleChange(() => this.retranslate());
    this.retranslate();
  }

  /** Adds the "Tasks" view next to the commands, with a switch at the top. */
  attachTasks(tasks: TaskPanel) {
    this.tasks = tasks;
    const switcher = el("div", "panel-views");
    for (const view of ["commands", "tasks"] as View[]) {
      const b = el("button", "panel-view");
      b.addEventListener("click", () => this.setView(view, true));
      this.viewTabs.set(view, b);
      switcher.append(b);
    }
    this.element.prepend(switcher);
    this.element.append(tasks.element);
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(VIEW_KEY);
    } catch {
      // Private window or blocked storage: start on commands.
    }
    this.retranslate();
    this.setView(saved === "tasks" ? "tasks" : "commands", false);
  }

  private setView(view: View, focus: boolean) {
    this.view = view;
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // Remembering the tab is a convenience only.
    }
    const commands = view === "commands";
    if (this.head) this.head.hidden = !commands;
    this.list.hidden = !commands;
    this.foot.hidden = !commands;
    if (this.tasks) this.tasks.element.hidden = commands;
    for (const [v, b] of this.viewTabs) b.classList.toggle("active", v === view);
    if (commands) void this.refresh();
    else {
      this.tasks?.shown();
      if (focus) this.tasks?.element.querySelector<HTMLElement>(".task-add")?.focus();
    }
  }

  private retranslate() {
    const commandsTab = this.viewTabs.get("commands");
    commandsTab?.replaceChildren(t("tasks.tabCommands"));
    if (commandsTab)
      commandsTab.title = `${t("frequentPanel.title")} (${t("frequentPanel.hotkey")})`;
    this.viewTabs.get("tasks")?.replaceChildren(t("tasks.tabTasks"));
    this.hint.textContent = t("frequentPanel.footerHint");
    this.rail.title = t("frequentPanel.railTitle");
    this.tabs.get("dir")!.textContent = t("frequentPanel.scopeDir");
    this.tabs.get("all")!.textContent = t("frequentPanel.scopeAll");
    this.tabs.get("host")!.textContent =
      this.lastHost === undefined
        ? t("frequentPanel.scopeHost")
        : this.lastHost === "local"
          ? t("frequentPanel.scopeHostLocal")
          : t("frequentPanel.scopeHostRemote");
    if (this.lastHost !== undefined) this.render(this.lastCwd, this.lastThreshold);
  }

  /**
   * The drag handle on the panel's left edge. The terminal re-fits on its own
   * as the panel changes width (it watches its container); double-click puts
   * the width back to the default.
   */
  private makeResizer(): HTMLElement {
    const handle = el("div", "freq-resizer");
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // No live pointer to capture (a synthetic event): the drag still works
        // while the pointer stays over the handle.
      }
      const startX = e.clientX;
      const startWidth = this.element.getBoundingClientRect().width;
      handle.classList.add("dragging");
      const move = (ev: PointerEvent) => {
        this.setWidth(startWidth + (startX - ev.clientX));
      };
      const end = () => {
        handle.classList.remove("dragging");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        this.saveWidth();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });
    handle.addEventListener("dblclick", () => {
      this.setWidth(DEFAULT_WIDTH);
      this.saveWidth();
    });
    return handle;
  }

  private setWidth(width: number) {
    this.element.style.width = `${clampWidth(width)}px`;
  }

  private saveWidth() {
    const width = Math.round(this.element.getBoundingClientRect().width);
    invoke<Config>("store_get", { kind: "config" })
      .then((config) =>
        invoke("store_put", { kind: "config", value: { ...config, frequentPanelWidth: width } }),
      )
      .catch(() => {});
  }

  async init() {
    const config = await invoke<Config>("store_get", { kind: "config" });
    if (config.frequentPanelWidth) this.setWidth(config.frequentPanelWidth);
    this.applyOpen(config.frequentPanelOpen);
    await this.refresh();
  }

  /** ⌘J: open and focus; if already focused, fold back to the rail. */
  toggle() {
    const focused = this.element.contains(document.activeElement);
    if (this.open && focused) this.setOpen(false, false);
    else this.setOpen(true, true);
  }

  async refresh() {
    const session = this.getSession();
    if (!session || !this.open) return;
    const { host, cwd } = session.context();
    const [items, config] = await Promise.all([
      invoke<Ranked[]>("stats_top", { host, cwd, scope: this.scope, limit: LIMIT }),
      invoke<Config>("store_get", { kind: "config" }),
    ]);

    const key = `${this.scope}|${host}|${this.scope === "dir" ? cwd : ""}`;
    if (key !== this.seenKey) {
      this.seenKey = key;
      this.seen = new Set(items.map((i) => i.command));
      this.fresh.clear();
    } else {
      for (const item of items) {
        if (!this.seen.has(item.command)) this.fresh.add(item.command);
        this.seen.add(item.command);
      }
    }

    this.items = items;
    this.lastHost = host;
    this.lastCwd = cwd;
    this.lastThreshold = config.promotionThreshold;
    this.tabs.get("host")!.textContent =
      host === "local" ? t("frequentPanel.scopeHostLocal") : t("frequentPanel.scopeHostRemote");
    this.render(cwd, config.promotionThreshold);
  }

  private render(cwd: string, threshold: number) {
    this.list.replaceChildren();
    if (this.items.length === 0) {
      const where =
        this.scope === "dir"
          ? t("frequentPanel.emptyWhereDir", { folder: basename(cwd) })
          : t("frequentPanel.emptyWhereOther");
      this.list.append(
        el("div", "freq-empty", t("frequentPanel.empty", { where, threshold: String(threshold) })),
      );
    }
    this.items.forEach((item, index) => {
      const row = el("button", index === 0 ? "freq-item top" : "freq-item");
      const main = el("div", "fi-main");
      main.append(el("div", "fi-cmd", item.command));
      if (this.fresh.has(item.command))
        main.append(el("div", "fi-meta fresh", t("frequentPanel.freshlyPromoted")));
      row.append(
        el("span", "fi-key", String(index + 1)),
        main,
        el("span", "fi-count", t("frequentPanel.count", { count: String(item.count) })),
      );
      row.title = t("frequentPanel.runHint", {
        command: item.command,
        index: String(index + 1),
      });
      row.addEventListener("click", () => this.run(index));
      this.list.append(row);
    });
    this.foot.replaceChildren(
      el("span", undefined, t("frequentPanel.autoThreshold", { threshold: String(threshold) })),
      el("span", undefined, `${this.items.length}/${LIMIT}`),
    );
  }

  private setScope(scope: Scope) {
    this.scope = scope;
    this.updateTabs();
    void this.refresh();
  }

  private updateTabs() {
    for (const [scope, tab] of this.tabs) tab.classList.toggle("active", scope === this.scope);
  }

  private setOpen(open: boolean, focus: boolean) {
    this.applyOpen(open);
    invoke<Config>("store_get", { kind: "config" }).then((config) =>
      invoke("store_put", { kind: "config", value: { ...config, frequentPanelOpen: open } }),
    );
    if (open) {
      void this.refresh();
      if (focus) this.element.focus();
    } else {
      this.getSession()?.focus();
    }
  }

  private applyOpen(open: boolean) {
    this.open = open;
    this.element.hidden = !open;
    this.rail.hidden = open;
  }

  private onKey(e: KeyboardEvent) {
    // The Tasks view has text fields: digits and arrows are for typing there.
    if (this.view === "tasks") {
      if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        this.getSession()?.focus();
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      this.run(Number(e.key) - 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      this.cycleScope(e.key === "ArrowRight" ? 1 : -1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.getSession()?.focus();
    }
  }

  /** ← →: cycles 여기서 → 이 호스트 → 전체 and back. */
  private cycleScope(step: 1 | -1) {
    const order: Scope[] = ["dir", "host", "all"];
    const i = order.indexOf(this.scope);
    this.setScope(order[(i + step + order.length) % order.length]);
  }

  private run(index: number) {
    const item = this.items[index];
    const session = this.getSession();
    if (!item || !session) return;
    session.focus();
    session.run(item.command);
  }
}
