import { invoke } from "@tauri-apps/api/core";
import { chooseDialog } from "./dialog";
import { showToast } from "./toast";
import { t, onLocaleChange } from "../i18n";

interface Rule {
  id: string;
  pattern: string;
  severity: "block" | "warn";
  label: string;
  enabled: boolean;
}

/** Where the active tab is, for installing the Claude Code hook there. */
export interface ActiveTarget {
  /** SSH profile of the tab; undefined for this Mac. */
  profileId?: string;
  /** "이 Mac" or the profile name. */
  hostLabel: string;
  cwd: string;
  /** A local tab that ssh'd somewhere by hand: its cwd isn't on this Mac. */
  foreignShell: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const blankRule = (): Rule => ({
  id: "",
  pattern: "",
  severity: "block",
  label: "",
  enabled: true,
});

/** CRUD for guardrails.json, plus the Claude Code hook install. */
export class GuardrailManager {
  private readonly overlay = el("div", "manager-overlay");
  private readonly list = el("div", "mgmt-rows");
  private readonly count = el("span", "mgmt-count");
  private readonly form = el("form", "mgmt-form");
  private readonly probe = el("input", "input mono");
  private readonly probeResult = el("div", "field-hint");
  private readonly titleText = el("span");
  private readonly title = el("h3");
  private readonly addButton = el("button", "btn");
  private readonly claudeTitle = el("div", "gc-title");
  private readonly claudeHint = el("div", "field-hint");
  private readonly claudeUserButton = el("button", "btn ghost");
  private readonly claudeProjectButton = el("button", "btn ghost");
  private rules: Rule[] = [];
  private draft: Rule = blankRule();
  private error = "";
  private matched = new Set<string>();
  private invalid = new Set<string>();
  private onClose: () => void = () => {};

  constructor(private readonly activeTarget: () => ActiveTarget | undefined) {
    const box = el("div", "manager");
    const listPane = el("div", "mgmt-list");
    const head = el("div", "mgmt-list-head");
    this.title.append(this.titleText, this.count);
    this.addButton.type = "button";
    this.addButton.addEventListener("click", () => this.edit(blankRule()));
    head.append(this.title, this.addButton);

    const probeField = el("div", "field");
    this.probe.spellcheck = false;
    this.probe.addEventListener("input", () => void this.test());
    probeField.append(this.probe, this.probeResult);

    listPane.append(head, probeField, this.list, this.claudeSection());
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
    // this subscription is never unsubscribed — same as command-manager.ts.
    onLocaleChange(() => this.retranslate());
    this.retranslate();
  }

  private retranslate() {
    this.titleText.textContent = t("guardrailManager.title");
    this.addButton.textContent = t("guardrailManager.newRule");
    this.probe.placeholder = t("guardrailManager.probePlaceholder");
    this.claudeTitle.textContent = t("guardrailManager.claudeTitle");
    this.claudeHint.textContent = t("guardrailManager.claudeHint");
    this.claudeUserButton.textContent = t("guardrailManager.installUser");
    this.claudeProjectButton.textContent = t("guardrailManager.installProject");
    this.renderProbeResult();
    this.renderList();
    this.renderForm();
  }

  get isOpen() {
    return !this.overlay.hidden;
  }

  async open(onClose?: () => void) {
    this.onClose = onClose ?? (() => {});
    const file = await invoke<{ rules: Rule[] }>("store_get", { kind: "guardrails" });
    this.rules = file.rules;
    this.overlay.hidden = false;
    this.edit(this.rules[0] ?? blankRule());
    await this.test();
  }

  close() {
    this.overlay.hidden = true;
    this.onClose();
  }

  private edit(rule: Rule) {
    this.draft = { ...rule };
    this.error = "";
    this.renderList();
    this.renderForm();
  }

  /** Runs the probe line through zsh against every rule (enabled or not). */
  private async test() {
    const command = this.probe.value;
    try {
      const result = await invoke<{ matched: string[]; invalid: string[] }>("guardrail_test", {
        command,
        patterns: this.rules.map((r) => [r.id, r.pattern]),
      });
      this.matched = new Set(command.trim() ? result.matched : []);
      this.invalid = new Set(result.invalid);
    } catch {
      this.matched.clear();
    }
    this.renderProbeResult();
  }

  private renderProbeResult() {
    const command = this.probe.value;
    const hits = this.rules.filter((r) => this.matched.has(r.id));
    this.probeResult.textContent = !command.trim()
      ? t("guardrailManager.probeHelp")
      : hits.length
        ? t("guardrailManager.probeHit", {
            list: hits
              .map((r) => `${r.label}${r.enabled ? "" : t("guardrailManager.disabledSuffix")}`)
              .join(", "),
          })
        : t("guardrailManager.noHits");
    this.renderList();
  }

  private renderList() {
    this.count.textContent = ` · ${this.rules.length}`;
    this.list.replaceChildren(
      ...this.rules.map((r) => {
        const row = el("button", "cmd-row guard-row");
        row.type = "button";
        if (r.id === this.draft.id) row.classList.add("sel");
        if (this.matched.has(r.id)) row.classList.add("hit");
        if (!r.enabled) row.classList.add("off");
        const main = el("div", "cr-main");
        const name = el("div", "cr-name", r.label || t("guardrailManager.unnamed"));
        if (this.invalid.has(r.id))
          name.append(el("span", "cr-tag bad", t("guardrailManager.patternError")));
        main.append(name, el("div", "cr-sub", r.pattern));
        const badge = el(
          "span",
          `type-badge ${r.severity}`,
          r.severity === "block"
            ? t("guardrailManager.severityBlock")
            : t("guardrailManager.severityWarn"),
        );
        row.append(badge, main);
        row.addEventListener("click", () => this.edit(r));
        return row;
      }),
    );
  }

  private renderForm() {
    const d = this.draft;
    const isNew = !d.id;
    this.form.replaceChildren(
      el(
        "h3",
        undefined,
        isNew ? t("guardrailManager.newRuleTitle") : d.label || t("guardrailManager.untitledRule"),
      ),
      el("p", "hint", t("guardrailManager.formHint")),
    );
    const text = (key: "label" | "pattern", label: string, placeholder: string, mono = false) => {
      const field = el("div", "field");
      const l = el("label", undefined, label);
      const input = el("input", mono ? "input mono" : "input");
      input.id = `guard-${key}`;
      l.htmlFor = input.id;
      input.value = d[key];
      input.placeholder = placeholder;
      input.spellcheck = false;
      input.addEventListener("input", () => (this.draft[key] = input.value));
      field.append(l, input);
      return field;
    };
    const severity = el("div", "field");
    const sl = el("label", undefined, t("guardrailManager.severityLabel"));
    const toggle = el("div", "type-toggle");
    for (const [value, label] of [
      ["block", t("guardrailManager.severityBlockOption")],
      ["warn", t("guardrailManager.severityWarnOption")],
    ] as const) {
      const opt = el("button", d.severity === value ? "opt active" : "opt", label);
      opt.type = "button";
      opt.addEventListener("click", () => {
        this.draft.severity = value;
        this.renderForm();
      });
      toggle.append(opt);
    }
    severity.append(sl, toggle);
    const enabled = el("label", "check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = d.enabled;
    box.addEventListener("change", () => (this.draft.enabled = box.checked));
    enabled.append(box, document.createTextNode(t("guardrailManager.enabledLabel")));

    this.form.append(
      text(
        "label",
        t("guardrailManager.fields.label.label"),
        t("guardrailManager.fields.label.placeholder"),
      ),
      text(
        "pattern",
        t("guardrailManager.fields.pattern.label"),
        t("guardrailManager.fields.pattern.placeholder"),
        true,
      ),
      severity,
      enabled,
    );
    if (this.error) this.form.append(el("div", "field-error", this.error));
    const actions = el("div", "form-actions");
    const save = el(
      "button",
      "btn",
      isNew ? t("guardrailManager.add") : t("guardrailManager.save"),
    );
    save.type = "submit";
    actions.append(save);
    if (!isNew) {
      const del = el("button", "btn danger", t("guardrailManager.delete"));
      del.type = "button";
      del.addEventListener("click", () => void this.remove());
      actions.append(del);
    }
    this.form.append(actions);
  }

  private async save() {
    const d = { ...this.draft, label: this.draft.label.trim(), pattern: this.draft.pattern.trim() };
    if (!d.label || !d.pattern) {
      this.error = t("guardrailManager.validationRequired");
      return this.renderForm();
    }
    const check = await invoke<{ invalid: string[] }>("guardrail_test", {
      command: "",
      patterns: [["p", d.pattern]],
    });
    if (check.invalid.length) {
      this.error = t("guardrailManager.invalidPattern");
      return this.renderForm();
    }
    if (!d.id) {
      d.id = crypto.randomUUID();
      this.rules.push(d);
    } else {
      this.rules = this.rules.map((r) => (r.id === d.id ? d : r));
    }
    await this.persist();
    this.edit(d);
    await this.test();
  }

  private async remove() {
    this.rules = this.rules.filter((r) => r.id !== this.draft.id);
    await this.persist();
    this.edit(this.rules[0] ?? blankRule());
  }

  private async persist() {
    try {
      await invoke("store_put", { kind: "guardrails", value: { version: 1, rules: this.rules } });
      showToast(t("guardrailManager.saved"));
    } catch (err) {
      showToast(t("guardrailManager.saveFailed", { error: String(err) }));
    }
  }

  // ---------- Claude Code ----------

  private claudeSection(): HTMLElement {
    const section = el("div", "guard-claude");
    section.append(this.claudeTitle, this.claudeHint);
    const row = el("div", "form-actions");
    this.claudeUserButton.type = this.claudeProjectButton.type = "button";
    this.claudeUserButton.addEventListener("click", () => void this.installClaude("user"));
    this.claudeProjectButton.addEventListener("click", () => void this.installClaude("project"));
    row.append(this.claudeUserButton, this.claudeProjectButton);
    section.append(row);
    return section;
  }

  private async installClaude(scope: "user" | "project") {
    const target = this.activeTarget();
    if (!target) return;
    if (target.foreignShell) {
      showToast(t("guardrailManager.foreignShellInstall"));
      return;
    }
    if (scope === "project" && !target.cwd) {
      showToast(t("guardrailManager.unknownCwd"));
      return;
    }
    const file =
      scope === "user" ? "~/.claude/settings.json" : `${target.cwd}/.claude/settings.json`;
    const choice = await chooseDialog(
      t("guardrailManager.installConfirmTitle", { host: target.hostLabel }),
      [
        t("guardrailManager.installConfirmBody1", { file }),
        t("guardrailManager.installConfirmBody2"),
      ],
      [
        { value: "install", label: t("guardrailManager.install") },
        { value: "cancel", label: t("guardrailManager.cancel"), kind: "ghost" },
      ],
    );
    if (choice !== "install") return;
    try {
      const result = await invoke<{ settings: string; added: boolean }>("claude_hook_install", {
        target:
          scope === "user"
            ? { scope: "user", profileId: target.profileId ?? null }
            : { scope: "project", profileId: target.profileId ?? null, dir: target.cwd },
      });
      showToast(
        result.added
          ? t("guardrailManager.installed", { settings: result.settings })
          : t("guardrailManager.alreadyInstalled", { settings: result.settings }),
      );
    } catch (err) {
      showToast(t("guardrailManager.installFailed", { error: String(err) }));
    }
  }
}
