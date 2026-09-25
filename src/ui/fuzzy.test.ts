import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyScore } from "./fuzzy.ts";

test("subsequences match case-insensitively; missing characters do not", () => {
  assert.notEqual(fuzzyScore("gst", "git status"), undefined);
  assert.notEqual(fuzzyScore("DEPLOY", "npm run deploy"), undefined);
  assert.equal(fuzzyScore("gsx", "git status"), undefined);
  assert.equal(fuzzyScore("", "anything"), 0);
});

test("contiguous and word-start matches rank higher", () => {
  const score = (q: string, t: string) => fuzzyScore(q, t)!;
  assert.ok(score("test", "npm test") > score("test", "tmux e-s-t"));
  assert.ok(score("gs", "git status") > score("gs", "mygits"));
  assert.ok(score("dep", "deploy") > score("dep", "npm run deploy"));
});

test("Hangul matches by syllable and by initial consonant", () => {
  assert.notEqual(fuzzyScore("배포", "프로덕션 배포"), undefined);
  assert.notEqual(fuzzyScore("ㅂㅍ", "배포"), undefined);
  assert.notEqual(fuzzyScore("ㅌㅅㅌ", "테스트 전체 실행"), undefined);
  assert.equal(fuzzyScore("ㅂㅍ", "테스트"), undefined);
  // A full syllable in the query must match that syllable, not just its consonant.
  assert.equal(fuzzyScore("바", "배포"), undefined);
});

test("spaces in the query are ignored", () => {
  assert.notEqual(fuzzyScore("git st", "git status"), undefined);
});
