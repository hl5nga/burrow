import { invoke } from "@tauri-apps/api/core";
import type { StoredCommand } from "./command-validation";
import { chooseDialog } from "./dialog";
import { showToast } from "./toast";
import type { TabManager } from "./tabs";

type HookStatus =
  | { state: "current" | "outdated" | "missing" | "noZsh" }
  | { state: "unreachable"; reason: string };

/**
 * Opens an SSH profile in a new tab. Burrow's hooks are only installed on the
 * host after the user agrees; without them the session still works, it just
 * isn't tracked.
 */
export async function connectProfile(tabs: TabManager, profile: StoredCommand) {
  const label = profile.name || profile.sshHost || "SSH";
  let status: HookStatus;
  try {
    status = await invoke<HookStatus>("remote_hook_status", { profileId: profile.id });
  } catch (err) {
    showToast(`${label}: ${err}`);
    return;
  }

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

  await tabs.newSshTab(profile.id, label, withHooks);
}
