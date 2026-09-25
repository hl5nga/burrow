import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { copyText } from "../ui/clipboard";
import { showToast } from "../ui/toast";

/**
 * Warp-style command blocks on top of xterm's grid, driven by the shell hooks:
 *   prompt event → the line where the next prompt starts (block start)
 *   exec event   → the line where the command's output starts
 *   prompt event → the end of that block (and the start of the next)
 * Decorations are overlays, so they are rebuilt after a resize reflows lines.
 */

interface Block {
  cmd: string;
  cwd: string;
  host: string;
  start: IMarker;
  output: IMarker;
  startedAt: number;
  end?: IMarker;
  exit?: number;
  durationMs?: number;
  decorations: IDecoration[];
}

export interface BlockActions {
  rerun(cmd: string): void;
}

const META_COLS = 22;

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export class BlockTracker {
  private blocks: Block[] = [];
  private nextStart?: IMarker;
  private current?: Block;

  constructor(
    private readonly term: Terminal,
    private readonly actions: BlockActions,
  ) {
    term.onResize(() => this.rebuildAll());
  }

  onPrompt(exit: number) {
    const marker = this.term.registerMarker(0);
    if (this.current && marker) {
      const block = this.current;
      block.end = marker;
      block.exit = exit;
      block.durationMs = performance.now() - block.startedAt;
      this.current = undefined;
      this.decorate(block);
    }
    this.nextStart = marker;
  }

  onExec(cmd: string, host: string, cwd: string) {
    const output = this.term.registerMarker(0);
    // Without a recorded prompt (e.g. the first command) the command line is the one above.
    const start = this.nextStart ?? this.term.registerMarker(-1);
    this.nextStart = undefined;
    if (!output || !start) return;
    const block: Block = {
      cmd,
      host,
      cwd,
      start,
      output,
      startedAt: performance.now(),
      decorations: [],
    };
    this.blocks = this.blocks.filter((b) => !b.start.isDisposed);
    this.blocks.push(block);
    this.current = block;
    this.decorate(block);
  }

  dispose() {
    for (const b of this.blocks) b.decorations.forEach((d) => d.dispose());
    this.blocks = [];
  }

  private rebuildAll() {
    for (const block of this.blocks) {
      if (!block.start.isDisposed) this.decorate(block);
    }
  }

  private decorate(block: Block) {
    block.decorations.forEach((d) => d.dispose());
    block.decorations = [];
    // Decorations belong to the normal buffer; full-screen apps draw on the alternate one.
    if (this.term.buffer.active.type !== "normal") return;

    const finished = block.end !== undefined;
    const bottom = finished ? block.end!.line : block.output.line;
    const height = Math.max(1, bottom - block.start.line);
    const state = !finished ? "active" : block.exit === 0 ? "ok" : "err";

    const bar = this.term.registerDecoration({ marker: block.start, x: 0, width: 1, height });
    // Add classes rather than replacing them: xterm positions the element via its own class.
    bar?.onRender((el) => {
      el.classList.add("block-bar", state);
    });
    if (bar) block.decorations.push(bar);

    if (!finished) return;
    // In a narrow window the badge would cover the prompt or command; skip it then.
    const headerLength =
      this.term.buffer.active.getLine(block.start.line)?.translateToString(true).length ?? 0;
    if (headerLength > this.term.cols - META_COLS - 1) return;
    const meta = this.term.registerDecoration({
      marker: block.start,
      anchor: "right",
      // xterm skips right-anchoring when x is 0, so keep one cell of margin.
      x: 1,
      width: META_COLS,
      height: 1,
    });
    meta?.onRender((el) => {
      if (el.dataset.ready) return;
      el.dataset.ready = "1";
      el.classList.add("block-meta-host");
      el.replaceChildren(this.metaElement(block));
    });
    if (meta) block.decorations.push(meta);
  }

  private metaElement(block: Block): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "block-meta";
    const actions = document.createElement("div");
    actions.className = "block-actions";
    const button = (glyph: string, title: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = glyph;
      b.title = title;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      actions.append(b);
    };
    button("⧉", "출력 복사", () => void this.copy(this.outputText(block), "출력을 복사했습니다"));
    button("↻", "다시 실행", () => this.actions.rerun(block.cmd));
    button(
      "✦",
      "AI 컨텍스트로 복사",
      () =>
        void this.copy(this.aiContext(block), "명령·출력을 AI에 붙여넣기 좋은 형태로 복사했습니다"),
    );

    const status = document.createElement("span");
    status.className = block.exit === 0 ? "exit-ok" : "exit-err";
    status.textContent = block.exit === 0 ? "✓" : `✗ ${block.exit}`;
    const time = document.createElement("span");
    time.textContent = formatDuration(block.durationMs ?? 0);
    const info = document.createElement("div");
    info.className = "block-info";
    info.append(status, time);
    wrap.append(actions, info);
    return wrap;
  }

  /** The block's output: lines from the one after the command to just before the next prompt. */
  outputText(block: Block): string {
    const buffer = this.term.buffer.active;
    const end = block.end?.line ?? buffer.baseY + buffer.cursorY;
    const lines: string[] = [];
    for (let y = block.output.line; y < end; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join("\n").replace(/\s+$/, "");
  }

  private aiContext(block: Block): string {
    const where = block.host === "local" ? "로컬" : block.host;
    const exit = block.exit === undefined ? "" : ` · exit ${block.exit}`;
    const output = this.outputText(block);
    return [
      `${where} \`${block.cwd}\`${exit}`,
      "```console",
      `$ ${block.cmd}`,
      ...(output ? [output] : []),
      "```",
    ].join("\n");
  }

  private async copy(text: string, message: string) {
    try {
      await copyText(text);
      showToast(message, 2000);
    } catch (err) {
      showToast(`복사하지 못했습니다: ${err}`);
    }
  }
}
