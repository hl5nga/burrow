import { test } from "node:test";
import assert from "node:assert/strict";
import { FONT_SIZES, LINE_HEIGHTS, fontSizePx, lineHeightFor } from "./text-settings.ts";

test("levels map to the documented px/multiplier tables", () => {
  assert.equal(fontSizePx(1), FONT_SIZES[0]);
  assert.equal(fontSizePx(3), 11.5);
  assert.equal(fontSizePx(5), FONT_SIZES[4]);
  assert.equal(lineHeightFor(1), 1.0);
  assert.equal(lineHeightFor(2), 1.2);
  assert.equal(lineHeightFor(3), 1.4);
});

test("out-of-range or fractional levels are clamped and rounded", () => {
  assert.equal(fontSizePx(0), fontSizePx(1));
  assert.equal(fontSizePx(9), fontSizePx(5));
  assert.equal(fontSizePx(2.6), fontSizePx(3));
  assert.equal(lineHeightFor(-1), lineHeightFor(1));
  assert.equal(lineHeightFor(10), lineHeightFor(3));
});
