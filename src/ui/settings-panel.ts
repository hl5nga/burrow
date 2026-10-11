import { getLocale, LOCALES, onLocaleChange, saveLocale, t } from "../i18n";
import { FLAG, LABEL } from "./language-chip";
import { current as theme, saveTheme, THEMES } from "./theme-settings";
import {
  current as text,
  DEFAULT_TEXT_SETTINGS,
  FONT_SIZES,
  fontSizePx,
  lineHeightFor,
  saveTextSettings,
} from "./text-settings";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, content?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

/**
 * Burrow → Settings…: language, color theme, and terminal text size and line
 * spacing in one place. It drives the same settings the corner chips do
 * (changes apply at once and are saved), so the two never disagree.
 */
export class SettingsPanel {
  private overlay?: HTMLElement;

  constructor(
    /** Applies a theme to the open terminals (the page's own colors change in saveTheme). */
    private readonly applyTheme: (themeId: string) => void,
    /** Applies text size (px) and line height (multiplier) to the open terminals. */
    private readonly applyText: (fontSize: number, lineHeight: number) => void,
  ) {
    // Lives for the app's lifetime (a top-level singleton, see main.ts).
    onLocaleChange(() => this.render());
  }

  open() {
    if (this.overlay) return;
    const previous = document.activeElement as HTMLElement | null;
    const overlay = el("div", "dialog-overlay");
    overlay.tabIndex = -1;
    const box = el("div", "dialog settings-dialog");
    box.setAttribute("role", "dialog");
    overlay.append(box);
    this.overlay = overlay;

    const close = () => {
      overlay.remove();
      this.overlay = undefined;
      // Let the key that closed the dialog come up before the terminal gets
      // focus back, so its tail can't land in the shell.
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        window.removeEventListener("keyup", restore, true);
        previous?.focus();
      };
      window.addEventListener("keyup", restore, true);
      window.setTimeout(restore, 300);
    };
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    box.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-close]")) close();
    });
    document.body.append(overlay);
    this.render();
    overlay.focus();
  }

  private section(title: string, ...body: HTMLElement[]): HTMLElement {
    const wrap = el("section", "settings-section");
    wrap.append(el("h4", undefined, title), ...body);
    return wrap;
  }

  private render() {
    const box = this.overlay?.querySelector<HTMLElement>(".settings-dialog");
    if (!box) return;
    const title = el("h3", undefined, t("settings.title"));
    box.replaceChildren(
      title,
      this.languageSection(),
      this.themeSection(),
      this.textSection(),
      this.footer(),
    );
  }

  private languageSection(): HTMLElement {
    const menu = el("div", "theme-menu settings-row");
    for (const id of LOCALES) {
      const opt = el("button", id === getLocale() ? "theme-option active" : "theme-option");
      opt.type = "button";
      opt.textContent = `${FLAG[id]} ${LABEL[id]}`;
      opt.addEventListener("click", () => void saveLocale(id));
      menu.append(opt);
    }
    return this.section(t("language.label"), menu);
  }

  private themeSection(): HTMLElement {
    const menu = el("div", "theme-menu settings-row");
    for (const def of THEMES) {
      const opt = el("button", def.id === theme.theme ? "theme-option active" : "theme-option");
      opt.type = "button";
      opt.append(
        el("span", `theme-swatch swatch-${def.id}`),
        el("span", "", t(`themeChip.themes.${def.id}`)),
      );
      opt.addEventListener("click", async () => {
        await saveTheme(def.id);
        this.applyTheme(def.id);
        this.render();
      });
      menu.append(opt);
    }
    return this.section(t("themeChip.title"), menu);
  }

  private async setText(next: Partial<{ fontLevel: number; lineLevel: number }>) {
    const settings = { fontLevel: text.fontLevel, lineLevel: text.lineLevel, ...next };
    await saveTextSettings(settings);
    this.applyText(fontSizePx(settings.fontLevel), lineHeightFor(settings.lineLevel));
    this.render();
  }

  private textSection(): HTMLElement {
    const fontRow = el("div", "text-row");
    fontRow.append(
      el("span", "text-row-label", t("textChip.fontSizeLabel")),
      el("span", "text-row-level", `${text.fontLevel}/${FONT_SIZES.length}`),
    );
    const stepper = el("div", "text-stepper");
    const dec = el("button", "text-step", "－");
    const preview = el("span", "text-preview", t("textChip.preview"));
    preview.style.fontSize = `${fontSizePx(text.fontLevel)}px`;
    const inc = el("button", "text-step", "＋");
    dec.type = inc.type = "button";
    dec.disabled = text.fontLevel <= 1;
    inc.disabled = text.fontLevel >= FONT_SIZES.length;
    dec.addEventListener("click", () => void this.setText({ fontLevel: text.fontLevel - 1 }));
    inc.addEventListener("click", () => void this.setText({ fontLevel: text.fontLevel + 1 }));
    stepper.append(dec, preview, inc);
    fontRow.append(stepper);

    const lineRow = el("div", "text-row");
    lineRow.append(el("span", "text-row-label", t("textChip.lineHeightLabel")));
    const toggle = el("div", "type-toggle");
    [t("textChip.lineNarrow"), t("textChip.lineNormal"), t("textChip.lineWide")].forEach(
      (label, i) => {
        const level = i + 1;
        const opt = el("button", level === text.lineLevel ? "opt active" : "opt", label);
        opt.type = "button";
        opt.addEventListener("click", () => void this.setText({ lineLevel: level }));
        toggle.append(opt);
      },
    );
    lineRow.append(toggle);

    const reset = el("button", "text-reset", t("textChip.reset"));
    reset.type = "button";
    reset.hidden =
      text.fontLevel === DEFAULT_TEXT_SETTINGS.fontLevel &&
      text.lineLevel === DEFAULT_TEXT_SETTINGS.lineLevel;
    reset.addEventListener("click", () => void this.setText({ ...DEFAULT_TEXT_SETTINGS }));
    return this.section(t("textChip.head"), fontRow, lineRow, reset);
  }

  private footer(): HTMLElement {
    const actions = el("div", "dialog-actions");
    const done = el("button", "btn", t("settings.close"));
    done.type = "button";
    done.dataset.close = "1";
    actions.append(done);
    return actions;
  }
}
