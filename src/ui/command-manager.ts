import { invoke } from "@tauri-apps/api/core";
import {
  emptyCommand,
  normalizeCommand,
  suggestVpnDisconnect,
  validateCommand,
  type CommandType,
  type FieldErrors,
  type StoredCommand,
  type Transport,
} from "./command-validation";
import { showToast } from "./toast";
import { checkReachable } from "./reachability";
import { t, onLocaleChange } from "../i18n";

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

/** Built fresh on every render (instead of a static constant) so it always
 * reflects the current locale — see onLocaleChange in CommandManager. */
function buildFields(): FieldSpec[] {
  return [
    {
      key: "name",
      label: t("commandManager.fields.name.label"),
      for: "both",
      placeholder: t("commandManager.fields.name.placeholder"),
    },
    {
      key: "command",
      label: t("commandManager.fields.command.label"),
      for: "shell",
      placeholder: t("commandManager.fields.command.placeholder"),
      mono: true,
    },
    {
      key: "sshHost",
      label: t("commandManager.fields.sshHost.label"),
      for: "ssh-profile",
      placeholder: t("commandManager.fields.sshHost.placeholder"),
      hint: t("commandManager.fields.sshHost.hint"),
      mono: true,
    },
    {
      key: "tmuxSession",
      label: t("commandManager.fields.tmuxSession.label"),
      for: "ssh-profile",
      placeholder: t("commandManager.fields.tmuxSession.placeholder"),
      hint: t("commandManager.fields.tmuxSession.hint"),
      mono: true,
    },
    {
      key: "vpnPreConnect",
      label: t("commandManager.fields.vpnPreConnect.label"),
      for: "ssh-profile",
      placeholder: t("commandManager.fields.vpnPreConnect.placeholder"),
      hint: t("commandManager.fields.vpnPreConnect.hint"),
      mono: true,
    },
    {
      key: "vpnPostDisconnect",
      label: t("commandManager.fields.vpnPostDisconnect.label"),
      for: "ssh-profile",
      placeholder: t("commandManager.fields.vpnPostDisconnect.placeholder"),
      hint: t("commandManager.fields.vpnPostDisconnect.hint"),
      mono: true,
    },
    {
      key: "description",
      label: t("commandManager.fields.description.label"),
      for: "both",
      multiline: true,
    },
  ];
}

/** Registering, editing and deleting commands and SSH profiles (⌘,). */
export class CommandManager {
  /**
   * Overrides `connect` for the current `open()` session only (cleared on the
   * next `open()`). Lets a caller — the startup connection list's "새 연결"
   * flow — observe that a connection was actually started, without every
   * other caller of `connect` needing to know about that.
   */
  connectOverride?: (profile: StoredCommand) => void;

  private readonly overlay = el("div", "manager-overlay");
  private readonly list = el("div", "mgmt-rows");
  private readonly count = el("span", "mgmt-count");
  private readonly form = el("form", "mgmt-form");
  private readonly listTitleText = el("span");
  private readonly addButton = el("button", "btn");
  private readonly guardButton = el("button", "btn ghost");
  private readonly keysButton = el("button", "btn ghost");
  private commands: StoredCommand[] = [];
  private draft: StoredCommand = emptyCommand();
  private errors: FieldErrors = {};
  private deleteArmed = false;
  private onClose: () => void = () => {};

  constructor(
    private readonly connect: (profile: StoredCommand) => void,
    private readonly openGuardrails: () => void,
    private readonly openKeybindings: () => void,
  ) {
    const box = el("div", "manager");
    const listPane = el("div", "mgmt-list");
    const head = el("div", "mgmt-list-head");
    const title = el("h3");
    title.append(this.listTitleText, this.count);
    this.addButton.type = "button";
    this.addButton.addEventListener("click", () => this.edit(emptyCommand()));
    this.guardButton.type = "button";
    this.guardButton.addEventListener("click", () => {
      this.overlay.hidden = true;
      this.openGuardrails();
    });
    this.keysButton.type = "button";
    this.keysButton.addEventListener("click", () => {
      this.overlay.hidden = true;
      this.openKeybindings();
    });
    const actions = el("div", "mgmt-head-actions");
    actions.append(this.keysButton, this.guardButton, this.addButton);
    head.append(title, actions);
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

    // Lives for the app's lifetime (a top-level singleton, see main.ts), so
    // this subscription is never unsubscribed — same as the other app-lifetime
    // managers.
    onLocaleChange(() => this.retranslate());
    this.retranslate();
  }

  private retranslate() {
    this.listTitleText.textContent = t("commandManager.listTitle");
    this.addButton.textContent = t("commandManager.addNew");
    this.guardButton.textContent = t("commandManager.guardrails");
    this.guardButton.title = t("commandManager.guardrailsTitle");
    this.keysButton.textContent = t("commandManager.keybindings");
    this.renderList();
    this.renderForm();
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  /** Opens the manager, editing `target` (an existing id, or a prefilled new entry). */
  async open(target?: string | Partial<StoredCommand>, onClose?: () => void) {
    this.onClose = onClose ?? (() => {});
    this.connectOverride = undefined;
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
      this.list.append(el("div", "mgmt-empty", t("commandManager.emptyList")));
    }
    for (const c of this.commands) {
      const ssh = c.type === "ssh-profile";
      const row = el("button", ssh ? "cmd-row host-card" : "cmd-row");
      row.type = "button";
      if (c.id === this.draft.id) row.classList.add("sel");

      const main = el("div", "cr-main");
      const name = el("div", "cr-name", c.name || c.command);
      if (ssh && c.tmuxSession)
        name.append(el("span", "cr-tag", t("commandManager.tmuxTag", { session: c.tmuxSession })));
      main.append(name, el("div", "cr-sub", ssh ? (c.sshHost ?? "") : c.command));

      if (ssh) {
        const avatar = el("div", "host-avatar", initials(c));
        const dot = el("span", "h-status unknown");
        dot.title = t("commandManager.checking");
        avatar.append(dot);
        void checkReachable(c.id).then((r) => {
          dot.className = `h-status ${r.state}`;
          dot.title =
            r.state === "online"
              ? t("commandManager.online")
              : r.state === "offline"
                ? t("commandManager.offline", { reason: r.reason })
                : t("commandManager.proxyUnknown");
        });
        const connect = el("span", "cr-connect", t("commandManager.connect"));
        connect.title = t("commandManager.connectTitle", { host: c.sshHost ?? "" });
        connect.addEventListener("click", (e) => {
          e.stopPropagation();
          // connect() first: callers that check "did a connection start?" from
          // the onClose callback (the launcher's new-profile flow) need this
          // to have already happened by the time close() fires onClose.
          (this.connectOverride ?? this.connect)(c);
          this.close();
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
      el(
        "h3",
        undefined,
        isNew ? t("commandManager.newTitle") : d.name || d.command || t("commandManager.untitled"),
      ),
      el(
        "p",
        "hint",
        d.type === "ssh-profile"
          ? t("commandManager.sshProfileHint")
          : t("commandManager.shellHint"),
      ),
    );

    const typeField = el("div", "field");
    typeField.append(el("label", undefined, t("commandManager.type")));
    const toggle = el("div", "type-toggle");
    for (const [type, label] of [
      ["shell", t("commandManager.typeShell")],
      ["ssh-profile", t("commandManager.typeSshProfile")],
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

    for (const spec of buildFields()) {
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
      const errorKey = this.errors[spec.key];
      if (errorKey)
        field.append(el("div", "field-error", t(`commandManager.validation.${errorKey}`)));
      else if (spec.hint) field.append(el("div", "field-hint", spec.hint));
      this.form.append(field);

      if (spec.key === "sshHost") this.form.append(this.transportField());
      if (spec.key === "vpnPreConnect") this.form.append(this.homeNetworksField());
      if (spec.key === "vpnPostDisconnect") {
        const suggest = el("button", "btn ghost vpn-suggest", t("commandManager.vpnAutofill"));
        suggest.type = "button";
        suggest.addEventListener("click", () => {
          const guess = suggestVpnDisconnect(this.draft.vpnPreConnect ?? "");
          if (guess) {
            this.draft.vpnPostDisconnect = guess;
            this.renderForm();
          } else {
            showToast(t("commandManager.vpnAutofillFailed"));
          }
        });
        field.append(suggest);
      }
    }

    const actions = el("div", "form-actions");
    const save = el(
      "button",
      "btn",
      isNew ? t("commandManager.register") : t("commandManager.save"),
    );
    save.type = "submit";
    const cancel = el("button", "btn ghost", t("commandManager.close"));
    cancel.type = "button";
    cancel.addEventListener("click", () => this.close());
    actions.append(save, cancel);
    if (!isNew) {
      const del = el(
        "button",
        "btn danger",
        this.deleteArmed ? t("commandManager.deleteConfirm") : t("commandManager.delete"),
      );
      del.type = "button";
      del.addEventListener("click", () => void this.remove());
      actions.append(del);
    }
    this.form.append(actions);
  }

  /** Networks where the VPN step is skipped; others always run it first. */
  private homeNetworksField(): HTMLElement {
    const field = el("div", "field");
    field.append(el("label", undefined, t("commandManager.homeNetworks.label")));
    const list = el("div", "home-nets");
    const nets = this.draft.homeNetworks ?? [];
    for (const net of nets) {
      const chip = el("span", "home-net", net.name);
      chip.title = t("commandManager.homeNetworks.gateway", { mac: net.gatewayMac });
      const remove = el("button", "home-net-x", "×");
      remove.type = "button";
      remove.title = t("commandManager.homeNetworks.remove");
      remove.addEventListener("click", () => {
        this.draft.homeNetworks = nets.filter((n) => n.gatewayMac !== net.gatewayMac);
        this.renderForm();
      });
      chip.append(remove);
      list.append(chip);
    }
    const add = el("button", "btn ghost", t("commandManager.homeNetworks.add"));
    add.type = "button";
    add.addEventListener("click", async () => {
      const fp = await invoke<{ gateway: string; gatewayMac: string } | null>(
        "network_fingerprint",
      );
      if (!fp) return showToast(t("commandManager.homeNetworks.unknownNetwork"));
      if (nets.some((n) => n.gatewayMac === fp.gatewayMac))
        return showToast(t("commandManager.homeNetworks.alreadyAdded"));
      this.draft.homeNetworks = [
        ...nets,
        {
          gatewayMac: fp.gatewayMac,
          name: t("commandManager.homeNetworks.homeName", { gateway: fp.gateway }),
        },
      ];
      this.renderForm();
    });
    list.append(add);
    field.append(
      list,
      el(
        "div",
        "field-hint",
        nets.length
          ? t("commandManager.homeNetworks.hintWithNetworks")
          : t("commandManager.homeNetworks.hintEmpty"),
      ),
    );
    return field;
  }

  private transportField(): HTMLElement {
    const field = el("div", "field");
    const label = el("label", undefined, t("commandManager.transport.label"));
    label.htmlFor = "mgmt-transport";
    const select = el("select", "input");
    select.id = "mgmt-transport";
    for (const [value, text] of [
      ["auto", t("commandManager.transport.auto")],
      ["ssh", t("commandManager.transport.ssh")],
      ["mosh", t("commandManager.transport.mosh")],
    ] as [Transport, string][]) {
      const option = el("option", undefined, text);
      option.value = value;
      option.selected = this.draft.transport === value;
      select.append(option);
    }
    select.addEventListener("change", () => {
      this.draft.transport = select.value as Transport;
    });
    field.append(label, select, el("div", "field-hint", t("commandManager.transport.hint")));
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
      showToast(t("commandManager.saveFailed", { error: String(err) }));
      await this.load();
      return;
    }
    this.edit(normalized);
    showToast(t("commandManager.saved", { name: normalized.name || normalized.command }), 2500);
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
    showToast(t("commandManager.deleted", { name: removed.name || removed.command }), 2500);
  }
}
