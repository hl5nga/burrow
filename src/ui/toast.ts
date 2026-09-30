import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";

interface Recovery {
  file: string;
  backup: string;
  error: string;
}

export function showToast(message: string, durationMs = 8000) {
  let stack = document.querySelector<HTMLElement>(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  toast.addEventListener("click", () => toast.remove());
  stack.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}

export async function showStoreRecoveries() {
  const recoveries = await invoke<Recovery[]>("store_take_recoveries");
  for (const r of recoveries) {
    const name = r.file.split("/").pop();
    showToast(t("toast.recoveredFile", { name: name ?? r.file, backup: r.backup }));
  }
}
