import { invoke } from "@tauri-apps/api/core";
import { t, onLocaleChange } from "../i18n";
import type { TerminalSession } from "../terminal/session";
import type { AssignTarget } from "./agents";
import { chooseDialog } from "./dialog";
import {
  SLOT_COUNT,
  clearSlot,
  emptyDrafts,
  isBlank,
  normalizeDrafts,
  pickSlot,
  preview,
  pushRecent,
  resolveTarget,
  saveToSlot,
  stats,
  targetKey,
  type DraftsFile,
} from "./draft-logic";
import { guardPaste } from "./paste-guard";
import { shellQuote } from "./shell-quote";
import { showToast } from "./toast";

const MODE_KEY = "burrow.draft.modal";
const POS_KEY = "burrow.draft.pos";
const SAVE_DELAY_MS = 300;

interface Deps {
  activeSession(): TerminalSession | undefined;
  /** The active tab: its host's profile (undefined for a local tab) and a name for it. */
  activeTab(): { profileId?: string; label: string } | undefined;
  targetsFor(profileId: string): Promise<AssignTarget[]>;
  preparePaths(paths: string[]): Promise<string[]>;
  clipboardImagePath(): Promise<string | undefined>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function remember<T>(key: string, read: (raw: string) => T | undefined, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (read(raw) ?? fallback);
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Remembering the window's mode and place is a convenience only.
  }
}

/**
 * The Draft editor: a roomy place to write a prompt, with five saved slots in
 * the status bar. Closing it never loses the text (it is saved as you type),
 * and clicking outside it does nothing. It can float beside the terminal
 * (default) or sit in front of a dimmed screen (modal).
 */
export class DraftEditor {
  /** The `+ 1 2 3 4 5` chips for the status bar. */
  readonly chips = el("div", "seg drafts");
  private readonly plus = el("button", "draft-chip plus", "+");
  private readonly hotkey = el("span", "draft-hotkey");
  private hotkeyLabel = "";
  private readonly slotChips: HTMLButtonElement[] = [];

  private readonly backdrop = el("div", "draft-backdrop");
  private readonly win = el("div", "draft-win");
  private readonly head = el("div", "draft-head");
  private readonly titleText = el("span", "draft-title");
  private readonly where = el("span", "draft-where");
  private readonly modeButton = el("button", "draft-head-btn");
  private readonly recentButton = el("button", "draft-head-btn");
  private readonly closeButton = el("button", "draft-close", "×");
  private readonly recentMenu = el("div", "draft-recent");
  private readonly targetLabel = el("label", "draft-label");
  private readonly targetSelect = el("select", "draft-select");
  private readonly refreshButton = el("button", "draft-head-btn", "⟳");
  private readonly area = el("textarea", "draft-text");
  private readonly stats = el("span", "draft-stats");
  private readonly message = el("div", "draft-message");
  private readonly slotLabel = el("label", "draft-label");
  private readonly slotSelect = el("select", "draft-select slot");
  private readonly clearButton = el("button", "btn ghost");
  private readonly saveButton = el("button", "btn ghost");
  private readonly sendButton = el("button", "btn");

  private data: DraftsFile = emptyDrafts();
  private shown = false;
  private modal = remember(MODE_KEY, (raw) => raw === "1", false);
  private saveTimer = 0;
  private writing: Promise<unknown> = Promise.resolve();
  private busy = false;

  constructor(private readonly deps: Deps) {
    this.plus.type = "button";
    this.plus.addEventListener("click", () => this.toggle());
    this.plus.append(this.hotkey);
    this.chips.append(this.plus);
    for (let i = 0; i < SLOT_COUNT; i++) {
      const chip = el("button", "draft-chip", String(i + 1));
      chip.type = "button";
      chip.addEventListener("click", (e) => {
        if (e.altKey && this.data.slots[i]) void this.sendSlot(i);
        else this.show(i);
      });
      this.slotChips.push(chip);
      this.chips.append(chip);
    }

    this.modeButton.type = "button";
    this.modeButton.addEventListener("click", () => this.setModal(!this.modal));
    this.recentButton.type = "button";
    this.recentButton.addEventListener("click", () => this.toggleRecent());
    this.refreshButton.type = "button";
    this.refreshButton.addEventListener("click", () => void this.refreshTargets());
    this.closeButton.type = "button";
    this.closeButton.addEventListener("click", () => this.hide());
    this.head.append(
      this.titleText,
      this.where,
      this.modeButton,
      this.recentButton,
      this.closeButton,
    );

    const targetRow = el("div", "draft-row");
    this.targetLabel.htmlFor = "draft-target";
    this.targetSelect.id = "draft-target";
    this.targetSelect.addEventListener("change", () => {
      this.data.current.target = this.targetSelect.value || null;
      this.scheduleSave();
    });
    targetRow.append(this.targetLabel, this.targetSelect, this.refreshButton);

    this.area.rows = 5;
    this.area.spellcheck = false;
    this.area.addEventListener("input", () => {
      this.updateStats();
      this.scheduleSave();
    });
    this.area.addEventListener("keydown", (e) => this.onAreaKey(e));
    this.area.addEventListener("paste", (e) => this.onPaste(e));

    const foot = el("div", "draft-foot");
    this.slotLabel.htmlFor = "draft-slot";
    this.slotSelect.id = "draft-slot";
    this.slotSelect.addEventListener("change", () => {
      const value = this.slotSelect.value;
      this.data.current.slot = value === "" ? null : Number(value);
      this.updateSlotControls();
      this.scheduleSave();
    });
    this.clearButton.type = "button";
    this.clearButton.addEventListener("click", () => this.clearSelectedSlot());
    this.saveButton.type = "button";
    this.saveButton.addEventListener("click", () => void this.saveSlot());
    this.sendButton.type = "button";
    this.sendButton.addEventListener("click", () => void this.send());
    const slotBox = el("div", "draft-slotbox");
    slotBox.append(this.slotLabel, this.slotSelect, this.clearButton);
    const actions = el("div", "draft-actions");
    actions.append(this.saveButton, this.sendButton);
    foot.append(slotBox, this.stats, actions);

    this.win.append(this.head, this.recentMenu, targetRow, this.area, this.message, foot);
    this.win.tabIndex = -1;
    this.win.setAttribute("role", "dialog");
    this.win.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
      }
    });
    this.makeDraggable();
    this.backdrop.hidden = true;
    this.win.hidden = true;
    this.recentMenu.hidden = true;
    document.body.append(this.backdrop, this.win);

    // The text is saved as it is typed; these cover the moments a timer would miss.
    window.addEventListener("pagehide", () => this.flush());
    window.addEventListener("blur", () => this.flush());
    document.addEventListener("visibilitychange", () => document.hidden && this.flush());

    onLocaleChange(() => this.retranslate());
    this.retranslate();
    this.renderChips();
  }

  /** The shortcut that opens the editor, shown beside the `+` chip ("" when unbound). */
  setHotkey(label: string) {
    this.hotkeyLabel = label;
    this.hotkey.textContent = label;
    this.hotkey.hidden = !label;
    this.plus.title = label ? `${t("draft.plusTitle")} (${label})` : t("draft.plusTitle");
  }

  get isOpen() {
    return this.shown;
  }

  async init() {
    try {
      this.data = normalizeDrafts(await invoke<DraftsFile>("store_get", { kind: "drafts" }));
    } catch {
      this.data = emptyDrafts();
    }
    this.renderChips();
  }

  // ---------- open / close ----------

  /** The shortcut and the `+` chip: open it, or put it away when it has focus. */
  toggle() {
    if (this.shown && this.win.contains(document.activeElement)) this.hide();
    else this.show();
  }

  /** Opens the editor. With a slot number: that slot's draft (or, if it is empty, the place to save to). */
  show(slot?: number) {
    if (slot !== undefined) this.loadSlot(slot);
    this.shown = true;
    this.win.hidden = false;
    this.backdrop.hidden = !this.modal;
    this.area.value = this.data.current.text;
    this.updateStats();
    this.updateSlotControls();
    this.message.textContent = "";
    this.recentMenu.hidden = true;
    this.applyMode();
    this.place();
    this.renderChips();
    void this.refreshTargets();
    this.area.focus();
    const at = Math.min(this.data.current.cursor, this.area.value.length);
    this.area.setSelectionRange(at, at);
  }

  hide() {
    if (!this.shown) return;
    this.flush();
    this.shown = false;
    this.win.hidden = true;
    this.backdrop.hidden = true;
    this.recentMenu.hidden = true;
    this.setDropHover(false);
    this.renderChips();
    this.deps.activeSession()?.focus();
  }

  /** The active tab changed: its host decides which windows can be targeted. */
  activeChanged() {
    if (this.shown) void this.refreshTargets();
  }

  private loadSlot(index: number) {
    const slot = this.data.slots[index];
    const current = this.data.current;
    if (!slot) {
      // An empty slot: the draft in progress is what goes there.
      current.slot = index;
      return;
    }
    // What was being written stays reachable.
    if (!isBlank(current.text) && current.text !== slot.text) {
      this.data.recent = pushRecent(this.data.recent, current.text, current.target, Date.now());
    }
    this.data.current = {
      text: slot.text,
      cursor: slot.text.length,
      target: slot.target,
      slot: index,
    };
    this.persist();
  }

  // ---------- saving what is typed ----------

  private scheduleSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  /** Writes the draft in progress now. */
  private flush() {
    window.clearTimeout(this.saveTimer);
    if (this.shown) {
      this.data.current.text = this.area.value;
      this.data.current.cursor = this.area.selectionStart ?? this.area.value.length;
    }
    this.persist();
  }

  private persist() {
    const value = this.data;
    // One write at a time, in order, so an older save never lands after a newer one.
    this.writing = this.writing
      .then(() => invoke("store_put", { kind: "drafts", value }))
      .catch(() => {});
  }

  // ---------- targets ----------

  private async refreshTargets() {
    const tab = this.deps.activeTab();
    this.where.textContent = tab ? tab.label : "";
    let windows: AssignTarget[] = [];
    if (tab?.profileId) {
      try {
        windows = await this.deps.targetsFor(tab.profileId);
      } catch {
        windows = [];
      }
    }
    const wanted = this.data.current.target;
    this.targetSelect.replaceChildren();
    const own = el("option", undefined, t("draft.targetPrompt"));
    own.value = "";
    this.targetSelect.append(own);
    for (const w of windows) {
      const option = el("option", undefined, this.targetLabelFor(w));
      option.value = targetKey(w);
      this.targetSelect.append(option);
    }
    const found = resolveTarget(wanted, windows);
    this.targetSelect.value = found ? targetKey(found) : "";
    this.targetSelect.title = found || !wanted ? "" : t("draft.targetGone", { target: wanted });
  }

  private targetLabelFor(w: AssignTarget): string {
    const state = w.state === "none" ? t("draft.stateShell") : t(`agents.state.${w.state}`);
    return `${w.windowName} · ${w.session} — ${state}`;
  }

  // ---------- sending ----------

  private async send() {
    await this.deliver(this.area.value, this.targetSelect.value || null, true);
  }

  /** ⌥-click on a slot chip: send that slot as it is, to the window it names. */
  private async sendSlot(index: number) {
    const slot = this.data.slots[index];
    if (!slot) return;
    await this.deliver(slot.text, slot.target, false);
  }

  /** Puts `text` at the target's prompt (no Enter). `fromEditor`: clear and close the editor after. */
  private async deliver(text: string, target: string | null, fromEditor: boolean) {
    if (this.busy) return;
    if (isBlank(text)) return this.say(t("draft.empty"));
    this.busy = true;
    this.say("");
    try {
      let sentTo: string;
      if (!target) {
        const session = this.deps.activeSession();
        if (!session) return this.say(t("draft.noSession"));
        await guardPaste(session, text);
        sentTo = this.deps.activeTab()?.label ?? "";
      } else {
        const profileId = this.deps.activeTab()?.profileId;
        if (!profileId) return this.say(t("draft.noTmux"));
        // Read the windows again: what the list showed may be stale.
        const fresh = resolveTarget(target, await this.deps.targetsFor(profileId));
        if (!fresh) return this.say(t("draft.targetGone", { target }));
        if (fresh.state === "waiting") return this.say(t("draft.targetWaiting"));
        if (fresh.state === "none" && text.includes("\n")) {
          const ok = await chooseDialog(
            t("draft.shellTitle"),
            [t("draft.shellBody", { target: fresh.windowName })],
            [
              { value: "no", label: t("draft.cancel"), kind: "ghost" },
              { value: "yes", label: t("draft.sendAnyway"), kind: "primary" },
            ],
          );
          if (ok !== "yes") return;
        }
        await invoke("tmux_send_prompt", {
          profileId,
          paneId: fresh.paneId,
          text: text.trim(),
          submit: false,
        });
        sentTo = fresh.windowName;
      }
      if (fromEditor) this.finishSend(text, target);
      showToast(t("draft.sent", { to: sentTo }));
    } catch (err) {
      this.say(t("draft.sendFailed", { error: String(err) }));
    } finally {
      this.busy = false;
    }
  }

  /** Sent: the text moves to "recent" (so it can come back) and the editor empties. */
  private finishSend(text: string, target: string | null) {
    this.data.recent = pushRecent(this.data.recent, text, target, Date.now());
    this.data.current = { text: "", cursor: 0, target: this.data.current.target, slot: null };
    this.area.value = "";
    this.persist();
    this.hide();
  }

  // ---------- slots ----------

  private async saveSlot() {
    const text = this.area.value;
    if (isBlank(text)) return this.say(t("draft.empty"));
    this.flush();
    const wanted = this.slotSelect.value === "" ? null : Number(this.slotSelect.value);
    const { index, replaces } = pickSlot(this.data.slots, wanted);
    // Updating the slot this draft came from needs no question; replacing another does.
    if (replaces && replaces.text !== text && index !== this.data.current.slot) {
      const choice = await chooseDialog(
        t("draft.overwriteTitle", { n: String(index + 1) }),
        [t("draft.overwriteBody"), { code: preview(replaces.text) }],
        [
          { value: "no", label: t("draft.cancel"), kind: "ghost" },
          { value: "yes", label: t("draft.overwrite"), kind: "danger" },
        ],
      );
      if (choice !== "yes") return;
    }
    const target = this.targetSelect.value || null;
    this.data = saveToSlot(this.data, index, text, target, Date.now());
    this.data.current.slot = index;
    this.data.current.target = target;
    this.updateSlotControls();
    this.renderChips();
    this.persist();
    this.say(t("draft.savedTo", { n: String(index + 1) }));
  }

  private clearSelectedSlot() {
    const index = this.data.current.slot;
    if (index === null || !this.data.slots[index]) return;
    this.data = clearSlot(this.data, index, Date.now());
    this.data.current.slot = null;
    this.updateSlotControls();
    this.renderChips();
    this.persist();
    this.say(t("draft.cleared", { n: String(index + 1) }));
  }

  private updateSlotControls() {
    this.slotSelect.replaceChildren();
    const auto = el("option", undefined, t("draft.slotAuto"));
    auto.value = "";
    this.slotSelect.append(auto);
    for (let i = 0; i < SLOT_COUNT; i++) {
      const o = el("option", undefined, `${i + 1}${this.data.slots[i] ? " •" : ""}`);
      o.value = String(i);
      this.slotSelect.append(o);
    }
    const slot = this.data.current.slot;
    this.slotSelect.value = slot === null ? "" : String(slot);
    this.clearButton.disabled = slot === null || !this.data.slots[slot];
  }

  private renderChips() {
    this.plus.classList.toggle("open", this.shown);
    this.slotChips.forEach((chip, i) => {
      const slot = this.data.slots[i];
      chip.classList.toggle("filled", !!slot);
      chip.classList.toggle("active", this.shown && this.data.current.slot === i);
      chip.title = slot
        ? t("draft.chipFilled", { n: String(i + 1), text: preview(slot.text) })
        : t("draft.chipEmpty", { n: String(i + 1) });
    });
  }

  // ---------- recent ----------

  private toggleRecent() {
    if (!this.recentMenu.hidden) {
      this.recentMenu.hidden = true;
      return;
    }
    this.recentMenu.replaceChildren();
    if (this.data.recent.length === 0) {
      this.recentMenu.append(el("div", "draft-recent-empty", t("draft.recentEmpty")));
    }
    for (const item of this.data.recent) {
      const row = el("button", "draft-recent-row");
      row.type = "button";
      row.append(
        el("span", "draft-recent-text", preview(item.text)),
        el(
          "span",
          "draft-recent-time",
          new Date(item.at).toLocaleString(undefined, {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
        ),
      );
      row.addEventListener("click", () => this.loadRecent(item.text, item.target));
      this.recentMenu.append(row);
    }
    this.recentMenu.hidden = false;
  }

  private loadRecent(text: string, target: string | null) {
    this.recentMenu.hidden = true;
    const now = this.area.value;
    if (!isBlank(now) && now !== text) {
      this.data.recent = pushRecent(this.data.recent, now, this.data.current.target, Date.now());
    }
    this.data.current = { text, cursor: text.length, target, slot: null };
    this.area.value = text;
    this.updateStats();
    this.updateSlotControls();
    this.renderChips();
    void this.refreshTargets();
    this.persist();
    this.area.focus();
  }

  // ---------- editing ----------

  private onAreaKey(e: KeyboardEvent) {
    // Enter that confirms a Korean/Japanese composition is not a command.
    if (e.isComposing || e.keyCode === 229) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "Enter") {
      e.preventDefault();
      void this.send();
    } else if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void this.saveSlot();
    }
  }

  private async onPaste(e: ClipboardEvent) {
    const data = e.clipboardData;
    if (!data || data.getData("text/plain")) return;
    if (![...data.items].some((i) => i.type.startsWith("image/"))) return;
    // A screenshot: saved on the tab's host, its path goes into the text.
    e.preventDefault();
    const path = await this.deps.clipboardImagePath();
    if (path) this.insert(shellQuote(path) + " ");
  }

  private insert(text: string) {
    const { selectionStart: from, selectionEnd: to, value } = this.area;
    const start = from ?? value.length;
    const end = to ?? start;
    this.area.setRangeText(text, start, end, "end");
    this.area.focus();
    this.updateStats();
    this.scheduleSave();
  }

  private updateStats() {
    const s = stats(this.area.value);
    this.stats.textContent = t("draft.stats", { lines: String(s.lines), chars: String(s.chars) });
  }

  private say(text: string) {
    this.message.textContent = text;
  }

  // ---------- files dropped from Finder ----------

  /**
   * A Finder drop while the editor is open: the paths go into the text.
   * Returns false when the drop is for the terminal instead (a floating
   * editor leaves drops outside its own frame to the terminal).
   */
  handleDrop(paths: string[], at?: { x: number; y: number }): boolean {
    if (!this.shown || !this.takes(at)) return false;
    void this.deps.preparePaths(paths).then((ready) => {
      if (ready.length) this.insert(ready.map(shellQuote).join(" ") + " ");
    });
    return true;
  }

  /** Whether a drag at this position (window pixels) is over the editor. */
  takes(at?: { x: number; y: number }): boolean {
    if (!this.shown) return false;
    if (this.modal || !at) return true;
    const r = this.win.getBoundingClientRect();
    return at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom;
  }

  setDropHover(on: boolean) {
    this.win.classList.toggle("dropping", on);
  }

  // ---------- window: mode, place, size ----------

  private setModal(modal: boolean) {
    this.modal = modal;
    store(MODE_KEY, modal ? "1" : "0");
    this.backdrop.hidden = !modal || !this.shown;
    this.applyMode();
    this.place();
  }

  private applyMode() {
    this.win.classList.toggle("modal", this.modal);
    this.modeButton.textContent = this.modal ? t("draft.modeFloat") : t("draft.modeModal");
    this.modeButton.title = this.modal ? t("draft.modeFloatHint") : t("draft.modeModalHint");
  }

  /** Centered when modal; otherwise where it was last left (default: bottom center). */
  private place() {
    const w = this.win.offsetWidth || Math.max(420, window.innerWidth * 0.45);
    const h = this.win.offsetHeight || 300;
    let x = (window.innerWidth - w) / 2;
    let y = this.modal ? (window.innerHeight - h) / 3 : window.innerHeight - h - 56;
    if (!this.modal) {
      const saved = remember<{ x: number; y: number } | undefined>(
        POS_KEY,
        (raw) => JSON.parse(raw),
        undefined,
      );
      if (saved) ({ x, y } = saved);
    }
    this.moveTo(x, y);
  }

  private moveTo(x: number, y: number) {
    const w = this.win.offsetWidth;
    const h = this.win.offsetHeight;
    const left = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w));
    const top = Math.min(Math.max(34, y), Math.max(34, window.innerHeight - h - 8));
    this.win.style.left = `${left}px`;
    this.win.style.top = `${top}px`;
  }

  private makeDraggable() {
    this.head.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = this.win.getBoundingClientRect();
      this.head.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) =>
        this.moveTo(rect.left + ev.clientX - startX, rect.top + ev.clientY - startY);
      const end = () => {
        this.head.removeEventListener("pointermove", move);
        this.head.removeEventListener("pointerup", end);
        this.head.removeEventListener("pointercancel", end);
        if (!this.modal) {
          const r = this.win.getBoundingClientRect();
          store(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
        }
      };
      this.head.addEventListener("pointermove", move);
      this.head.addEventListener("pointerup", end);
      this.head.addEventListener("pointercancel", end);
    });
  }

  /** A button's label with its shortcut shown small beside it. */
  private withKey(button: HTMLElement, label: string, key: string) {
    button.replaceChildren(label, el("kbd", "draft-kbd", key));
  }

  private retranslate() {
    this.titleText.textContent = t("draft.title");
    this.setHotkey(this.hotkeyLabel);
    this.recentButton.textContent = t("draft.recent");
    this.refreshButton.title = t("draft.refreshTargets");
    this.targetLabel.textContent = t("draft.target");
    this.slotLabel.textContent = t("draft.slot");
    this.clearButton.textContent = t("draft.clearSlot");
    this.withKey(this.saveButton, t("draft.saveSlot"), "⌘S");
    this.withKey(this.sendButton, t("draft.send"), "⌘↵");
    this.sendButton.title = t("draft.sendHint");
    this.closeButton.title = `${t("draft.close")} (Esc)`;
    this.area.placeholder = t("draft.placeholder");
    this.applyMode();
    this.renderChips();
    this.updateStats();
    this.updateSlotControls();
  }
}
