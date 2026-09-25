import type { Terminal } from "@xterm/xterm";

/**
 * Replaces xterm.js's composition handling, which drops Hangul syllables in
 * WKWebView: when one syllable ends and the next begins in the same keystroke,
 * WebKit's compositionend/compositionstart ordering breaks xterm's
 * setTimeout-based textarea slicing.
 *
 * Instead the textarea is treated as the source of truth: everything in it
 * except the in-progress composition (always at the end, since the caret never
 * moves) is committed text, and only the not-yet-sent part is forwarded.
 */
function keySequence(term: Terminal, e: KeyboardEvent): string | undefined {
  if (e.metaKey || e.ctrlKey || e.altKey) return undefined;
  const app = term.modes.applicationCursorKeysMode;
  const arrow = (c: string) => (app ? `\x1bO${c}` : `\x1b[${c}`);
  switch (e.key) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case "Backspace":
      return "\x7f";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return arrow("A");
    case "ArrowDown":
      return arrow("B");
    case "ArrowRight":
      return arrow("C");
    case "ArrowLeft":
      return arrow("D");
    default:
      return undefined;
  }
}

export function installImeHandler(term: Terminal, container: HTMLElement): () => void {
  const textarea = term.textarea!;
  const preview = document.createElement("div");
  preview.className = "ime-preview";
  container.appendChild(preview);

  let composing = false;
  let composition = "";
  let sent = 0;
  // Keys pressed while a syllable is still being composed; replayed after it commits.
  let pendingKeys: string[] = [];

  const flush = () => {
    const value = textarea.value;
    if (value.length < sent) sent = 0;
    const committedEnd = composing
      ? Math.max(sent, value.length - composition.length)
      : value.length;
    if (committedEnd > sent) {
      // A textarea newline from a composition-committing Enter means Return to the shell.
      term.input(value.slice(sent, committedEnd).replace(/\n/g, "\r"), true);
      sent = committedEnd;
    }
    if (!composing && pendingKeys.length > 0) {
      term.input(pendingKeys.join(""), true);
      pendingKeys = [];
    }
    if (!composing && sent === value.length && value.length > 0) {
      textarea.value = "";
      sent = 0;
    }
  };
  const scheduleFlush = () => setTimeout(flush, 0);

  const updatePreview = () => {
    const buffer = term.buffer.active;
    if (!composing || !composition || buffer.viewportY !== buffer.baseY) {
      preview.classList.remove("active");
      return;
    }
    const screen = container.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const cellWidth = screen.clientWidth / term.cols;
    const cellHeight = screen.clientHeight / term.rows;
    const x = Math.min(buffer.cursorX, term.cols - 1);
    preview.textContent = composition;
    preview.style.left = `${screen.offsetLeft + x * cellWidth}px`;
    preview.style.top = `${screen.offsetTop + buffer.cursorY * cellHeight}px`;
    preview.style.height = `${cellHeight}px`;
    preview.style.lineHeight = `${cellHeight}px`;
    preview.style.fontFamily = term.options.fontFamily ?? "";
    preview.style.fontSize = `${term.options.fontSize}px`;
    preview.classList.add("active");
  };

  // Capture-phase listeners on an ancestor run before xterm's own listeners on
  // the textarea, so stopping propagation keeps xterm out of IME input entirely.
  const listeners: [string, (e: Event) => void][] = [
    [
      "compositionstart",
      (e) => {
        e.stopPropagation();
        composing = true;
        composition = "";
        scheduleFlush();
      },
    ],
    [
      "compositionupdate",
      (e) => {
        e.stopPropagation();
        composition = (e as CompositionEvent).data ?? "";
        updatePreview();
      },
    ],
    [
      "compositionend",
      (e) => {
        e.stopPropagation();
        composing = false;
        composition = "";
        updatePreview();
        scheduleFlush();
      },
    ],
    [
      // Plain ASCII typing never reaches here: xterm handles it on keydown and
      // prevents the default. Only IME, emoji picker and dictation insert text.
      "input",
      (e) => {
        e.stopPropagation();
        scheduleFlush();
      },
    ],
    [
      "keydown",
      (e) => {
        const ke = e as KeyboardEvent;
        if (ke.isComposing || ke.keyCode === 229) {
          e.stopPropagation();
          return;
        }
        const seq = composing ? keySequence(term, ke) : undefined;
        if (seq) {
          e.stopPropagation();
          e.preventDefault();
          pendingKeys.push(seq);
          scheduleFlush();
        }
      },
    ],
  ];

  for (const [type, fn] of listeners) container.addEventListener(type, fn, true);

  return () => {
    for (const [type, fn] of listeners) container.removeEventListener(type, fn, true);
    preview.remove();
  };
}
