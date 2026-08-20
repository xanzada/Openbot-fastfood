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

// Availability, price and menu questions are catalog talk, never an incident:
// "Суық суы бар ма?" asks about a cold drink, it does not report a cold order.
// The complaint matchers consult this before any SOS can come out of a dish
// name or a menu question (live false positives: шашлық, суық суы, 2026-08-20).
const MENU_QUESTION_RE =
  /(бар\s*ма|барма|есть\s*ли|есть\s+в\s+наличии|наявны|наявн|наличи|қанша\s*тұра|қанша\s*тұр|сколько\s*стоит|поч[её]м|қандай|мәзір|меню|menu|прайс|ассортимент)/iu;

export function isLikelyMenuQuestion(text: unknown) {
  return intentMatches(MENU_QUESTION_RE, text);
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
