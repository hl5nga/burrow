import type { HookEvent } from "../terminal/hook-events";
import { chooseDialog } from "./dialog";
import type { TabObserver, TabRef } from "./tabs";
import { showToast } from "./toast";

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
      showToast(`⚠ 가드레일: ${event.label}`);
      return;
    }
    if (!tab.isActive() || this.pending) {
      showToast(`⛔ ${tab.label()}: ${event.label} — Enter를 한 번 더 눌러야 실행됩니다`);
      return;
    }
    void this.confirm(tab, event.cmd, event.label);
  }

  private async confirm(tab: TabRef, cmd: string, label: string) {
    const abort = new AbortController();
    this.pending = { tabId: tab.id, abort };
    const choice = await chooseDialog(
      `위험할 수 있는 명령입니다 — ${label}`,
      [
        cmd,
        "가드레일 규칙에 걸려 실행 전에 멈췄습니다. 여기서 Enter를 누르면 취소됩니다 — 실행하려면 '그래도 실행'을 누르세요.",
      ],
      // Cancel first: it takes the focus, so a stray Enter doesn't run it.
      [
        { value: "cancel", label: "취소", kind: "ghost" },
        { value: "run", label: "그래도 실행", kind: "danger" },
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
