import { invoke } from "@tauri-apps/api/core";

const POLL_MS = 10_000;

/**
 * A small "does this Mac have internet at all" indicator, next to the VPN and
 * resource chips. Distinct from a profile's own host reachability (T12):
 * this one is about the internet in general, not any particular host.
 */
export class NetworkChip {
  private readonly chip = document.createElement("span");

  constructor(corner: HTMLElement) {
    this.chip.className = "rm-chip net";
    corner.append(this.chip);
    void this.refresh();
    window.setInterval(() => void this.refresh(), POLL_MS);
  }

  private async refresh() {
    let online = true;
    try {
      online = await invoke<boolean>("network_online");
    } catch {
      online = true; // Fail open: a broken check must not read as "offline".
    }
    this.chip.classList.toggle("offline", !online);
    this.chip.textContent = online ? "🌐" : "🌐 오프라인";
    this.chip.title = online ? "인터넷 연결됨" : "인터넷 연결 없음";
  }
}
