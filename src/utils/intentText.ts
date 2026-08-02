const KAZAKH_FOLD: Record<string, string> = {
  "ә": "а",
  "ғ": "г",
  "қ": "к",
  "ң": "н",
  "ө": "о",
  "ұ": "у",
  "ү": "у",
  "һ": "х",
  "і": "и",
  "ё": "е",
};

/**
 * WhatsApp Kazakh is often typed on a Russian keyboard. Keep the original for
 * exact matching, but also compare a folded form so missing Kazakh letters do
 * not turn a live-data request into an ungrounded model guess.
 */
export function foldIntentText(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/[әғқңөұүһіё]/gu, (letter) => KAZAKH_FOLD[letter] || letter);
}

const foldedPatterns = new WeakMap<RegExp, RegExp>();

function foldPatternSource(source: string) {
  return source.replace(/[әғқңөұүһіё]/gu, (letter) => KAZAKH_FOLD[letter] || letter);
}

export function intentMatches(pattern: RegExp, value: unknown) {
  const text = String(value || "");
  if (pattern.test(text)) return true;
  let foldedPattern = foldedPatterns.get(pattern);
  if (!foldedPattern) {
    foldedPattern = new RegExp(foldPatternSource(pattern.source), pattern.flags.replace("g", ""));
    foldedPatterns.set(pattern, foldedPattern);
  }
  return foldedPattern.test(foldIntentText(text));
}
