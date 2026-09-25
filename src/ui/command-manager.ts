import { invoke } from "@tauri-apps/api/core";
import {
  emptyCommand,
  normalizeCommand,
  validateCommand,
  type CommandType,
  type FieldErrors,
  type StoredCommand,
  type Transport,
} from "./command-validation";
import { showToast } from "./toast";
import { checkReachable } from "./reachability";

interface CommandsFile {
  version: number;
  commands: StoredCommand[];
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

function initials(c: StoredCommand): string {
  const source = (c.name || c.sshHost || "?").replace(/^[^@]*@/, "");
  const words = source.split(/[\s.\-_]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

interface FieldSpec {
  key: keyof StoredCommand;
  label: string;
  for: CommandType | "both";
  multiline?: boolean;
  placeholder?: string;
  hint?: string;
  mono?: boolean;
}

const FIELDS: FieldSpec[] = [
  { key: "name", label: "이름", for: "both", placeholder: "예: 배포, 집 노트북" },
  { key: "command", label: "명령", for: "shell", placeholder: "npm run deploy", mono: true },
  {
    key: "sshHost",
    label: "SSH 호스트",
    for: "ssh-profile",
    placeholder: "user@home-laptop.tailnet.ts.net",
    hint: "원격 노트북이 잠들면 접속할 수 없습니다. 그쪽에서 시스템 설정 › 배터리 › 옵션의 '네트워크 접근 시 깨우기'를 켜거나 caffeinate -s를 실행해 두세요",
    mono: true,
  },
  {
    key: "tmuxSession",
    label: "tmux 세션",
    for: "ssh-profile",
    placeholder: "비워두면 tmux 없이 접속",
    hint: "접속하면 이 이름의 tmux 세션에 자동으로 다시 붙습니다",
    mono: true,
  },
  {
    key: "vpnPreConnect",
    label: "접속 전 VPN 명령",
    for: "ssh-profile",
    placeholder: "tailscale up",
    hint: '적어 둔 경우에만, 호스트에 닿지 않을 때 이 Mac에서 실행합니다. 예: tailscale up · scutil --nc start "회사 VPN" · wg-quick up home (sudo가 필요한 명령은 안 됩니다)',
    mono: true,
  },
  { key: "description", label: "설명", for: "both", multiline: true },
];

/** Registering, editing and deleting commands and SSH profiles (⌘,). */
export class CommandManager {
  private readonly overlay = el("div", "manager-overlay");
  private readonly list = el("div", "mgmt-rows");
  private readonly count = el("span", "mgmt-count");
  private readonly form = el("form", "mgmt-form");
  private commands: StoredCommand[] = [];
  private draft: StoredCommand = emptyCommand();
  private errors: FieldErrors = {};
  private deleteArmed = false;
  private onClose: () => void = () => {};

  constructor(private readonly connect: (profile: StoredCommand) => void) {
    const box = el("div", "manager");
    const listPane = el("div", "mgmt-list");
    const head = el("div", "mgmt-list-head");
    const title = el("h3", undefined, "등록된 명령어");
    title.append(this.count);
    const add = el("button", "btn", "＋ 새로 등록");
    add.type = "button";
    add.addEventListener("click", () => this.edit(emptyCommand()));
    head.append(title, add);
    listPane.append(head, this.list);

    box.append(listPane, this.form);
    this.overlay.append(box);
    this.overlay.hidden = true;
    document.body.append(this.overlay);

    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close();
    });
    this.overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        this.close();
      }
    });
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.save();
    });
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  /** Opens the manager, editing `target` (an existing id, or a prefilled new entry). */
  async open(target?: string | Partial<StoredCommand>, onClose?: () => void) {
    this.onClose = onClose ?? (() => {});
    await this.load();
    this.overlay.hidden = false;
    if (typeof target === "string" && target.startsWith("new:")) {
      this.edit({ ...emptyCommand(), command: target.slice(4) });
    } else if (typeof target === "string") {
      const existing = this.commands.find((c) => c.id === target);
      this.edit(existing ?? this.commands[0] ?? emptyCommand());
    } else if (target) {
      this.edit({ ...emptyCommand(target.type ?? "shell"), ...target, id: "" });
    } else {
      this.edit(this.commands[0] ?? emptyCommand());
    }
  }

  close() {
    this.overlay.hidden = true;
    this.onClose();
  }

  private async load() {
    const file = await invoke<CommandsFile>("store_get", { kind: "commands" });
    this.commands = file.commands;
  }

  private async persist() {
    await invoke("store_put", {
      kind: "commands",
      value: { version: 1, commands: this.commands },
    });
  }

  private edit(command: StoredCommand) {
    this.draft = { ...command };
    this.errors = {};
    this.deleteArmed = false;
    this.renderList();
    this.renderForm();
    this.form.querySelector<HTMLInputElement>("input, textarea")?.focus();
  }

  private renderList() {
    this.count.textContent = ` · ${this.commands.length}`;
    this.list.replaceChildren();
    if (this.commands.length === 0) {
      this.list.append(
        el(
          "div",
          "mgmt-empty",
          "아직 등록한 명령어가 없습니다. 오른쪽에서 첫 명령을 만들어 보세요.",
        ),
      );
    }
    for (const c of this.commands) {
      const ssh = c.type === "ssh-profile";
      const row = el("button", ssh ? "cmd-row host-card" : "cmd-row");
      row.type = "button";
      if (c.id === this.draft.id) row.classList.add("sel");

      const main = el("div", "cr-main");
      const name = el("div", "cr-name", c.name || c.command);
      if (ssh && c.tmuxSession) name.append(el("span", "cr-tag", `tmux · ${c.tmuxSession}`));
      main.append(name, el("div", "cr-sub", ssh ? (c.sshHost ?? "") : c.command));

      if (ssh) {
        const avatar = el("div", "host-avatar", initials(c));
        const dot = el("span", "h-status unknown");
        dot.title = "확인 중…";
        avatar.append(dot);
        void checkReachable(c.id).then((r) => {
          dot.className = `h-status ${r.state}`;
          dot.title =
            r.state === "online"
              ? "온라인"
              : r.state === "offline"
                ? `오프라인 · ${r.reason}`
                : "프록시 경유라 미리 확인할 수 없습니다";
        });
        const connect = el("span", "cr-connect", "접속");
        connect.title = `${c.sshHost}에 접속`;
        connect.addEventListener("click", (e) => {
          e.stopPropagation();
          this.close();
          this.connect(c);
        });
        row.append(avatar, main, connect);
      } else {
        row.append(el("span", "type-badge shell", "SH"), main);
      }
      row.addEventListener("click", () => this.edit(c));
      this.list.append(row);
    }
  }

  private renderForm() {
    const d = this.draft;
    const isNew = !d.id;
    this.form.replaceChildren();
    this.form.append(
      el("h3", undefined, isNew ? "새 명령어 등록" : d.name || d.command || "명령어"),
      el(
        "p",
        "hint",
        d.type === "ssh-profile"
          ? "SSH 프로필 — 접속하면 원격 zsh 훅이 적용되고, 원격에서 쓴 명령도 따로 집계됩니다."
          : "쉘 명령 — ⌘K 팔레트와 자주 쓰는 명령어 패널에서 바로 실행됩니다.",
      ),
    );

    const typeField = el("div", "field");
    typeField.append(el("label", undefined, "타입"));
    const toggle = el("div", "type-toggle");
    for (const [type, label] of [
      ["shell", "쉘 명령어"],
      ["ssh-profile", "SSH 프로필"],
    ] as [CommandType, string][]) {
      const opt = el("button", d.type === type ? "opt active" : "opt", label);
      opt.type = "button";
      opt.addEventListener("click", () => {
        this.draft.type = type;
        this.errors = {};
        this.renderForm();
      });
      toggle.append(opt);
    }
    typeField.append(toggle);
    this.form.append(typeField);

    for (const spec of FIELDS) {
      if (spec.for !== "both" && spec.for !== d.type) continue;
      const field = el("div", "field");
      const id = `mgmt-${spec.key}`;
      const label = el("label", undefined, spec.label);
      label.htmlFor = id;
      const input = spec.multiline ? el("textarea", "input") : el("input", "input");
      input.id = id;
      if (spec.mono) input.classList.add("mono");
      input.placeholder = spec.placeholder ?? "";
      input.spellcheck = false;
      input.value = String(d[spec.key] ?? "");
      input.addEventListener("input", () => {
        (this.draft as unknown as Record<string, string>)[spec.key] = input.value;
      });
      field.append(label, input);
      if (this.errors[spec.key]) field.append(el("div", "field-error", this.errors[spec.key]));
      else if (spec.hint) field.append(el("div", "field-hint", spec.hint));
      this.form.append(field);

      if (spec.key === "sshHost") this.form.append(this.transportField());
    }

    const actions = el("div", "form-actions");
    const save = el("button", "btn", isNew ? "등록" : "저장");
    save.type = "submit";
    const cancel = el("button", "btn ghost", "닫기");
    cancel.type = "button";
    cancel.addEventListener("click", () => this.close());
    actions.append(save, cancel);
    if (!isNew) {
      const del = el("button", "btn danger", this.deleteArmed ? "정말 삭제" : "삭제");
      del.type = "button";
      del.addEventListener("click", () => void this.remove());
      actions.append(del);
    }
    this.form.append(actions);
  }

  private transportField(): HTMLElement {
    const field = el("div", "field");
    const label = el("label", undefined, "전송 방식");
    label.htmlFor = "mgmt-transport";
    const select = el("select", "input");
    select.id = "mgmt-transport";
    for (const [value, text] of [
      ["auto", "자동 (원격에 mosh-server가 있으면 Mosh)"],
      ["ssh", "SSH"],
      ["mosh", "Mosh"],
    ] as [Transport, string][]) {
      const option = el("option", undefined, text);
      option.value = value;
      option.selected = this.draft.transport === value;
      select.append(option);
    }
    select.addEventListener("change", () => {
      this.draft.transport = select.value as Transport;
    });
    field.append(
      label,
      select,
      el(
        "div",
        "field-hint",
        "Mosh는 Wi-Fi가 바뀌거나 잠깐 끊겨도 세션이 유지됩니다. 이 Mac에도 mosh가 있어야 합니다 (brew install mosh)",
      ),
    );
    return field;
  }

  private async save() {
    const normalized = normalizeCommand(this.draft);
    this.errors = validateCommand(normalized);
    if (Object.keys(this.errors).length > 0) {
      this.renderForm();
      return;
    }
    if (!normalized.id) {
      normalized.id = crypto.randomUUID();
      this.commands.push(normalized);
    } else {
      this.commands = this.commands.map((c) => (c.id === normalized.id ? normalized : c));
    }
    try {
      await this.persist();
    } catch (err) {
      showToast(`저장하지 못했습니다: ${err}`);
      await this.load();
      return;
    }
    this.edit(normalized);
    showToast(`'${normalized.name || normalized.command}' 저장됨`, 2500);
  }

  private async remove() {
    if (!this.deleteArmed) {
      this.deleteArmed = true;
      this.renderForm();
      setTimeout(() => {
        if (this.deleteArmed) {
          this.deleteArmed = false;
          if (this.isOpen) this.renderForm();
        }
      }, 3000);
      return;
    }
    const removed = this.draft;
    this.commands = this.commands.filter((c) => c.id !== removed.id);
    await this.persist();
    this.edit(this.commands[0] ?? emptyCommand());
    showToast(`'${removed.name || removed.command}' 삭제됨`, 2500);
  }
}
