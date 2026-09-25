export const DEL = "\x7f";

/**
 * Keeps the end of the shell line equal to the IME textarea's text. The IME may
 * rewrite characters it already produced, so each change is turned into
 * "DEL for every changed character, then the new text".
 */
export class ImeLineSync {
  /** Code points of the textarea text the shell line currently ends with. */
  private sent: string[] = [];

  /** Returns the bytes to send so the shell line ends with `text`. */
  update(text: string): string {
    const target = Array.from(text);
    let keep = 0;
    while (keep < this.sent.length && keep < target.length && this.sent[keep] === target[keep]) {
      keep++;
    }
    const erase = this.sent.length - keep;
    const insert = target.slice(keep).join("").replace(/\n/g, "\r");
    this.sent = target;
    return DEL.repeat(erase) + insert;
  }

  /** The shell already received `text` some other way (e.g. xterm's own keydown). */
  adopt(text: string) {
    this.sent = Array.from(text);
  }

  /** The shell deleted one character on its own; returns the new textarea text. */
  backspace(): string {
    this.sent = this.sent.slice(0, -1);
    return this.sent.join("");
  }

  /** Keeps only the last `keep` characters; returns the new textarea text. */
  trim(maxLength: number, keep: number): string | undefined {
    if (this.sent.length <= maxLength) return undefined;
    this.sent = this.sent.slice(-keep);
    return this.sent.join("");
  }

  reset() {
    this.sent = [];
  }
}
