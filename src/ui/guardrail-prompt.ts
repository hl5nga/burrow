import type { HookEvent } from "../terminal/hook-events";
import { chooseDialog } from "./dialog";
import type { TabObserver, TabRef } from "./tabs";
import { showToast } from "./toast";
import { t } from "../i18n";

/**
 * The app side of the shell guardrail. The shell already holds the line and
 * waits for a second Enter; this modal is the clearer way to give (or refuse)
 * that Enter. Answering in the terminal directly works just the same.
 */
export class GuardrailPrompt implements TabObserver {
  /** The tab whose modal is open, and how to close it. */
  private pending?: { tabId: number; abort: AbortController };

  onHookEvent(tab: TabRef, event: HookEvent) {
    // The user answered in the terminal (the line ran, or a new prompt came).
    if (event.type !== "guardrail") {
      if (this.pending?.tabId === tab.id) this.pending.abort.abort();
      return;
    }
    if (event.severity === "warn") {
      showToast(t("guardrailPrompt.warn", { label: event.label }));
      return;
    }
    if (!tab.isActive() || this.pending) {
      showToast(t("guardrailPrompt.blockedBackground", { tab: tab.label(), label: event.label }));
      return;
    }
    void this.confirm(tab, event.cmd, event.label);
  }

  private async confirm(tab: TabRef, cmd: string, label: string) {
    const abort = new AbortController();
    this.pending = { tabId: tab.id, abort };
    const choice = await chooseDialog(
      t("guardrailPrompt.confirmTitle", { label }),
      [cmd, t("guardrailPrompt.confirmBody")],
      // Cancel first: it takes the focus, so a stray Enter doesn't run it.
      [
        { value: "cancel", label: t("guardrailPrompt.cancel"), kind: "ghost" },
        { value: "run", label: t("guardrailPrompt.runAnyway"), kind: "danger" },
      ],
      abort.signal,
    );
    this.pending = undefined;
    const session = tab.session();
    if (!session || abort.signal.aborted) return;
    // The shell kept the line: Enter runs it, Ctrl-C drops it.
    session.send(choice === "run" ? "\r" : "\x03");
    session.focus();
  }

  onScreenChange() {}
  onClosed() {}
}
