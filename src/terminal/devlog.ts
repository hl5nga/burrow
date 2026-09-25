import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";

/** Dev builds only: records raw key/IME/input event order to $TMPDIR/burrow-dev-events.log. */
export function installInputEventLog(term: Terminal): () => void {
  const types = [
    "keydown",
    "keyup",
    "compositionstart",
    "compositionupdate",
    "compositionend",
    "beforeinput",
    "input",
  ];
  const log = (e: Event) => {
    const k = e as KeyboardEvent & InputEvent & CompositionEvent;
    const fields = [
      e.type,
      k.key !== undefined ? `key=${JSON.stringify(k.key)} code=${k.keyCode}` : "",
      "isComposing" in k ? `composing=${k.isComposing}` : "",
      "inputType" in k ? `inputType=${k.inputType}` : "",
      k.data !== undefined && k.data !== null ? `data=${JSON.stringify(k.data)}` : "",
      `textarea=${JSON.stringify(term.textarea?.value ?? "")}`,
    ];
    invoke("dev_log", {
      line: `${performance.now().toFixed(1)} ${fields.filter(Boolean).join(" ")}`,
    });
  };
  // Window capture runs before the IME handler's container capture, so nothing is hidden.
  for (const t of types) window.addEventListener(t, log, true);
  const dataSub = term.onData((d) =>
    invoke("dev_log", { line: `${performance.now().toFixed(1)} >>pty ${JSON.stringify(d)}` }),
  );
  return () => {
    for (const t of types) window.removeEventListener(t, log, true);
    dataSub.dispose();
  };
}
