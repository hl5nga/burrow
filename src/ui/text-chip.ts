import {
  current,
  fontSizePx,
  lineHeightFor,
  saveTextSettings,
  DEFAULT_TEXT_SETTINGS,
  FONT_SIZES,
} from "./text-settings";

const LINE_LABELS = ["좁게", "보통", "넓게"];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * "Aa" chip for terminal text size and line spacing (⌘, and the keybindings
 * panel are for app shortcuts/behavior; this is purely how the terminal looks,
 * so it lives with the other display chips). Applies immediately to every
 * open tab and persists to config.json, so it's remembered per Mac.
 */
export class TextSizeChip {
  private readonly chip = el("button", "rm-chip text-size", "Aa");
  private readonly card = el("div", "res-hud text-card");

  constructor(
    corner: HTMLElement,
    private readonly onChange: (fontSize: number, lineHeight: number) => void,
  ) {
    this.chip.type = "button";
    this.chip.title = "글자 크기 · 줄 간격";
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
  }

  private async set(next: Partial<{ fontLevel: number; lineLevel: number }>) {
    const settings = { fontLevel: current.fontLevel, lineLevel: current.lineLevel, ...next };
    await saveTextSettings(settings);
    this.onChange(fontSizePx(settings.fontLevel), lineHeightFor(settings.lineLevel));
    this.render();
  }

  private render() {
    const head = el("div", "rh-head", "글자·줄 간격");

    const fontRow = el("div", "text-row");
    fontRow.append(
      el("span", "text-row-label", "글자 크기"),
      el("span", "text-row-level", `${current.fontLevel}/${FONT_SIZES.length}`),
    );
    const fontControls = el("div", "text-stepper");
    const dec = el("button", "text-step", "－");
    const preview = el("span", "text-preview", "Aa 가나 123");
    preview.style.fontSize = `${fontSizePx(current.fontLevel)}px`;
    const inc = el("button", "text-step", "＋");
    dec.type = inc.type = "button";
    dec.disabled = current.fontLevel <= 1;
    inc.disabled = current.fontLevel >= FONT_SIZES.length;
    dec.addEventListener("click", () => void this.set({ fontLevel: current.fontLevel - 1 }));
    inc.addEventListener("click", () => void this.set({ fontLevel: current.fontLevel + 1 }));
    fontControls.append(dec, preview, inc);
    fontRow.append(fontControls);

    const lineRow = el("div", "text-row");
    lineRow.append(el("span", "text-row-label", "줄 간격"));
    const lineToggle = el("div", "type-toggle");
    LINE_LABELS.forEach((label, i) => {
      const level = i + 1;
      const opt = el("button", level === current.lineLevel ? "opt active" : "opt", label);
      opt.type = "button";
      opt.addEventListener("click", () => void this.set({ lineLevel: level }));
      lineToggle.append(opt);
    });
    lineRow.append(lineToggle);

    const reset = el("button", "text-reset", "기본값으로");
    reset.type = "button";
    reset.hidden =
      current.fontLevel === DEFAULT_TEXT_SETTINGS.fontLevel &&
      current.lineLevel === DEFAULT_TEXT_SETTINGS.lineLevel;
    reset.addEventListener("click", () => void this.set({ ...DEFAULT_TEXT_SETTINGS }));

    this.card.replaceChildren(head, fontRow, lineRow, reset);
  }
}
