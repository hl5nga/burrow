/** Pure helpers behind the task panel and the Assign dialog (no DOM). */

export type TaskStatus = "todo" | "doing" | "review" | "done" | "hold";
export type TaskPriority = "high" | "normal" | "low";

export const STATUSES: TaskStatus[] = ["todo", "doing", "review", "done", "hold"];
export const PRIORITIES: TaskPriority[] = ["high", "normal", "low"];

export interface TaskAssignment {
  paneId: string;
  label: string;
  at: number;
  text: string;
  submitted: boolean;
}

export interface Task {
  id: string;
  projectId: string;
  /** Short number within the project (#12): stable, never reused. */
  serial: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  role: string;
  docPath: string;
  createdAt: number;
  updatedAt: number;
  /** When the status last became "done"; null while it isn't. */
  completedAt: number | null;
  assignments: TaskAssignment[];
}

export interface TaskProject {
  id: string;
  name: string;
  profileId: string | null;
  tmuxSession: string | null;
  template: string;
  /** The serial number the next task of this project gets. */
  nextSerial: number;
}

export interface TasksFile {
  version: number;
  projects: TaskProject[];
  tasks: Task[];
  selectedProject: string | null;
}

/** A tmux pane as the Assign dialog sees it (see agents.ts). */
export interface Target {
  paneId: string;
  windowName: string;
  session: string;
  state: "unknown" | "working" | "waiting" | "done" | "error" | "none";
  toolLabel?: string;
  bypass: boolean;
}

export function newId(): string {
  return crypto.randomUUID();
}

export function blankTask(projectId: string, title: string, serial = 0, now = Date.now()): Task {
  return {
    id: newId(),
    projectId,
    serial,
    title,
    description: "",
    status: "todo",
    priority: "normal",
    role: "",
    docPath: "",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    assignments: [],
  };
}

/** The next free serial of the project, advancing its counter. */
export function takeSerial(project: Pick<TaskProject, "nextSerial">): number {
  const serial = Math.max(1, project.nextSerial || 1);
  project.nextSerial = serial + 1;
  return serial;
}

/**
 * Every status change goes through here so the completion time stays right:
 * set when a task becomes done, cleared when it is reopened.
 */
export function withStatus(task: Task, status: TaskStatus, now = Date.now()): Task {
  return {
    ...task,
    status,
    completedAt: status === "done" ? (task.status === "done" ? task.completedAt : now) : null,
    updatedAt: now,
  };
}

/** Fills `{title}`, `{description}` and `{doc}`; unknown braces stay as typed. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(title|description|doc)\}/g, (_, key: string) => vars[key] ?? "");
}

/**
 * The text Assign sends. A project template wins; otherwise the built-in
 * wording (one form when the task points at a document). A description the
 * template doesn't place itself is appended, so nothing typed is dropped.
 */
export function buildPrompt(
  task: Pick<Task, "title" | "description" | "docPath">,
  project: Pick<TaskProject, "template"> | undefined,
  defaults: { plain: string; doc: string },
): string {
  const doc = task.docPath.trim();
  const custom = project?.template.trim() ?? "";
  const template = custom || (doc ? defaults.doc : defaults.plain);
  const description = task.description.trim();
  let text = fill(template, { title: task.title.trim(), description, doc }).trim();
  if (description && !template.includes("{description}")) text += `\n\n${description}`;
  return text;
}

/**
 * The window to pre-select: the one this task went to last time, else the
 * window named like its role, else an idle agent, else any agent.
 */
export function pickTarget(task: Task, targets: Target[]): Target | undefined {
  const last = task.assignments[task.assignments.length - 1];
  const again = last && targets.find((x) => x.paneId === last.paneId);
  if (again) return again;
  const role = task.role.trim().toLowerCase();
  const byRole = role ? targets.find((x) => x.windowName.toLowerCase() === role) : undefined;
  if (byRole) return byRole;
  const agents = targets.filter((x) => x.state !== "none");
  return agents.find((x) => x.state === "done") ?? agents[0] ?? targets[0];
}

export type AssignWarning =
  | { key: "blockedWaiting"; block: true }
  | { key: "warnWorking" | "warnBypass" | "warnPlain"; block?: false }
  | { key: "warnDup"; block?: false; label: string; ago: string };

/** Everything the dialog should say about sending `task` to `target` now. */
export function assessAssign(
  task: Pick<Task, "assignments">,
  target: Target,
  now: number,
  formatAgo: (ms: number) => string,
): AssignWarning[] {
  const out: AssignWarning[] = [];
  if (target.state === "waiting") out.push({ key: "blockedWaiting", block: true });
  if (target.state === "working") out.push({ key: "warnWorking" });
  if (target.state === "none") out.push({ key: "warnPlain" });
  if (target.bypass) out.push({ key: "warnBypass" });
  const prior = [...task.assignments].reverse().find((a) => a.paneId === target.paneId);
  if (prior) {
    out.push({ key: "warnDup", label: prior.label, ago: formatAgo(now - prior.at) });
  }
  return out;
}

const STATUS_ORDER: TaskStatus[] = ["doing", "review", "todo", "hold", "done"];
const PRIORITY_ORDER: TaskPriority[] = ["high", "normal", "low"];

export type TaskFilter = "open" | "done" | "all";
export type SortKey = "status" | "serial" | "created" | "completed" | "updated" | "priority";
export const SORT_KEYS: SortKey[] = [
  "status",
  "serial",
  "created",
  "completed",
  "updated",
  "priority",
];
export interface TaskSort {
  key: SortKey;
  /** "asc" = smallest/oldest first. */
  dir: "asc" | "desc";
}

/** What each sort key does on its first pick: newest/biggest numbers first, except status. */
export const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  status: "asc",
  serial: "desc",
  created: "desc",
  completed: "desc",
  updated: "desc",
  priority: "asc",
};

function byStatus(a: Task, b: Task): number {
  return (
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
    PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
    a.createdAt - b.createdAt
  );
}

/** Tasks that have no value for the key (not completed yet) always sort last. */
function compare(sort: TaskSort): (a: Task, b: Task) => number {
  const sign = sort.dir === "asc" ? 1 : -1;
  const num = (get: (t: Task) => number | null) => (a: Task, b: Task) => {
    const x = get(a);
    const y = get(b);
    if (x === null && y === null) return a.serial - b.serial;
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * (x - y) || a.serial - b.serial;
  };
  switch (sort.key) {
    case "status":
      return (a, b) => sign * byStatus(a, b);
    case "serial":
      return num((t) => t.serial);
    case "created":
      return num((t) => t.createdAt);
    case "completed":
      return num((t) => t.completedAt);
    case "updated":
      return num((t) => t.updatedAt);
    case "priority":
      return (a, b) =>
        sign * (PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)) ||
        byStatus(a, b);
  }
}

/** Tasks of a project for the list, filtered and sorted. */
export function visibleTasks(
  tasks: Task[],
  projectId: string | null,
  filter: TaskFilter,
  sort: TaskSort = { key: "status", dir: "asc" },
): Task[] {
  return tasks
    .filter((x) => x.projectId === projectId)
    .filter((x) =>
      filter === "all"
        ? true
        : filter === "done"
          ? x.status === "done"
          : x.status !== "done" && x.status !== "hold",
    )
    .sort(compare(sort));
}

/** The date a row shows, following the sort: completion, update, or (default) creation — a done task shows when it was completed. */
export function rowDate(
  task: Task,
  sort: TaskSort,
): { kind: "created" | "completed" | "updated"; at: number } {
  if (sort.key === "updated") return { kind: "updated", at: task.updatedAt };
  if (
    sort.key === "completed" ||
    (sort.key !== "created" && task.status === "done" && task.completedAt)
  ) {
    if (task.completedAt) return { kind: "completed", at: task.completedAt };
  }
  return { kind: "created", at: task.createdAt };
}

/** Applies what a successful Assign changes on the task. */
export function recordAssignment(task: Task, entry: TaskAssignment, now = Date.now()): Task {
  const status: TaskStatus =
    task.status === "done" || task.status === "todo" ? "doing" : task.status;
  return { ...withStatus(task, status, now), assignments: [...task.assignments, entry] };
}
