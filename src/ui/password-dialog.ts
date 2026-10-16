import { t } from "../i18n";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface PasswordAnswer {
  password: string;
  /** Keep it in the macOS Keychain for next time. */
  save: boolean;
}

/**
 * Asks for an SSH login password (masked) with a "remember" checkbox.
 * Resolves with the answer, or undefined if the user cancels — then they can
 * type it into the terminal themselves.
 */
export function askSshPassword(label: string): Promise<PasswordAnswer | undefined> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const overlay = el("div", "dialog-overlay");
    const box = el("div", "dialog");
    box.setAttribute("role", "dialog");
    box.append(
      el("h3", undefined, t("sshPassword.title")),
      el("p", undefined, t("sshPassword.body", { label })),
    );
    const input = el("input", "input");
    input.type = "password";
    input.autocomplete = "off";
    input.setAttribute("aria-label", t("sshPassword.field"));
    input.placeholder = t("sshPassword.field");
    const save = el("input");
    save.type = "checkbox";
    const remember = el("label", "assign-submit");
    remember.append(save, document.createTextNode(t("sshPassword.save")));
    const actions = el("div", "dialog-actions");
    const cancel = el("button", "btn ghost", t("sshPassword.cancel"));
    const ok = el("button", "btn", t("sshPassword.ok"));
    cancel.type = ok.type = "button";
    actions.append(cancel, ok);
    box.append(input, remember, actions);
    overlay.append(box);

    const finish = (answer: PasswordAnswer | undefined) => {
      overlay.remove();
      // Let the key that closed the dialog come up before the terminal gets
      // focus back (same as the other dialogs).
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        window.removeEventListener("keyup", restore, true);
        previous?.focus();
      };
      window.addEventListener("keyup", restore, true);
      window.setTimeout(restore, 300);
      resolve(answer);
    };
    const submit = () => {
      if (!input.value) return input.focus();
      finish({ password: input.value, save: save.checked });
    };
    ok.addEventListener("click", submit);
    cancel.addEventListener("click", () => finish(undefined));
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(undefined);
      } else if (e.key === "Enter" && !e.isComposing && e.target === input) {
        e.preventDefault();
        submit();
      }
    });
    document.body.append(overlay);
    input.focus();
  });
}
