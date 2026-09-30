import { current, saveTheme, THEMES } from "./theme-settings";
import { t, onLocaleChange } from "../i18n";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * "Theme" chip for the app's color profile (dark/light/sky/paper/mono).
 * Applies to the app's own chrome (CSS variables, src/styles.css) and to
 * every open terminal's ANSI palette (src/terminal/themes.ts) immediately,
 * and persists to config.json so it's remembered per Mac.
 */
export class ThemeChip {
  private readonly chip = el("button", "rm-chip theme", "Theme");
  private readonly card = el("div", "res-hud theme-card");

  constructor(
    corner: HTMLElement,
    private readonly onChange: (themeId: string) => void,
  ) {
    this.chip.type = "button";
    this.card.hidden = true;
    corner.append(this.chip, this.card);
    this.chip.addEventListener("click", (e) => {
      e.stopPropagation();
      this.card.hidden = !this.card.hidden;
      if (!this.card.hidden) this.render();
    });
    document.addEventListener("mousedown", (e) => {
      if (!this.card.hidden && !this.card.contains(e.target as Node) && e.target !== this.chip) {
        this.card.hidden = true;
      }
    });

    // Lives for the app's lifetime (a top-level singleton, see main.ts), so
    // this subscription is never unsubscribed — same as vpn-chip.ts.
    onLocaleChange(() => this.retranslate());
    this.retranslate();
  }

  private retranslate() {
    this.chip.title = t("themeChip.title");
    if (!this.card.hidden) this.render();
  }

  private async set(themeId: string) {
    await saveTheme(themeId);
    this.onChange(themeId);
    this.render();
  }

  private render() {
    const head = el("div", "rh-head", t("themeChip.title"));
    const menu = el("div", "theme-menu");
    for (const theme of THEMES) {
      const opt = el("button", theme.id === current.theme ? "theme-option active" : "theme-option");
      opt.type = "button";
      opt.append(
        el("span", `theme-swatch swatch-${theme.id}`),
        el("span", "", t(`themeChip.themes.${theme.id}`)),
      );
      opt.addEventListener("click", () => void this.set(theme.id));
      menu.append(opt);
    }
    this.card.replaceChildren(head, menu);
  }
}
