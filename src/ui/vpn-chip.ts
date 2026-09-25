import { invoke } from "@tauri-apps/api/core";

export interface VpnService {
  name: string;
  kind: string;
  connected: boolean;
  detail: string | null;
}

const POLL_MS = 8000;

const LOCK_CLOSED = `<svg class="rm-icon" viewBox="0 0 16 16" fill="none"><rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" stroke-width="1.4"/></svg>`;
const LOCK_OPEN = `<svg class="rm-icon" viewBox="0 0 16 16" fill="none"><rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

function ago(since: number): string {
  const minutes = Math.floor((Date.now() - since) / 60000);
  if (minutes < 1) return "방금 연결";
  if (minutes < 60) return `${minutes}분째 연결`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분째 연결`;
}

/** Lock chip in the terminal's top-right corner; click for the service list. */
export class VpnChip {
  private readonly chip = document.createElement("button");
  private readonly card = document.createElement("div");
  private services: VpnService[] = [];
  /** When Burrow first saw each service connected (macOS doesn't say). */
  private readonly since = new Map<string, number>();
  private timer = 0;

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
    this.render();
    this.timer = window.setTimeout(() => void this.refresh(), POLL_MS);
    return this.services;
  }

  private render() {
    // No VPN configured at all: nothing worth a chip.
    this.chip.hidden = this.services.length === 0;
    const up = this.services.filter((s) => s.connected);
    this.chip.classList.toggle("connected", up.length > 0);
    this.chip.innerHTML = `${up.length ? LOCK_CLOSED : LOCK_OPEN}<span>${up.length ? "VPN" : "VPN 꺼짐"}</span>`;
    this.chip.title = up.length ? `연결됨: ${up.map((s) => s.name).join(", ")}` : "연결된 VPN 없음";
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
      name.textContent = s.kind === "utun" ? `알 수 없는 VPN (${s.name})` : s.name;
      const sub = document.createElement("span");
      sub.className = "vpn-sub";
      const since = this.since.get(`${s.kind}:${s.name}`);
      sub.textContent = [
        s.connected && since ? ago(since) : s.connected ? "연결됨" : "꺼짐",
        s.detail,
      ]
        .filter(Boolean)
        .join(" · ");
      row.append(dot, name, sub);
      return row;
    });
    const note = document.createElement("div");
    note.className = "vpn-note";
    note.textContent = "SSH 프로필에 'VPN 명령'을 적어 두면 접속 전에 필요할 때만 실행합니다";
    this.card.replaceChildren(head, ...rows, note);
  }
}
