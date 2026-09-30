import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessAssign,
  blankTask,
  buildPrompt,
  pickTarget,
  recordAssignment,
  visibleTasks,
  type Target,
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

test("list: only this project, active first, optionally hiding done/hold", () => {
  const mk = (
    id: string,
    status: string,
    priority: string,
    createdAt: number,
    projectId = "p",
  ) => ({
    ...blankTask(projectId, id, createdAt),
    id,
    status: status as never,
    priority: priority as never,
  });
  const tasks = [
    mk("done1", "done", "high", 1),
    mk("todo-low", "todo", "low", 2),
    mk("todo-high", "todo", "high", 3),
    mk("doing", "doing", "low", 4),
    mk("other", "todo", "high", 5, "q"),
    mk("hold", "hold", "high", 6),
  ];
  assert.deepEqual(
    visibleTasks(tasks, "p", false).map((x) => x.id),
    ["doing", "todo-high", "todo-low", "hold", "done1"],
  );
  assert.deepEqual(
    visibleTasks(tasks, "p", true).map((x) => x.id),
    ["doing", "todo-high", "todo-low"],
  );
});
