import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessAssign,
  blankTask,
  buildPrompt,
  pickTarget,
  recordAssignment,
  rowDate,
  takeSerial,
  visibleTasks,
  withStatus,
  type Target,
  type Task,
} from "./task-logic.ts";

const defaults = {
  plain: "다음 작업을 진행해줘: {title}",
  doc: "{doc} 문서를 읽고 진행해줘: {title}",
};
const tgt = (over: Partial<Target>): Target => ({
  paneId: "%1",
  windowName: "be",
  session: "movion",
  state: "done",
  bypass: false,
  ...over,
});

test("prompt: default wording, description appended", () => {
  const t = { title: " Copy Equipment 범위 ", description: "  - 첫째\n- 둘째 ", docPath: "" };
  assert.equal(
    buildPrompt(t, undefined, defaults),
    "다음 작업을 진행해줘: Copy Equipment 범위\n\n- 첫째\n- 둘째",
  );
});

test("prompt: a document path switches the wording", () => {
  const t = { title: "T", description: "", docPath: "docs/1_task/a.md" };
  assert.equal(
    buildPrompt(t, { template: "" }, defaults),
    "docs/1_task/a.md 문서를 읽고 진행해줘: T",
  );
});

test("prompt: project template places the description itself", () => {
  const t = { title: "T", description: "D", docPath: "" };
  assert.equal(buildPrompt(t, { template: "[{title}]\n{description}" }, defaults), "[T]\nD");
  // A template without {description} still keeps the description.
  assert.equal(buildPrompt(t, { template: "do {title}" }, defaults), "do T\n\nD");
});

test("target: last pane, then role, then an idle agent", () => {
  const a = tgt({ paneId: "%1", windowName: "cpo", state: "working" });
  const b = tgt({ paneId: "%2", windowName: "be", state: "working" });
  const c = tgt({ paneId: "%3", windowName: "fe", state: "done" });
  const shell = tgt({ paneId: "%4", windowName: "be_mon", state: "none" });
  const task = blankTask("p", "x");
  assert.equal(pickTarget({ ...task, role: "BE" }, [a, b, c, shell])?.paneId, "%2");
  assert.equal(pickTarget(task, [a, b, c, shell])?.paneId, "%3");
  const sent = recordAssignment(task, {
    paneId: "%1",
    label: "cpo",
    at: 1,
    text: "t",
    submitted: true,
  });
  assert.equal(pickTarget({ ...sent, role: "be" }, [a, b, c])?.paneId, "%1");
});

test("assess: waiting blocks; working, bypass, plain shell and repeats warn", () => {
  const task = blankTask("p", "x");
  const ago = (ms: number) => `${Math.round(ms / 60000)}m`;
  assert.deepEqual(assessAssign(task, tgt({ state: "waiting" }), 0, ago), [
    { key: "blockedWaiting", block: true },
  ]);
  const keys = (x: ReturnType<typeof assessAssign>) => x.map((w) => w.key);
  assert.deepEqual(keys(assessAssign(task, tgt({ state: "working", bypass: true }), 0, ago)), [
    "warnWorking",
    "warnBypass",
  ]);
  assert.deepEqual(keys(assessAssign(task, tgt({ state: "none" }), 0, ago)), ["warnPlain"]);
  const sent = recordAssignment(task, {
    paneId: "%1",
    label: "be",
    at: 0,
    text: "t",
    submitted: true,
  });
  const dup = assessAssign(sent, tgt({}), 12 * 60000, ago);
  assert.deepEqual(dup, [{ key: "warnDup", label: "be", ago: "12m" }]);
});

test("assign moves todo/done to doing but keeps review/hold", () => {
  const e = { paneId: "%1", label: "be", at: 1, text: "t", submitted: true };
  const base = blankTask("p", "x");
  assert.equal(recordAssignment(base, e).status, "doing");
  assert.equal(recordAssignment({ ...base, status: "done" }, e).status, "doing");
  assert.equal(recordAssignment({ ...base, status: "review" }, e).status, "review");
  assert.equal(recordAssignment({ ...base, status: "hold" }, e).status, "hold");
  assert.equal(recordAssignment(base, e).assignments.length, 1);
});

const mk = (
  id: string,
  serial: number,
  status: string,
  priority: string,
  createdAt: number,
  extra: Partial<Task> = {},
): Task => ({
  ...blankTask("p", id, serial, createdAt),
  id,
  status: status as never,
  priority: priority as never,
  ...extra,
});
const ids = (tasks: Task[]) => tasks.map((x) => x.id);

test("list: this project only, grouped by status by default, filters open/done/all", () => {
  const tasks = [
    mk("done1", 1, "done", "high", 1, { completedAt: 50 }),
    mk("todo-low", 2, "todo", "low", 2),
    mk("todo-high", 3, "todo", "high", 3),
    mk("doing", 4, "doing", "low", 4),
    { ...mk("other", 5, "todo", "high", 5), projectId: "q" },
    mk("hold", 6, "hold", "high", 6),
  ];
  assert.deepEqual(ids(visibleTasks(tasks, "p", "all")), [
    "doing",
    "todo-high",
    "todo-low",
    "hold",
    "done1",
  ]);
  assert.deepEqual(ids(visibleTasks(tasks, "p", "open")), ["doing", "todo-high", "todo-low"]);
  assert.deepEqual(ids(visibleTasks(tasks, "p", "done")), ["done1"]);
});

test("sort: by serial, creation, completion and update, both directions", () => {
  const tasks = [
    mk("a", 1, "done", "normal", 300, { completedAt: 900, updatedAt: 950 }),
    mk("b", 2, "todo", "normal", 100, { updatedAt: 100 }),
    mk("c", 3, "done", "normal", 200, { completedAt: 500, updatedAt: 500 }),
    mk("d", 4, "doing", "normal", 400, { updatedAt: 800 }),
  ];
  const sorted = (key: never, dir: "asc" | "desc") =>
    ids(visibleTasks(tasks, "p", "all", { key, dir }));
  assert.deepEqual(sorted("serial" as never, "asc"), ["a", "b", "c", "d"]);
  assert.deepEqual(sorted("serial" as never, "desc"), ["d", "c", "b", "a"]);
  assert.deepEqual(sorted("created" as never, "asc"), ["b", "c", "a", "d"]);
  assert.deepEqual(sorted("created" as never, "desc"), ["d", "a", "c", "b"]);
  // Not completed yet = last, whichever way it goes (then by serial).
  assert.deepEqual(sorted("completed" as never, "desc"), ["a", "c", "b", "d"]);
  assert.deepEqual(sorted("completed" as never, "asc"), ["c", "a", "b", "d"]);
  assert.deepEqual(sorted("updated" as never, "desc"), ["a", "d", "c", "b"]);
});

test("serials count up and are never reused", () => {
  const project = { nextSerial: 0 };
  assert.deepEqual([takeSerial(project), takeSerial(project), takeSerial(project)], [1, 2, 3]);
  assert.equal(project.nextSerial, 4);
});

test("status changes keep the completion time right", () => {
  const t = mk("a", 1, "todo", "normal", 1);
  const done = withStatus(t, "done", 500);
  assert.equal(done.completedAt, 500);
  // Staying done doesn't move the completion time; reopening clears it.
  assert.equal(withStatus(done, "done", 900).completedAt, 500);
  assert.equal(withStatus(done, "doing", 900).completedAt, null);
  // Assign reopens a finished task.
  const e = { paneId: "%1", label: "be", at: 1, text: "t", submitted: true };
  assert.equal(recordAssignment(done, e, 900).completedAt, null);
});

test("row date follows the sort; a done task shows when it was completed", () => {
  const done = mk("a", 1, "done", "normal", 100, { completedAt: 700, updatedAt: 800 });
  const open = mk("b", 2, "todo", "normal", 200, { updatedAt: 300 });
  const by = (key: never) => ({ key, dir: "desc" as const });
  assert.deepEqual(rowDate(done, by("status" as never)), { kind: "completed", at: 700 });
  assert.deepEqual(rowDate(open, by("status" as never)), { kind: "created", at: 200 });
  assert.deepEqual(rowDate(done, by("created" as never)), { kind: "created", at: 100 });
  assert.deepEqual(rowDate(open, by("completed" as never)), { kind: "created", at: 200 });
  assert.deepEqual(rowDate(done, by("updated" as never)), { kind: "updated", at: 800 });
});
