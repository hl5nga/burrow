import { invoke } from "@tauri-apps/api/core";
import { t, onLocaleChange } from "../i18n";

const POLL_MS = 10_000;

/**
 * A small "does this Mac have internet at all" indicator, next to the VPN and
 * resource chips. Distinct from a profile's own host reachability (T12):
 * this one is about the internet in general, not any particular host.
 */
export class NetworkChip {
  private readonly chip = document.createElement("span");
  private online = true;

  constructor(corner: HTMLElement) {
    this.chip.className = "rm-chip net";
    corner.append(this.chip);
    void this.refresh();
    window.setInterval(() => void this.refresh(), POLL_MS);

    // Lives for the app's lifetime (a top-level singleton, see main.ts), so
    // this subscription is never unsubscribed — same as command-manager.ts.
    onLocaleChange(() => this.render());
  }

  private async refresh() {
    let online = true;
    try {
      online = await invoke<boolean>("network_online");
    } catch {
      online = true; // Fail open: a broken check must not read as "offline".
    }
    this.online = online;
    this.render();
  }

  private render() {
    const online = this.online;
    this.chip.classList.toggle("offline", !online);
    this.chip.textContent = online ? "🌐" : t("networkChip.offlineLabel");
    this.chip.title = online ? t("networkChip.onlineTitle") : t("networkChip.offlineTitle");
  }
}
