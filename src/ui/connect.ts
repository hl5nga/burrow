import { invoke } from "@tauri-apps/api/core";
import type { StoredCommand } from "./command-validation";
import { chooseDialog } from "./dialog";
import { checkReachable } from "./reachability";
import { showToast } from "./toast";
import type { SessionTransport, TabManager } from "./tabs";
import type { VpnChip } from "./vpn-chip";

type HookStatus =
  | { state: "current" | "outdated" | "missing" | "noZsh" }
  | { state: "unreachable"; reason: string };

interface RemoteProbe {
  hooks: HookStatus;
  moshServer: boolean;
  tmux: boolean;
  localMosh: boolean;
}

const VPN_WAIT_MS = 15_000;

/**
 * Runs the profile's own VPN command when the host can't be reached yet, then
 * waits for the host to answer. The command runs only when it is needed, and
 * never for profiles that don't have one.
 */
async function bringUpVpn(profile: StoredCommand, label: string, vpn: VpnChip) {
  showToast(`${label}에 닿지 않아 VPN 명령을 실행합니다: ${profile.vpnPreConnect}`);
  try {
    await invoke("vpn_pre_connect", { profileId: profile.id });
  } catch (err) {
    showToast(`VPN 명령이 실패했습니다 (${err}). 그래도 접속을 시도합니다`);
  }
  // Commands like `scutil --nc start` return before the tunnel is up.
  const deadline = Date.now() + VPN_WAIT_MS;
  let reach = await checkReachable(profile.id, true);
  while (reach.state === "offline" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    reach = await checkReachable(profile.id, true);
  }
  void vpn.refresh();
  return reach;
}

/** Profiles already told that installing mosh locally would help, this run. */
const moshHintShown = new Set<string>();

function chooseTransport(
  profile: StoredCommand,
  probe: RemoteProbe,
  label: string,
): SessionTransport {
  const reachable = probe.hooks.state !== "unreachable";
  if (profile.transport === "ssh") return "ssh";
  if (profile.transport === "mosh") {
    if (!probe.localMosh) {
      showToast("이 Mac에 mosh가 없어 SSH로 접속합니다 (brew install mosh)");
      return "ssh";
    }
    if (reachable && !probe.moshServer) {
      showToast(`${label}에 mosh-server가 없어 SSH로 접속합니다`);
      return "ssh";
    }
    return "mosh";
  }
  // auto: Mosh whenever both ends have it.
  if (probe.moshServer && probe.localMosh) return "mosh";
  if (probe.moshServer && !moshHintShown.has(profile.id)) {
    moshHintShown.add(profile.id);
    showToast(
      `${label}에 mosh-server가 있습니다. 이 Mac에도 mosh를 설치하면 (brew install mosh) 네트워크가 바뀌어도 세션이 유지됩니다`,
    );
  }
  return "ssh";
}

/**
 * Opens an SSH profile in a new tab. Burrow's hooks are only installed on the
 * host after the user agrees; without them the session still works, it just
 * isn't tracked.
 */
export async function connectProfile(tabs: TabManager, profile: StoredCommand, vpn: VpnChip) {
  const label = profile.name || profile.sshHost || "SSH";
  let reach = await checkReachable(profile.id, true);
  // "unknown" (behind a proxy) could just as well need the VPN.
  if (reach.state !== "online" && profile.vpnPreConnect?.trim()) {
    reach = await bringUpVpn(profile, label, vpn);
  }
  if (reach.state === "offline") {
    showToast(`${label} 오프라인 — ${reach.reason}`);
    return;
  }

  let probe: RemoteProbe;
  try {
    probe = await invoke<RemoteProbe>("remote_probe", { profileId: profile.id });
  } catch (err) {
    showToast(`${label}: ${err}`);
    return;
  }

  const status = probe.hooks;
  let withHooks = status.state === "current";
  if (status.state === "missing" || status.state === "outdated") {
    const outdated = status.state === "outdated";
    const choice = await chooseDialog(
      outdated ? `${label}의 Burrow 훅을 업데이트할까요?` : `${label}에 Burrow 훅을 설치할까요?`,
      [
        `원격의 ~/.burrow/shell/zsh 폴더에만 파일 5개를 ${outdated ? "새 버전으로 덮어씁니다" : "씁니다"}. 원격의 ~/.zshrc 같은 dotfile은 수정하지 않습니다.`,
        "훅이 있으면 이 서버에서 쓴 명령이 서버별·폴더별로 집계되고 명령 블록이 표시됩니다. 훅 없이도 접속은 됩니다.",
      ],
      [
        { value: "install", label: outdated ? "업데이트하고 접속" : "설치하고 접속" },
        { value: "plain", label: "훅 없이 접속", kind: "ghost" },
        { value: "cancel", label: "취소", kind: "ghost" },
      ],
    );
    if (!choice || choice === "cancel") return;
    if (choice === "install") {
      try {
        await invoke("remote_install_hooks", { profileId: profile.id });
        withHooks = true;
      } catch (err) {
        showToast(`훅을 설치하지 못해 훅 없이 접속합니다: ${err}`);
      }
    }
  } else if (status.state === "noZsh") {
    showToast(`${label}에 zsh가 없어 명령 추적 없이 접속합니다`);
  } else if (status.state === "unreachable") {
    // Often a password-only login, which the non-interactive check cannot do.
    showToast(`${label} 상태를 미리 확인하지 못했습니다 (${status.reason}). 훅 없이 접속합니다`);
  }

  if (profile.tmuxSession && status.state !== "unreachable" && !probe.tmux) {
    showToast(`${label}에 tmux가 없어 일반 셸로 접속합니다`);
  }
  const transport = chooseTransport(profile, probe, label);
  await tabs.newSshTab(profile.id, label, withHooks, transport);
}
