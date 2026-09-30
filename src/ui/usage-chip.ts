import { invoke } from "@tauri-apps/api/core";
import { t, onLocaleChange } from "../i18n";
import { showToast } from "./toast";
import type { ResourceTarget } from "./resource-chip";

interface Window {
  percent: number;
  resetsAt?: number;
}

interface UsageSample {
  installed: boolean;
  ageSecs?: number;
  fiveHour?: Window;
  sevenDay?: Window;
  noLimits: boolean;
}

const POLL_MS = 30_000;

type UsageLevel = "ok" | "warn" | "high";
const usageLevel = (percent: number): UsageLevel =>
  percent >= 90 ? "high" : percent >= 70 ? "warn" : "ok";

/** "2h 10m" / "35m" / "3d 4h" until a unix-seconds instant. */
function until(resetsAt: number): string {
  const secs = Math.max(0, resetsAt - Date.now() / 1000);
  const mins = Math.floor(secs / 60);
  if (mins >= 24 * 60) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m`;
}

/**
 * Claude Code's 5-hour and weekly usage for the active tab's host, in the top
 * corner. The numbers come from Claude Code's status-line hook (see usage.rs),
 * which has to be installed on each host once — the card has the button.
 */
export class UsageMonitor {
  private readonly chip = document.createElement("button");
  private readonly card = document.createElement("div");
  private readonly samples = new Map<string, { at: number; sample: UsageSample }>();
  private readonly inFlight = new Set<string>();
  private active?: ResourceTarget;

  constructor(
    corner: HTMLElement,
    private readonly targets: () => ResourceTarget[],
  ) {
    this.chip.className = "rm-group usage-chip";
    this.chip.hidden = true;
    this.card.className = "res-hud res-card usage-card";
    this.card.hidden = true;
    corner.prepend(this.chip);
    corner.append(this.card);
    this.chip.addEventListener("click", (e) => {
      e.stopPropagation();
      this.card.hidden = !this.card.hidden;
      this.render();
    });
    document.addEventListener("mousedown", (e) => {
      if (
        !this.card.hidden &&
        !this.card.contains(e.target as Node) &&
        !this.chip.contains(e.target as Node)
      ) {
        this.card.hidden = true;
      }
    });
    window.setInterval(() => this.tick(), 1000);
    // Lives for the app's lifetime, like the other corner chips.
    onLocaleChange(() => this.render());
  }

  activeChanged() {
    this.tick();
    this.render();
  }

  private key(target: ResourceTarget) {
    return target.profileId ?? "local";
  }

  private tick() {
    this.active = this.targets().find((x) => x.active);
    const target = this.active;
    if (!target || !target.reachable) return this.render();
    const key = this.key(target);
    const hit = this.samples.get(key);
    if (this.inFlight.has(key) || (hit && Date.now() - hit.at < POLL_MS)) return;
    void this.fetch(target, key);
  }

  private async fetch(target: ResourceTarget, key: string) {
    this.inFlight.add(key);
    try {
      const sample = await invoke<UsageSample>("usage_sample", {
        profileId: target.profileId ?? null,
      });
      this.samples.set(key, { at: Date.now(), sample });
    } catch {
      // Unreachable host or no shell access: keep the last numbers, retry later.
      const old = this.samples.get(key);
      if (old) old.at = Date.now();
    } finally {
      this.inFlight.delete(key);
    }
    if (this.active && this.key(this.active) === key) this.render();
  }

  private async install(target: ResourceTarget, remove: boolean) {
    try {
      await invoke(remove ? "usage_uninstall" : "usage_install", {
        profileId: target.profileId ?? null,
      });
      showToast(t(remove ? "usageChip.removed" : "usageChip.installed", { label: target.label }));
    } catch (err) {
      showToast(t("usageChip.failed", { error: String(err) }));
    }
    this.samples.delete(this.key(target));
    this.tick();
  }

  private render() {
    const target = this.active;
    const hit = target?.reachable ? this.samples.get(this.key(target)) : undefined;
    this.chip.hidden = !hit || !target;
    if (!hit || !target) {
      this.card.hidden = true;
      return;
    }
    const s = hit.sample;
    const cell = (label: string, w?: Window) =>
      `<span class="rm-chip ${w ? usageLevel(w.percent) : ""}">${label} ${
        w ? `${Math.round(w.percent)}%` : "–"
      }</span>`;
    this.chip.innerHTML = cell("5h", s.fiveHour) + cell(t("usageChip.weekShort"), s.sevenDay);
    this.chip.title = t("usageChip.title");
    if (this.card.hidden) return;

    const head = document.createElement("div");
    head.className = "rh-head";
    head.textContent = `${t("usageChip.cardTitle")} · ${target.label}`;
    const body = document.createElement("div");
    const bar = (name: string, w: Window) => {
      const p = Math.round(w.percent);
      const reset = w.resetsAt ? t("usageChip.resetsIn", { time: until(w.resetsAt) }) : "";
      return `
        <div class="rh-row"><span>${name}</span><span class="rh-val ${usageLevel(p)}">${p}%</span></div>
        <div class="rh-bar"><div class="rh-fill ${usageLevel(p)}" style="width:${Math.min(p, 100)}%"></div></div>
        <div class="rh-detail">${reset}</div>`;
    };
    if (s.fiveHour) body.innerHTML += bar(t("usageChip.fiveHour"), s.fiveHour);
    if (s.sevenDay) body.innerHTML += bar(t("usageChip.weekly"), s.sevenDay);
    const note = document.createElement("div");
    note.className = "rh-detail usage-note";
    if (!s.installed) note.textContent = t("usageChip.notInstalled");
    else if (s.noLimits) note.textContent = t("usageChip.noLimits");
    else if (!s.fiveHour && !s.sevenDay) note.textContent = t("usageChip.waiting");
    else if (s.ageSecs !== undefined && s.ageSecs > 120)
      note.textContent = t("usageChip.stale", { min: String(Math.round(s.ageSecs / 60)) });
    const button = document.createElement("button");
    button.className = "btn ghost usage-action";
    button.textContent = t(s.installed ? "usageChip.remove" : "usageChip.install");
    button.addEventListener("click", () => void this.install(target, s.installed));
    body.append(note, button);
    this.card.replaceChildren(head, body);
  }
}
