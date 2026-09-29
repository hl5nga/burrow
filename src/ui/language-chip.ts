import { getLocale, LOCALES, onLocaleChange, saveLocale, t, type Locale } from "../i18n";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const LABEL: Record<Locale, string> = { ko: "한국어", en: "English" };

/**
 * "🌐 KO"/"🌐 EN" chip — the forced language override the user asked for,
 * separate from the automatic OS-locale detection (src/i18n/index.ts's
 * detectLocale(), used only the very first run). Reusable: one instance
 * lives on the Launcher (the first screen), another in the main window's
 * corner chip row, so the choice is reachable from either place.
 */
export class LanguageChip {
  private readonly chip = el("button", "rm-chip language");
  private readonly card = el("div", "res-hud language-card");

  constructor(corner: HTMLElement) {
    this.chip.type = "button";
    this.chip.title = t("language.label");
    this.card.hidden = true;
    corner.append(this.chip, this.card);
    this.renderChip();
    this.chip.addEventListener("click", (e) => {
      e.stopPropagation();
      this.card.hidden = !this.card.hidden;
      if (!this.card.hidden) this.renderCard();
    });
    document.addEventListener("mousedown", (e) => {
      if (!this.card.hidden && !this.card.contains(e.target as Node) && e.target !== this.chip) {
        this.card.hidden = true;
      }
    });
    // Another instance of this chip (or startup detection resolving after
    // this one was already constructed) can change the locale; stay in sync.
    onLocaleChange(() => {
      this.chip.title = t("language.label");
      this.renderChip();
      if (!this.card.hidden) this.renderCard();
    });
  }

  private renderChip() {
    this.chip.textContent = `🌐 ${getLocale().toUpperCase()}`;
  }

  private async set(next: Locale) {
    await saveLocale(next);
    this.renderChip();
    this.renderCard();
  }

  private renderCard() {
    const head = el("div", "rh-head", t("language.label"));
    const menu = el("div", "theme-menu");
    for (const id of LOCALES) {
      const opt = el(
        "button",
        id === getLocale() ? "theme-option active" : "theme-option",
        LABEL[id],
      );
      opt.type = "button";
      opt.addEventListener("click", () => void this.set(id));
      menu.append(opt);
    }
    this.card.replaceChildren(head, menu);
  }
}
