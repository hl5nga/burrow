import { invoke } from "@tauri-apps/api/core";
import type { TerminalSession } from "../terminal/session";
import { fuzzyScore } from "./fuzzy";

interface StoredCommand {
  id: string;
  name: string;
  command: string;
  description: string;
  type: "shell" | "ssh-profile";
  sshHost: string | null;
}

interface Ranked {
  command: string;
  count: number;
}

interface Entry {
  section: string;
  title: string;
  subtitle: string;
  run: string;
  icon: "SH" | "SSH";
  /** The title is a raw command line (monospace) rather than a human-given name. */
  titleIsCommand: boolean;
  count?: number;
  disabledReason?: string;
  /** Extra text the query can match (e.g. a registered command's description). */
  searchable: string[];
}

const FREQUENT_LIMIT = 8;

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "/";
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class CommandPalette {
  private readonly overlay = el("div", "palette-overlay");
  private readonly input = el("input");
  private readonly results = el("div", "palette-results");
  private readonly footerNote = el("span", "palette-note");
  private entries: Entry[] = [];
  private visible: Entry[] = [];
  private selected = 0;

  constructor(private readonly getSession: () => TerminalSession | undefined) {
    const box = el("div", "palette");
    const search = el("div", "palette-search");
    this.input.placeholder = "명령어 검색 — 초성(ㅂㅍ)도 됩니다";
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    search.append(el("span", "glyph", "❯"), this.input, el("span", "kbd", "esc 닫기"));

    const footer = el("div", "palette-footer");
    for (const [key, label] of [
      ["↑↓", "이동"],
      ["↵", "실행"],
    ]) {
      const hint = el("span");
      hint.append(el("b", undefined, key), label);
      footer.append(hint);
    }
    footer.append(this.footerNote);

    box.append(search, this.results, footer);
    this.overlay.append(box);
    this.overlay.hidden = true;
    document.body.append(this.overlay);

    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close();
    });
    this.input.addEventListener("input", () => {
      this.selected = 0;
      this.render();
    });
    this.input.addEventListener("keydown", (e) => this.onKey(e));
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  toggle() {
    if (this.isOpen) this.close();
    else void this.open();
  }

  async open() {
    const session = this.getSession();
    if (!session) return;
    this.overlay.hidden = false;
    this.input.value = "";
    this.selected = 0;
    this.input.focus();
    this.entries = await this.loadEntries(session);
    this.render();
  }

  close() {
    this.overlay.hidden = true;
    this.getSession()?.focus();
  }

  private async loadEntries(session: TerminalSession): Promise<Entry[]> {
    const { host, cwd } = session.context();
    const [commandsFile, config, here, onHost] = await Promise.all([
      invoke<{ commands: StoredCommand[] }>("store_get", { kind: "commands" }),
      invoke<{ promotionThreshold: number }>("store_get", { kind: "config" }),
      invoke<Ranked[]>("stats_top", { host, cwd, scope: "dir", limit: FREQUENT_LIMIT }),
      invoke<Ranked[]>("stats_top", { host, cwd, scope: "host", limit: FREQUENT_LIMIT * 2 }),
    ]);
    this.footerNote.textContent = `${config.promotionThreshold}회 이상 쓴 명령이 자동으로 올라옵니다`;

    const registered: Entry[] = commandsFile.commands.map((c) => ({
      section: "사용자 등록 명령어",
      title: c.name || c.command,
      subtitle: c.type === "ssh-profile" ? (c.sshHost ?? "") : c.command,
      run: c.command,
      icon: c.type === "ssh-profile" ? "SSH" : "SH",
      titleIsCommand: !c.name,
      disabledReason: c.type === "ssh-profile" ? "SSH 프로필 접속은 준비 중입니다" : undefined,
      searchable: [c.name, c.command, c.description, c.sshHost ?? ""],
    }));

    const frequent = (r: Ranked, section: string): Entry => ({
      section,
      title: r.command,
      subtitle: "",
      run: r.command,
      icon: "SH",
      titleIsCommand: true,
      count: r.count,
      searchable: [r.command],
    });
    const hereSection = `여기서 자주 씀 · ${basename(cwd)}`;
    const hostSection = host === "local" ? "로컬에서 자주 씀" : `이 서버에서 자주 씀 · ${host}`;
    const inHere = new Set(here.map((r) => r.command));
    return [
      ...registered,
      ...here.map((r) => frequent(r, hereSection)),
      ...onHost
        .filter((r) => !inHere.has(r.command))
        .slice(0, FREQUENT_LIMIT)
        .map((r) => frequent(r, hostSection)),
    ];
  }

  private filtered(): Entry[] {
    const query = this.input.value;
    if (!query.trim()) return this.entries;
    const scored = this.entries
      .map((entry) => {
        const scores = entry.searchable
          .map((text) => fuzzyScore(query, text))
          .filter((s): s is number => s !== undefined);
        return { entry, score: scores.length ? Math.max(...scores) : undefined };
      })
      .filter((x): x is { entry: Entry; score: number } => x.score !== undefined);
    // Keep sections in their usual order; rank within each section.
    const order = [...new Set(this.entries.map((e) => e.section))];
    return scored
      .sort(
        (a, b) =>
          order.indexOf(a.entry.section) - order.indexOf(b.entry.section) || b.score - a.score,
      )
      .map((x) => x.entry);
  }

  private render() {
    this.visible = this.filtered();
    this.selected = Math.min(this.selected, Math.max(this.visible.length - 1, 0));
    this.results.replaceChildren();

    if (this.visible.length === 0) {
      const empty = this.input.value.trim()
        ? "일치하는 명령어가 없습니다"
        : "아직 등록된 명령어도, 자주 쓴 명령어도 없습니다";
      this.results.append(el("div", "palette-empty", empty));
      return;
    }

    let current: HTMLElement | undefined;
    let currentName = "";
    this.visible.forEach((entry, index) => {
      if (!current || entry.section !== currentName) {
        currentName = entry.section;
        current = el("div", "palette-section");
        current.append(el("div", "sec-title", entry.section));
        this.results.append(current);
      }
      const row = el("div", "palette-item");
      if (index === this.selected) row.classList.add("hi");
      if (entry.disabledReason) {
        row.classList.add("disabled");
        row.title = entry.disabledReason;
      }
      const main = el("div", "p-main");
      main.append(el("div", entry.titleIsCommand ? "p-name mono" : "p-name", entry.title));
      if (entry.subtitle) main.append(el("div", "p-cmd", entry.subtitle));
      row.append(el("div", `p-icon ${entry.icon === "SSH" ? "ssh" : "shell"}`, entry.icon), main);
      if (entry.count !== undefined) row.append(el("div", "p-count", `${entry.count}회`));
      row.addEventListener("mousemove", () => this.select(index));
      row.addEventListener("click", () => this.runSelected());
      current.append(row);
    });
    this.results.querySelector(".palette-item.hi")?.scrollIntoView({ block: "nearest" });
  }

  private select(index: number) {
    if (index === this.selected) return;
    this.selected = index;
    this.results.querySelectorAll(".palette-item").forEach((row, i) => {
      row.classList.toggle("hi", i === index);
    });
  }

  private onKey(e: KeyboardEvent) {
    // Enter or arrows that commit a Hangul syllable belong to the IME, not the list.
    if (e.isComposing || e.keyCode === 229) return;
    const count = this.visible.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (count) this.select((this.selected + 1) % count);
        this.scrollSelected();
        break;
      case "ArrowUp":
        e.preventDefault();
        if (count) this.select((this.selected - 1 + count) % count);
        this.scrollSelected();
        break;
      case "Enter":
        e.preventDefault();
        this.runSelected();
        break;
      case "Escape":
        e.preventDefault();
        this.close();
        break;
    }
  }

  private scrollSelected() {
    this.results.querySelector(".palette-item.hi")?.scrollIntoView({ block: "nearest" });
  }

  private runSelected() {
    const entry = this.visible[this.selected];
    if (!entry || entry.disabledReason) return;
    const session = this.getSession();
    this.close();
    session?.run(entry.run);
  }
}
