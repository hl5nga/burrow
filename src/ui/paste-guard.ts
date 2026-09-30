import { invoke } from "@tauri-apps/api/core";
import { joinLines, preparePaste } from "../terminal/paste";
import type { TerminalSession } from "../terminal/session";
import { chooseDialog } from "./dialog";
import { t } from "../i18n";

const PREVIEW_LINES = 8;
const PIPE_PRESET = "preset-pipe-to-shell";

interface Rule {
  id: string;
  pattern: string;
  label: string;
  enabled: boolean;
}

/** Guardrail rules the pasted text hits, checked by zsh like the shell does. */
async function matchedRules(text: string): Promise<string[]> {
  try {
    const { rules } = await invoke<{ rules: Rule[] }>("store_get", { kind: "guardrails" });
    const enabled = rules.filter((r) => r.enabled);
    // Pasted `curl … | sh` is the case this check exists for, so it applies
    // even when the user's rules were written before that preset existed.
    if (!rules.some((r) => r.id === PIPE_PRESET)) {
      const presets = await invoke<Rule[]>("guardrail_presets");
      enabled.push(...presets.filter((r) => r.id === PIPE_PRESET));
    }
    const { matched } = await invoke<{ matched: string[] }>("guardrail_test", {
      command: text,
      patterns: enabled.map((r) => [r.id, r.pattern]),
    });
    return enabled.filter((r) => matched.includes(r.id)).map((r) => r.label);
  } catch {
    return [];
  }
}

/**
 * Multi-line text pasted at a shell could run several commands at once, and
 * pasted scripts (`curl … | sh`) are a classic trap. Those get a preview first;
 * a single line goes straight in, where the guardrail still checks it on Enter.
 * Full-screen apps (vim, less) get their paste untouched.
 */
export async function guardPaste(session: TerminalSession, raw: string) {
  const paste = preparePaste(raw);
  if (!paste.multiline || session.term.buffer.active.type !== "normal") {
    session.paste(paste.text);
    return;
  }
  const hits = await matchedRules(paste.text);
  const shown = paste.lines.slice(0, PREVIEW_LINES).join("\n");
  const more = paste.lines.length - PREVIEW_LINES;
  const count = paste.lines.filter((l) => l.trim()).length;
  const choice = await chooseDialog(
    hits.length
      ? t("pasteGuard.riskyTitle", { hits: hits.join(", ") })
      : t("pasteGuard.confirmTitle", { count: String(count) }),
    [
      { code: more > 0 ? t("pasteGuard.previewMore", { shown, more: String(more) }) : shown },
      t("pasteGuard.multilineHint"),
    ],
    // With a warning, the focused (first) button is cancel.
    hits.length
      ? [
          { value: "cancel", label: t("pasteGuard.cancel"), kind: "ghost" },
          { value: "join", label: t("pasteGuard.pasteAsOneLine"), kind: "ghost" },
          { value: "paste", label: t("pasteGuard.pasteAnyway"), kind: "danger" },
        ]
      : [
          { value: "paste", label: t("pasteGuard.paste") },
          { value: "join", label: t("pasteGuard.pasteAsOneLine"), kind: "ghost" },
          { value: "cancel", label: t("pasteGuard.cancel"), kind: "ghost" },
        ],
  );
  if (choice === "paste") session.paste(paste.text);
  else if (choice === "join") session.paste(joinLines(paste.lines));
  session.focus();
}
