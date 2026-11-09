import { invoke } from "@tauri-apps/api/core";
import type { TerminalSession } from "../terminal/session";
import { t, onLocaleChange } from "../i18n";
import { showToast } from "./toast";
import type { TaskPanel } from "./task-panel";

type Scope = "dir" | "host" | "all";
type View = "commands" | "tasks";

const VIEW_KEY = "burrow.panelView";

interface Ranked {
  command: string;
  count: number;
}

interface Recent {
  command: string;
  cwd: string;
  at: number;
}

interface Saved {
  id: string;
  command: string;
  /** null = shown on every host. */
  host: string | null;
}

/** One entry of the list, whichever section it came from. */
interface Row {
  kind: "saved" | "freq" | "recent";
  command: string;
  count?: number;
  saved?: Saved;
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
/** Recent commands shown under the frequent ones, so the list is never bare. */
const RECENT_LIMIT = 6;
const MAX_THRESHOLD = 20;

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
  // "This host" by default: a per-folder count rarely reaches the threshold, and
  // in ssh/tmux the folder is often unknown or keeps changing.
  private scope: Scope = "host";
  private view: View = "commands";
  private readonly viewTabs = new Map<View, HTMLButtonElement>();
  private head?: HTMLElement;
  private tasks?: TaskPanel;
  private items: Ranked[] = [];
  private savedItems: Saved[] = [];
  private recentItems: Recent[] = [];
  private rows: Row[] = [];
  private readonly addBar = el("div", "freq-add");
  /** Pinned: docked beside the terminal. Unpinned: folded into the rail. */
  private open = true;
  /** Unpinned, but the rail was clicked: the panel floats over the terminal. */
  private peeking = false;
  private readonly pin = el("button", "panel-pin");
  private readonly railHotkey = el("span", "rail-hotkey", t("frequentPanel.hotkey"));
  private hotkey = "";
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
    this.buildAddBar();
    this.element.append(head, this.addBar, this.list, this.foot);
    this.element.tabIndex = -1;
    this.element.addEventListener("keydown", (e) => this.onKey(e));
    this.element.append(this.makeResizer());

    this.rail.append(el("span", "rail-icon", "★"), this.railHotkey);
    this.rail.addEventListener("click", () => this.peek(true, true));
    this.pin.type = "button";
    this.pin.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">' +
      '<path d="M9.8 1.5l4.7 4.7-1.4.7-2 2 .3 2.6-1 1-2.9-2.9-4.1 4.1-.9-.9 4.1-4.1L3.7 6.8l1-1 2.6.3 2-2z"/></svg>';
    this.pin.addEventListener("click", () => this.setOpen(!this.open, !this.open));
    document.addEventListener("pointerdown", (e) => {
      if (
        this.peeking &&
        !this.element.contains(e.target as Node) &&
        !this.rail.contains(e.target as Node)
      )
        this.peek(false, false);
    });

    host.append(this.element, this.rail);
    this.updateTabs();

    // Lives for the app's lifetime (a top-level singleton, see main.ts), so
    // this subscription is never unsubscribed — same as command-manager.ts.
    onLocaleChange(() => this.retranslate());
    this.retranslate();
  }

  /** The shortcut that opens/folds the panel, shown under the rail's star and in the pin's tooltip. */
  setHotkey(label: string) {
    this.hotkey = label;
    this.railHotkey.textContent = label;
    this.railHotkey.hidden = !label;
    this.updatePin();
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
    switcher.append(this.pin);
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
    this.addBar.hidden = !commands;
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
    this.retranslateAdd();
    this.rail.title = this.hotkey
      ? `${t("frequentPanel.railTitle")} (${this.hotkey})`
      : t("frequentPanel.railTitle");
    this.updatePin();
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
    else if (this.open) this.element.focus();
    else if (this.peeking && focused) this.peek(false, false);
    else this.peek(true, true);
  }

  async refresh() {
    const session = this.getSession();
    if (!session || !(this.open || this.peeking)) return;
    const { host, cwd } = session.context();
    const [items, config, saved] = await Promise.all([
      invoke<Ranked[]>("stats_top", { host, cwd, scope: this.scope, limit: LIMIT }),
      invoke<Config>("store_get", { kind: "config" }),
      invoke<Saved[]>("saved_list", { host }),
    ]);
    // A saved command is shown once, in its own section.
    const savedSet = new Set(saved.map((c) => c.command));
    const ranked = items.filter((i) => !savedSet.has(i.command));
    const recent = await invoke<Recent[]>("stats_recent", {
      host,
      cwd,
      scope: this.scope,
      exclude: [...savedSet, ...ranked.map((i) => i.command)],
      limit: RECENT_LIMIT,
    });

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

    this.items = ranked;
    this.savedItems = saved;
    this.recentItems = recent;
    this.lastHost = host;
    this.lastCwd = cwd;
    this.lastThreshold = config.promotionThreshold;
    this.tabs.get("host")!.textContent =
      host === "local" ? t("frequentPanel.scopeHostLocal") : t("frequentPanel.scopeHostRemote");
    this.render(cwd, config.promotionThreshold);
  }

  private render(cwd: string, threshold: number) {
    this.list.replaceChildren();
    this.rows = [
      ...this.savedItems.map((saved): Row => ({ kind: "saved", command: saved.command, saved })),
      ...this.items.map((i): Row => ({ kind: "freq", command: i.command, count: i.count })),
      ...this.recentItems.map((r): Row => ({ kind: "recent", command: r.command })),
    ];
    if (this.rows.length === 0) {
      const where =
        this.scope === "dir"
          ? t("frequentPanel.emptyWhereDir", { folder: basename(cwd) })
          : t("frequentPanel.emptyWhereOther");
      this.list.append(
        el(
          "div",
          "freq-empty",
          `${t("frequentPanel.empty", { where, threshold: String(threshold) })} ${t("frequentPanel.emptyHint")}`,
        ),
      );
    }
    let lastKind: Row["kind"] | undefined;
    this.rows.forEach((row, index) => {
      if (row.kind !== lastKind) {
        lastKind = row.kind;
        const title =
          row.kind === "saved"
            ? t("frequentPanel.sectionSaved")
            : row.kind === "freq"
              ? t("frequentPanel.sectionFrequent")
              : t("frequentPanel.sectionRecent");
        this.list.append(el("div", "freq-section", title));
      }
      this.list.append(this.renderRow(row, index));
    });

    const less = el("button", "thr-btn", "−");
    less.title = t("frequentPanel.thresholdLess");
    less.disabled = threshold <= 1;
    less.addEventListener("click", () => void this.setThreshold(threshold - 1));
    const more = el("button", "thr-btn", "+");
    more.title = t("frequentPanel.thresholdMore");
    more.disabled = threshold >= MAX_THRESHOLD;
    more.addEventListener("click", () => void this.setThreshold(threshold + 1));
    const label = el("span", "thr-label");
    label.append(
      less,
      el("span", undefined, t("frequentPanel.autoThreshold", { threshold: String(threshold) })),
      more,
    );
    this.foot.replaceChildren(label, el("span", undefined, `${this.items.length}/${LIMIT}`));
  }

  private renderRow(row: Row, index: number): HTMLElement {
    const node = el(
      "div",
      row.kind === "saved" || (row.kind === "freq" && index === this.savedItems.length)
        ? "freq-item top"
        : "freq-item",
    );
    node.tabIndex = -1;
    const main = el("div", "fi-main");
    main.append(el("div", "fi-cmd", row.command));
    if (row.kind === "freq" && this.fresh.has(row.command))
      main.append(el("div", "fi-meta fresh", t("frequentPanel.freshlyPromoted")));
    if (row.kind === "saved" && row.saved?.host === null)
      main.append(el("div", "fi-meta", t("frequentPanel.savedEverywhere")));
    node.append(
      // Only the first nine can be run by key.
      el("span", index < 9 ? "fi-key" : "fi-key none", index < 9 ? String(index + 1) : ""),
      main,
    );
    if (row.count !== undefined)
      node.append(el("span", "fi-count", t("frequentPanel.count", { count: String(row.count) })));
    const act = el("button", "fi-act");
    act.type = "button";
    if (row.kind === "saved") {
      act.textContent = "✕";
      act.title = t("frequentPanel.removeSaved");
      act.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.removeSaved(row.saved!);
      });
    } else {
      act.textContent = "☆";
      act.title = t("frequentPanel.saveThis");
      act.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.save(row.command, false);
      });
    }
    node.append(act);
    node.title = t("frequentPanel.runHint", { command: row.command, index: String(index + 1) });
    node.addEventListener("click", () => this.run(index));
    return node;
  }

  private buildAddBar() {
    const open = el("button", "freq-add-open", "");
    open.type = "button";
    const form = el("div", "freq-add-form");
    form.hidden = true;
    const input = el("input", "freq-add-input");
    input.type = "text";
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.autocomplete = "off";
    const all = el("input");
    all.type = "checkbox";
    const allLabel = el("label", "freq-add-all");
    const allText = el("span");
    allLabel.append(all, allText);
    const ok = el("button", "freq-add-ok");
    ok.type = "button";
    const cancel = el("button", "freq-add-cancel");
    cancel.type = "button";
    const row = el("div", "freq-add-row");
    row.append(allLabel, cancel, ok);
    form.append(input, row);
    this.addBar.append(open, form);

    const show = (visible: boolean) => {
      form.hidden = !visible;
      open.hidden = visible;
      if (visible) input.focus();
      else this.element.focus();
    };
    const submit = async () => {
      const done = await this.save(input.value, all.checked);
      if (!done) return;
      input.value = "";
      all.checked = false;
      show(false);
    };
    open.addEventListener("click", () => show(true));
    ok.addEventListener("click", () => void submit());
    cancel.addEventListener("click", () => show(false));
    input.addEventListener("keydown", (e) => {
      // Typing here must not trigger the panel's number/arrow shortcuts.
      e.stopPropagation();
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        show(false);
      }
    });
    this.retranslateAdd = () => {
      open.textContent = t("frequentPanel.addButton");
      input.placeholder = t("frequentPanel.addPlaceholder");
      allText.textContent = t("frequentPanel.addAllHosts");
      ok.textContent = t("frequentPanel.addConfirm");
      cancel.textContent = t("frequentPanel.addCancel");
    };
    this.retranslateAdd();
  }

  private retranslateAdd: () => void = () => {};

  /** Pins `command` for this host (or every host). Returns whether it was stored. */
  private async save(command: string, everywhere: boolean): Promise<boolean> {
    const text = command.trim();
    if (!text) return false;
    try {
      await invoke("saved_add", {
        command: text,
        host: everywhere ? null : (this.lastHost ?? "local"),
      });
    } catch (error) {
      showToast(t("frequentPanel.addFailed", { error: String(error) }));
      return false;
    }
    await this.refresh();
    return true;
  }

  private async removeSaved(saved: Saved) {
    await invoke("saved_remove", { id: saved.id }).catch(() => {});
    await this.refresh();
  }

  private async setThreshold(value: number) {
    const next = Math.min(MAX_THRESHOLD, Math.max(1, value));
    const config = await invoke<Config>("store_get", { kind: "config" });
    await invoke("store_put", { kind: "config", value: { ...config, promotionThreshold: next } });
    await this.refresh();
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
    this.peeking = false;
    this.element.classList.remove("peek");
    this.element.hidden = !open;
    this.rail.hidden = open;
    this.updatePin();
  }

  /** Unpinned: float the panel over the terminal (or tuck it away again). */
  private peek(show: boolean, focus: boolean) {
    if (this.open || this.peeking === show) return;
    this.peeking = show;
    this.element.classList.toggle("peek", show);
    this.element.hidden = !show;
    if (show) {
      void this.refresh();
      if (focus) this.element.focus();
    } else if (focus) {
      this.getSession()?.focus();
    }
  }

  private updatePin() {
    this.pin.classList.toggle("pinned", this.open);
    const hint = this.open ? t("frequentPanel.unpin") : t("frequentPanel.pin");
    this.pin.title = this.hotkey ? `${hint} (${this.hotkey})` : hint;
    this.pin.setAttribute("aria-pressed", String(this.open));
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && this.peeking && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      this.peek(false, true);
      return;
    }
    // The Tasks view has text fields: digits and arrows are for typing there.
    if (this.view === "tasks") {
      if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        this.getSession()?.focus();
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement) return;
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
    const item = this.rows[index];
    const session = this.getSession();
    if (!item || !session) return;
    session.focus();
    session.run(item.command);
    this.peek(false, false);
  }
}
