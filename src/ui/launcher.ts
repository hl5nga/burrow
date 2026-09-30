import { invoke } from "@tauri-apps/api/core";
import type { StoredCommand } from "./command-validation";
import { checkReachable } from "./reachability";
import { t, onLocaleChange } from "../i18n";
import { LanguageChip } from "./language-chip";

export type LauncherEntry = { kind: "local" } | { kind: "ssh"; profile: StoredCommand };

/**
 * Opens the SSH-profile registration form (the same one ⌘, opens) and
 * resolves once the user connects something from it, or undefined if they
 * close it without connecting — the launcher stays open in that case.
 */
export type NewConnectionHandler = () => Promise<LauncherEntry | undefined>;

/** The id `config.json`'s `autoOpenId` uses for the local-terminal entry. */
const LOCAL_ID = "local";

function entryId(entry: LauncherEntry): string {
  return entry.kind === "local" ? LOCAL_ID : entry.profile.id;
}

interface ConfigLike {
  autoOpenId?: string | null;
  [key: string]: unknown;
}

async function loadProfiles(): Promise<StoredCommand[]> {
  try {
    const file = await invoke<{ commands: StoredCommand[] }>("store_get", { kind: "commands" });
    return file.commands.filter((c) => c.type === "ssh-profile");
  } catch {
    return [];
  }
}

async function loadConfig(): Promise<ConfigLike> {
  try {
    return await invoke<ConfigLike>("store_get", { kind: "config" });
  } catch {
    return {};
  }
}

async function saveAutoOpen(id: string | null) {
  const config = await loadConfig();
  await invoke("store_put", { kind: "config", value: { ...config, autoOpenId: id } });
}

/**
 * Decides what the app should do at startup, without showing anything. If a
 * valid auto-open target is configured, main.ts uses this to skip the
 * connection list entirely. Undefined means "show the list" — including when
 * the configured profile has since been deleted.
 */
export async function resolveAutoOpen(): Promise<LauncherEntry | undefined> {
  const config = await loadConfig();
  const id = config.autoOpenId;
  if (!id) return undefined;
  if (id === LOCAL_ID) return { kind: "local" };
  const profile = (await loadProfiles()).find((p) => p.id === id);
  return profile ? { kind: "ssh", profile } : undefined;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const NET_POLL_MS = 5000;

const TERMINAL_ICON = `<svg viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4 6.5L6.5 8.5L4 10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10.5H11.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;

/** A small type badge to the left of each row: terminal glyph for the local
 * entry, an "SSH" pill for every remote profile — so the kind of connection
 * reads at a glance, separately from the reachability dot next to it. */
function icon(entry: LauncherEntry): HTMLElement {
  if (entry.kind === "local") {
    const box = el("span", "launcher-icon local");
    box.innerHTML = TERMINAL_ICON;
    return box;
  }
  return el("span", "launcher-icon ssh", "SSH");
}

/**
 * The app's start page: the local terminal plus every registered SSH profile,
 * each with an "auto open" switch (only one may be on — see resolveAutoOpen,
 * which skips this screen next time using whichever one is on). SSH rows are
 * disabled while this Mac has no internet at all; the local entry never is.
 */
export class Launcher {
  private readonly overlay = el("div", "launcher-overlay");
  private readonly list = el("div", "launcher-list");
  private readonly netChip = el("span", "launcher-net");
  private readonly sub = el("div", "launcher-sub");
  private online = true;
  private pollTimer = 0;
  private profiles: StoredCommand[] = [];
  private autoOpenId: string | null = null;
  private unsubLocale?: () => void;

  private resolveEntry?: (entry: LauncherEntry | undefined) => void;

  constructor(
    private readonly root: HTMLElement,
    private readonly onNewConnection?: NewConnectionHandler,
    /**
     * True when this is revisiting the list from a session already under
     * way (menu bar → 연결 목록 보기), where Escape/clicking outside should
     * just cancel back to whatever was on screen. False (the default) is the
     * one-time startup gate, which has nothing to cancel back to.
     */
    private readonly dismissible = false,
    /** Edit-icon click on an SSH row: hides the list, opens the profile in
     * the command manager, and calls back once it's closed so the list can
     * reload (the name/host shown may have changed). */
    private readonly onEditProfile?: (profile: StoredCommand, onDone: () => void) => void,
    /** Fills its `root` (a tab's body) instead of covering the whole window. */
    inline = false,
  ) {
    const box = el("div", "launcher");
    const head = el("div", "launcher-head");
    head.setAttribute("data-tauri-drag-region", "");
    const corner = el("div", "launcher-head-corner");
    new LanguageChip(corner);
    corner.append(this.netChip);
    head.append(el("div", "launcher-title", "Burrow"), corner);
    this.sub.setAttribute("data-tauri-drag-region", "");
    box.append(head, this.sub, this.list);
    this.overlay.append(box);
    this.overlay.setAttribute("data-tauri-drag-region", "");
    this.overlay.classList.toggle("inline", inline);
    this.overlay.tabIndex = -1;
    this.overlay.addEventListener("mousedown", (e) => {
      if (this.dismissible && e.target === this.overlay) this.resolveEntry?.(undefined);
    });
    this.overlay.addEventListener("keydown", (e) => {
      if (this.dismissible && e.key === "Escape") {
        e.preventDefault();
        this.resolveEntry?.(undefined);
      }
    });
    this.unsubLocale = onLocaleChange(() => this.retranslate());
    this.retranslate();
  }

  /**
   * Renders the list and resolves once the user picks an entry to open, or
   * (only when `dismissible`) closes it without choosing.
   */
  open(): Promise<LauncherEntry | undefined> {
    this.root.append(this.overlay);
    const previous = document.activeElement as HTMLElement | null;
    return new Promise<LauncherEntry | undefined>((resolve) => {
      this.resolveEntry = resolve;
      void this.load();
    }).finally(() => {
      window.clearInterval(this.pollTimer);
      this.overlay.remove();
      this.unsubLocale?.();
      if (this.dismissible) previous?.focus();
    });
  }

  /** Gives up without picking anything (e.g. the tab it lives in was closed). */
  cancel() {
    this.resolveEntry?.(undefined);
  }

  private retranslate() {
    this.sub.textContent = t("launcher.subtitle");
    this.render(this.profiles, this.autoOpenId);
    void this.pollNetwork();
  }

  private async load() {
    const [profiles, config] = await Promise.all([loadProfiles(), loadConfig()]);
    this.profiles = profiles;
    this.autoOpenId = (config.autoOpenId as string | undefined) ?? null;
    this.render(this.profiles, this.autoOpenId);
    this.pollTimer = window.setInterval(() => void this.pollNetwork(), NET_POLL_MS);
    void this.pollNetwork();
  }

  /**
   * The "＋ 새 연결" button: opens the same SSH-profile form ⌘, does, with
   * this screen hidden underneath. If the user connects something from it,
   * that finishes startup; if they just close it, the list comes back.
   */
  private async handleNewConnection() {
    if (!this.onNewConnection) return;
    window.clearInterval(this.pollTimer);
    this.overlay.hidden = true;
    const entry = await this.onNewConnection();
    if (entry) {
      this.resolveEntry?.(entry);
      return;
    }
    this.overlay.hidden = false;
    await this.load();
  }

  private async pollNetwork() {
    try {
      this.online = await invoke<boolean>("network_online");
    } catch {
      this.online = true; // Fail open: never block the user on our own check misbehaving.
    }
    this.netChip.textContent = t(this.online ? "launcher.online" : "launcher.offline");
    this.netChip.classList.toggle("offline", !this.online);
    for (const row of this.list.querySelectorAll<HTMLDivElement>(".launcher-row.ssh")) {
      row.classList.toggle("disabled", !this.online);
      row.tabIndex = this.online ? 0 : -1;
      row.title = this.online ? "" : t("launcher.offlineHint");
      const connect = row.querySelector<HTMLButtonElement>(".launcher-connect");
      if (connect) connect.disabled = !this.online;
      const edit = row.querySelector<HTMLButtonElement>(".launcher-edit");
      if (edit) edit.disabled = !this.online;
    }
  }

  private render(profiles: StoredCommand[], autoOpenId: string | null) {
    const entries: LauncherEntry[] = [
      { kind: "local" },
      ...profiles.map((profile) => ({ kind: "ssh" as const, profile })),
    ];
    this.list.replaceChildren(...entries.map((entry) => this.row(entry, autoOpenId)));
    if (profiles.length === 0) {
      this.list.append(el("div", "launcher-hint", t("launcher.noProfiles")));
    }
    if (this.onNewConnection) {
      const add = el("button", "launcher-new", t("launcher.newConnection"));
      add.type = "button";
      add.addEventListener("click", () => void this.handleNewConnection());
      this.list.append(add);
    }
  }

  private row(entry: LauncherEntry, autoOpenId: string | null): HTMLDivElement {
    const id = entryId(entry);
    const isSsh = entry.kind === "ssh";
    // A <div>, not a <button>: the row itself is clickable (connects/opens),
    // but also has to contain the real "Connect"/edit <button>s inside it —
    // a <button> can't nest another <button> (invalid HTML, and unreliable
    // to click in WebKit specifically), which is exactly what made the edit
    // icon unclickable.
    const row = el("div", isSsh ? "launcher-row ssh" : "launcher-row local");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.dataset.entryId = id;

    const dot = el("span", "launcher-dot unknown");
    const main = el("div", "launcher-main");
    const name = el(
      "div",
      "launcher-name",
      isSsh
        ? entry.profile.name || entry.profile.sshHost || t("launcher.ssh")
        : t("launcher.localTerminal"),
    );
    const sub = el(
      "div",
      "launcher-sub-row",
      isSsh ? (entry.profile.sshHost ?? "") : t("launcher.thisMac"),
    );
    main.append(name, sub);

    const auto = el("label", "launcher-auto");
    const checkbox = el("input", "switch");
    checkbox.type = "checkbox";
    checkbox.checked = autoOpenId === id;
    auto.append(document.createTextNode(t("launcher.autoOpen")), checkbox);
    auto.title = t("launcher.autoOpenHint");
    auto.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", () => void this.setAutoOpen(checkbox.checked ? id : null));

    const connect = el(
      "button",
      "launcher-connect",
      t(isSsh ? "launcher.connect" : "launcher.open"),
    );
    connect.type = "button";
    connect.addEventListener("click", (e) => {
      e.stopPropagation();
      this.resolveEntry?.(entry);
    });

    let edit: HTMLButtonElement | undefined;
    if (isSsh) {
      edit = el("button", "launcher-edit", "✎");
      edit.type = "button";
      edit.title = t("launcher.edit");
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        this.handleEdit(entry.profile);
      });
    }

    row.append(icon(entry), dot, main, ...(edit ? [edit] : []), auto, connect);
    row.addEventListener("click", (e) => {
      // Clicks on the row's own controls (Connect, Edit, the auto-open switch)
      // are theirs alone — never also a "connect" on the row itself.
      if ((e.target as Element).closest("button, label")) return;
      if (!row.classList.contains("disabled")) this.resolveEntry?.(entry);
    });
    row.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && !row.classList.contains("disabled")) {
        e.preventDefault();
        this.resolveEntry?.(entry);
      }
    });

    if (isSsh) {
      void checkReachable(entry.profile.id).then((r) => {
        dot.className = `launcher-dot ${r.state}`;
      });
    } else {
      dot.className = "launcher-dot online";
    }
    return row;
  }

  private handleEdit(profile: StoredCommand) {
    if (!this.onEditProfile) return;
    window.clearInterval(this.pollTimer);
    // The launcher stays put underneath; the manager stacks above it.
    this.onEditProfile(profile, () => {
      void this.load();
    });
  }

  private async setAutoOpen(id: string | null) {
    await saveAutoOpen(id);
    // Only the one just checked stays checked; every other row's switch clears.
    for (const input of this.list.querySelectorAll<HTMLInputElement>(".launcher-auto input")) {
      const row = input.closest<HTMLElement>(".launcher-row");
      input.checked = row?.dataset.entryId === id;
    }
  }
}
