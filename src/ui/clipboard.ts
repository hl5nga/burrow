import { invoke } from "@tauri-apps/api/core";

export async function copyText(text: string): Promise<void> {
  // Native first: works without a browser user gesture (e.g. from the menu).
  try {
    await invoke("clip_text_write", { text });
    return;
  } catch {
    // Falls through to the web APIs.
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Falls through: some webviews reject the async API outside a user gesture.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("clipboard unavailable");
}
