import { getVersion } from "@tauri-apps/api/app";
import appIcon from "../assets/icon.png";
import { t } from "../i18n";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let overlay: HTMLElement | undefined;

/**
 * Burrow's own themed About panel (menu bar → Burrow → About Burrow),
 * replacing the OS-styled default so it matches the rest of the app instead
 * of standing out as a native dialog.
 */
export async function showAbout() {
  if (overlay) return; // already open
  const box = el("div", "about");
  const icon = el("img", "about-icon");
  icon.src = appIcon;
  icon.alt = "";
  const heading = el("div", "about-heading");
  heading.append(el("div", "about-title", t("about.title")));
  let version = "";
  try {
    version = await getVersion();
  } catch {
    // Shown without a version rather than failing the whole panel.
  }
  if (version) heading.append(el("div", "about-version", `v${version}`));
  box.append(icon, heading);
  box.append(el("p", "about-tagline", t("about.tagline")));
  box.append(el("div", "about-stack", t("about.stack")));
  const close = el("button", "btn ghost", t("about.close"));
  close.type = "button";
  const actions = el("div", "about-actions");
  actions.append(close);
  box.append(actions);

  const root = el("div", "dialog-overlay about-overlay");
  root.append(box);
  root.tabIndex = -1;
  const previous = document.activeElement as HTMLElement | null;
  const finish = () => {
    root.remove();
    overlay = undefined;
    previous?.focus();
  };
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) finish();
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      finish();
    }
  });
  close.addEventListener("click", finish);
  overlay = root;
  document.body.append(root);
  root.focus();
}
