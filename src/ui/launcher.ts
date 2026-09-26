import { invoke } from "@tauri-apps/api/core";
import type { StoredCommand } from "./command-validation";
import { checkReachable } from "./reachability";

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
  private online = true;
  private pollTimer = 0;

  private resolveEntry?: (entry: LauncherEntry) => void;

  constructor(
    private readonly root: HTMLElement,
    private readonly onNewConnection?: NewConnectionHandler,
  ) {
    const box = el("div", "launcher");
    const head = el("div", "launcher-head");
    head.setAttribute("data-tauri-drag-region", "");
    head.append(el("div", "launcher-title", "Burrow"), this.netChip);
    const sub = el("div", "launcher-sub", "연결을 선택하세요");
    sub.setAttribute("data-tauri-drag-region", "");
    box.append(head, sub, this.list);
    this.overlay.append(box);
    this.overlay.setAttribute("data-tauri-drag-region", "");
  }

  /** Renders the list and resolves once the user picks an entry to open. */
  open(): Promise<LauncherEntry> {
    this.root.append(this.overlay);
    return new Promise<LauncherEntry>((resolve) => {
      this.resolveEntry = resolve;
      void this.load();
    }).finally(() => {
      window.clearInterval(this.pollTimer);
      this.overlay.remove();
    });
  }

  private async load() {
    const [profiles, config] = await Promise.all([loadProfiles(), loadConfig()]);
    const autoOpenId = (config.autoOpenId as string | undefined) ?? null;
    this.render(profiles, autoOpenId);
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
    this.netChip.textContent = this.online ? "🌐 온라인" : "🌐 오프라인";
    this.netChip.classList.toggle("offline", !this.online);
    for (const row of this.list.querySelectorAll<HTMLButtonElement>(".launcher-row.ssh")) {
      row.disabled = !this.online;
      row.classList.toggle("disabled", !this.online);
      row.title = this.online ? "" : "인터넷 연결이 없어 접속할 수 없습니다";
      const connect = row.querySelector<HTMLButtonElement>(".launcher-connect");
      if (connect) connect.disabled = !this.online;
    }
  }

  private render(profiles: StoredCommand[], autoOpenId: string | null) {
    const entries: LauncherEntry[] = [
      { kind: "local" },
      ...profiles.map((profile) => ({ kind: "ssh" as const, profile })),
    ];
    this.list.replaceChildren(...entries.map((entry) => this.row(entry, autoOpenId)));
    if (profiles.length === 0) {
      this.list.append(
        el("div", "launcher-hint", "등록된 SSH 프로필이 없습니다. 아래에서 새 연결을 등록하세요."),
      );
    }
    if (this.onNewConnection) {
      const add = el("button", "launcher-new", "＋ 새 연결");
      add.type = "button";
      add.addEventListener("click", () => void this.handleNewConnection());
      this.list.append(add);
    }
  }

  private row(entry: LauncherEntry, autoOpenId: string | null): HTMLButtonElement {
    const id = entryId(entry);
    const isSsh = entry.kind === "ssh";
    const row = el("button", isSsh ? "launcher-row ssh" : "launcher-row local");
    row.type = "button";
    row.dataset.entryId = id;

    const dot = el("span", "launcher-dot unknown");
    const main = el("div", "launcher-main");
    const name = el(
      "div",
      "launcher-name",
      isSsh ? entry.profile.name || entry.profile.sshHost || "SSH" : "로컬 터미널",
    );
    const sub = el("div", "launcher-sub-row", isSsh ? (entry.profile.sshHost ?? "") : "이 Mac");
    main.append(name, sub);

    const auto = el("label", "launcher-auto");
    const checkbox = el("input", "switch");
    checkbox.type = "checkbox";
    checkbox.checked = autoOpenId === id;
    auto.append(document.createTextNode("자동 열기"), checkbox);
    auto.title = "다음 실행부터 이 목록을 건너뛰고 바로 엽니다";
    auto.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", () => void this.setAutoOpen(checkbox.checked ? id : null));

    const connect = el("button", "launcher-connect", isSsh ? "접속" : "열기");
    connect.type = "button";
    connect.addEventListener("click", (e) => {
      e.stopPropagation();
      this.resolveEntry?.(entry);
    });

    row.append(icon(entry), dot, main, auto, connect);
    row.addEventListener("click", () => this.resolveEntry?.(entry));

    if (isSsh) {
      void checkReachable(entry.profile.id).then((r) => {
        dot.className = `launcher-dot ${r.state}`;
      });
    } else {
      dot.className = "launcher-dot online";
    }
    return row;
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
