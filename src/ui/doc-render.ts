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
 * An HTML file shown in an iframe. Scripts never run (the sandbox has no
 * `allow-scripts`) and a CSP blocks every fetch except inline styles and
 * data: images. `allow-same-origin` is safe without scripts and lets the app
 * read the text selected in the frame, so ⌘C can copy it.
 */
export function htmlFrame(text: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.srcdoc =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
    text;
  return frame;
}

/**
 * The absolute path a relative `href`/`src` in an HTML file points to, only
 * when it stays inside the HTML file's own folder (assets/app.css, img/a.png,
 * ./x.css). URLs with a scheme, absolute paths and anything that climbs out of
 * the folder yield undefined: a page must not make the viewer read arbitrary
 * files.
 */
export function resolveAssetPath(htmlPath: string, ref: string): string | undefined {
  const clean = ref.trim().split(/[?#]/)[0];
  if (
    !clean ||
    /^[a-z][a-z0-9+.-]*:/i.test(clean) ||
    clean.startsWith("/") ||
    clean.includes("\\")
  ) {
    return undefined;
  }
  const dir = htmlPath.split("/").slice(0, -1);
  const parts = [...dir];
  const base = dir.length;
  for (const piece of clean.split("/")) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") {
      if (parts.length <= base) return undefined; // would leave the HTML's folder
      parts.pop();
    } else {
      parts.push(piece);
    }
  }
  return parts.length > base ? parts.join("/") : undefined;
}

const MAX_INLINED = 12;

/**
 * Inlines what a page links from its own folder — stylesheets as <style>,
 * small pictures as data: URIs — since the preview itself may fetch nothing.
 * The page's scripts are left alone (and never run). A reference that can't
 * be read is just skipped.
 */
export async function inlineHtmlAssets(
  html: string,
  htmlPath: string,
  readText: (path: string) => Promise<string | undefined>,
  readImage: (path: string) => Promise<string | undefined>,
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const jobs: Promise<void>[] = [];
  let budget = MAX_INLINED;
  for (const link of doc.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet'][href]")) {
    const path = resolveAssetPath(htmlPath, link.getAttribute("href") ?? "");
    if (!path || budget-- <= 0) continue;
    jobs.push(
      readText(path).then((css) => {
        if (css === undefined) return;
        const style = doc.createElement("style");
        style.textContent = css;
        link.replaceWith(style);
      }),
    );
  }
  for (const img of doc.querySelectorAll<HTMLImageElement>("img[src]")) {
    const path = resolveAssetPath(htmlPath, img.getAttribute("src") ?? "");
    if (!path || budget-- <= 0) continue;
    jobs.push(
      readImage(path).then((uri) => {
        if (uri !== undefined) img.setAttribute("src", uri);
      }),
    );
  }
  await Promise.all(jobs);
  const type = doc.doctype ? `<!doctype ${doc.doctype.name}>` : "";
  return type + doc.documentElement.outerHTML;
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
