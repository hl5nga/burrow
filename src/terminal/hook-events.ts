/**
 * OSC 9999 events from shell/zsh/burrow-hooks.zsh:
 *   <event> ; base64(<field> NUL <field> NUL ...)
 */
export type HookEvent =
  | { type: "exec"; host: string; cwd: string; cmd: string }
  | { type: "prompt"; host: string; cwd: string; exit: number; branch: string };

export const HOOK_OSC = 9999;

function decodeFields(payload: string): string[] | undefined {
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Every field is NUL-terminated, so the last split element is empty.
    return text.split("\0").slice(0, -1);
  } catch {
    return undefined;
  }
}

export function parseHookEvent(data: string): HookEvent | undefined {
  const sep = data.indexOf(";");
  if (sep < 0) return undefined;
  const event = data.slice(0, sep);
  const fields = decodeFields(data.slice(sep + 1));
  if (!fields) return undefined;

  if (event === "exec" && fields.length === 3) {
    const [host, cwd, cmd] = fields;
    return { type: "exec", host, cwd, cmd };
  }
  if (event === "prompt" && (fields.length === 3 || fields.length === 4)) {
    const [host, cwd, exit, branch = ""] = fields;
    const code = Number(exit);
    return { type: "prompt", host, cwd, exit: Number.isInteger(code) ? code : -1, branch };
  }
  return undefined;
}
