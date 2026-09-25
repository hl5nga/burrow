const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;

/** The initial consonant of a Hangul syllable ("배" → "ㅂ"), else undefined. */
function initialConsonant(ch: string): string | undefined {
  const code = ch.codePointAt(0)!;
  if (code < HANGUL_FIRST || code > HANGUL_LAST) return undefined;
  return CHOSEONG[Math.floor((code - HANGUL_FIRST) / 588)];
}

// A lone consonant in the query also matches syllables starting with it, so
// "ㅂㅍ" finds "배포" the way Korean search boxes usually behave.
function charMatches(q: string, t: string): boolean {
  return q === t || (CHOSEONG.includes(q) && initialConsonant(t) === q);
}

function isBoundary(text: string[], i: number): boolean {
  if (i === 0) return true;
  return /[\s\-_/.:@]/.test(text[i - 1]);
}

/**
 * Subsequence match of `query` in `text`, case-insensitive. Returns a score
 * (higher is better) or undefined when not every query character is found.
 */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = Array.from(query.trim().toLowerCase()).filter((c) => c !== " ");
  if (q.length === 0) return 0;
  const t = Array.from(text.toLowerCase());

  let score = 0;
  let qi = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (!charMatches(q[qi], t[ti])) continue;
    score += 1;
    if (ti === prev + 1) score += 3;
    if (isBoundary(t, ti)) score += 2;
    if (ti === 0) score += 2;
    prev = ti;
    qi++;
  }
  if (qi < q.length) return undefined;
  // Prefer shorter texts when the matches are otherwise equal.
  return score - t.length * 0.01;
}
