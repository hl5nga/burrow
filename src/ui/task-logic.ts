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
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  role: string;
  docPath: string;
  createdAt: number;
  updatedAt: number;
  assignments: TaskAssignment[];
}

export interface TaskProject {
  id: string;
  name: string;
  profileId: string | null;
  tmuxSession: string | null;
  template: string;
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

export function blankTask(projectId: string, title: string, now = Date.now()): Task {
  return {
    id: newId(),
    projectId,
    title,
    description: "",
    status: "todo",
    priority: "normal",
    role: "",
    docPath: "",
    createdAt: now,
    updatedAt: now,
    assignments: [],
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

/** Tasks of a project for the list: active ones first, then by priority and age. */
export function visibleTasks(tasks: Task[], projectId: string | null, onlyOpen: boolean): Task[] {
  return tasks
    .filter((x) => x.projectId === projectId)
    .filter((x) => !onlyOpen || (x.status !== "done" && x.status !== "hold"))
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
        a.createdAt - b.createdAt,
    );
}

/** Applies what a successful Assign changes on the task. */
export function recordAssignment(task: Task, entry: TaskAssignment, now = Date.now()): Task {
  return {
    ...task,
    status: task.status === "done" ? "doing" : task.status === "todo" ? "doing" : task.status,
    assignments: [...task.assignments, entry],
    updatedAt: now,
  };
}
