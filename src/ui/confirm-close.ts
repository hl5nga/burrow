import { chooseDialog } from "./dialog";

/**
 * One shared confirmation for every way the app can be asked to close: the
 * last tab's ⌘W/×, the red traffic light, ⌘Q, Dock "Quit", and the menu's
 * "Burrow 종료" — window.close() emits the same close-requested event as
 * those do, so a single dialog covers them all (see lib.rs's ConfirmedExit).
 */
export function confirmCloseWindow(): Promise<boolean> {
  return chooseDialog(
    "Burrow를 닫으시겠습니까?",
    [
      "열려 있는 로컬 터미널 세션이 모두 종료됩니다.",
      "SSH로 연결한 원격 tmux 세션은 서버에 그대로 남아 있어, 나중에 다시 접속하면 이어집니다.",
    ],
    [
      { value: "cancel", label: "취소", kind: "ghost" },
      { value: "close", label: "닫기", kind: "danger" },
    ],
  ).then((choice) => choice === "close");
}
