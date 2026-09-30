import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { AssignTarget } from "./agents";
import {
  assessAssign,
  buildPrompt,
  pickTarget,
  type AssignWarning,
  type Task,
  type TaskProject,
} from "./task-logic";

export interface AssignChoice {
  target: AssignTarget;
  text: string;
  submitted: boolean;
}

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

function formatAgo(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 90
    ? t("tasks.assignDialog.minutes", { n: String(minutes) })
    : t("tasks.assignDialog.hours", { n: String(Math.round(minutes / 60)) });
}

/**
 * The Assign dialog: pick the tmux window, read and edit the exact text, see
 * what is wrong with sending it there, and send. The window list is read
 * fresh when the dialog opens and again at the moment of sending, so a window
 * that started waiting for an approval in between still blocks the send.
 * Resolves with what was sent, or undefined if the user backed out.
 */
export function openAssignDialog(deps: {
  task: Task;
  project: TaskProject | undefined;
  profileId: string | null;
  loadTargets: () => Promise<AssignTarget[]>;
}): Promise<AssignChoice | undefined> {
  const { task, project, profileId, loadTargets } = deps;
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const overlay = el("div", "dialog-overlay");
    const box = el("div", "dialog assign-dialog");
    box.setAttribute("role", "dialog");
    box.append(el("h3", undefined, t("tasks.assignDialog.title", { title: task.title })));

    const targetLabel = el("div", "assign-label", t("tasks.assignDialog.target"));
    const refresh = el("button", "assign-refresh", t("tasks.assignDialog.refresh"));
    refresh.type = "button";
    targetLabel.append(refresh);
    const targetList = el("div", "assign-targets");
    const warnings = el("div", "assign-warnings");

    const promptLabel = el("div", "assign-label", t("tasks.assignDialog.prompt"));
    const prompt = el("textarea", "assign-prompt");
    prompt.rows = 7;
    prompt.spellcheck = false;
    prompt.value = buildPrompt(task, project, {
      plain: t("tasks.defaultTemplate"),
      doc: t("tasks.defaultTemplateDoc"),
    });

    const submitRow = el("label", "assign-submit");
    const submitBox = el("input");
    submitBox.type = "checkbox";
    submitBox.checked = true;
    submitRow.append(submitBox, document.createTextNode(t("tasks.assignDialog.submit")));

    const actions = el("div", "dialog-actions");
    const cancel = el("button", "btn ghost", t("tasks.cancel"));
    const pasteOnly = el("button", "btn ghost", t("tasks.assignDialog.pasteOnly"));
    const send = el("button", "btn", t("tasks.assignDialog.send"));
    for (const b of [cancel, pasteOnly, send]) b.type = "button";
    actions.append(cancel, pasteOnly, send);
    box.append(targetLabel, targetList, warnings, promptLabel, prompt, submitRow, actions);
    overlay.append(box);

    let targets: AssignTarget[] = [];
    let selected: AssignTarget | undefined;
    let busy = false;

    const finish = (value: AssignChoice | undefined) => {
      overlay.remove();
      // Wait for the key that may have clicked a button to come up, so the
      // rest of it doesn't land in the terminal (same as chooseDialog).
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        window.removeEventListener("keyup", restore, true);
        previous?.focus();
      };
      window.addEventListener("keyup", restore, true);
      window.setTimeout(restore, 300);
      resolve(value);
    };

    const warningText = (w: AssignWarning): string =>
      t(
        `tasks.assignDialog.${w.key}`,
        w.key === "warnDup" ? { label: w.label, ago: w.ago } : undefined,
      );

    const assess = (target: AssignTarget | undefined) =>
      target ? assessAssign(task, target, Date.now(), formatAgo) : [];

    const refreshControls = () => {
      const list = assess(selected);
      warnings.replaceChildren(
        ...list.map((w) =>
          el("div", w.block ? "assign-warn block" : "assign-warn", warningText(w)),
        ),
      );
      const blocked = list.some((w) => w.block) || !selected || !prompt.value.trim() || busy;
      send.disabled = blocked;
      pasteOnly.disabled = blocked;
    };

    const renderTargets = () => {
      if (!profileId) {
        targetList.replaceChildren(el("div", "assign-empty", t("tasks.assignDialog.noProfile")));
        return;
      }
      if (targets.length === 0) {
        targetList.replaceChildren(el("div", "assign-empty", t("tasks.assignDialog.noTargets")));
        return;
      }
      targetList.replaceChildren(
        ...targets.map((target) => {
          const row = el("button", "assign-target");
          row.type = "button";
          row.classList.toggle("selected", target.paneId === selected?.paneId);
          const dot = el("span", `assign-dot ${target.state}`, "●");
          const name = el("span", "assign-target-name", target.windowName);
          const meta = el(
            "span",
            "assign-target-meta",
            `${target.session} · ${target.toolLabel ?? t("tasks.assignDialog.notAgent")}`,
          );
          row.append(dot, name, meta);
          if (target.bypass) row.append(el("span", "assign-bypass", "bypass"));
          row.addEventListener("click", () => {
            selected = target;
            renderTargets();
            refreshControls();
          });
          return row;
        }),
      );
    };

    const load = async () => {
      if (!profileId) {
        renderTargets();
        refreshControls();
        return;
      }
      targetList.replaceChildren(el("div", "assign-empty", t("tasks.assignDialog.loading")));
      try {
        targets = await loadTargets();
      } catch {
        targets = [];
      }
      selected = pickTarget(task, targets);
      renderTargets();
      refreshControls();
    };

    const doSend = async (submit: boolean) => {
      if (!selected || !profileId || busy) return;
      busy = true;
      refreshControls();
      try {
        // Read the windows again right now: the state from when the dialog
        // opened may be stale.
        const fresh = (await loadTargets()).find((x) => x.paneId === selected!.paneId);
        if (!fresh) throw new Error(t("tasks.assignDialog.noTargets"));
        selected = fresh;
        if (assess(fresh).some((w) => w.block)) {
          targets = targets.map((x) => (x.paneId === fresh.paneId ? fresh : x));
          renderTargets();
          return;
        }
        const text = prompt.value.trim();
        await invoke("tmux_send_prompt", {
          profileId,
          paneId: fresh.paneId,
          text,
          submit,
        });
        finish({ target: fresh, text, submitted: submit });
      } catch (err) {
        warnings.append(
          el("div", "assign-warn block", t("tasks.assignDialog.failed", { error: String(err) })),
        );
      } finally {
        busy = false;
        if (overlay.isConnected) refreshControls();
      }
    };

    cancel.addEventListener("click", () => finish(undefined));
    refresh.addEventListener("click", () => void load());
    send.addEventListener("click", () => void doSend(submitBox.checked));
    pasteOnly.addEventListener("click", () => void doSend(false));
    prompt.addEventListener("input", refreshControls);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) finish(undefined);
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(undefined);
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !send.disabled) {
        e.preventDefault();
        void doSend(submitBox.checked);
      }
    });

    document.body.append(overlay);
    refreshControls();
    void load();
    prompt.focus();
  });
}
