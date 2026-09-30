import { invoke } from "@tauri-apps/api/core";
import { t, onLocaleChange } from "../i18n";

export interface ResourceSample {
  cpu: number;
  cores: number;
  memUsed: number;
  memTotal: number;
}

export type Level = "ok" | "warn" | "high";

/** One tab's host, as the resource monitor sees it. */
export interface ResourceTarget {
  /** Profile id for SSH tabs; undefined samples this Mac. */
  profileId?: string;
  label: string;
  active: boolean;
  /** False while an SSH tab is reconnecting or offline. */
  reachable: boolean;
  setLevel(level: Level | undefined): void;
}

const ACTIVE_MS = 5000;
const BACKGROUND_MS = 30_000;

export function level(percent: number): Level {
  if (percent > 85) return "high";
  if (percent >= 60) return "warn";
  return "ok";
}

const CPU_ICON = `<svg class="rm-icon" viewBox="0 0 16 16" fill="none"><rect x="4" y="4" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.4"/><path d="M6 1.5V4M10 1.5V4M6 12V14.5M10 12V14.5M1.5 6H4M1.5 10H4M12 6H14.5M12 10H14.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
const RAM_ICON = `<svg class="rm-icon" viewBox="0 0 16 16" fill="none"><rect x="2" y="5" width="12" height="7" rx="1" stroke="currentColor" stroke-width="1.4"/><path d="M5 5V2.5M8 5V2.5M11 5V2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

/**
 * CPU/RAM chips for the active tab's host, polled every 5 seconds; other tabs'
 * hosts are polled every 30 seconds just for their tab dots.
 */
export class ResourceMonitor {
  private readonly chips = document.createElement("button");
  private readonly card = document.createElement("div");
  private readonly samples = new Map<string, { at: number; sample: ResourceSample }>();
  private readonly inFlight = new Set<string>();
  /** Hosts whose last sample failed, so they're retried slowly. */
  private readonly failedAt = new Map<string, number>();
  private active?: ResourceTarget;

  constructor(
    corner: HTMLElement,
    private readonly targets: () => ResourceTarget[],
  ) {
    this.chips.className = "rm-group";
    this.chips.hidden = true;
    this.card.className = "res-hud res-card";
    this.card.hidden = true;
    corner.prepend(this.chips);
    corner.append(this.card);
    this.chips.addEventListener("click", (e) => {
      e.stopPropagation();
      this.card.hidden = !this.card.hidden;
      this.render();
    });
    document.addEventListener("mousedown", (e) => {
      if (
        !this.card.hidden &&
        !this.card.contains(e.target as Node) &&
        !this.chips.contains(e.target as Node)
      ) {
        this.card.hidden = true;
      }
    });
    window.setInterval(() => this.tick(), 1000);

    // Lives for the app's lifetime (a top-level singleton, see main.ts), so
    // this subscription is never unsubscribed — same as command-manager.ts.
    onLocaleChange(() => this.render());
  }

  /** The active tab changed: show what we have now, fetch if it's stale. */
  activeChanged() {
    this.tick();
    this.render();
  }

  private key(t: ResourceTarget) {
    return t.profileId ?? "local";
  }

  private tick() {
    const all = this.targets();
    this.active = all.find((t) => t.active);
    const seen = new Set<string>();
    for (const t of all) {
      const key = this.key(t);
      const hit = this.samples.get(key);
      t.setLevel(
        hit && t.reachable
          ? level(Math.max(hit.sample.cpu, this.memPercent(hit.sample)))
          : undefined,
      );
      if (seen.has(key) && !t.active) continue;
      seen.add(key);
      const every = t.active ? ACTIVE_MS : BACKGROUND_MS;
      if (!t.reachable || this.inFlight.has(key)) continue;
      const failed = this.failedAt.get(key);
      if (failed && Date.now() - failed < BACKGROUND_MS) continue;
      if (hit && Date.now() - hit.at < every) continue;
      void this.fetch(t, key);
    }
  }

  private async fetch(t: ResourceTarget, key: string) {
    this.inFlight.add(key);
    try {
      const sample = await invoke<ResourceSample>("resource_sample", {
        profileId: t.profileId ?? null,
      });
      this.samples.set(key, { at: Date.now(), sample });
      this.failedAt.delete(key);
    } catch {
      // Unreachable or unsupported OS: hide the chip for this host for a while.
      this.samples.delete(key);
      this.failedAt.set(key, Date.now());
    } finally {
      this.inFlight.delete(key);
    }
    if (this.active && this.key(this.active) === key) this.render();
  }

  private memPercent(s: ResourceSample) {
    return s.memTotal ? (100 * s.memUsed) / s.memTotal : 0;
  }

  private render() {
    const target = this.active;
    const hit = target && target.reachable ? this.samples.get(this.key(target)) : undefined;
    this.chips.hidden = !hit;
    if (!hit || !target) {
      this.card.hidden = true;
      return;
    }
    const s = hit.sample;
    const cpu = Math.round(s.cpu);
    const mem = Math.round(this.memPercent(s));
    this.chips.innerHTML =
      `<span class="rm-chip ${level(cpu)}">${CPU_ICON}${cpu}%</span>` +
      `<span class="rm-chip ${level(mem)}">${RAM_ICON}${mem}%</span>`;
    this.chips.title = t("resourceChip.cardTitleWithStats", {
      label: target.label,
      cpu: String(cpu),
      mem: String(mem),
    });
    if (this.card.hidden) return;
    const bar = (name: string, percent: number, detail: string) => `
      <div class="rh-row"><span>${name}</span><span class="rh-val ${level(percent)}">${percent}%</span></div>
      <div class="rh-bar"><div class="rh-fill ${level(percent)}" style="width:${percent}%"></div></div>
      <div class="rh-detail">${detail}</div>`;
    const head = document.createElement("div");
    head.className = "rh-head";
    head.textContent = target.label;
    const body = document.createElement("div");
    body.innerHTML =
      bar("CPU", cpu, t("resourceChip.cpuDetail", { cores: String(s.cores) })) +
      bar(t("resourceChip.memoryLabel"), mem, `${gb(s.memUsed)} / ${gb(s.memTotal)} GB`);
    this.card.replaceChildren(head, body);
  }
}
