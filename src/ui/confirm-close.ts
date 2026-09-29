import { chooseDialog } from "./dialog";
import { t } from "../i18n";

/**
 * One shared confirmation for every way the app can be asked to close: the
 * last tab's ⌘W/×, the red traffic light, ⌘Q, Dock "Quit", and the menu's
 * "Burrow 종료" — window.close() emits the same close-requested event as
 * those do, so a single dialog covers them all (see lib.rs's ConfirmedExit).
 */
export function confirmCloseWindow(): Promise<boolean> {
  return chooseDialog(
    t("confirmClose.title"),
    [t("confirmClose.body1"), t("confirmClose.body2"), t("confirmClose.body3")],
    [
      { value: "cancel", label: t("confirmClose.cancel"), kind: "ghost" },
      { value: "close", label: t("confirmClose.close"), kind: "danger" },
    ],
  ).then((choice) => choice === "close");
}
