import { invoke } from "@tauri-apps/api/core";
import { chooseDialog } from "./dialog";
import { showToast } from "./toast";

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
    const title = el("h3", undefined, "가드레일 규칙");
    title.append(this.count);
    const add = el("button", "btn", "＋ 새 규칙");
    add.type = "button";
    add.addEventListener("click", () => this.edit(blankRule()));
    head.append(title, add);

    const probeField = el("div", "field");
    this.probe.placeholder = "명령을 입력해 보세요 — 걸리는 규칙이 표시됩니다";
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
    const hits = this.rules.filter((r) => this.matched.has(r.id));
    this.probeResult.textContent = !command.trim()
      ? "패턴은 zsh =~ (POSIX 확장 정규식): \\s 대신 [[:space:]], (?i) 같은 PCRE 문법은 쓸 수 없습니다"
      : hits.length
        ? `걸림: ${hits.map((r) => `${r.label}${r.enabled ? "" : " (꺼짐)"}`).join(", ")}`
        : "걸리는 규칙 없음";
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
        const name = el("div", "cr-name", r.label || "(이름 없음)");
        if (this.invalid.has(r.id)) name.append(el("span", "cr-tag bad", "패턴 오류"));
        main.append(name, el("div", "cr-sub", r.pattern));
        const badge = el(
          "span",
          `type-badge ${r.severity}`,
          r.severity === "block" ? "차단" : "경고",
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
      el("h3", undefined, isNew ? "새 가드레일 규칙" : d.label || "규칙"),
      el(
        "p",
        "hint",
        "Enter를 누른 순간 명령줄 전체를 이 패턴과 비교합니다. 사람이 친 명령·붙여넣기·팔레트 실행 모두 해당됩니다.",
      ),
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
    const sl = el("label", undefined, "심각도");
    const toggle = el("div", "type-toggle");
    for (const [value, label] of [
      ["block", "차단 — Enter 두 번"],
      ["warn", "경고만"],
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
    enabled.append(box, document.createTextNode(" 사용"));

    this.form.append(
      text("label", "이름", "예: 운영 DB 삭제"),
      text("pattern", "패턴", "예: psql.*prod.*DROP", true),
      severity,
      enabled,
    );
    if (this.error) this.form.append(el("div", "field-error", this.error));
    const actions = el("div", "form-actions");
    const save = el("button", "btn", isNew ? "추가" : "저장");
    save.type = "submit";
    actions.append(save);
    if (!isNew) {
      const del = el("button", "btn danger", "삭제");
      del.type = "button";
      del.addEventListener("click", () => void this.remove());
      actions.append(del);
    }
    this.form.append(actions);
  }

  private async save() {
    const d = { ...this.draft, label: this.draft.label.trim(), pattern: this.draft.pattern.trim() };
    if (!d.label || !d.pattern) {
      this.error = "이름과 패턴을 모두 입력하세요";
      return this.renderForm();
    }
    const check = await invoke<{ invalid: string[] }>("guardrail_test", {
      command: "",
      patterns: [["p", d.pattern]],
    });
    if (check.invalid.length) {
      this.error = "zsh가 이 패턴을 해석하지 못합니다 (POSIX 확장 정규식인지 확인하세요)";
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
      showToast("가드레일을 저장했습니다 · 열린 셸은 다음 프롬프트부터 적용 (원격은 다음 접속 때)");
    } catch (err) {
      showToast(`저장하지 못했습니다: ${err}`);
    }
  }

  // ---------- Claude Code ----------

  private claudeSection(): HTMLElement {
    const section = el("div", "guard-claude");
    section.append(
      el("div", "gc-title", "Claude Code 연동"),
      el(
        "div",
        "field-hint",
        "에이전트는 셸 입력줄을 거치지 않고 명령을 실행해서 위 규칙이 닿지 않습니다. 같은 '차단' 규칙으로 Claude Code의 PreToolUse 훅을 설치하면 에이전트의 Bash 호출도 막습니다.",
      ),
    );
    const row = el("div", "form-actions");
    const user = el("button", "btn ghost", "사용자 설정에 설치");
    const project = el("button", "btn ghost", "현재 폴더 프로젝트에 설치");
    user.type = project.type = "button";
    user.addEventListener("click", () => void this.installClaude("user"));
    project.addEventListener("click", () => void this.installClaude("project"));
    row.append(user, project);
    section.append(row);
    return section;
  }

  private async installClaude(scope: "user" | "project") {
    const target = this.activeTarget();
    if (!target) return;
    if (target.foreignShell) {
      showToast(
        "이 탭은 직접 ssh로 들어간 셸이라 설치할 곳을 알 수 없습니다. SSH 프로필 탭에서 해 주세요",
      );
      return;
    }
    if (scope === "project" && !target.cwd) {
      showToast("현재 폴더를 아직 모릅니다 (훅이 있는 셸에서 명령을 한 번 실행해 주세요)");
      return;
    }
    const file =
      scope === "user" ? "~/.claude/settings.json" : `${target.cwd}/.claude/settings.json`;
    const choice = await chooseDialog(
      `${target.hostLabel}의 Claude Code에 가드레일 훅을 설치할까요?`,
      [
        `${file}의 hooks.PreToolUse에 Burrow 항목 하나를 추가합니다. 파일의 다른 설정은 그대로 두고, 바꾸기 전 내용은 settings.json.burrow-bak으로 남깁니다.`,
        "훅 스크립트는 ~/.burrow/claude/guardrail-hook.zsh에 씁니다. '차단' 규칙에 걸리는 Bash 명령을 거부하고 이유를 에이전트에게 알려 줍니다.",
      ],
      [
        { value: "install", label: "설치" },
        { value: "cancel", label: "취소", kind: "ghost" },
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
          ? `설치했습니다: ${result.settings} · 실행 중인 Claude Code는 다시 시작해야 적용됩니다`
          : `이미 설치돼 있어 규칙만 갱신했습니다: ${result.settings}`,
      );
    } catch (err) {
      showToast(`설치하지 못했습니다: ${err}`);
    }
  }
}
