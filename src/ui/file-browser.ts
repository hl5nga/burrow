import { invoke } from "@tauri-apps/api/core";
import { copyText } from "./clipboard";
import { highlight, htmlFrame, jsonTree, languageFor, renderMarkdown } from "./doc-render";
import type { ActiveTarget } from "./guardrail-manager";
import type { TerminalSession } from "../terminal/session";
import { showToast } from "./toast";

interface Entry {
  name: string;
  dir: boolean;
  link: boolean;
  size: number;
}

type FileContent =
  | { kind: "text"; text: string; size: number }
  | { kind: "tooLarge"; size: number }
  | { kind: "binary"; size: number };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;

function icon(e: Entry): string {
  if (e.dir) return "▸";
  const ext = e.name.includes(".") ? e.name.split(".").pop()!.toLowerCase() : "";
  if (ext === "md") return "M";
  if (ext === "json") return "{}";
  if (ext === "html" || ext === "htm") return "<>";
  if (languageFor(e.name)) return "·";
  return "·";
}

const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const parent = (dir: string) => dir.replace(/\/[^/]+\/?$/, "") || "/";
const shellQuote = (p: string) =>
  /^[\w./@%+=:,-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;

/**
 * A docked, read-only view of the active tab's folder, following the shell's
 * cwd, and an overlay viewer for Markdown, HTML, code and JSON. Nothing here
 * can change a file.
 */
export class FileBrowser {
  private readonly panel = el("aside", "files-panel");
  private readonly crumbs = el("div", "files-crumbs");
  private readonly list = el("div", "files-list");
  private readonly hiddenToggle = el("input");
  private readonly viewer = el("div", "viewer-overlay");
  private target?: ActiveTarget;
  private path = "";
  /** The folder the shell reported last; the panel follows it on change. */
  private shellCwd = "";
  private request = 0;

  constructor(
    workspace: HTMLElement,
    private readonly active: () => { target?: ActiveTarget; session?: TerminalSession },
  ) {
    const head = el("div", "files-head");
    head.append(el("span", "files-title", "파일"));
    const hidden = el("label", "files-hidden");
    this.hiddenToggle.type = "checkbox";
    this.hiddenToggle.addEventListener("change", () => void this.load());
    hidden.append(this.hiddenToggle, document.createTextNode(" 숨김 파일"));
    head.append(hidden);
    this.panel.append(
      head,
      this.crumbs,
      this.list,
      el("div", "files-note", "읽기 전용 — 수정은 편집기에서"),
    );
    this.panel.hidden = true;
    workspace.prepend(this.panel);
    this.viewer.hidden = true;
    document.body.append(this.viewer);
    this.viewer.addEventListener("mousedown", (e) => {
      if (e.target === this.viewer) this.closeViewer();
    });
    this.viewer.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.closeViewer();
      }
    });
    this.viewer.tabIndex = -1;
  }

  get isOpen() {
    return !this.panel.hidden;
  }

  toggle() {
    this.panel.hidden = !this.panel.hidden;
    if (this.isOpen) this.follow(true);
    else this.active().session?.focus();
  }

  /** The active tab, or its cwd, changed. */
  follow(force = false) {
    const { target } = this.active();
    const changedTab =
      target?.profileId !== this.target?.profileId || target?.hostLabel !== this.target?.hostLabel;
    this.target = target;
    const cwd = target?.cwd ?? "";
    if (!force && !changedTab && cwd === this.shellCwd) return;
    this.shellCwd = cwd;
    if (!this.isOpen) return;
    if (cwd) this.navigate(cwd);
    else
      this.showMessage(
        "현재 폴더를 아직 모릅니다 — 훅이 있는 셸에서 명령을 한 번 실행하면 나타납니다",
      );
  }

  private navigate(path: string) {
    this.path = path;
    void this.load();
  }

  private showMessage(text: string) {
    this.crumbs.replaceChildren();
    this.list.replaceChildren(el("div", "files-empty", text));
  }

  private async load() {
    const target = this.target;
    if (!target || !this.path) return;
    if (target.foreignShell) {
      return this.showMessage(
        "직접 ssh로 들어간 셸이라 폴더를 볼 수 없습니다. SSH 프로필 탭에서 열어 주세요",
      );
    }
    const id = ++this.request;
    this.renderCrumbs();
    this.list.replaceChildren(el("div", "files-empty", "불러오는 중…"));
    try {
      const entries = await invoke<Entry[]>("fs_list", {
        profileId: target.profileId ?? null,
        path: this.path,
      });
      if (id !== this.request) return; // a newer folder is loading
      this.renderList(entries.filter((e) => this.hiddenToggle.checked || !e.name.startsWith(".")));
    } catch (err) {
      if (id === this.request) this.list.replaceChildren(el("div", "files-empty", String(err)));
    }
  }

  private renderCrumbs() {
    const parts = this.path.split("/").filter(Boolean);
    const nodes: HTMLElement[] = [];
    const host = this.target?.hostLabel === "이 Mac" ? "" : `${this.target?.hostLabel}:`;
    const root = el("button", "crumb", parts.length ? host || "/" : `${host}/`);
    root.addEventListener("click", () => this.navigate("/"));
    nodes.push(root);
    parts.forEach((part, i) => {
      const b = el("button", "crumb", part);
      const to = `/${parts.slice(0, i + 1).join("/")}`;
      b.addEventListener("click", () => this.navigate(to));
      // Local paths start at the root button itself ("/"), remote ones after "host:".
      if (i > 0 || host) nodes.push(el("span", "crumb-sep", "/"));
      nodes.push(b);
    });
    this.crumbs.replaceChildren(...nodes);
    this.crumbs.title = this.path;
  }

  private renderList(entries: Entry[]) {
    const rows: HTMLElement[] = [];
    if (this.path !== "/") {
      const up = el("button", "file-row dir", "..");
      up.addEventListener("click", () => this.navigate(parent(this.path)));
      rows.push(up);
    }
    for (const e of entries) {
      const row = el("button", e.dir ? "file-row dir" : "file-row");
      row.append(
        el("span", "file-icon", icon(e)),
        el("span", "file-name", e.name + (e.link ? " ↗" : "")),
      );
      if (!e.dir) row.append(el("span", "file-size", size(e.size)));
      row.title = join(this.path, e.name);
      row.addEventListener("click", () =>
        e.dir
          ? this.navigate(join(this.path, e.name))
          : void this.open(join(this.path, e.name), e.name),
      );
      rows.push(row);
    }
    if (entries.length === 0) rows.push(el("div", "files-empty", "비어 있음"));
    this.list.replaceChildren(...rows);
  }

  // ---------- viewer ----------

  private async open(path: string, name: string) {
    const target = this.target;
    if (!target) return;
    const box = el("div", "viewer");
    const head = el("div", "viewer-head");
    const title = el("span", "viewer-path", path);
    const actions = el("div", "viewer-actions");
    const body = el("div", "viewer-body");
    head.append(title, actions);
    box.append(head, body);
    this.viewer.replaceChildren(box);
    this.viewer.hidden = false;
    this.viewer.focus();
    body.append(el("div", "files-empty", "불러오는 중…"));

    const button = (label: string, run: () => void) => {
      const b = el("button", "btn ghost", label);
      b.type = "button";
      b.addEventListener("click", run);
      actions.append(b);
      return b;
    };
    button("경로를 터미널에", () => {
      const session = this.active().session;
      this.closeViewer();
      session?.paste(shellQuote(path));
    });

    let content: FileContent;
    try {
      content = await invoke<FileContent>("fs_read", { profileId: target.profileId ?? null, path });
    } catch (err) {
      body.replaceChildren(el("div", "files-empty", String(err)));
      button("닫기", () => this.closeViewer());
      return;
    }
    if (content.kind !== "text") {
      body.replaceChildren(
        el(
          "div",
          "files-empty",
          content.kind === "tooLarge"
            ? `미리보기엔 너무 큽니다 (${size(content.size)}, 2 MB까지)`
            : `바이너리 파일이라 미리보지 않습니다 (${size(content.size)})`,
        ),
      );
      button("닫기", () => this.closeViewer());
      return;
    }
    const text = content.text;
    button("복사", () => void copyText(text).then(() => showToast("내용을 복사했습니다")));
    const lower = name.toLowerCase();
    const source = () => {
      const pre = el("pre", "viewer-code hljs");
      pre.innerHTML = highlight(text, name);
      return pre;
    };
    let rendered: () => HTMLElement;
    if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
      rendered = () => {
        const doc = el("article", "viewer-md");
        doc.innerHTML = renderMarkdown(text);
        // Links would navigate the app's own webview.
        doc.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest("a")) e.preventDefault();
        });
        return doc;
      };
    } else if (lower.endsWith(".html") || lower.endsWith(".htm")) {
      rendered = () => htmlFrame(text);
    } else if (lower.endsWith(".json")) {
      rendered = () => {
        try {
          const tree = el("div", "viewer-json");
          tree.append(jsonTree(JSON.parse(text)));
          return tree;
        } catch {
          return source();
        }
      };
    } else {
      rendered = source;
    }
    let showingSource = false;
    const show = () => body.replaceChildren(showingSource ? source() : rendered());
    if (rendered !== source) {
      const toggle = button("소스 보기", () => {
        showingSource = !showingSource;
        toggle.textContent = showingSource ? "미리보기" : "소스 보기";
        show();
      });
    }
    button("닫기", () => this.closeViewer());
    show();
  }

  private closeViewer() {
    this.viewer.hidden = true;
    this.viewer.replaceChildren();
    this.active().session?.focus();
  }
}
