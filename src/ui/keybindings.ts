import { invoke } from "@tauri-apps/api/core";
import { displayCombo, eventToCombo, normalizeCombo } from "../terminal/keys";
import { showToast } from "./toast";
import { t, onLocaleChange } from "../i18n";

export interface Binding {
  action: string;
  /** "" when the user unbound it. */
  keys: string;
  disableInAltScreen: boolean;
}

export interface Action {
  id: string;
  label: string;
  /** Return false to let the key through (e.g. copy outside the terminal). */
  run(e: KeyboardEvent): boolean | void;
}

interface Context {
  /** A full-screen app (vim, htop, less) is showing in the active tab. */
  altScreen(): boolean;
  /** The event happened inside the terminal, not a panel's text field. */
  inTerminal(e: KeyboardEvent): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * All app shortcuts: a registry of actions, the bindings from keybindings.json,
 * and one capture-phase keydown listener that runs before xterm sees the key.
 * Changes apply at once; nothing needs a restart.
 */
export class Keybindings {
  private readonly actions = new Map<string, Action>();
  private bindings: Binding[] = [];
  private defaults: Binding[] = [];
  /** Canonical combo → binding, rebuilt whenever bindings change. */
  private byCombo = new Map<string, Binding>();
  private readonly overlay = el("div", "manager-overlay");
  private readonly list = el("div", "keys-list");
  private readonly titleText = el("h3");
  private readonly resetButton = el("button", "btn ghost");
  private readonly altScreenNote = el("div", "field-hint");
  private recording?: { action: string; combo?: string; conflict?: Binding };
  private onClose: () => void = () => {};

  constructor(private readonly context: Context) {
    window.addEventListener("keydown", (e) => this.onKey(e), true);
    const box = el("div", "manager keys-panel");
    const head = el("div", "mgmt-list-head");
    head.append(this.titleText);
    this.resetButton.type = "button";
    this.resetButton.addEventListener("click", () => void this.resetAll());
    head.append(this.resetButton);
    box.append(head, this.altScreenNote, this.list, this.extras());
    this.overlay.append(box);
    this.overlay.hidden = true;
    document.body.append(this.overlay);
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close();
    });

    // Lives for the app's lifetime (a top-level singleton, see main.ts), so
    // this subscription is never unsubscribed — same as command-manager.ts.
    onLocaleChange(() => this.retranslate());
    this.retranslate();
  }

  private retranslate() {
    this.titleText.textContent = t("keybindings.panel.title");
    this.resetButton.textContent = t("keybindings.panel.resetAll");
    this.altScreenNote.textContent = t("keybindings.panel.altScreenNote");
    this.render();
    this.renderExtras();
  }

  register(action: Action) {
    this.actions.set(action.id, action);
  }

  async load() {
    try {
      this.defaults = await invoke<Binding[]>("keybinding_defaults");
      const file = await invoke<{ bindings: Binding[] }>("store_get", { kind: "keybindings" });
      // Files from older builds lack newer actions: those get their default.
      const known = new Set(file.bindings.map((b) => b.action));
      this.bindings = [...file.bindings, ...this.defaults.filter((d) => !known.has(d.action))];
    } catch (err) {
      showToast(t("keybindings.panel.loadFailed", { error: String(err) }));
      this.bindings = [...this.defaults];
    }
    this.index();
  }

  private index() {
    this.byCombo = new Map();
    for (const b of this.bindings) {
      const combo = b.keys && normalizeCombo(b.keys);
      if (combo && this.actions.has(b.action)) this.byCombo.set(combo, b);
    }
  }

  private onKey(e: KeyboardEvent) {
    if (this.recording) return this.record(e);
    if (this.isOpen && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return this.close();
    }
    if (e.isComposing) return;
    // Plain typing never reaches the lookup.
    if (!e.metaKey && !e.ctrlKey && !e.altKey && !/^F\d+$/.test(e.code)) return;
    const combo = eventToCombo(e);
    const binding = combo && this.byCombo.get(combo);
    if (!binding) return;
    if (binding.disableInAltScreen && this.context.altScreen() && this.context.inTerminal(e))
      return;
    const handled = this.actions.get(binding.action)?.run(e);
    if (handled === false) return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** The combo currently bound to an action, for menus and hints. */
  label(action: string): string {
    const b = this.bindings.find((x) => x.action === action);
    return b?.keys ? displayCombo(b.keys) : "";
  }

  // ---------- settings panel ----------

  get isOpen() {
    return !this.overlay.hidden;
  }

  open(onClose?: () => void) {
    this.onClose = onClose ?? (() => {});
    this.overlay.hidden = false;
    this.render();
    this.renderExtras();
  }

  close() {
    this.recording = undefined;
    this.overlay.hidden = true;
    this.onClose();
  }

  private record(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.recording = undefined;
      return this.render();
    }
    const combo = eventToCombo(e);
    if (!combo || !this.recording) return; // a modifier alone: keep waiting
    if (!e.metaKey && !e.ctrlKey && !e.altKey && !/^F\d+$/.test(e.code)) {
      showToast(t("keybindings.panel.needModifier"));
      return;
    }
    const conflict = this.bindings.find(
      (b) => b.action !== this.recording!.action && b.keys && normalizeCombo(b.keys) === combo,
    );
    this.recording = { action: this.recording.action, combo, conflict };
    if (!conflict) void this.assign(this.recording.action, combo);
    else this.render();
  }

  private async assign(action: string, combo: string, takeFrom?: Binding) {
    if (takeFrom) takeFrom.keys = "";
    const b = this.bindings.find((x) => x.action === action);
    if (b) b.keys = combo;
    else this.bindings.push({ action, keys: combo, disableInAltScreen: false });
    this.recording = undefined;
    await this.save();
  }

  private async save() {
    this.index();
    this.render();
    try {
      await invoke("store_put", {
        kind: "keybindings",
        value: { version: 1, bindings: this.bindings },
      });
    } catch (err) {
      showToast(t("keybindings.panel.saveFailed", { error: String(err) }));
    }
  }

  private async resetAll() {
    this.bindings = this.defaults.map((d) => ({ ...d }));
    await this.save();
  }

  private render() {
    const rows = [...this.actions.values()].map((action) => {
      const b = this.bindings.find((x) => x.action === action.id);
      const row = el("div", "keys-row");
      row.append(el("span", "keys-name", action.label));
      const rec = this.recording?.action === action.id ? this.recording : undefined;
      const chip = el(
        "button",
        rec ? "keys-chip recording" : "keys-chip",
        rec
          ? rec.combo
            ? displayCombo(rec.combo)
            : t("keybindings.panel.pressKey")
          : b?.keys
            ? displayCombo(b.keys)
            : t("keybindings.panel.none"),
      );
      chip.type = "button";
      chip.title = t("keybindings.panel.chipTitle");
      chip.addEventListener("click", () => {
        this.recording = { action: action.id };
        this.render();
      });
      const alt = el("label", "keys-alt");
      const box = el("input");
      box.type = "checkbox";
      box.checked = !!b?.disableInAltScreen;
      box.addEventListener("change", () => {
        const target = this.bindings.find((x) => x.action === action.id);
        if (target) target.disableInAltScreen = box.checked;
        else this.bindings.push({ action: action.id, keys: "", disableInAltScreen: box.checked });
        void this.save();
      });
      alt.append(box, document.createTextNode(t("keybindings.panel.disableInAltScreen")));
      const reset = el("button", "keys-reset", t("keybindings.panel.resetOne"));
      reset.type = "button";
      const def = this.defaults.find((d) => d.action === action.id);
      reset.disabled = !def || (b?.keys ?? "") === def.keys;
      reset.addEventListener("click", () => {
        if (def) void this.assign(action.id, def.keys);
      });
      row.append(chip, alt, reset);
      if (rec?.conflict) {
        const warn = el("div", "keys-conflict");
        const other = this.actions.get(rec.conflict.action)?.label ?? rec.conflict.action;
        warn.append(document.createTextNode(t("keybindings.panel.conflict", { other })));
        const take = el("button", "btn danger", t("keybindings.panel.takeOver"));
        take.type = "button";
        take.addEventListener("click", () => void this.assign(action.id, rec.combo!, rec.conflict));
        warn.append(take);
        row.append(warn);
      }
      return row;
    });
    this.list.replaceChildren(...rows);
  }

  // ---------- other preferences living here ----------

  private extraToggles: { label: string; get(): boolean; set(v: boolean): void }[] = [];
  private readonly extrasBox = el("div", "keys-extras");

  addToggle(label: string, get: () => boolean, set: (v: boolean) => void) {
    this.extraToggles.push({ label, get, set });
    this.renderExtras();
  }

  private extras() {
    return this.extrasBox;
  }

  private renderExtras() {
    this.extrasBox.replaceChildren(
      el("div", "gc-title", t("keybindings.panel.other")),
      ...this.extraToggles.map((toggle) => {
        const label = el("label", "check");
        const box = el("input");
        box.type = "checkbox";
        box.checked = toggle.get();
        box.addEventListener("change", () => toggle.set(box.checked));
        label.append(box, document.createTextNode(` ${toggle.label}`));
        return label;
      }),
    );
  }
}
