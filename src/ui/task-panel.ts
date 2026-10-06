import { invoke } from "@tauri-apps/api/core";
import { t, onLocaleChange } from "../i18n";
import type { AgentMonitor } from "./agents";
import { openAssignDialog } from "./assign-dialog";
import type { StoredCommand } from "./command-validation";
import { chooseDialog } from "./dialog";
import {
  blankTask,
  DEFAULT_DIR,
  DEFAULT_SORT,
  rowDate,
  SORT_KEYS,
  takeSerial,
  validSort,
  withStatus,
  type SortKey,
  type TaskFilter,
  type TaskSort,
  newId,
  PRIORITIES,
  recordAssignment,
  STATUSES,
  visibleTasks,
  type Task,
  type TaskProject,
  type TasksFile,
} from "./task-logic";
import { showToast } from "./toast";

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

const TRACK_MS = 8000;
const FILTER_KEY = "burrow.taskFilter";
const SORT_KEY = "burrow.taskSort";

/** 10/02 within this year, 2025-10-02 otherwise. */
function shortDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const md = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

const STATUS_MARK: Record<string, string> = {
  todo: "○",
  doing: "◐",
  review: "◑",
  done: "●",
  hold: "⏸",
};

/**
 * The "Tasks" side of the right-hand panel: projects, their tasks, and the
 * Assign button that sends a task to a tmux agent window. Everything lives in
 * tasks.json; edits save a moment after the last keystroke.
 */
export class TaskPanel {
  readonly element = el("div", "task-view");
  private file: TasksFile = { version: 1, projects: [], tasks: [], selectedProject: null };
  private loaded = false;
  private filter: TaskFilter = "open";
  private sort: TaskSort = { ...DEFAULT_SORT };
  private expanded: string | null = null;
  private saveTimer = 0;
  /** Finished-looking tasks the user hasn't confirmed or dismissed yet. */
  private readonly looksDone = new Set<string>();
  private readonly lastState = new Map<string, string | undefined>();
  /** What the rows last showed of the agents, so a poll only redraws on a change. */
  private lastSignature = "";
  private polling = false;

  constructor(
    private readonly agents: AgentMonitor,
    private readonly activeProfileId: () => string | undefined,
  ) {
    this.element.hidden = true;
    this.loadPrefs();
    onLocaleChange(() => this.render());
    agents.addUpdateListener(() => void this.onAgentsUpdate());
    // Hosts without an open tab aren't polled by the agent monitor; tasks
    // sent there still get followed.
    window.setInterval(() => void this.onAgentsUpdate(), TRACK_MS);
  }

  async load() {
    try {
      this.file = await invoke<TasksFile>("store_get", { kind: "tasks" });
    } catch (err) {
      showToast(t("tasks.saveFailed", { error: String(err) }));
    }
    this.loaded = true;
    this.followProfile(this.activeProfileId());
    this.render();
  }

  /** The panel became visible. */
  shown() {
    if (!this.loaded) void this.load();
    else this.render();
  }

  /** Switches to the project of the active SSH tab, when there is one. */
  followProfile(profileId: string | undefined) {
    if (!profileId) return;
    const current = this.project();
    if (current?.profileId === profileId) return;
    const match = this.file.projects.find((p) => p.profileId === profileId);
    if (match) {
      this.file.selectedProject = match.id;
      this.expanded = null;
      if (!this.element.hidden) this.render();
    }
  }

  // ---------- data ----------

  private project(): TaskProject | undefined {
    return (
      this.file.projects.find((p) => p.id === this.file.selectedProject) ?? this.file.projects[0]
    );
  }

  private scheduleSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.saveNow(), 300);
  }

  private async saveNow() {
    window.clearTimeout(this.saveTimer);
    try {
      await invoke("store_put", { kind: "tasks", value: this.file });
    } catch (err) {
      showToast(t("tasks.saveFailed", { error: String(err) }));
    }
  }

  private update(task: Task, patch: Partial<Task>) {
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.scheduleSave();
  }

  // ---------- rendering ----------

  render() {
    if (this.element.hidden) return;
    const active = document.activeElement;
    // A re-render must not steal the typing caret from a field in the panel.
    if (
      active instanceof HTMLElement &&
      this.element.contains(active) &&
      this.isTextField(active)
    ) {
      return;
    }
    const project = this.project();
    this.element.replaceChildren(this.renderHeader(project));
    if (!project) {
      this.element.append(el("div", "task-empty", t("tasks.noProject")));
      return;
    }
    this.element.append(this.renderAdd(project), this.renderFilter(), this.renderList(project));
  }

  private isTextField(node: HTMLElement) {
    return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
  }

  private renderHeader(project: TaskProject | undefined): HTMLElement {
    const row = el("div", "task-head");
    const select = el("select", "task-project-select");
    select.title = t("tasks.project");
    for (const p of this.file.projects) {
      const option = el("option", undefined, p.name);
      option.value = p.id;
      option.selected = p.id === project?.id;
      select.append(option);
    }
    select.disabled = this.file.projects.length === 0;
    select.addEventListener("change", () => {
      this.file.selectedProject = select.value;
      this.expanded = null;
      this.scheduleSave();
      this.render();
    });
    const edit = el("button", "task-icon-btn", "⚙");
    edit.title = t("tasks.editProject");
    edit.disabled = !project;
    edit.addEventListener("click", () => project && void this.openProjectForm(project));
    const add = el("button", "task-icon-btn", "+");
    add.title = t("tasks.newProject");
    add.addEventListener("click", () => void this.openProjectForm(undefined));
    row.append(select, edit, add);
    return row;
  }

  private renderAdd(project: TaskProject): HTMLElement {
    const input = el("input", "task-add");
    input.type = "text";
    input.placeholder = t("tasks.addPlaceholder");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && input.value.trim()) {
        e.preventDefault();
        const task = blankTask(project.id, input.value.trim(), takeSerial(project));
        this.file.tasks.push(task);
        this.expanded = null;
        input.value = "";
        this.scheduleSave();
        this.renderForced();
      }
    });
    return input;
  }

  private loadPrefs() {
    try {
      const filter = localStorage.getItem(FILTER_KEY);
      if (filter === "open" || filter === "done" || filter === "all") this.filter = filter;
      this.sort = validSort(JSON.parse(localStorage.getItem(SORT_KEY) ?? "null"));
    } catch {
      // Remembering the list view is a convenience only.
    }
  }

  private savePrefs() {
    try {
      localStorage.setItem(FILTER_KEY, this.filter);
      localStorage.setItem(SORT_KEY, JSON.stringify(this.sort));
    } catch {
      // Same: fine without it.
    }
  }

  /** Changes a task's status with its completion time kept right. */
  private setStatus(task: Task, status: Task["status"]) {
    Object.assign(task, withStatus(task, status));
    this.scheduleSave();
  }

  private renderFilter(): HTMLElement {
    const wrap = el("div", "task-controls");
    const filters = el("div", "task-filter");
    for (const [value, label] of [
      ["open", t("tasks.filterOpen")],
      ["done", t("tasks.filterDone")],
      ["all", t("tasks.filterAll")],
    ] as const) {
      const b = el("button", "task-filter-btn", label);
      b.classList.toggle("active", this.filter === value);
      b.addEventListener("click", () => {
        this.filter = value;
        this.savePrefs();
        this.render();
      });
      filters.append(b);
    }
    const sorting = el("div", "task-sort");
    const select = el("select", "task-sort-select");
    select.title = t("tasks.sortBy");
    for (const key of SORT_KEYS) {
      const o = el("option", undefined, t(`tasks.sort.${key}`));
      o.value = key;
      o.selected = key === this.sort.key;
      select.append(o);
    }
    select.addEventListener("change", () => {
      const key = select.value as SortKey;
      this.sort = { key, dir: DEFAULT_DIR[key] };
      // "Open" holds nothing that was completed: show them when sorting by it.
      if (key === "completed" && this.filter === "open") this.filter = "all";
      this.savePrefs();
      this.render();
    });
    const dir = el("button", "task-sort-dir", this.sort.dir === "asc" ? "↑" : "↓");
    dir.title = t(this.sort.dir === "asc" ? "tasks.sortAsc" : "tasks.sortDesc");
    dir.addEventListener("click", () => {
      this.sort = { ...this.sort, dir: this.sort.dir === "asc" ? "desc" : "asc" };
      this.savePrefs();
      this.render();
    });
    sorting.append(select, dir);
    wrap.append(filters, sorting);
    return wrap;
  }

  /** Re-render even while the add field has focus (it was just cleared). */
  private renderForced() {
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.render();
  }

  private renderList(project: TaskProject): HTMLElement {
    const list = el("div", "task-list");
    const tasks = visibleTasks(this.file.tasks, project.id, this.filter, this.sort);
    if (tasks.length === 0) {
      const any = this.file.tasks.some((x) => x.projectId === project.id);
      list.append(el("div", "task-empty", t(any ? "tasks.emptyFiltered" : "tasks.empty")));
    }
    for (const task of tasks) list.append(this.renderTask(task, project));
    return list;
  }

  private renderTask(task: Task, project: TaskProject): HTMLElement {
    const box = el("div", `task-item ${task.status}`);
    const row = el("div", "task-row");
    const mark = el("button", "task-status", STATUS_MARK[task.status]);
    mark.title = t(`tasks.status.${task.status}`);
    mark.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setStatus(task, task.status === "done" ? "todo" : "done");
      this.render();
    });
    const main = el("div", "task-main");
    const title = el("div", "task-title");
    if (task.serial) title.append(el("span", "task-serial", `#${task.serial}`));
    title.append(document.createTextNode(task.title));
    main.append(title);
    const meta = el("div", "task-meta");
    const when = rowDate(task, this.sort);
    const stamp = el("span", "task-date", `${t(`tasks.date.${when.kind}`)} ${shortDate(when.at)}`);
    stamp.title = new Date(when.at).toLocaleString();
    meta.append(stamp);
    if (task.priority !== "normal") {
      meta.append(el("span", `task-prio ${task.priority}`, t(`tasks.priority.${task.priority}`)));
    }
    if (task.role) meta.append(el("span", "task-role", task.role));
    const last = task.assignments[task.assignments.length - 1];
    if (last && task.status === "doing") {
      const state = this.lastState.get(task.id);
      const dot = el("span", `assign-dot ${state ?? "none"}`, "●");
      meta.append(dot, el("span", undefined, t("tasks.assignedTo", { label: last.label })));
    }
    if (meta.childNodes.length) main.append(meta);
    const assign = el("button", "task-assign", t("tasks.assign"));
    assign.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.assign(task, project);
    });
    row.append(mark, main, assign);
    row.addEventListener("click", () => {
      this.expanded = this.expanded === task.id ? null : task.id;
      this.render();
    });
    box.append(row);

    if (this.looksDone.has(task.id)) {
      const banner = el("div", "task-banner");
      banner.append(el("span", undefined, t("tasks.looksDone")));
      const done = el("button", "task-banner-btn", t("tasks.markDone"));
      done.addEventListener("click", () => {
        this.looksDone.delete(task.id);
        this.setStatus(task, "done");
        this.render();
      });
      const not = el("button", "task-banner-btn ghost", t("tasks.stillWorking"));
      not.addEventListener("click", () => {
        this.looksDone.delete(task.id);
        this.render();
      });
      banner.append(done, not);
      box.append(banner);
    }
    if (this.expanded === task.id) box.append(this.renderDetail(task));
    return box;
  }

  private renderDetail(task: Task): HTMLElement {
    const form = el("div", "task-detail");
    const field = (label: string, control: HTMLElement) => {
      const wrap = el("label", "task-field");
      wrap.append(el("span", undefined, label), control);
      return wrap;
    };
    const text = (value: string, onInput: (v: string) => void) => {
      const i = el("input");
      i.type = "text";
      i.value = value;
      i.addEventListener("input", () => onInput(i.value));
      return i;
    };
    const title = text(task.title, (v) => this.update(task, { title: v }));
    title.addEventListener("change", () => this.renderForced());
    const description = el("textarea");
    description.rows = 6;
    description.value = task.description;
    description.addEventListener("input", () =>
      this.update(task, { description: description.value }),
    );
    const role = text(task.role, (v) => this.update(task, { role: v.trim() }));
    const doc = text(task.docPath, (v) => this.update(task, { docPath: v.trim() }));
    const status = el("select");
    for (const s of STATUSES) {
      const o = el("option", undefined, t(`tasks.status.${s}`));
      o.value = s;
      o.selected = s === task.status;
      status.append(o);
    }
    status.addEventListener("change", () => {
      this.setStatus(task, status.value as Task["status"]);
      this.render();
    });
    const priority = el("select");
    for (const p of PRIORITIES) {
      const o = el("option", undefined, t(`tasks.priority.${p}`));
      o.value = p;
      o.selected = p === task.priority;
      priority.append(o);
    }
    priority.addEventListener("change", () => {
      this.update(task, { priority: priority.value as Task["priority"] });
      this.render();
    });
    const twoCol = el("div", "task-two");
    twoCol.append(
      field(t("tasks.detailStatus"), status),
      field(t("tasks.detailPriority"), priority),
    );
    form.append(
      field(t("tasks.detailTitle"), title),
      field(t("tasks.detailDescription"), description),
      twoCol,
      field(t("tasks.detailRole"), role),
      field(t("tasks.detailDoc"), doc),
    );
    if (task.assignments.length) {
      const hist = el("div", "task-history");
      hist.append(el("div", "task-history-title", t("tasks.history")));
      for (const a of [...task.assignments].reverse().slice(0, 5)) {
        hist.append(
          el(
            "div",
            "task-history-row",
            t("tasks.historyEntry", {
              when: new Date(a.at).toLocaleString(),
              label: a.label,
              mode: a.submitted ? "" : t("tasks.historyPasteOnly"),
            }),
          ),
        );
      }
      form.append(hist);
    }
    const remove = el("button", "btn danger task-delete", t("tasks.delete"));
    remove.addEventListener("click", () => void this.deleteTask(task));
    form.append(remove);
    return form;
  }

  // ---------- actions ----------

  private async deleteTask(task: Task) {
    const choice = await chooseDialog(
      t("tasks.delete"),
      [t("tasks.deleteTaskConfirm", { title: task.title })],
      [
        { value: "cancel", label: t("tasks.cancel"), kind: "ghost" },
        { value: "delete", label: t("tasks.delete"), kind: "danger" },
      ],
    );
    if (choice !== "delete") return;
    this.file.tasks = this.file.tasks.filter((x) => x.id !== task.id);
    this.looksDone.delete(task.id);
    this.expanded = null;
    this.scheduleSave();
    this.render();
  }

  private async assign(task: Task, project: TaskProject) {
    const profileId = project.profileId;
    const choice = await openAssignDialog({
      task,
      project,
      profileId,
      loadTargets: () =>
        profileId ? this.agents.targetsFor(profileId, project.tmuxSession) : Promise.resolve([]),
    });
    if (!choice) return;
    const updated = recordAssignment(task, {
      paneId: choice.target.paneId,
      label: `${choice.target.session} › ${choice.target.windowName}`,
      at: Date.now(),
      text: choice.text,
      submitted: choice.submitted,
    });
    Object.assign(task, updated);
    this.looksDone.delete(task.id);
    this.lastState.delete(task.id);
    showToast(t("tasks.assignDialog.sent", { label: choice.target.windowName }));
    await this.saveNow();
    this.render();
  }

  private async openProjectForm(existing: TaskProject | undefined) {
    let profiles: StoredCommand[] = [];
    try {
      const file = await invoke<{ commands: StoredCommand[] }>("store_get", { kind: "commands" });
      profiles = file.commands.filter((c) => c.type === "ssh-profile");
    } catch {
      // The form still works without the list; the connection stays unset.
    }
    const active = this.activeProfileId();
    const seed = profiles.find((p) => p.id === (existing?.profileId ?? active));

    const overlay = el("div", "dialog-overlay");
    const box = el("div", "dialog task-project-form");
    box.append(el("h3", undefined, existing ? t("tasks.editProject") : t("tasks.newProject")));
    const name = el("input");
    name.type = "text";
    name.value = existing?.name ?? seed?.name ?? "";
    const host = el("select");
    const none = el("option", undefined, t("tasks.projectHostNone"));
    none.value = "";
    host.append(none);
    for (const p of profiles) {
      const o = el("option", undefined, `${p.name} (${p.sshHost ?? ""})`);
      o.value = p.id;
      o.selected = p.id === seed?.id;
      host.append(o);
    }
    const session = el("input");
    session.type = "text";
    session.value = existing?.tmuxSession ?? seed?.tmuxSession ?? "";
    const template = el("textarea");
    template.rows = 3;
    template.value = existing?.template ?? "";
    template.spellcheck = false;
    const field = (label: string, control: HTMLElement, hint?: string) => {
      const wrap = el("label", "task-field");
      wrap.append(el("span", undefined, label), control);
      if (hint) wrap.append(el("small", undefined, hint));
      return wrap;
    };
    box.append(
      field(t("tasks.projectName"), name),
      field(t("tasks.projectHost"), host),
      field(t("tasks.projectSession"), session),
      field(t("tasks.projectTemplate"), template, t("tasks.templateHint")),
    );
    const actions = el("div", "dialog-actions");
    const cancel = el("button", "btn ghost", t("tasks.cancel"));
    const save = el("button", "btn", t("tasks.save"));
    if (existing) {
      const remove = el("button", "btn danger", t("tasks.delete"));
      remove.addEventListener("click", async () => {
        const count = this.file.tasks.filter((x) => x.projectId === existing.id).length;
        const choice = await chooseDialog(
          t("tasks.delete"),
          [t("tasks.deleteProjectConfirm", { name: existing.name, count: String(count) })],
          [
            { value: "cancel", label: t("tasks.cancel"), kind: "ghost" },
            { value: "delete", label: t("tasks.delete"), kind: "danger" },
          ],
        );
        if (choice !== "delete") return;
        this.file.projects = this.file.projects.filter((p) => p.id !== existing.id);
        this.file.tasks = this.file.tasks.filter((x) => x.projectId !== existing.id);
        this.file.selectedProject = this.file.projects[0]?.id ?? null;
        overlay.remove();
        await this.saveNow();
        this.render();
      });
      actions.append(remove);
    }
    actions.append(cancel, save);
    box.append(actions);
    overlay.append(box);
    const close = () => overlay.remove();
    cancel.addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    save.addEventListener("click", async () => {
      const title = name.value.trim();
      if (!title) {
        name.focus();
        return;
      }
      const values = {
        name: title,
        profileId: host.value || null,
        tmuxSession: session.value.trim() || null,
        template: template.value,
      };
      if (existing) Object.assign(existing, values);
      else {
        const created: TaskProject = { id: newId(), nextSerial: 1, ...values };
        this.file.projects.push(created);
        this.file.selectedProject = created.id;
      }
      close();
      await this.saveNow();
      this.render();
    });
    document.body.append(overlay);
    name.focus();
  }

  // ---------- following the agents ----------

  /** The last pane state for each profile, read on this poll when the monitor has none. */
  private async statesFor(profileId: string, session: string | null) {
    try {
      const targets = await this.agents.targetsFor(profileId, session);
      return new Map(targets.map((x) => [x.paneId, x.state === "none" ? undefined : x.state]));
    } catch {
      return new Map<string, string | undefined>();
    }
  }

  private async onAgentsUpdate() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.followTasks();
    } finally {
      this.polling = false;
    }
  }

  private async followTasks() {
    const fetched = new Map<string, Map<string, string | undefined>>();
    let changed = false;
    for (const task of this.file.tasks) {
      if (task.status !== "doing") continue;
      const last = task.assignments[task.assignments.length - 1];
      const project = this.file.projects.find((p) => p.id === task.projectId);
      if (!last || !project?.profileId) continue;
      let state: string | undefined = this.agents.stateOf(project.profileId, last.paneId);
      if (state === undefined) {
        const key = `${project.profileId} ${project.tmuxSession ?? ""}`;
        if (!fetched.has(key)) {
          fetched.set(key, await this.statesFor(project.profileId, project.tmuxSession));
        }
        state = fetched.get(key)?.get(last.paneId);
      }
      const before = this.lastState.get(task.id);
      this.lastState.set(task.id, state);
      if (before === "working" && state === "done" && !this.looksDone.has(task.id)) {
        this.looksDone.add(task.id);
        changed = true;
        const label = last.label;
        showToast(t("tasks.finishedToast", { title: task.title, label }));
        void this.agents.notifyText(t("tasks.looksDone"), `${task.title} — ${label}`);
      }
    }
    // Dots on the rows follow the states even when nothing finished — but a
    // redraw also resets the list's scroll, so only when something changed.
    const signature = this.file.tasks
      .filter((x) => x.status === "doing")
      .map((x) => `${x.id}:${this.lastState.get(x.id) ?? "-"}`)
      .join("|");
    const moved = signature !== this.lastSignature || changed;
    this.lastSignature = signature;
    if (!moved) return;
    if (!this.element.hidden) this.render();
  }
}
