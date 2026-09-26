export interface DialogButton<T extends string> {
  value: T;
  label: string;
  kind?: "primary" | "ghost" | "danger";
}

/** A small modal with a few choices; resolves with the chosen value, or undefined on Escape. */
export function chooseDialog<T extends string>(
  title: string,
  /** Paragraphs; `{ code }` renders as a monospace preview block. */
  body: (string | { code: string })[],
  buttons: DialogButton<T>[],
  /** Closes the dialog from outside (resolving undefined), e.g. when it became moot. */
  signal?: AbortSignal,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    const box = document.createElement("div");
    box.className = "dialog";
    box.setAttribute("role", "dialog");
    const heading = document.createElement("h3");
    heading.textContent = title;
    box.append(heading);
    for (const item of body) {
      const node = document.createElement(typeof item === "string" ? "p" : "pre");
      node.textContent = typeof item === "string" ? item : item.code;
      box.append(node);
    }
    const row = document.createElement("div");
    row.className = "dialog-actions";
    const finish = (value: T | undefined) => {
      overlay.remove();
      previous?.focus();
      resolve(value);
    };
    for (const b of buttons) {
      const button = document.createElement("button");
      button.className = b.kind && b.kind !== "primary" ? `btn ${b.kind}` : "btn";
      button.textContent = b.label;
      button.addEventListener("click", () => finish(b.value));
      row.append(button);
    }
    box.append(row);
    overlay.append(box);
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(undefined);
      }
    });
    signal?.addEventListener("abort", () => overlay.isConnected && finish(undefined));
    document.body.append(overlay);
    row.querySelector<HTMLButtonElement>("button")?.focus();
  });
}
