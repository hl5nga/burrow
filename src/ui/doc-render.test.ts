import { test } from "node:test";
import assert from "node:assert/strict";

// DOMPurify needs a DOM; these checks run where one exists (the app), so the
// unit test covers the pure part only.
import { languageFor, resolveAssetPath } from "./doc-render.ts";

test("languages come from extensions and well-known file names", () => {
  assert.equal(languageFor("main.rs"), "rust");
  assert.equal(languageFor("App.TSX"), "typescript");
  assert.equal(languageFor("Dockerfile"), "dockerfile");
  assert.equal(languageFor("notes.unknownext"), undefined);
});

test("page assets resolve only inside the page's own folder", () => {
  const html = "/home/u/docs/mockups/01.html";
  assert.equal(resolveAssetPath(html, "assets/a.css"), "/home/u/docs/mockups/assets/a.css");
  assert.equal(
    resolveAssetPath(html, "./assets/../img/a.png?v=3#x"),
    "/home/u/docs/mockups/img/a.png",
  );
  // Out of the folder, absolute, other schemes, protocol-relative, backslashes.
  assert.equal(resolveAssetPath(html, "../shared/a.css"), undefined);
  assert.equal(resolveAssetPath(html, "assets/../../a.css"), undefined);
  assert.equal(resolveAssetPath(html, "/etc/passwd"), undefined);
  assert.equal(resolveAssetPath(html, "https://x.com/a.css"), undefined);
  assert.equal(resolveAssetPath(html, "//x.com/a.css"), undefined);
  assert.equal(resolveAssetPath(html, "data:image/png;base64,AAAA"), undefined);
  assert.equal(resolveAssetPath(html, "a\\b.css"), undefined);
  assert.equal(resolveAssetPath(html, ""), undefined);
  assert.equal(resolveAssetPath(html, "."), undefined);
});
