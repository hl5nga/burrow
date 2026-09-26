import { test } from "node:test";
import assert from "node:assert/strict";

// DOMPurify needs a DOM; these checks run where one exists (the app), so the
// unit test covers the pure part only.
import { languageFor } from "./doc-render.ts";

test("languages come from extensions and well-known file names", () => {
  assert.equal(languageFor("main.rs"), "rust");
  assert.equal(languageFor("App.TSX"), "typescript");
  assert.equal(languageFor("Dockerfile"), "dockerfile");
  assert.equal(languageFor("notes.unknownext"), undefined);
});
