import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { installImeHandler } from "./ime";
import { installInputEventLog } from "./devlog";
import { HOOK_OSC, parseHookEvent, type HookEvent } from "./hook-events";
import { BlockTracker } from "./blocks";

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
  context(): SessionContext;
  /** True between a command starting and the next prompt. */
  isRunning(): boolean;
  /**
   * Runs `command` as if typed. At an idle prompt the line is cleared first;
   * while a program is running the text is only typed, never executed blind.
   */
  run(command: string): void;
  /** Starts the process again in the same terminal, e.g. after a dropped connection. */
  restart(): Promise<void>;
  /** The bottom `lines` rows of the live screen as plain text (no colors). */
  screenText(lines: number): string;
  /** Prints a dim status line into the terminal (not sent to the process). */
  notice(text: string): void;
  focus(): void;
  dispose(): void;
}

export interface SessionContext {
  /** Key used for this session in stats.json: "local" for local shells. */
  host: string;
  cwd: string;
  /** Git branch of cwd, "" outside a repository. */
  branch: string;
}

export interface SessionHandlers {
  onExit(code: number | null): void;
  /** Keys typed while no process is running (after an exit the tab kept open). */
  onInputWhileStopped?(data: string): void;
  onContext?(context: SessionContext): void;
  onHookEvent?(event: HookEvent): void;
  /** Output was drawn; fires per write, so debounce before doing real work. */
  onScreenChange?(): void;
}

export interface SessionOptions {
  /** Starts the process behind the terminal; defaults to a local login shell. */
  spawn?(cols: number, rows: number, output: Channel<ArrayBuffer>): Promise<number>;
  /** An SSH session: every hook event comes from the remote host. */
  remote?: boolean;
}

export async function openTerminalSession(
  container: HTMLElement,
  handlers: SessionHandlers,
  options: SessionOptions = {},
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

  const context: SessionContext = { host: options.remote ? "" : "local", cwd: "", branch: "" };
  // A local tab's first event comes from this machine; later events from another
  // host mean the user ssh'd somewhere that has Burrow's hooks.
  let thisMachine: string | undefined;
  let running = false;
  let write: (data: string) => void = () => {};
  const blocks = new BlockTracker(term, {
    rerun: (cmd) => session.run(cmd),
  });
  // Consumed before rendering, so hook events never show up on screen.
  const hookOsc = term.parser.registerOscHandler(HOOK_OSC, (data) => {
    const event = parseHookEvent(data);
    if (import.meta.env.DEV) {
      invoke("dev_log", {
        line: `hook ${event ? JSON.stringify(event) : `unparsed ${data.slice(0, 40)}`}`,
      });
    }
    if (!event) return true;
    const branch = event.type === "prompt" ? event.branch : context.branch;
    if (!options.remote) thisMachine ??= event.host;
    const host = options.remote || event.host !== thisMachine ? event.host : "local";
    if (event.cwd !== context.cwd || branch !== context.branch || host !== context.host) {
      context.cwd = event.cwd;
      context.branch = branch;
      context.host = host;
      handlers.onContext?.({ ...context });
    }
    if (event.type === "exec") {
      running = true;
      blocks.onExec(event.cmd, context.host, event.cwd);
      invoke("stats_record", { host: context.host, cwd: event.cwd, cmd: event.cmd });
    } else {
      running = false;
      blocks.onPrompt(event.exit);
    }
    handlers.onHookEvent?.(event);
    return true;
  });
  const ime = installImeHandler(term, container);
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

  const spawnProcess = () => {
    const output = new Channel<ArrayBuffer>();
    output.onmessage = (chunk) => term.write(new Uint8Array(chunk));
    return options.spawn
      ? options.spawn(term.cols, term.rows, output)
      : invoke<number>("pty_spawn", { cols: term.cols, rows: term.rows, onOutput: output });
  };
  let id = await spawnProcess();
  let alive = true;

  const unlistenExit = await listen<PtyExit>("pty-exit", (event) => {
    if (event.payload.id !== id || !alive) return;
    alive = false;
    running = false;
    handlers.onExit(event.payload.code);
  });

  const dataSub = term.onData((data) => {
    if (alive) invoke("pty_write", { id, data });
    else handlers.onInputWhileStopped?.(data);
  });
  const writeSub = term.onWriteParsed(() => handlers.onScreenChange?.());
  const resizeSub = term.onResize(({ cols, rows }) => {
    if (alive) invoke("pty_resize", { id, cols, rows });
  });

  let fitFrame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => fit.fit());
  });
  observer.observe(container);

  term.focus();

  write = (data: string) => {
    if (alive) invoke("pty_write", { id, data });
  };

  const session: TerminalSession = {
    term,
    context: () => ({ ...context }),
    isRunning: () => running,
    run(command) {
      ime.reset();
      if (running) {
        write(command);
      } else {
        // Ctrl-U clears whatever is half-typed so the command runs on its own.
        write(`\x15${command}\r`);
      }
      term.scrollToBottom();
    },
    async restart() {
      if (alive) {
        alive = false;
        await invoke("pty_kill", { id }).catch(() => {});
      }
      running = false;
      ime.reset();
      id = await spawnProcess();
      alive = true;
    },
    screenText(lines) {
      const buffer = term.buffer.active;
      const rows: string[] = [];
      // baseY is the top of the live screen, wherever the user has scrolled to.
      for (let y = buffer.baseY; y < buffer.baseY + term.rows; y++) {
        rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
      }
      while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
      return rows.slice(-lines).join("\n");
    },
    notice(text) {
      // Start on a fresh line; the remote side may have left the cursor anywhere.
      term.write(`\x1b[0m\r\n\x1b[2m${text}\x1b[0m\r\n`);
    },
    focus: () => term.focus(),
    dispose() {
      observer.disconnect();
      hookOsc.dispose();
      blocks.dispose();
      ime.dispose();
      removeDevLog();
      document.fonts.removeEventListener("loadingdone", onFontsLoaded);
      dataSub.dispose();
      writeSub.dispose();
      resizeSub.dispose();
      unlistenExit();
      if (alive) invoke("pty_kill", { id });
      term.dispose();
    },
  };
  return session;
}
