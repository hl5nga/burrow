export interface DialogButton<T extends string> {
  value: T;
  label: string;
  kind?: "primary" | "ghost";
}

/** A small modal with a few choices; resolves with the chosen value, or undefined on Escape. */
export function chooseDialog<T extends string>(
  title: string,
  body: string[],
  buttons: DialogButton<T>[],
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
    for (const text of body) {
      const p = document.createElement("p");
      p.textContent = text;
      box.append(p);
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
      button.className = b.kind === "ghost" ? "btn ghost" : "btn";
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
    document.body.append(overlay);
    row.querySelector<HTMLButtonElement>("button")?.focus();
  });
}
