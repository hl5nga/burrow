import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

/**
 * Everything here renders files Burrow did not write — possibly from a server
 * the user doesn't trust — so nothing may run and nothing may be fetched.
 */

// Tags that could run code, load remote content, or phone home.
const FORBID_TAGS = [
  "script",
  "style",
  "iframe",
  "frame",
  "object",
  "embed",
  "form",
  "img",
  "video",
  "audio",
  "source",
  "link",
  "meta",
  "base",
  "svg",
  "math",
];

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS, FORBID_ATTR: ["style", "src", "srcset"] });
}

/**
 * An HTML file shown in an iframe with an empty sandbox (no scripts, no
 * same-origin) plus a CSP that blocks every fetch except inline styles and
 * data: images.
 */
export function htmlFrame(text: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.srcdoc =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
    text;
  return frame;
}

const EXT_LANG: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  zsh: "bash",
  bash: "bash",
  css: "css",
  scss: "scss",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  json: "json",
  md: "markdown",
  lua: "lua",
  r: "r",
  pl: "perl",
  dockerfile: "dockerfile",
  makefile: "makefile",
};

export function languageFor(name: string): string | undefined {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop()! : lower;
  return EXT_LANG[ext];
}

/** Highlighted code as sanitized HTML (hljs escapes the source text). */
export function highlight(text: string, name: string): string {
  const lang = languageFor(name);
  const html =
    lang && hljs.getLanguage(lang)
      ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
      : hljs.highlightAuto(text.slice(0, 200_000)).value;
  return DOMPurify.sanitize(html);
}

/** A collapsible tree; big objects start folded below the first level. */
export function jsonTree(value: unknown, key?: string, depth = 0): HTMLElement {
  const label = (text: string, cls: string) => {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    return span;
  };
  const prefix = () =>
    key === undefined ? [] : [label(JSON.stringify(key), "j-key"), label(": ", "j-punct")];
  if (value !== null && typeof value === "object") {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [String(i), v] as const)
      : Object.entries(value);
    const details = document.createElement("details");
    details.open = depth < 1 || entries.length <= 20;
    const summary = document.createElement("summary");
    summary.append(
      ...prefix(),
      label(Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`, "j-punct"),
    );
    details.append(summary);
    for (const [k, v] of entries)
      details.append(jsonTree(v, Array.isArray(value) ? undefined : k, depth + 1));
    return details;
  }
  const row = document.createElement("div");
  row.className = "j-row";
  const type = value === null ? "null" : typeof value;
  row.append(...prefix(), label(JSON.stringify(value), `j-${type}`));
  return row;
}
