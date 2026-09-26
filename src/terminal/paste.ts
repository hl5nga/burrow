export interface PreparedPaste {
  /** What goes to the terminal (line endings normalized). */
  text: string;
  lines: string[];
  /** More than one line: the shell could run several commands from it. */
  multiline: boolean;
}

/**
 * Normalizes clipboard text before it reaches the terminal. A single line
 * copied with its trailing newline loses that newline, so pasting it never
 * runs it by itself.
 */
export function preparePaste(raw: string): PreparedPaste {
  let text = raw.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines.length === 2 && lines[1] === "") {
    text = lines[0];
    lines.pop();
  }
  return { text, lines, multiline: lines.length > 1 };
}

/**
 * "Paste as one line": joins the lines with spaces, dropping blank ones and the
 * backslashes that continued a command onto the next line.
 */
export function joinLines(lines: string[]): string {
  return lines
    .map((l) => l.trim().replace(/\\$/, "").trim())
    .filter(Boolean)
    .join(" ");
}
