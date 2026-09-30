import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./toast";
import { t, onLocaleChange } from "../i18n";

export interface VpnService {
  name: string;
  kind: string;
  connected: boolean;
  transitioning: boolean;
  detail: string | null;
}

/** How long a connect/disconnect may take before the card gives up waiting. */
const TOGGLE_WAIT_MS = 25_000;

const POLL_MS = 8000;

const LOCK_CLOSED = `<svg class="rm-icon" viewBox="0 0 16 16" fill="none"><rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" stroke-width="1.4"/></svg>`;
const LOCK_OPEN = `<svg class="rm-icon" viewBox="0 0 16 16" fill="none"><rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

function ago(since: number): string {
  const minutes = Math.floor((Date.now() - since) / 60000);
  if (minutes < 1) return t("vpnChip.justConnected");
  if (minutes < 60) return t("vpnChip.connectedMinutes", { minutes: String(minutes) });
  return t("vpnChip.connectedHoursMinutes", {
    hours: String(Math.floor(minutes / 60)),
    minutes: String(minutes % 60),
  });
}

/** Lock chip in the terminal's top-right corner; click for the service list. */
export class VpnChip {
  private readonly chip = document.createElement("button");
  private readonly card = document.createElement("div");
  private services: VpnService[] = [];
  /** When Burrow first saw each service connected (macOS doesn't say). */
  private readonly since = new Map<string, number>();
  private timer = 0;
  /** Services the user just asked to change: key → wanted state and deadline. */
  private readonly pending = new Map<string, { up: boolean; until: number }>();

  constructor(corner: HTMLElement) {
    this.chip.className = "rm-chip vpn";
    this.chip.hidden = true;
    this.card.className = "res-hud vpn-card";
    this.card.hidden = true;
    corner.append(this.chip, this.card);
    this.chip.addEventListener("click", (e) => {
      e.stopPropagation();
      this.card.hidden = !this.card.hidden;
      this.renderCard();
    });
    document.addEventListener("mousedown", (e) => {
      if (!this.card.hidden && !this.card.contains(e.target as Node) && e.target !== this.chip) {
        this.card.hidden = true;
      }
    });
    void this.refresh();

    // Lives for the app's lifetime (a top-level singleton, see main.ts), so
    // this subscription is never unsubscribed — same as command-manager.ts.
    onLocaleChange(() => this.render());
  }

  /** Polls now and restarts the interval, e.g. right after a pre-connect command. */
  async refresh(): Promise<VpnService[]> {
    window.clearTimeout(this.timer);
    try {
      this.services = await invoke<VpnService[]>("vpn_status");
    } catch {
      this.services = [];
    }
    const key = (s: VpnService) => `${s.kind}:${s.name}`;
    for (const s of this.services) {
      if (s.connected && !this.since.has(key(s))) this.since.set(key(s), Date.now());
      if (!s.connected) this.since.delete(key(s));
    }
    for (const [k, want] of this.pending) {
      const svc = this.services.find((x) => key(x) === k);
      if (svc && svc.connected === want.up && !svc.transitioning) {
        this.pending.delete(k);
      } else if (Date.now() > want.until) {
        this.pending.delete(k);
        showToast(
          want.up
            ? t("vpnChip.connectFailed", { name: svc?.name ?? "VPN" })
            : t("vpnChip.disconnectFailed", { name: svc?.name ?? "VPN" }),
        );
      }
    }
    this.render();
    // Poll fast while something is switching, slowly otherwise.
    this.timer = window.setTimeout(() => void this.refresh(), this.pending.size ? 1000 : POLL_MS);
    return this.services;
  }

  /** Only on the user's click: switching a VPN changes this Mac's network. */
  private async toggle(s: VpnService, up: boolean) {
    const k = `${s.kind}:${s.name}`;
    this.pending.set(k, { up, until: Date.now() + TOGGLE_WAIT_MS });
    this.renderCard();
    try {
      await invoke("vpn_toggle", { kind: s.kind, name: s.name, up });
    } catch (err) {
      this.pending.delete(k);
      showToast(t("vpnChip.toggleFailed", { name: s.name, error: String(err) }));
    }
    void this.refresh();
  }

  private render() {
    // No VPN configured at all: nothing worth a chip.
    this.chip.hidden = this.services.length === 0;
    const up = this.services.filter((s) => s.connected);
    this.chip.classList.toggle("connected", up.length > 0);
    this.chip.innerHTML = `${up.length ? LOCK_CLOSED : LOCK_OPEN}<span>${up.length ? "VPN" : t("vpnChip.off")}</span>`;
    this.chip.title = up.length
      ? t("vpnChip.connectedTitle", { names: up.map((s) => s.name).join(", ") })
      : t("vpnChip.noneConnectedTitle");
    if (!this.card.hidden) this.renderCard();
  }

  private renderCard() {
    const head = document.createElement("div");
    head.className = "rh-head";
    head.textContent = "VPN";
    const rows = this.services.map((s) => {
      const row = document.createElement("div");
      row.className = `vpn-row${s.connected ? " on" : ""}`;
      const dot = document.createElement("span");
      dot.className = "vpn-dot";
      const name = document.createElement("span");
      name.className = "vpn-name";
      name.textContent = s.kind === "utun" ? t("vpnChip.unknownVpn", { name: s.name }) : s.name;
      const sub = document.createElement("span");
      sub.className = "vpn-sub";
      const since = this.since.get(`${s.kind}:${s.name}`);
      sub.textContent = [
        s.connected && since
          ? ago(since)
          : s.connected
            ? t("vpnChip.connected")
            : t("vpnChip.disconnected"),
        s.detail,
      ]
        .filter(Boolean)
        .join(" · ");
      row.append(dot, name, sub);
      if (s.kind === "macOS" || s.kind === "Tailscale") {
        const k = `${s.kind}:${s.name}`;
        const want = this.pending.get(k);
        const btn = document.createElement("button");
        btn.className = s.connected ? "vpn-toggle on" : "vpn-toggle";
        btn.disabled = !!want || s.transitioning;
        btn.textContent =
          want || s.transitioning
            ? want?.up === false
              ? t("vpnChip.disconnecting")
              : t("vpnChip.connecting")
            : s.connected
              ? t("vpnChip.disconnect")
              : t("vpnChip.connect");
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.toggle(s, !s.connected);
        });
        row.append(btn);
      }
      return row;
    });
    const note = document.createElement("div");
    note.className = "vpn-note";
    note.textContent = t("vpnChip.note");
    this.card.replaceChildren(head, ...rows, note);
  }
}
