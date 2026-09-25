import type { Terminal } from "@xterm/xterm";
import { DEL, ImeLineSync } from "./ime-sync";

/**
 * Replaces xterm.js's IME handling, which loses Hangul in WKWebView.
 *
 * Observed in WKWebView (dev builds log raw events to $TMPDIR/burrow-dev-events.log):
 * the macOS Korean IME fires no composition events at all. It inserts the first
 * jamo as plain `insertText`, then edits the text already in the field with
 * `insertReplacementText` ("ㄹ" → "러", "하" → "한" → "하"+"나"). That only works
 * if the previous characters are still in the textarea and it sits at a real
 * caret position — xterm parks it off-screen at zero size and empties it.
 *
 * So the textarea is kept at the cursor with its text left in place, and it is
 * the source of truth: after every change the part that differs from what was
 * already sent is rewritten on the shell line (DEL per changed character, then
 * the new text). IMEs that do use composition events are handled too — the
 * in-progress composition at the end is excluded until it commits.
 */

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);
const TEXTAREA_TRIM_AT = 256;
const TEXTAREA_KEEP = 32;

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
      return DEL;
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

export interface ImeHandler {
  /** Forget the textarea context after input reached the shell some other way. */
  reset(): void;
  dispose(): void;
}

export function installImeHandler(term: Terminal, container: HTMLElement): ImeHandler {
  const textarea = term.textarea!;
  const preview = document.createElement("div");
  preview.className = "ime-preview";
  container.appendChild(preview);

  let composing = false;
  let composition = "";
  const sync = new ImeLineSync();
  // Keys pressed while a composition-event IME is still composing; replayed after commit.
  let pendingKeys: string[] = [];
  // The character of the last keydown xterm sent itself (e.g. space). If the browser
  // then also inserts that same text into the textarea, it was already sent.
  let xtermSentKey: string | undefined;

  const cellGeometry = () => {
    const screen = container.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return undefined;
    const buffer = term.buffer.active;
    const width = screen.clientWidth / term.cols;
    const height = screen.clientHeight / term.rows;
    const x = Math.min(buffer.cursorX, term.cols - 1);
    return { screen, width, height, left: x * width, top: buffer.cursorY * height };
  };

  // The IME needs a real caret rectangle (and its candidate window a position),
  // so the textarea follows the cursor instead of sitting at -9999em.
  const syncTextarea = () => {
    const cell = cellGeometry();
    if (!cell) return;
    textarea.style.left = `${cell.left}px`;
    textarea.style.top = `${cell.top}px`;
    textarea.style.width = `${cell.width * 2}px`;
    textarea.style.height = `${cell.height}px`;
    textarea.style.lineHeight = `${cell.height}px`;
  };

  const keepCaretAtEnd = () => {
    if (composing) return;
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  };

  const resetContext = () => {
    textarea.value = "";
    sync.reset();
  };

  const flush = () => {
    const value = textarea.value;
    const committed =
      composing && composition ? value.slice(0, value.length - composition.length) : value;
    const data = sync.update(committed);
    if (data) term.input(data, true);

    if (!composing && pendingKeys.length > 0) {
      term.input(pendingKeys.join(""), true);
      pendingKeys = [];
    }
    if (!composing) {
      const trimmed = sync.trim(TEXTAREA_TRIM_AT, TEXTAREA_KEEP);
      if (trimmed !== undefined) textarea.value = trimmed;
    }
    keepCaretAtEnd();
  };

  const updatePreview = () => {
    const buffer = term.buffer.active;
    const cell = cellGeometry();
    if (!cell || !composing || !composition || buffer.viewportY !== buffer.baseY) {
      preview.classList.remove("active");
      return;
    }
    preview.textContent = composition;
    preview.style.left = `${cell.screen.offsetLeft + cell.left}px`;
    preview.style.top = `${cell.screen.offsetTop + cell.top}px`;
    preview.style.height = `${cell.height}px`;
    preview.style.lineHeight = `${cell.height}px`;
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
        setTimeout(flush, 0);
      },
    ],
    [
      "input",
      (e) => {
        e.stopPropagation();
        if (!composing && xtermSentKey && (e as InputEvent).data === xtermSentKey) {
          xtermSentKey = undefined;
          sync.adopt(textarea.value);
          return;
        }
        flush();
      },
    ],
    [
      "keydown",
      (e) => {
        const ke = e as KeyboardEvent;
        if (ke.isComposing || ke.keyCode === 229) {
          // The IME owns this key; it reports the result as textarea edits.
          e.stopPropagation();
          return;
        }
        if (MODIFIER_KEYS.has(ke.key)) return;
        if (composing) {
          const seq = keySequence(term, ke);
          if (seq) {
            e.stopPropagation();
            e.preventDefault();
            pendingKeys.push(seq);
            setTimeout(flush, 0);
          }
          return;
        }
        // From here on xterm handles the key and sends it to the shell itself.
        if (ke.key === "Backspace" && !ke.metaKey && !ke.altKey && !ke.ctrlKey) {
          // Mirror the shell's deletion so textarea and shell line stay aligned.
          textarea.value = sync.backspace();
          return;
        }
        // Anything else (Enter, arrows, other characters) breaks the link between
        // the textarea and the end of the shell line, so start a fresh context.
        resetContext();
        xtermSentKey = ke.key.length === 1 && !ke.metaKey && !ke.ctrlKey ? ke.key : undefined;
      },
    ],
    ["keyup", () => keepCaretAtEnd()],
  ];

  for (const [type, fn] of listeners) container.addEventListener(type, fn, true);
  const cursorSub = term.onCursorMove(syncTextarea);
  const renderSub = term.onRender(syncTextarea);
  syncTextarea();

  return {
    reset: resetContext,
    dispose() {
      for (const [type, fn] of listeners) container.removeEventListener(type, fn, true);
      cursorSub.dispose();
      renderSub.dispose();
      preview.remove();
    },
  };
}
