import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { installImeHandler } from "./ime";
import { installInputEventLog } from "./devlog";
import { HOOK_OSC, parseHookEvent, type HookEvent } from "./hook-events";

interface PtyExit {
  id: number;
  code: number | null;
}

const FONT_SIZE = 13.5;

// xterm measures the cell size once at open(), so the primary font must be ready
// before that. Hangul glyphs come from unicode-range chunks that load lazily.
async function loadTerminalFonts(fontFamily: string) {
  await Promise.all([
    document.fonts.load(`${FONT_SIZE}px ${fontFamily}`, "W"),
    document.fonts.load(`bold ${FONT_SIZE}px ${fontFamily}`, "W"),
    document.fonts.load(`${FONT_SIZE}px ${fontFamily}`, "한글"),
  ]);
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

export interface SessionContext {
  /** Key used for this session in stats.json: "local" for local shells. */
  host: string;
  cwd: string;
}

export interface SessionHandlers {
  onExit(code: number | null): void;
  onContext?(context: SessionContext): void;
  onHookEvent?(event: HookEvent): void;
}

export async function openTerminalSession(
  container: HTMLElement,
  handlers: SessionHandlers,
): Promise<TerminalSession> {
  const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim();
  await loadTerminalFonts(fontFamily);

  const term = new Terminal({
    fontFamily,
    fontSize: FONT_SIZE,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(container);

  const context: SessionContext = { host: "local", cwd: "" };
  // Consumed before rendering, so hook events never show up on screen.
  const hookOsc = term.parser.registerOscHandler(HOOK_OSC, (data) => {
    const event = parseHookEvent(data);
    if (!event) return true;
    if (event.cwd !== context.cwd) {
      context.cwd = event.cwd;
      handlers.onContext?.({ ...context });
    }
    if (event.type === "exec") {
      invoke("stats_record", { host: context.host, cwd: event.cwd, cmd: event.cmd });
    }
    handlers.onHookEvent?.(event);
    return true;
  });
  const removeIme = installImeHandler(term, container);
  const removeDevLog = import.meta.env.DEV ? installInputEventLog(term) : () => {};

  // A newly loaded glyph chunk would otherwise keep its fallback-font rendering
  // cached in the WebGL texture atlas.
  const onFontsLoaded = () => term.clearTextureAtlas();
  document.fonts.addEventListener("loadingdone", onFontsLoaded);

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
    if (event.payload.id === id) handlers.onExit(event.payload.code);
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
      hookOsc.dispose();
      removeIme();
      removeDevLog();
      document.fonts.removeEventListener("loadingdone", onFontsLoaded);
      dataSub.dispose();
      resizeSub.dispose();
      unlistenExit();
      invoke("pty_kill", { id });
      term.dispose();
    },
  };
}
