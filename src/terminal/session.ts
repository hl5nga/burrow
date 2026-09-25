import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

interface PtyExit {
  id: number;
  code: number | null;
}

const theme = {
  background: "#111317",
  foreground: "#eeece6",
  cursor: "#ffb000",
  cursorAccent: "#111317",
  selectionBackground: "rgba(255, 176, 0, 0.30)",
  black: "#15171b",
  red: "#ff6259",
  green: "#54d68a",
  yellow: "#ffb000",
  blue: "#6aa8ff",
  magenta: "#9b8cff",
  cyan: "#4be3d0",
  white: "#d8d6d0",
  brightBlack: "#5b6167",
  brightRed: "#ff8a83",
  brightGreen: "#7fe3a8",
  brightYellow: "#ffc947",
  brightBlue: "#94c1ff",
  brightMagenta: "#b9aeff",
  brightCyan: "#7eeede",
  brightWhite: "#eeece6",
};

export interface TerminalSession {
  term: Terminal;
  dispose(): void;
}

export async function openTerminalSession(
  container: HTMLElement,
  onExit: (code: number | null) => void,
): Promise<TerminalSession> {
  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(),
    fontSize: 13.5,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);

  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // WebGL unavailable: xterm falls back to its DOM renderer.
  }

  fit.fit();

  const output = new Channel<ArrayBuffer>();
  output.onmessage = (chunk) => term.write(new Uint8Array(chunk));

  const id = await invoke<number>("pty_spawn", {
    cols: term.cols,
    rows: term.rows,
    onOutput: output,
  });

  const unlistenExit = await listen<PtyExit>("pty-exit", (event) => {
    if (event.payload.id === id) onExit(event.payload.code);
  });

  const dataSub = term.onData((data) => {
    invoke("pty_write", { id, data });
  });
  const resizeSub = term.onResize(({ cols, rows }) => {
    invoke("pty_resize", { id, cols, rows });
  });

  let fitFrame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => fit.fit());
  });
  observer.observe(container);

  term.focus();

  return {
    term,
    dispose() {
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      unlistenExit();
      invoke("pty_kill", { id });
      term.dispose();
    },
  };
}
