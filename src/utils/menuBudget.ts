import { foldIntentText } from "./intentText.js";

const AMOUNT_RE = /(?<![\p{L}\p{N}+\-.,])([+\-]?\s*(?:(?:\d+|бир|еки|уш|торт|бес|алты|жети|сегиз|тогыз|он|жиырма|отыз|кырык|елу|алпыс|жетпис|сексен|токсан|жуз|мын|миллион|нол|жарым|жарты|минус|плюс|или|немесе)\s+)*(?:\d+|бир|еки|уш|торт|бес|алты|жети|сегиз|тогыз|он|жиырма|отыз|кырык|елу|алпыс|жетпис|сексен|токсан|жуз|мын|миллион|нол|жарым|жарты|минус|плюс|или|немесе))\s*(?:тенге(?:ге|м|мен|лик)?|тг|kzt|₸)(?![\p{L}\p{N}])/giu;
const CURRENCY_RE = /(?<!\p{L})(?:тенге(?:ге|м|мен|лик)?|тг|kzt|₸)(?!\p{L})/iu;
const PRICE_CEILING_RE = /(?:(?<!\p{L})(?:до|не\s+дороже)\s*(\d{1,7})(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(\d{1,7})\s*(?:тенге(?:ге|м|мен|лик)?|тг|kzt|₸)?\s*(?:дейин|аспайтын)(?!\p{L}))/giu;
const QUALITATIVE_BUDGET_RE = /(?<!\p{L})(?:подешевле|дешевле|недорог\p{L}*|бюджетн\p{L}*|арзанырак|арзандау|арзан)(?!\p{L})/iu;
const EXPLORATION_RE = /(?:не\s*(?:аламын|алсам|алуга|жеуге|усынасыз|бар|келеди)|кандай[^.!?]{0,30}(?:алсам|алуга|аламан)|что(?:\s+\p{L}+){0,3}\s*(?:взять|купить|выбрать|поесть|посоветуете)|на\s+что\s+хватит|что\s+посоветуете)/iu;
const HUNGER_RE = /(?:карным[^.!?]{0,30}аш|голод(?:ен|на|ный|ная)|студент)/iu;
// Category names belong to the live catalog. Recognise the grammatical shape
// of a browse request instead of maintaining a dish dictionary here.
const CATEGORY_BROWSE_RE = /(?<!\p{L})(?:какие|какой|какую|какое|қандай|кандай)(?:\s+[\p{L}-]{2,}){1,5}/iu;
const FOOD_CHOICE_RE = /(?:аламын|алайын|возьму|закажу|заказываю|хочу\s+(?:заказать|взять)|тапсырыс\s*(?:берей|берем|жаса))/iu;
const MONEY_LEG_RE = /(?:оплат|перевел|перевод|реквизит|кас[пб]и|чек|толед|толем|аудар|жеткиз|достав|курьер)/iu;
const DENIED_RE = /(?:керек\s*емес|кажет\s*емес|жок|(?<!\p{L})не\s+(?:хочу|нуж|надо|интерес|спрашива|буду)|нет\s+(?:денег|бюджет))/iu;
const UNITS: Record<string, number> = { бир: 1, еки: 2, уш: 3, торт: 4, бес: 5, алты: 6, жети: 7, сегиз: 8, тогыз: 9 };
const TENS: Record<string, number> = { он: 10, жиырма: 20, отыз: 30, кырык: 40, елу: 50, алпыс: 60, жетпис: 70, сексен: 80, токсан: 90 };

function belowThousand(tokens: string[]): number | null {
  if (!tokens.length) return 0;
  let total = 0;
  let index = 0;
  if (tokens[0] === "жуз") { total = 100; index = 1; }
  else if (UNITS[tokens[0]] && tokens[1] === "жуз") { total = UNITS[tokens[0]] * 100; index = 2; }
  if (TENS[tokens[index]]) total += TENS[tokens[index++]];
  if (UNITS[tokens[index]]) total += UNITS[tokens[index++]];
  return index === tokens.length ? total : null;
}

function amountFromTokens(raw: string): number | null {
  const value = raw.trim();
  if (/^\d{1,7}$|^\d{1,3}(?:[ \u00a0\u202f]\d{3}){1,2}$/u.test(value)) {
    const amount = Number(value.replace(/\s/gu, ""));
    return Number.isSafeInteger(amount) && amount > 0 && amount <= 1_000_000 ? amount : null;
  }
  const tokens = value.split(/\s+/u);
  if (tokens.some(token => /\d|^[+\-]$/u.test(token) || /^(?:нол|жарым|жарты|минус|плюс|или|немесе)$/u.test(token))) return null;
  let total = 0;
  let start = 0;
  let previousScale = Infinity;
  for (let index = 0; index < tokens.length; index++) {
    const scale = tokens[index] === "миллион" ? 1_000_000 : tokens[index] === "мын" ? 1_000 : 0;
    if (!scale) continue;
    if (scale >= previousScale) return null;
    const group = index === start ? 1 : belowThousand(tokens.slice(start, index));
    if (group === null || group <= 0) return null;
    total += group * scale;
    previousScale = scale;
    start = index + 1;
  }
  const rest = belowThousand(tokens.slice(start));
  if (rest === null) return null;
  const amount = total + rest;
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 1_000_000 ? amount : null;
}

function currentBudgetClauses(text: string): string[] {
  const value = foldIntentText(String(text || "").replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu, "")).replace(/(?<!\p{L})(бюджет(?:ім|ым|а)?)(?=\d)/giu, "$1 ");
  // A refusal of an independent URL does not erase the food budget in that clause.
  const budgetText = value.replace(/(?:силтеме\p{L}*|ссылк\p{L}*|линк|link|url)[^\d.!?]{0,24}(?:(?:керек|кажет)\s*емес|кереги\s*жок|(?<!\p{L})не\s*(?:нуж\p{L}*|надо))|(?<!\p{L})не\s*(?:нуж\p{L}*|надо)[^\d.!?]{0,24}(?:силтеме\p{L}*|ссылк\p{L}*|линк|link|url)/giu, "")
    // Having this amount and "no other money" is not a denial of the stated budget.
    .replace(/(?<!\p{L})баска(?:\s+акшам?)?\s+жок(?!\p{L})/giu, "");
  // Mask unsupported decimal amounts, preserving inquiry kind before punctuation splitting.
  const clauses = budgetText.replace(/\d+[.,]\d+(\s*(?:тенге(?:ге|м)?|тг|kzt|₸))(?!\p{L})/giu, (_match, currency) => "unsupported_amount " + currency)
    .split(/[.!?;,\n]+|(?<!\p{L})(?:но|бирак)(?!\p{L})/iu);
  // A real food choice remains a choice even if this turn previously considered a budget.
  if (clauses.some(clause => FOOD_CHOICE_RE.test(clause)
    && !EXPLORATION_RE.test(clause)
    && !/^\s*(?:хочу\s+(?:заказать|взять)|закажу|заказываю|тапсырыс\s*(?:берей|берем|жаса))\s*$/iu.test(clause)
    && !/(?:не\s+(?:хочу|буду)|алмай|бар\s*ма|если|можно|могу)/iu.test(clause))) return [];
  const exploratory = EXPLORATION_RE.test(value);
  const hungry = HUNGER_RE.test(value);
  return clauses.filter(clause => {
    PRICE_CEILING_RE.lastIndex = 0;
    const ceiling = PRICE_CEILING_RE.test(clause);
    PRICE_CEILING_RE.lastIndex = 0;
    const categoryBrowse = CATEGORY_BROWSE_RE.test(clause);
    return (CURRENCY_RE.test(clause) || ceiling) && !MONEY_LEG_RE.test(clause) && !DENIED_RE.test(clause)
      && (exploratory || hungry || /бюджет/iu.test(clause) || ceiling && categoryBrowse);
  });
}

/** Inquiry kind is independent of whether its stated amount supports deterministic advice. */
export function isMenuBudgetInquiry(text: string): boolean {
  const visible = foldIntentText(String(text || "").replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu, ""));
  return currentBudgetClauses(text).length > 0 || QUALITATIVE_BUDGET_RE.test(visible);
}

/** Current exploratory food budget only. Integer KZT (1..1,000,000), no quoted facts.
 * Decimals, ambiguous alternatives and non-KZT amounts are intentionally unsupported.
 * This amount grounds advice; unsupported amounts never grant checkout permission.
 */
export function getMenuBudgetInquiry(text: string): number | null {
  const amounts = new Set<number>();
  for (const clause of currentBudgetClauses(text)) {
    if (/\d\s*(?:(?:тенге(?:ге|м)?|тг|kzt|₸)\s*)?(?:или|немесе)\s*\d|(?<!\p{L})(?:usd|eur|руб\p{L}*|доллар\p{L}*|евро)(?!\p{L})|[$€₽]/iu.test(clause)) return null;
    for (const match of clause.matchAll(AMOUNT_RE)) {
      const amount = amountFromTokens(match[1]);
      if (amount === null) return null;
      amounts.add(amount);
    }
    PRICE_CEILING_RE.lastIndex = 0;
    for (const match of clause.matchAll(PRICE_CEILING_RE)) {
      const amount = amountFromTokens(match[1] || match[2] || "");
      if (amount === null) return null;
      amounts.add(amount);
    }
    PRICE_CEILING_RE.lastIndex = 0;
  }
  return amounts.size === 1 ? [...amounts][0] : null;
}
